#!/usr/bin/env python3
"""Exercise an unpacked Pi-Bolt binary over JSONL and a loopback-only model fixture.

Usage: python3 tests/pi/rpc-message-id.py /absolute/path/to/pi
No real provider, API key, user agent directory or external model service is used.
"""
import contextlib
import http.server
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import unittest

BINARY = str(pathlib.Path(sys.argv.pop(1)).resolve())


class ModelFixture:
    def __init__(self):
        self.requests = []
        self.condition = threading.Condition()
        self.release = threading.Event()
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                with fixture.condition:
                    index = len(fixture.requests)
                    fixture.requests.append(body)
                    fixture.condition.notify_all()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    self.emit({"role": "assistant", "content": "fixture "})
                    if index == 0:
                        fixture.release.wait(30)
                    self.emit({"content": "ok"})
                    self.emit({}, "stop")
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def emit(self, delta, finish=None):
                chunk = {"id": "fixture-response", "object": "chat.completion.chunk", "created": 1,
                         "model": "rpc-fixture", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.flush()

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def wait_requests(self, count):
        with self.condition:
            if not self.condition.wait_for(lambda: len(self.requests) >= count, timeout=20):
                raise AssertionError(f"model fixture saw {len(self.requests)} requests; wanted {count}")

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()


class RpcClient:
    def __init__(self, directory, fixture, extension=False):
        self.directory = pathlib.Path(directory)
        agent = self.directory / "agent"
        agent.mkdir()
        self.sessions = self.directory / "sessions"
        self.sessions.mkdir()
        (self.directory / "home").mkdir()
        (agent / "models.json").write_text(json.dumps({"providers": {"rpc-fixture": {
            "baseUrl": f"http://127.0.0.1:{fixture.server.server_port}/v1",
            "api": "openai-completions", "apiKey": "loopback-fixture-only", "models": [{"id": "rpc-fixture"}],
        }}}))
        (agent / "settings.json").write_text(json.dumps({"autoCompaction": {"enabled": False}, "retry": {"enabled": False}}))
        args = [BINARY, "--mode", "rpc", "--offline", "--provider", "rpc-fixture", "--model", "rpc-fixture",
                "--session-dir", str(self.sessions), "-ne"]
        if extension:
            path = self.directory / "fixture-extension.js"
            path.write_text('export default function (pi) { pi.on("input", event => {\n'
                            'if (event.text === "binary-transform") return { action: "transform", text: "binary-transformed" };\n'
                            'if (event.text === "binary-handled") return { action: "handled" };\n'
                            'return { action: "continue" }; }); }\n')
            args += ["-e", str(path)]
        env = {"PATH": os.environ["PATH"], "HOME": str(self.directory / "home"), "PI_CODING_AGENT_DIR": str(agent),
               "DO_NOT_TRACK": "1", "BUN_ENABLE_CRASH_REPORTING": "0", "NO_PROXY": "127.0.0.1,localhost"}
        self.process = subprocess.Popen(args, cwd=self.directory, env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.events = []
        self.errors = []
        self.condition = threading.Condition()
        self.counter = 0
        threading.Thread(target=self.read_stdout, daemon=True).start()
        threading.Thread(target=self.read_stderr, daemon=True).start()
        self.command("get_state")

    def read_stdout(self):
        for line in self.process.stdout:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                record = {"invalid_jsonl": line}
            with self.condition:
                self.events.append(record)
                self.condition.notify_all()
        with self.condition:
            self.condition.notify_all()

    def read_stderr(self):
        for line in self.process.stderr:
            self.errors.append(line)

    def wait(self, predicate, since=0):
        deadline = time.monotonic() + 20
        with self.condition:
            while True:
                for event in self.events[since:]:
                    if "invalid_jsonl" in event:
                        raise AssertionError(f"non-JSONL stdout: {event}")
                    if predicate(event):
                        return event
                remaining = deadline - time.monotonic()
                if remaining <= 0 or self.process.poll() is not None:
                    raise AssertionError(f"RPC wait failed; exit={self.process.poll()}, stderr={''.join(self.errors)[-2000:]}, "
                                         f"events={[e.get('type') for e in self.events[-20:]]}")
                self.condition.wait(min(remaining, 0.1))

    def command(self, kind, **fields):
        self.counter += 1
        command_id = f"command-{self.counter}"
        self.process.stdin.write(json.dumps({"id": command_id, "type": kind, **fields}) + "\n")
        self.process.stdin.flush()
        response = self.wait(lambda event: event.get("type") == "response" and event.get("id") == command_id)
        if not response["success"]:
            raise AssertionError(response)
        return response

    def settled(self, since=0):
        return self.wait(lambda event: event.get("type") == "agent_settled", since)

    def tracking(self, reason=None):
        records = [event["tracking"] for event in self.events if event.get("type") == "queue_update" and "tracking" in event]
        return [record for record in records if reason is None or record["change"]["reason"] == reason]

    def close(self):
        with contextlib.suppress(BrokenPipeError, OSError):
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


class BinaryRpcTests(unittest.TestCase):
    @contextlib.contextmanager
    def client(self, extension=False):
        fixture = ModelFixture()
        with tempfile.TemporaryDirectory(prefix="pi-bolt-rpc-acceptance-") as directory:
            client = None
            try:
                client = RpcClient(directory, fixture, extension)
                yield client, fixture
            finally:
                fixture.close()
                if client:
                    client.close()

    def assert_no_leak(self, client, fixture, ids):
        messages = client.command("get_messages")["data"]["messages"]
        sessions = list(client.sessions.rglob("*.jsonl"))
        self.assertTrue(sessions, "a real persisted session must be checked")
        serialized = json.dumps(fixture.requests) + json.dumps(messages) + "".join(path.read_text() for path in sessions)
        for message_id in ids:
            self.assertNotIn(message_id, serialized)
        for key in ('"message_id"', '"steeringMessageIds"', '"followUpMessageIds"', '"batchId"', '"tracking"', '"instanceId"'):
            self.assertNotIn(key, json.dumps(fixture.requests))
        tracking = client.tracking()
        self.assertEqual([item["sequence"] for item in tracking], list(range(1, len(tracking) + 1)))
        self.assertEqual(len({item["instanceId"] for item in tracking}), 1)
        for item in tracking:
            self.assertNotIn(item["instanceId"], serialized)
            self.assertEqual(item["version"], 1)
            self.assertEqual("batchId" in item, item["change"]["reason"] in ("consume", "prompt_start"))

    def test_follow_up_duplicate_text_ordered_batch_and_no_leak(self):
        with self.client() as (client, fixture):
            ids = ["private-correlation-follow-A", "private-correlation-follow-B", "private-correlation-follow-C"]
            client.command("set_follow_up_mode", mode="all")
            first = client.command("prompt", message="initial", message_id=ids[0])
            self.assertEqual(first["data"], {"disposition": "started", "message_id": ids[0]})
            fixture.wait_requests(1)
            for message_id in ids[1:]:
                response = client.command("follow_up", message="duplicate", message_id=message_id)
                self.assertEqual(response["data"], {"disposition": "queued", "message_id": message_id})
            self.assertFalse(client.tracking("consume"), "admission must not claim consumption")
            self.assertEqual(client.tracking("enqueue")[-1]["followUpMessageIds"], ids[1:])
            fixture.release.set()
            client.settled()
            initial_ids = client.tracking("prompt_start")[0]["change"]["messageIds"]
            self.assertEqual([value for value in initial_ids if value is not None], ids[:1])
            changes = [item["change"] for item in client.tracking("consume") if item["change"]["messageIds"]]
            self.assertEqual(changes, [{"reason": "consume", "source": "followUp", "messageIds": ids[1:]}])
            self.assert_no_leak(client, fixture, ids)

    def test_steering_duplicate_text_ordered_batch(self):
        with self.client() as (client, fixture):
            ids = ["private-correlation-steer-A", "private-correlation-steer-B", "private-correlation-steer-C"]
            client.command("set_steering_mode", mode="all")
            client.command("prompt", message="initial", message_id=ids[0])
            fixture.wait_requests(1)
            for message_id in ids[1:]:
                client.command("steer", message="duplicate", message_id=message_id)
            self.assertFalse(client.tracking("consume"))
            self.assertEqual(client.tracking("enqueue")[-1]["steeringMessageIds"], ids[1:])
            fixture.release.set()
            client.settled()
            changes = [item["change"] for item in client.tracking("consume") if item["change"]["messageIds"]]
            self.assertEqual(changes, [{"reason": "consume", "source": "steer", "messageIds": ids[1:]}])
            self.assert_no_leak(client, fixture, ids)

    def test_clear_and_abort_do_not_consume_cancelled_inputs(self):
        with self.client() as (client, fixture):
            ids = ["private-correlation-clear-A", "private-correlation-clear-B", "private-correlation-clear-C"]
            client.command("prompt", message="initial", message_id=ids[0])
            fixture.wait_requests(1)
            client.command("steer", message="duplicate", message_id=ids[1])
            client.command("follow_up", message="duplicate", message_id=ids[2])
            cleared = client.command("clear_queue")
            self.assertEqual(cleared["data"], {"steering": ["duplicate"], "followUp": ["duplicate"]})
            self.assertEqual(client.tracking("clear")[-1]["change"]["messageIds"], {"steering": ids[1:2], "followUp": ids[2:]})
            client.command("abort")
            self.assertTrue(client.settled()["aborted"])
            self.assertFalse(client.tracking("consume"))
            self.assertEqual(client.command("get_state")["data"]["pendingMessageCount"], 0)
            self.assert_no_leak(client, fixture, ids)

    def test_legacy_client_remains_usable_without_tracking(self):
        with self.client() as (client, fixture):
            response = client.command("prompt", message="legacy input")
            self.assertEqual(response["data"], {"disposition": "started"})
            fixture.wait_requests(1)
            fixture.release.set()
            client.settled()
            self.assertFalse(client.tracking())
            self.assertTrue(client.command("get_messages")["data"]["messages"])

    def test_abort_retains_queued_ids_until_an_explicit_clear(self):
        with self.client() as (client, fixture):
            ids = ["private-correlation-abort-A", "private-correlation-abort-B"]
            client.command("prompt", message="initial", message_id=ids[0])
            fixture.wait_requests(1)
            client.command("follow_up", message="pending", message_id=ids[1])
            client.command("abort")
            self.assertTrue(client.settled()["aborted"])
            self.assertFalse(client.tracking("consume"))
            self.assertEqual(client.command("get_state")["data"]["pendingMessageCount"], 1)
            client.command("clear_queue")
            self.assertEqual(client.tracking("clear")[-1]["change"]["messageIds"]["followUp"], ids[1:])
            self.assert_no_leak(client, fixture, ids)

    def test_extension_transforms_and_handles_identified_input(self):
        with self.client(extension=True) as (client, fixture):
            handled_id = "private-correlation-extension-handled"
            handled = client.command("prompt", message="binary-handled", message_id=handled_id)
            self.assertEqual(handled["data"], {"disposition": "handled", "message_id": handled_id})
            self.assertFalse(fixture.requests)
            message_id = "private-correlation-extension-transformed"
            client.command("prompt", message="binary-transform", message_id=message_id)
            fixture.wait_requests(1)
            fixture.release.set()
            client.settled()
            self.assertIn("binary-transformed", json.dumps(fixture.requests))
            self.assertNotIn("binary-transform\"", json.dumps(fixture.requests))
            self.assert_no_leak(client, fixture, [handled_id, message_id])


if __name__ == "__main__":
    unittest.main(verbosity=2)
