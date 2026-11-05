import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { forkConfiguration, publicKeyFields, synchronizeForkRelease } from "./configure-fork-release.mjs";
import { linuxReleaseFiles, prepareForkRelease, verifyForkRelease } from "./fork-release.mjs";
import { signSshRelease, sshPublicKey } from "./lib/sshsig.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");

function temporary(t) {
	const dir = mkdtempSync(join(tmpdir(), "pi-fork-release-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function fixture(t, configured = true) {
	const directory = temporary(t);
	const files = ["fork-release.json", "VERSION", "npm/package.json", "npm/bin/pi-bolt", "npm/install.cjs", "install.sh",
		"install.ps1", "packages/coding-agent/src/pi-bolt.ts", "keys/release.pub", "keys/upstream-runtime.pub", "runtime-source.json", "extensions.txt"];
	for (const name of files) {
		mkdirSync(dirname(join(directory, name)), { recursive: true });
		copyFileSync(join(root, name), join(directory, name));
	}
	const owner = generateKeyPairSync("ed25519");
	// Each fixture owns its key configuration, independently of whether the checkout has a production public key.
	synchronizeForkRelease({ root: directory, publicKey: configured ? owner.publicKey.export({ format: "pem", type: "spki" }).toString() : "" });
	writeFileSync(join(directory, ".gitignore"), ".work/\ndist/\n");
	execFileSync("git", ["init", "--quiet"], { cwd: directory });
	execFileSync("git", ["add", ...files, ".gitignore"], { cwd: directory });
	execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: directory });
	const runtime = JSON.parse(readFileSync(join(directory, "runtime-source.json")));
	mkdirSync(join(directory, ".work/runtime"), { recursive: true });
	writeFileSync(join(directory, ".work/runtime/UPSTREAM_SOURCE.json"), JSON.stringify(runtime));
	writeFileSync(join(directory, ".work/runtime/RUNTIME_STAMP"), `${runtime.runtimeStamp}\n`);
	const dist = join(directory, "dist", forkConfiguration(directory).version);
	mkdirSync(dist, { recursive: true });
	for (const name of linuxReleaseFiles.filter((file) => file.includes(".tar."))) writeFileSync(join(dist, name), `fixture: ${name}`);
	const tag = `bolt-v${forkConfiguration(directory).version}`;
	const metadata = prepareForkRelease({ root: directory, dir: dist, tag, workflowCommit: "a".repeat(40) });
	return { directory, dist, owner, tag, metadata };
}

test("missing fork key fails closed and the upstream runtime key cannot become the fork key", (t) => {
	const { directory } = fixture(t, false);
	assert.equal(synchronizeForkRelease({ root: directory, check: true }).keyFingerprint, null);
	assert.throws(() => synchronizeForkRelease({ root: directory, check: true, requireKey: true }), /not configured/);
	const upstream = readFileSync(join(root, "keys/upstream-runtime.pub"), "utf8");
	assert.throws(() => publicKeyFields(upstream, upstream), /cannot sign fork releases/);
	const result = spawnSync("sh", [join(directory, "install.sh")], { encoding: "utf8", env: { ...process.env, HOME: directory } });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /fork release signing key is not configured/);
});

test("supplied public keys are synchronized and both fork signature formats verify", (t) => {
	const { directory, dist, owner, tag, metadata } = fixture(t);
	const fields = publicKeyFields(owner.publicKey.export({ format: "pem", type: "spki" }).toString(), readFileSync(join(root, "keys/upstream-runtime.pub"), "utf8"));
	assert.equal(fields.ssh, sshPublicKey(fields.pem));
	const sums = readFileSync(join(dist, "SHA256SUMS"));
	writeFileSync(join(dist, "SHA256SUMS.sig"), sign(null, sums, owner.privateKey));
	writeFileSync(join(dist, "SHA256SUMS.sshsig"), signSshRelease(owner.privateKey, sums));
	assert.equal(verifyForkRelease({ root: directory, dir: dist, tag, commit: metadata.commit, requireKey: true, requireClean: true, signature: true }).fileCount, 13);
	const wrong = generateKeyPairSync("ed25519");
	writeFileSync(join(dist, "SHA256SUMS.sig"), sign(null, sums, wrong.privateKey));
	assert.throws(() => verifyForkRelease({ root: directory, dir: dist, tag, signature: true }), /signature does not verify/);
});

