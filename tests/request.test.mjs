import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeSubagentRequest, RequestValidationError } = await jiti.import("../src/request.ts");

test("normalizes single, parallel, and chain requests", () => {
	assert.deepEqual(normalizeSubagentRequest({ agent: "reviewer", task: "check" }), {
		mode: "single",
		agentScope: "user",
		confirmProjectAgents: true,
		steps: [{ agent: "reviewer", task: "check", cwd: undefined }],
	});

	assert.equal(normalizeSubagentRequest({ tasks: [{ agent: "a", task: "x" }] }).mode, "parallel");
	assert.deepEqual(normalizeSubagentRequest({ chain: [{ agent: "a", task: "x" }] }).steps[0].step, 1);
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
