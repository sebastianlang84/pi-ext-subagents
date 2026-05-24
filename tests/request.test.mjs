import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeSubagentRequest, RequestValidationError } = await jiti.import("../src/request.ts");

test("normalizes single, parallel, and chain requests", () => {
	assert.deepEqual(normalizeSubagentRequest({ agent: "reviewer", task: "check" }), {
		mode: "single",
		agentScope: "global",
		confirmProjectAgents: true,
		steps: [{ agent: "reviewer", task: "check", cwd: undefined }],
	});

	assert.equal(normalizeSubagentRequest({ tasks: [{ agent: "a", task: "x" }] }).mode, "parallel");
	assert.deepEqual(normalizeSubagentRequest({ chain: [{ agent: "a", task: "x" }] }).steps[0].step, 1);
});

test("normalizes preferred agentScope names and legacy aliases", () => {
	assert.equal(normalizeSubagentRequest({ agent: "a", task: "x", agentScope: "global" }).agentScope, "global");
	assert.equal(normalizeSubagentRequest({ agent: "a", task: "x", agentScope: "repo" }).agentScope, "repo");
	assert.equal(normalizeSubagentRequest({ agent: "a", task: "x", agentScope: "global+repo" }).agentScope, "global+repo");
	assert.equal(normalizeSubagentRequest({ agent: "a", task: "x", agentScope: "user" }).agentScope, "global");
	assert.equal(normalizeSubagentRequest({ agent: "a", task: "x", agentScope: "project" }).agentScope, "repo");
	assert.equal(normalizeSubagentRequest({ agent: "a", task: "x", agentScope: "both" }).agentScope, "global+repo");
});

test("normalizes optional per-task runtime controls", () => {
	assert.deepEqual(normalizeSubagentRequest({ agent: "reviewer", task: "check", timeoutMs: 1000, maxOutputChars: 80, outputMode: "summary" }).steps[0], {
		agent: "reviewer",
		task: "check",
		cwd: undefined,
		timeoutMs: 1000,
		maxOutputChars: 80,
		outputMode: "summary",
	});

	assert.deepEqual(normalizeSubagentRequest({ tasks: [{ agent: "a", task: "x", timeoutMs: 5 }] }).steps[0].timeoutMs, 5);
	assert.deepEqual(normalizeSubagentRequest({ chain: [{ agent: "a", task: "x", outputMode: "full" }] }).steps[0].outputMode, "full");
});

test("applies top-level cwd and runtime controls as parallel and chain defaults", () => {
	assert.deepEqual(
		normalizeSubagentRequest({
			cwd: "/repo",
			timeoutMs: 1000,
			maxOutputChars: 80,
			outputMode: "summary",
			tasks: [
				{ agent: "a", task: "x" },
				{ agent: "b", task: "y", cwd: "/other", timeoutMs: 5, outputMode: "full" },
			],
		}).steps,
		[
			{ agent: "a", task: "x", cwd: "/repo", timeoutMs: 1000, maxOutputChars: 80, outputMode: "summary" },
			{ agent: "b", task: "y", cwd: "/other", timeoutMs: 5, maxOutputChars: 80, outputMode: "full" },
		],
	);

	assert.deepEqual(
		normalizeSubagentRequest({ cwd: "/repo", maxOutputChars: 20, chain: [{ agent: "a", task: "x" }] }).steps[0],
		{ agent: "a", task: "x", cwd: "/repo", maxOutputChars: 20, step: 1 },
	);
});

test("rejects mixed modes, empty tasks, and incomplete single mode consistently", () => {
	for (const params of [
		{ agent: "a", task: "x", tasks: [{ agent: "b", task: "y" }] },
		{ tasks: [] },
		{ chain: [] },
		{ agent: "a" },
		{ task: "x" },
		{},
	]) {
		assert.throws(() => normalizeSubagentRequest(params), RequestValidationError);
	}
});

test("rejects invalid task invariants", () => {
	assert.throws(() => normalizeSubagentRequest({ tasks: [{ agent: "", task: "x" }] }), /agent/);
	assert.throws(() => normalizeSubagentRequest({ tasks: [{ agent: "a", task: "   " }] }), /task/);
	assert.throws(() => normalizeSubagentRequest({ tasks: Array.from({ length: 9 }, (_, i) => ({ agent: `a${i}`, task: "x" })) }), /Too many/);
});

test("rejects invalid agentScope and whitespace cwd values", () => {
	assert.throws(() => normalizeSubagentRequest({ agent: "a", task: "x", agentScope: "workspace" }), /agentScope/);
	assert.throws(() => normalizeSubagentRequest({ agent: "a", task: "x", cwd: "   " }), /single\.cwd/);
	assert.throws(() => normalizeSubagentRequest({ tasks: [{ agent: "a", task: "x", cwd: "\n" }] }), /tasks\[0\]\.cwd/);
	assert.throws(() => normalizeSubagentRequest({ chain: [{ agent: "a", task: "x", cwd: "\t" }] }), /chain\[0\]\.cwd/);
});

test("rejects invalid runtime controls", () => {
	assert.throws(() => normalizeSubagentRequest({ agent: "a", task: "x", timeoutMs: 0 }), /single\.timeoutMs/);
	assert.throws(() => normalizeSubagentRequest({ agent: "a", task: "x", timeoutMs: 2_147_483_648 }), /single\.timeoutMs/);
	assert.throws(() => normalizeSubagentRequest({ agent: "a", task: "x", maxOutputChars: -1 }), /single\.maxOutputChars/);
	assert.throws(() => normalizeSubagentRequest({ agent: "a", task: "x", outputMode: "verbose" }), /single\.outputMode/);
	assert.throws(() => normalizeSubagentRequest({ tasks: [{ agent: "a", task: "x", timeoutMs: 1.5 }] }), /tasks\[0\]\.timeoutMs/);
	assert.throws(() => normalizeSubagentRequest({ chain: [{ agent: "a", task: "x", outputMode: "verbose" }] }), /chain\[0\]\.outputMode/);
	assert.throws(() => normalizeSubagentRequest({ tasks: [{ agent: "a", task: "x" }], timeoutMs: 0 }), /defaults\.timeoutMs/);
});
