import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildResultDisplayModel, stringifyResultDisplayModel } = await jiti.import("../src/display.ts");

function result(agent, text, exitCode = 0) {
	return {
		agent,
		agentSource: "user",
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
		{ content: [{ type: "text", text: "done" }], details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [result("reviewer", "Looks good")] } },
		false,
		10,
	);

	assert.equal(stringifyResultDisplayModel(model), [
		"success reviewer (user)",
		"## reviewer success",
		"tool:read",
		"Looks good",
		"usage: 1 turn ↑1.0k ↓25 $0.0100 ctx:1.0k model-a",
	].join("\n"));
});

test("builds expanded chain display with tasks, final output, and aggregate usage", () => {
	const model = buildResultDisplayModel(
		{ content: [{ type: "text", text: "done" }], details: { mode: "chain", agentScope: "user", projectAgentsDir: null, results: [result("one", "First"), result("two", "Second")] } },
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
