import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runSingleAgent, getFinalOutput } = await jiti.import("../src/run.ts");

class FakeProcess extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kills = [];
	kill(signal) {
		this.kills.push(signal);
		return true;
	}
	close(code = 0) {
		this.emit("close", code);
	}
}

const agent = { name: "scout", description: "Scout", source: "user", systemPrompt: "", filePath: "/tmp/scout.md" };

function message(text) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, cost: { total: 0.001 }, totalTokens: 16 },
		model: "model-a",
		stopReason: "end_turn",
	};
}

function startRun(fake, extra = {}) {
	return runSingleAgent({
		defaultCwd: process.cwd(),
		agents: [agent],
		agentName: "scout",
		task: "do work",
		makeDetails: (results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		spawner: () => fake,
		...extra,
	});
}

test("getFinalOutput preserves all text parts from the final assistant message", () => {
	const messages = [
		message("older output"),
		{
			role: "assistant",
			content: [
				{ type: "text", text: "first part" },
				{ type: "tool_use", id: "tool-1", name: "read", args: { path: "README.md" } },
				{ type: "text", text: "second part" },
			],
		},
	];

	assert.equal(getFinalOutput(messages), "first part\n\nsecond part");
});

test("parses partial JSON lines, ignores malformed events, and aggregates usage", async () => {
	const fake = new FakeProcess();
	const promise = startRun(fake);
	setImmediate(() => {
		fake.stdout.emit("data", "not json\n");
		const line = JSON.stringify({ type: "message_end", message: message("done") }) + "\n";
		fake.stdout.emit("data", line.slice(0, 20));
		fake.stdout.emit("data", line.slice(20));
		fake.close(0);
	});

	const result = await promise;
	assert.equal(result.exitCode, 0);
	assert.equal(getFinalOutput(result.messages), "done");
	assert.equal(result.usage.input, 10);
	assert.equal(result.usage.output, 3);
	assert.match(result.stderr, /Ignored malformed JSON/);
});

test("emits partial updates as running until the child closes", async () => {
	const fake = new FakeProcess();
	const seenExitCodes = [];
	const promise = startRun(fake, {
		onUpdate: (partial) => seenExitCodes.push(partial.details.results[0].exitCode),
	});
	setImmediate(() => {
		fake.stdout.emit("data", JSON.stringify({ type: "message_end", message: message("working") }) + "\n");
		fake.close(0);
	});

	const result = await promise;
	assert.deepEqual(seenExitCodes, [-1]);
	assert.equal(result.exitCode, 0);
});

test("ingests tool_result_end messages without counting assistant usage", async () => {
	const fake = new FakeProcess();
	const toolMessage = {
		role: "assistant",
		content: [{ type: "text", text: "tool result captured" }],
		model: "model-tool",
	};
	const promise = startRun(fake);
	setImmediate(() => {
		fake.stdout.emit("data", JSON.stringify({ type: "tool_result_end", message: toolMessage }) + "\n");
		fake.close(0);
	});

	const result = await promise;
	assert.equal(result.exitCode, 0);
	assert.equal(result.messages.length, 1);
	assert.equal(getFinalOutput(result.messages), "tool result captured");
	assert.equal(result.usage.turns, 0);
	assert.equal(result.usage.input, 0);
});

test("force-kills a process that hangs after agent_end but keeps the final result", async () => {
	const fake = new FakeProcess();
	const promise = startRun(fake, { agentEndGraceMs: 5, agentEndForceKillMs: 5 });
	setImmediate(() => {
		fake.stdout.emit("data", JSON.stringify({ type: "message_end", message: message("final") }) + "\n");
		fake.stdout.emit("data", JSON.stringify({ type: "agent_end" }) + "\n");
	});

	const result = await promise;
	assert.equal(result.exitCode, 0);
	assert.equal(getFinalOutput(result.messages), "final");
	assert.deepEqual(fake.kills, ["SIGTERM", "SIGKILL"]);
	assert.match(result.stderr, /force-killed after final result/);
});

test("honors injected timer scheduling for agent_end cleanup", async () => {
	const fake = new FakeProcess();
	const timers = [];
	const schedule = (fn, ms) => {
		const timer = { fn, ms, unref() {} };
		timers.push(timer);
		return timer;
	};
	const promise = startRun(fake, { now: schedule, agentEndGraceMs: 10, agentEndForceKillMs: 20 });
	setImmediate(() => {
		fake.stdout.emit("data", JSON.stringify({ type: "message_end", message: message("final") }) + "\n");
		fake.stdout.emit("data", JSON.stringify({ type: "agent_end" }) + "\n");
	});

	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(timers.length, 1);
	assert.equal(timers[0].ms, 10);
	timers[0].fn();
	assert.deepEqual(fake.kills, ["SIGTERM"]);
	assert.equal(timers.length, 2);
	assert.equal(timers[1].ms, 20);
	timers[1].fn();

	const result = await promise;
	assert.equal(result.exitCode, 0);
	assert.equal(getFinalOutput(result.messages), "final");
	assert.deepEqual(fake.kills, ["SIGTERM", "SIGKILL"]);
});

test("honors injected timer scheduling for abort fallback", async () => {
	const fake = new FakeProcess();
	const timers = [];
	const schedule = (fn, ms) => {
		const timer = { fn, ms, unref() {} };
		timers.push(timer);
		return timer;
	};
	const controller = new AbortController();
	const promise = startRun(fake, { signal: controller.signal, abortForceKillMs: 30, now: schedule });

	controller.abort();
	assert.deepEqual(fake.kills, ["SIGTERM"]);
	assert.equal(timers.length, 1);
	assert.equal(timers[0].ms, 30);
	timers[0].fn();

	await assert.rejects(promise, /Subagent was aborted/);
	assert.deepEqual(fake.kills, ["SIGTERM", "SIGKILL"]);
});

test("handles subprocess spawn errors", async () => {
	const fake = new FakeProcess();
	const promise = startRun(fake);
	setImmediate(() => fake.emit("error", new Error("spawn failed")));
	const result = await promise;
	assert.equal(result.exitCode, 1);
	assert.match(result.stderr, /spawn failed/);
});

test("aborts with SIGTERM then SIGKILL when the child does not close", async () => {
	const fake = new FakeProcess();
	const controller = new AbortController();
	const promise = startRun(fake, { signal: controller.signal, abortForceKillMs: 5 });
	setImmediate(() => controller.abort());
	await assert.rejects(promise, /Subagent was aborted/);
	assert.deepEqual(fake.kills, ["SIGTERM", "SIGKILL"]);
});

test("caps stderr output", async () => {
	const fake = new FakeProcess();
	const promise = startRun(fake, { maxStderrBytes: 40 });
	setImmediate(() => {
		fake.stderr.emit("data", "x".repeat(200));
		fake.close(1);
	});
	const result = await promise;
	assert.equal(result.exitCode, 1);
	assert.match(result.stderr, /truncated after 40 bytes/);
});