test("candidate verification rejects tampering, extra files, dirty sources and mismatched tags", (t) => {
	const { directory, dist, tag } = fixture(t);
	verifyForkRelease({ root: directory, dir: dist, tag, requireClean: true });
	assert.throws(() => verifyForkRelease({ root: directory, dir: dist, tag: "bolt-v1.9.0-message" }), /exactly match VERSION/);
	writeFileSync(join(dist, "unexpected"), "extra");
	assert.throws(() => verifyForkRelease({ root: directory, dir: dist, tag }), /unexpected release file/);
	rmSync(join(dist, "unexpected"));
	writeFileSync(join(dist, "pi-bolt-linux-x64.tar.xz"), "tampered");
	assert.throws(() => verifyForkRelease({ root: directory, dir: dist, tag }), /checksum mismatch/);
	prepareForkRelease({ root: directory, dir: dist, tag });
	writeFileSync(join(directory, "unreviewed.txt"), "dirty");
	prepareForkRelease({ root: directory, dir: dist, tag });
	assert.throws(() => verifyForkRelease({ root: directory, dir: dist, tag, requireClean: true }), /dirty source/);
});

function runtimeFixture(t, change = {}) {
	const directory = temporary(t);
	for (const name of ["scripts/fetch-runtime.sh", "scripts/lib/common.sh"]) {
		mkdirSync(dirname(join(directory, name)), { recursive: true });
		copyFileSync(join(root, name), join(directory, name));
	}
	const server = join(directory, "server");
	mkdirSync(server);
	const staged = join(directory, "staged/pi-bolt-runtime-linux-x64");
	mkdirSync(staged, { recursive: true });
	writeFileSync(join(staged, "bun"), "#!/bin/sh\nprintf '1.4.3\\n'\n", { mode: 0o755 });
	const archive = "pi-bolt-runtime-linux-x64.tar.gz";
	execFileSync("tar", ["-czf", join(server, archive), "-C", dirname(staged), basename(staged)]);
	const stamp = "2e54e6641c78fd6d";
	writeFileSync(join(server, "RUNTIME_STAMP"), `${change.badStamp ? "0".repeat(16) : stamp}\n`);
	const upstream = generateKeyPairSync("ed25519");
	const sums = Buffer.from(`# pi-bolt ${change.badVersion ? "1.0.8" : "1.0.9"}\n${sha(readFileSync(join(server, archive)))}  ${archive}\n${sha(readFileSync(join(server, "RUNTIME_STAMP")))}  RUNTIME_STAMP\n`);
	const signature = sign(null, sums, upstream.privateKey);
	writeFileSync(join(server, "SHA256SUMS"), sums);
	writeFileSync(join(server, "SHA256SUMS.sig"), signature);
	mkdirSync(join(directory, "keys"));
	const accepted = change.wrongKey ? generateKeyPairSync("ed25519").publicKey : upstream.publicKey;
	writeFileSync(join(directory, "keys/upstream-runtime.pub"), accepted.export({ format: "pem", type: "spki" }));
	writeFileSync(join(directory, "keys/release.pub"), "");
	const config = { repository: "opensec-git/Pi-Bolt", tag: "bolt-v1.0.9", publicKey: "keys/upstream-runtime.pub",
		runtimeStamp: stamp, bunVersion: "1.4.3", checksumsSha256: sha(sums), signatureSha256: sha(signature),
		attestation: { signerWorkflow: "opensec-git/Pi-Bolt/.github/workflows/release.yml", sourceRef: "refs/tags/bolt-v1.0.9",
			sourceCommit: "739424a30d14afabc423ea1706f0f11c702eca9d" },
		archives: { "linux-x64": change.wrongArchive ? "0".repeat(64) : sha(readFileSync(join(server, archive))) } };
	writeFileSync(join(directory, "runtime-source.json"), JSON.stringify(config));
	writeFileSync(join(directory, "scripts/runtime-stamp.sh"), `#!/bin/sh\nprintf '${stamp}\\n'\n`, { mode: 0o755 });
	mkdirSync(join(directory, "mock-bin"));
	writeFileSync(join(directory, "mock-bin/curl"), '#!/usr/bin/env python3\nimport os,pathlib,shutil,sys\nargs=sys.argv[1:]\nshutil.copyfile(pathlib.Path(os.environ["MOCK_RUNTIME_SERVER"])/args[-1].rsplit("/",1)[-1],args[args.index("-o")+1])\n', { mode: 0o755 });
	writeFileSync(join(directory, "mock-bin/gh"), `#!/usr/bin/env python3
import os,pathlib,sys
args=sys.argv[1:]
if args[0] == "api":
 assert args[1:3] == ["--method", "GET"]
 assert args[3].startswith("repos/opensec-git/Pi-Bolt/attestations/sha256:")
 print("{}")
 sys.exit(0)
assert args[:2] == ["attestation", "verify"]
for flag,value in [("--repo","opensec-git/Pi-Bolt"),("--signer-workflow","opensec-git/Pi-Bolt/.github/workflows/release.yml"),("--source-ref","refs/tags/bolt-v1.0.9"),("--source-digest","739424a30d14afabc423ea1706f0f11c702eca9d")]:
 assert args[args.index(flag)+1] == value
assert "--deny-self-hosted-runners" in args
assert pathlib.Path(args[args.index("--bundle")+1]).read_text().strip() == "{}"
pathlib.Path(os.environ["MOCK_RUNTIME_SERVER"], "attestation-checked").touch()
sys.exit(int(os.environ.get("MOCK_BAD_ATTESTATION", "0")))
`, { mode: 0o755 });
	mkdirSync(join(directory, ".work/runtime"), { recursive: true });
	writeFileSync(join(directory, ".work/runtime/bun"), "old runtime");
	return { directory, config, env: { ...process.env, MOCK_RUNTIME_SERVER: server, MOCK_BAD_ATTESTATION: change.badAttestation ? "1" : "0", PATH: `${join(directory, "mock-bin")}:${process.env.PATH}` } };
}

