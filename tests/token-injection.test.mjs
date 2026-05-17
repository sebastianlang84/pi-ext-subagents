import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
	buildSubagentTokenInjectionReport,
	defaultTokenInjectionBudgets,
	evaluateTokenInjectionBudget,
	formatTokenInjectionBudgetFailure,
} from "../scripts/check-token-injection.mjs";

test("registered subagent tool reports token injection fields", async () => {
	const report = await buildSubagentTokenInjectionReport("2026-05-16T00:00:00.000Z");

	assert.deepEqual(defaultTokenInjectionBudgets, {});
	assert.deepEqual(report.tools.map((tool) => tool.name), ["subagent"]);
	const subagent = report.tools[0];
	assert.ok(subagent.fields.description.tokens > 0, "description tokens should be counted");
	assert.ok(subagent.fields.parameters.tokens > 0, "parameter schema tokens should be counted");
	assert.ok(subagent.fields.promptSnippet.tokens > 0, "promptSnippet tokens should be counted");
	assert.ok(subagent.fields.promptGuidelines.tokens > 0, "promptGuidelines tokens should be counted");
});

test("token-injection budget gate only enforces explicit budgets", async () => {
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
	assert.deepEqual(report.gate?.budgets, {});
	assert.deepEqual(report.tools?.map((tool) => tool.name), ["subagent"]);
	assert.ok((report.totals?.tokens ?? 0) > 0);
});

test("token-injection checker requires explicit budget values for gating", () => {
	assert.throws(
		() => execFileSync(process.execPath, ["scripts/check-token-injection.mjs", "--budget-gate"], { encoding: "utf8", stdio: "pipe" }),
		/--budget-gate requires --max-tool-tokens/,
	);
});
