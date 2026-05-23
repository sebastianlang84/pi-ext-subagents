import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
	buildSubagentTokenInjectionReport,
	defaultTokenInjectionBudgets,
	evaluateTokenInjectionBudget,
	formatTokenInjectionBudgetFailure,
} from "../scripts/check-token-injection.mjs";

test("registered tools report token injection fields", async () => {
	const report = await buildSubagentTokenInjectionReport("2026-05-16T00:00:00.000Z");

	assert.deepEqual(defaultTokenInjectionBudgets, { maxTokensPerTool: 350, maxTotalTokens: 500 });
	assert.deepEqual(report.tools.map((tool) => tool.name), ["subagent", "context_scout"]);
	const subagent = report.tools.find((tool) => tool.name === "subagent");
	const contextScout = report.tools.find((tool) => tool.name === "context_scout");
	assert.ok(subagent.fields.description.tokens > 0, "description tokens should be counted");
	assert.ok(subagent.fields.parameters.tokens > 0, "parameter schema tokens should be counted");
	assert.ok(subagent.fields.promptSnippet.tokens > 0, "promptSnippet tokens should be counted");
	assert.ok(subagent.fields.promptGuidelines.tokens > 0, "promptGuidelines tokens should be counted");
	assert.ok(contextScout.fields.description.tokens > 0, "context_scout description tokens should be counted");
	assert.ok(contextScout.fields.parameters.tokens > 0, "context_scout schema tokens should be counted");
	assert.ok(contextScout.total.tokens < subagent.total.tokens, "context_scout prompt footprint should stay smaller than subagent");
});

test("token-injection budget gate enforces default and override budgets", async () => {
	const report = await buildSubagentTokenInjectionReport("2026-05-16T00:00:00.000Z");

	assert.equal(evaluateTokenInjectionBudget(report).passed, true);
	const gate = evaluateTokenInjectionBudget(report, { maxTokensPerTool: 1, maxTotalTokens: 1 });
	assert.equal(gate.passed, false);
	assert.match(formatTokenInjectionBudgetFailure(report, gate.issues), /exceeds <= 1/);
});

test("token-injection checker emits a machine-readable report", () => {
	const output = execFileSync(process.execPath, ["scripts/check-token-injection.mjs"], { encoding: "utf8" });
	const report = JSON.parse(output);

	assert.equal(report.gate?.passed, true);
	assert.deepEqual(report.gate?.budgets, { maxTokensPerTool: 350, maxTotalTokens: 500 });
	assert.deepEqual(report.tools?.map((tool) => tool.name), ["subagent", "context_scout"]);
	assert.ok((report.totals?.tokens ?? 0) > 0);
});

test("token-injection checker rejects invalid explicit budgets", () => {
	assert.throws(
		() => execFileSync(process.execPath, ["scripts/check-token-injection.mjs", "--max-tool-tokens", "nope"], { encoding: "utf8", stdio: "pipe" }),
		/--max-tool-tokens must be a positive integer/,
	);
});
