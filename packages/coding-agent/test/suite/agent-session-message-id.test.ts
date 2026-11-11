import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { QueueUpdateTracking } from "../../src/core/agent-session.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

function latch() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function blockedResponse(text = "first response") {
	const started = latch();
	const released = latch();
	const response: FauxResponseFactory = async () => {
		started.release();
		await released.promise;
		return fauxAssistantMessage(text);
	};
	return { response, started: started.promise, release: released.release };
}

function tracking(harness: Harness): QueueUpdateTracking[] {
	return harness.eventsOfType("queue_update").flatMap((event) => (event.tracking ? [event.tracking] : []));
}

function consumedIds(harness: Harness): readonly (string | null)[][] {
	return tracking(harness).flatMap(({ change }) => (change.reason === "consume" ? [[...change.messageIds]] : []));
}

describe("AgentSession input IDs", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("keeps legacy queue snapshots and does not add a prompt queue event without IDs", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.steer("queued");
		expect(harness.eventsOfType("queue_update")).toEqual([
			{ type: "queue_update", steering: ["queued"], followUp: [] },
		]);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("initial");
		expect(harness.eventsOfType("queue_update")).toEqual([
			{ type: "queue_update", steering: ["queued"], followUp: [] },
			{ type: "queue_update", steering: [], followUp: [] },
		]);
	});

	it.each([
		{ source: "steer", mode: "all" },
		{ source: "steer", mode: "one-at-a-time" },
		{ source: "followUp", mode: "all" },
		{ source: "followUp", mode: "one-at-a-time" },
	] as const)("reports $source $mode drains in order after the previous turn", async ({ source, mode }) => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.steeringMode = mode;
		harness.session.agent.followUpMode = mode;
		const blocked = blockedResponse();
		harness.setResponses([
			blocked.response,
			fauxAssistantMessage("next response"),
			...(mode === "one-at-a-time" ? [fauxAssistantMessage("last response")] : []),
		]);
		const run = harness.session.prompt("initial", { messageId: "A" });
		await blocked.started;
		try {
			await harness.session[source]("same text", undefined, { messageId: "B" });
			await harness.session[source]("same text", undefined, { messageId: "C" });
			expect(consumedIds(harness)).toEqual([]);
			expect(harness.session.pendingMessageCount).toBe(2);
		} finally {
			blocked.release();
		}
		await run;

		expect(consumedIds(harness)).toEqual(mode === "all" ? [["B", "C"]] : [["B"], ["C"]]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(getUserTexts(harness)).toEqual(["initial", "same text", "same text"]);
		const updates = tracking(harness);
		expect(updates.map((update) => update.sequence)).toEqual(updates.map((_, index) => index + 1));
		const batches = updates.filter((update) => update.batchId !== undefined);
		expect(new Set(batches.map((update) => update.batchId)).size).toBe(batches.length);
		const consumeIndex = harness.events.findIndex(
			(event) => event.type === "queue_update" && event.tracking?.change.reason === "consume",
		);
		expect(harness.events.slice(0, consumeIndex).some((event) => event.type === "turn_end")).toBe(true);
		expect(
			harness.events
				.slice(0, consumeIndex)
				.filter((event) => event.type === "message_start" && event.message.role === "user"),
		).toHaveLength(1);
		expect(harness.events.at(-1)).toEqual({ type: "agent_settled", aborted: false });
	});

	it("correlates transformed and image-only inputs without putting IDs in requests or history", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) =>
						event.text === "original" ? { action: "transform", text: "transformed" } : { action: "continue" },
					);
				},
			],
		});
		harnesses.push(harness);
		await harness.session.steer("original", undefined, { messageId: "private-transform-id" });
		await harness.session.followUp(
			"",
			[
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
					mimeType: "image/png",
				},
			],
			{ messageId: "private-image-id" },
		);
		const requests: string[] = [];
		const response: FauxResponseFactory = (context) => {
			requests.push(JSON.stringify(context));
			return fauxAssistantMessage("done");
		};
		harness.setResponses([response, response]);
		await harness.session.prompt("start", { messageId: "private-prompt-id" });
		expect(consumedIds(harness)).toEqual([["private-transform-id"], ["private-image-id"]]);
		expect(getUserTexts(harness)).toEqual(["start", "transformed", ""]);
		expect(tracking(harness).find((update) => update.change.reason === "prompt_start")?.change).toEqual({
			reason: "prompt_start",
			source: "prompt",
			messageIds: [null, "private-prompt-id"],
		});
		for (const serialized of [...requests, JSON.stringify(harness.sessionManager.getEntries())]) {
			expect(serialized).not.toContain("private-");
			expect(serialized).not.toContain("message_id");
			expect(serialized).not.toContain("messageId");
		}
	});

	it("reports continue's direct steering drain once, then the follow-up drain", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("start", { messageId: "A" });
		await harness.session.steer("steer", undefined, { messageId: "B" });
		await harness.session.followUp("follow", undefined, { messageId: "C" });
		harness.setResponses([fauxAssistantMessage("steered"), fauxAssistantMessage("followed")]);
		await harness.session.agent.continue();
		expect(consumedIds(harness)).toEqual([["B"], ["C"]]);
	});

	it("can report two drains before one provider request on the follow-up continue path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("start", { messageId: "A" });
		await harness.session.followUp("follow", undefined, { messageId: "B" });
		let enqueue: Promise<unknown> | undefined;
		harness.session.subscribe((event) => {
			if (event.type !== "queue_update" || event.tracking?.change.reason !== "consume") return;
			if (event.tracking.change.messageIds.includes("B")) {
				enqueue = harness.session.steer("steer", undefined, { messageId: "C" });
			}
		});
		harness.setResponses([
			(context) => {
				expect(context.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
					"start",
					"follow",
					"steer",
				]);
				return fauxAssistantMessage("both inputs");
			},
		]);
		await harness.session.agent.continue();
		await enqueue;
		expect(consumedIds(harness)).toEqual([["B"], ["C"]]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("clears identified and unidentified inputs without reporting consumption", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.steer("legacy");
		await harness.session.steer("same", undefined, { messageId: "B" });
		await harness.session.followUp("same", undefined, { messageId: "C" });
		expect(harness.session.clearQueue()).toEqual({ steering: ["legacy", "same"], followUp: ["same"] });
		expect(tracking(harness).at(-1)?.change).toEqual({
			reason: "clear",
			messageIds: { steering: [null, "B"], followUp: ["C"] },
		});
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(consumedIds(harness)).toEqual([]);
	});

	it("observes direct agent clears and resets as removals", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.steer("steer", undefined, { messageId: "B" });
		await harness.session.followUp("follow", undefined, { messageId: "C" });
		harness.session.agent.clearSteeringQueue();
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(tracking(harness).at(-1)?.change).toEqual({
			reason: "clear",
			messageIds: { steering: ["B"], followUp: [] },
		});
		harness.session.agent.reset();
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(tracking(harness).at(-1)?.change).toEqual({
			reason: "clear",
			messageIds: { steering: [], followUp: ["C"] },
		});
		expect(consumedIds(harness)).toEqual([]);
	});

	it("reports A then a B/C batch then D, using queue drain time", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.followUpMode = "all";
		const first = blockedResponse("reply A");
		const second = blockedResponse("reply B/C");
		harness.setResponses([first.response, second.response, fauxAssistantMessage("reply D")]);
		const run = harness.session.prompt("A", { messageId: "A" });
		await first.started;
		await harness.session.followUp("B", undefined, { messageId: "B" });
		await harness.session.followUp("C", undefined, { messageId: "C" });
		first.release();
		await second.started;
		await harness.session.followUp("D", undefined, { messageId: "D" });
		expect(consumedIds(harness)).toEqual([["B", "C"]]);
		second.release();
		await run;
		expect(consumedIds(harness)).toEqual([["B", "C"], ["D"]]);
		const boundaries = harness.events.flatMap((event) => {
			if (event.type === "queue_update" && event.tracking?.change.reason === "consume") {
				return [`consume:${event.tracking.change.messageIds.join(",")}`];
			}
			return event.type === "message_end" && event.message.role === "assistant"
				? [getMessageText(event.message)]
				: [];
		});
		expect(boundaries).toEqual(["reply A", "consume:B,C", "reply B/C", "consume:D", "reply D"]);
	});

	it.each(["steer", "followUp"] as const)("waits for tools before consuming %s", async (source) => {
		const started = latch();
		const released = latch();
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait until released",
			parameters: Type.Object({}),
			execute: async () => {
				started.release();
				await released.promise;
				return { content: [{ type: "text", text: "tool finished" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const hasB = context.messages.some((message) => message.role === "user" && getMessageText(message) === "B");
				expect(hasB).toBe(source === "steer");
				return fauxAssistantMessage("original work finished");
			},
			...(source === "followUp" ? [fauxAssistantMessage("follow-up finished")] : []),
		]);
		const run = harness.session.prompt("A", { messageId: "A" });
		await started.promise;
		try {
			await harness.session[source]("B", undefined, { messageId: "B" });
			expect(consumedIds(harness)).toEqual([]);
		} finally {
			released.release();
		}
		await run;
		expect(consumedIds(harness)).toEqual([["B"]]);
		const consumeIndex = harness.events.findIndex(
			(event) => event.type === "queue_update" && event.tracking?.change.reason === "consume",
		);
		expect(harness.events.findIndex((event) => event.type === "tool_execution_end")).toBeLessThan(consumeIndex);
	});

	it("commits enqueue before notification and preserves sequence during reentrant clear", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type !== "queue_update" || event.tracking?.change.reason !== "enqueue") return;
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
			expect(harness.session.clearQueue()).toEqual({ steering: ["queued"], followUp: [] });
		});
		const sequences: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "queue_update" && event.tracking) sequences.push(event.tracking.sequence);
		});
		await harness.session.steer("queued", undefined, { messageId: "B" });
		expect(sequences).toEqual([1, 2]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(consumedIds(harness)).toEqual([]);
	});

	it("does not clear a drained input when a consumption listener clears the remaining queue", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const blocked = blockedResponse();
		harness.setResponses([blocked.response, fauxAssistantMessage("B response")]);
		const run = harness.session.prompt("initial", { messageId: "A" });
		await blocked.started;
		await harness.session.steer("B input", undefined, { messageId: "B" });
		await harness.session.steer("C input", undefined, { messageId: "C" });
		harness.session.subscribe((event) => {
			if (event.type !== "queue_update" || event.tracking?.change.reason !== "consume") return;
			expect(harness.session.clearQueue()).toEqual({ steering: ["C input"], followUp: [] });
		});
		blocked.release();
		await run;
		expect(consumedIds(harness)).toEqual([["B"]]);
		expect(getUserTexts(harness)).toEqual(["initial", "B input"]);
	});

	it("keeps unconsumed inputs on abort and reports them only when explicitly cleared", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const blocked = blockedResponse();
		harness.setResponses([blocked.response]);
		const run = harness.session.prompt("initial", { messageId: "A" });
		await blocked.started;
		await harness.session.followUp("queued", undefined, { messageId: "B" });
		const aborted = harness.session.abort();
		blocked.release();
		await Promise.all([run, aborted]);
		expect(consumedIds(harness)).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual(["queued"]);
		expect(harness.events.at(-1)).toEqual({ type: "agent_settled", aborted: true });
		harness.session.clearQueue();
		expect(tracking(harness).at(-1)?.change).toEqual({
			reason: "clear",
			messageIds: { steering: [], followUp: ["B"] },
		});
	});

	it("does not repeat the initial handoff when automatically retrying", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("retry", { messageId: "A" });
		expect(harness.faux.state.callCount).toBe(2);
		expect(tracking(harness).filter((update) => update.change.reason === "prompt_start")).toHaveLength(1);
		expect(consumedIds(harness)).toEqual([]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.events.at(-1)).toEqual({ type: "agent_settled", aborted: false });
	});

	it("reports a drain even when next-turn preparation fails before a provider request", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false }, compaction: { enabled: false } } });
		harnesses.push(harness);
		const blocked = blockedResponse();
		harness.setResponses([blocked.response]);
		const run = harness.session.prompt("initial", { messageId: "A" });
		await blocked.started;
		await harness.session.steer("queued", undefined, { messageId: "B" });
		harness.session.agent.prepareNextTurnWithContext = () => {
			throw new Error("preparation failed");
		};
		blocked.release();
		await run;
		expect(consumedIds(harness)).toEqual([["B"]]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.faux.state.callCount).toBe(1);
		expect(getUserTexts(harness)).toEqual(["initial"]);
		expect(harness.eventsOfType("message_end").at(-1)?.message).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "preparation failed",
		});
	});

	it("does not activate handled or rejected prompts", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => (event.text === "handled" ? { action: "handled" } : { action: "continue" }));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.prompt("handled", { messageId: "handled-id" });
		await expect(harness.session.prompt("rejected", { messageId: "rejected-id" })).rejects.toThrow("No API key");
		expect(harness.eventsOfType("queue_update")).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});
});
