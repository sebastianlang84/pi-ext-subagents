import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildResultDisplayModel, stringifyResultDisplayModel } = await jiti.import("../src/display.ts");

function result(agent, text, exitCode = 0, agentSource = "global") {
	return {
		agent,
		agentSource,
		task: `task-${agent}`,
		exitCode,
		stderr: "",
		usage: { input: 1000, output: 25, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 1025, turns: 1 },
		model: "model-a",
		messages: [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", name: "read", arguments: { path: "README.md" } },
					{ type: "text", text },
				],
				model: "model-a",
			},
		],
	};
}

test("builds a collapsed single-result display model", () => {
	const model = buildResultDisplayModel(
		{ content: [{ type: "text", text: "done" }], details: { mode: "single", agentScope: "global", repoAgentsDir: null, results: [result("reviewer", "Looks good")] } },
		false,
		10,
	);

	assert.equal(stringifyResultDisplayModel(model), [
		"success reviewer",
		"tool:read",
		"Looks good",
		"usage: 1 turn ↑1.0k ↓25 $0.0100 ctx:1.0k model-a",
	].join("\n"));
	assert.equal(model.sections[0].presentation, "inline");
});

test("single-result display exposes source only when diagnostically useful", () => {
	const repoModel = buildResultDisplayModel(
		{ content: [{ type: "text", text: "done" }], details: { mode: "single", agentScope: "repo", repoAgentsDir: null, results: [result("reviewer", "Looks good", 0, "repo")] } },
		false,
		10,
	);
	assert.equal(repoModel.header, "reviewer (repo)");

	const ambiguousModel = buildResultDisplayModel(
		{ content: [{ type: "text", text: "done" }], details: { mode: "single", agentScope: "both", repoAgentsDir: null, results: [result("reviewer", "Looks good")] } },
		false,
		10,
	);
	assert.equal(ambiguousModel.header, "reviewer (global via both)");

	const unknownModel = buildResultDisplayModel(
		{ content: [{ type: "text", text: "done" }], details: { mode: "single", agentScope: "global", repoAgentsDir: null, results: [result("reviewer", "Looks good", 0, "unknown")] } },
		false,
		10,
	);
	assert.equal(unknownModel.header, "reviewer (unknown)");

	const errorModel = buildResultDisplayModel(
		{ content: [{ type: "text", text: "done" }], details: { mode: "single", agentScope: "global", repoAgentsDir: null, results: [result("reviewer", "Failed", 1)] } },
		false,
		10,
	);
	assert.equal(errorModel.header, "reviewer");
	assert.equal(errorModel.sections[0].error, "Failed");
});

test("builds parallel display states for running, failed, and completed results", () => {
	const running = { ...result("slow", "", -1), messages: [] };
	const failed = { ...result("bad", "Failed", 1), errorMessage: "subagent exploded", stopReason: "error" };
	const failedWithStderr = { ...result("stderr", "Partial", 1), stderr: "stderr diagnostic" };
	const stoppedWithError = { ...result("stopped", "Stopped", 0), errorMessage: "model stopped with error", stopReason: "error" };
	const passed = result("ok", "Done");

	const runningModel = buildResultDisplayModel(
		{ content: [{ type: "text", text: "running" }], details: { mode: "parallel", agentScope: "global", repoAgentsDir: null, results: [running, failed, passed] } },
		true,
		10,
	);

	assert.equal(runningModel.header, "parallel 2/3 done, 1 running");
	assert.equal(runningModel.tone, "running");
	assert.deepEqual(runningModel.sections.map((section) => section.status), ["running", "error", "success"]);
	assert.equal(runningModel.sections[1].error, "subagent exploded");
	assert.equal(runningModel.footer, undefined);

	const completedModel = buildResultDisplayModel(
		{
			content: [{ type: "text", text: "done" }],
			details: { mode: "parallel", agentScope: "global", repoAgentsDir: null, results: [failed, failedWithStderr, passed] },
		},
		false,
		10,
	);

	assert.equal(completedModel.header, "parallel 1/3 tasks");
	assert.equal(completedModel.tone, "warning");
	assert.equal(completedModel.sections[0].error, "subagent exploded");
	assert.equal(completedModel.sections[1].error, "stderr diagnostic");
	assert.match(stringifyResultDisplayModel(completedModel), /## bad error/);
	assert.equal(completedModel.sections[0].presentation, "section");

	const stoppedModel = buildResultDisplayModel(
		{ content: [{ type: "text", text: "done" }], details: { mode: "parallel", agentScope: "global", repoAgentsDir: null, results: [stoppedWithError, passed] } },
		false,
		10,
	);
	assert.equal(stoppedModel.tone, "warning");
	assert.equal(stoppedModel.sections[0].status, "error");
	assert.equal(stoppedModel.sections[0].error, "model stopped with error");
});

test("marks chain tone as error when a step exits zero with an error stop reason", () => {
	const stoppedWithError = { ...result("stopped", "Stopped", 0), errorMessage: "model stopped with error", stopReason: "error" };
	const model = buildResultDisplayModel(
		{ content: [{ type: "text", text: "done" }], details: { mode: "chain", agentScope: "global", repoAgentsDir: null, results: [stoppedWithError] } },
		false,
		10,
	);

	assert.equal(model.header, "chain 0/1 steps");
	assert.equal(model.tone, "error");
	assert.equal(model.sections[0].status, "error");
});

test("builds expanded chain display with tasks, final output, and aggregate usage", () => {
	const model = buildResultDisplayModel(
		{ content: [{ type: "text", text: "done" }], details: { mode: "chain", agentScope: "global", repoAgentsDir: null, results: [result("one", "First"), result("two", "Second")] } },
		true,
		10,
	);

	assert.equal(stringifyResultDisplayModel(model), [
		"success chain 2/2 steps",
		"## one success",
		"task: task-one",
		"tool:read",
		"First",
		"final: First",
		"usage: 1 turn ↑1.0k ↓25 $0.0100 ctx:1.0k model-a",
		"## two success",
		"task: task-two",
		"tool:read",
		"Second",
		"final: Second",
		"usage: 1 turn ↑1.0k ↓25 $0.0100 ctx:1.0k model-a",
		"total: 2 turns ↑2.0k ↓50 $0.0200",
	].join("\n"));
});