test("locked runtime requires upstream signatures, provenance, exact version, archive pin and signed stamp before replacing a runtime", (t) => {
	for (const change of [{ wrongKey: true }, { wrongArchive: true }, { badStamp: true }, { badVersion: true }, { badAttestation: true }]) {
		const { directory, env } = runtimeFixture(t, change);
		const result = spawnSync("bash", [join(directory, "scripts/fetch-runtime.sh"), "--locked"], { env, encoding: "utf8" });
		assert.notEqual(result.status, 0, JSON.stringify(change));
		assert.equal(readFileSync(join(directory, ".work/runtime/bun"), "utf8"), "old runtime");
		assert.equal(existsSync(join(directory, ".work/runtime/UPSTREAM_SOURCE.json")), false);
	}
	const { directory, env, config } = runtimeFixture(t);
	const result = spawnSync("bash", [join(directory, "scripts/fetch-runtime.sh"), "--locked"], { env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(existsSync(join(env.MOCK_RUNTIME_SERVER, "attestation-checked")));
	assert.deepEqual(JSON.parse(readFileSync(join(directory, ".work/runtime/UPSTREAM_SOURCE.json"))), config);
	assert.match(readFileSync(join(directory, ".work/runtime/bun"), "utf8"), /1\.4\.3/);
});

test("Linux installer accepts only the fork signature and never falls back to upstream npm", async (t) => {
	const { directory, owner } = fixture(t);
	const staged = join(directory, "installer-stage/pi-bolt-linux-x64-baseline");
	mkdirSync(staged, { recursive: true });
	writeFileSync(join(staged, "pi"), "#!/bin/sh\necho '1.4.0 (Pi-Bolt 1.0.10, linux-x64-baseline, JIT off)'\n", { mode: 0o755 });
	const tarball = join(directory, "installer.tar.gz");
	execFileSync("tar", ["-czf", tarball, "-C", dirname(staged), basename(staged)]);
	const archive = "pi-bolt-linux-x64-baseline.tar.gz";
	const sums = Buffer.from(`# pi-bolt 1.0.10\n${sha(readFileSync(tarball))}  ${archive}\n`);
	let signature = sign(null, sums, owner.privateKey);
	const requests = [];
	const server = createServer((req, res) => {
		requests.push(req.url);
		const files = { [archive]: readFileSync(tarball), SHA256SUMS: sums, "SHA256SUMS.sig": signature };
		const data = files[req.url.slice(1)];
		if (!data) { res.writeHead(404); res.end(); return; }
		res.writeHead(200, { "content-length": data.length });
		res.end(req.method === "HEAD" ? undefined : data);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const base = `http://127.0.0.1:${server.address().port}`;
	async function install(destination) {
		const child = spawn("sh", [join(directory, "install.sh")], { env: { ...process.env, HOME: directory,
			PIBOLT_VERSION: "bolt-v1.0.10", PIBOLT_VARIANT: "x64-baseline", PIBOLT_SOURCE: "auto", PIBOLT_LAUNCHER: "1",
			PIBOLT_INSTALL: destination, PIBOLT_DOWNLOAD_BASE: base, PIBOLT_NPM_REGISTRY: `${base}/forbidden-npm`, PIBOLT_CONNECTIONS: "1",
			PIBOLT_UNVERIFIED: sha(sums) }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (part) => { output += part; });
		child.stderr.on("data", (part) => { output += part; });
		const status = await new Promise((resolve) => child.on("close", resolve));
		return { status, output };
	}
	const accepted = join(directory, "installed-valid");
	const positive = await install(accepted);
	assert.equal(positive.status, 0, positive.output);
	assert.ok(existsSync(join(accepted, "pi-bolt-linux-x64-baseline/pi")));
	signature = sign(null, sums, generateKeyPairSync("ed25519").privateKey);
	const rejected = await install(join(directory, "installed-wrong-signature"));
	assert.notEqual(rejected.status, 0);
	assert.match(rejected.output, /signature does not verify/);
	assert.ok(requests.every((path) => !path.includes("forbidden-npm")));
});

test("production workflow defaults to candidates and isolates signing from build and inherited upstream publication", () => {
	const workflow = parse(readFileSync(join(root, ".github/workflows/fork-release.yml"), "utf8"));
	assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
	assert.deepEqual(workflow.jobs.build.permissions, { contents: "read" });
	assert.doesNotMatch(JSON.stringify(workflow.jobs.build), /secrets\./);
	assert.equal(workflow.jobs.publish.environment, "release");
	assert.deepEqual(workflow.jobs.publish.needs, ["build", "attest"]);
	assert.equal(workflow.jobs.attest.permissions["id-token"], "write");
	assert.equal(workflow.jobs.attest.permissions.attestations, "write");
	assert.equal(workflow.jobs.attest.permissions.contents, "read");
	assert.doesNotMatch(JSON.stringify(workflow.jobs.attest), /secrets\./);
	assert.match(JSON.stringify(workflow.jobs.attest), /actions\/attest-build-provenance@/);
	assert.match(workflow.jobs.publish.if, /refs\/heads\/pi-bolt/);
	assert.match(workflow.jobs.build.if, /!endsWith.*-message/);
	const publisher = JSON.stringify(workflow.jobs.publish);
	assert.match(publisher, /--verify-tag/);
	assert.match(publisher, /--require-clean/);
	assert.match(publisher, /git merge-base --is-ancestor/);
	assert.match(publisher, /gh attestation verify release\/SHA256SUMS/);
	assert.match(publisher, /--source-digest/);
	assert.doesNotMatch(publisher, /--clobber|gh release (?:edit|upload|delete)|npm publish|publish-installer/);
	for (const [file, jobs] of [["release.yml", ["prepare", "draft"]], ["publish.yml", ["verify"]], ["tag.yml", ["tag"]]]) {
		const inherited = parse(readFileSync(join(root, ".github/workflows", file), "utf8"));
		for (const job of jobs) assert.match(inherited.jobs[job].if, /github\.repository == 'opensec-git\/Pi-Bolt'/);
	}
	const ci = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
	for (const job of Object.values(ci.jobs)) assert.match(job.if, /github\.repository == 'opensec-git\/Pi-Bolt'/);
});
