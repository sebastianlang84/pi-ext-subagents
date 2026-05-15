import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
	buildSubagentTokenInjectionReport,
	defaultTokenInjectionBudgets,
	evaluateTokenInjectionBudget,
	formatTokenInjectionBudgetFailure,
} from "../scripts/check-token-injection.mjs";

test("registered subagent tool stays within token injection budgets", async () => {
	const report = await buildSubagentTokenInjectionReport("2026-05-16T00:00:00.000Z");
	const gate = evaluateTokenInjectionBudget(report, defaultTokenInjectionBudgets);

	assert.deepEqual(report.tools.map((tool) => tool.name), ["subagent"]);
	const subagent = report.tools[0];
	assert.ok(subagent.fields.description.tokens > 0, "description tokens should be counted");
	assert.ok(subagent.fields.parameters.tokens > 0, "parameter schema tokens should be counted");
	assert.ok(subagent.fields.promptSnippet.tokens > 0, "promptSnippet tokens should be counted");
	assert.ok(subagent.fields.promptGuidelines.tokens > 0, "promptGuidelines tokens should be counted");
	assert.equal(gate.passed, true, formatTokenInjectionBudgetFailure(report, gate.issues));
});

test("token-injection checker emits a machine-readable budget report", () => {
	const output = execFileSync(process.execPath, ["scripts/check-token-injection.mjs", "--budget-gate"], { encoding: "utf8" });
	const report = JSON.parse(output);

	assert.equal(report.gate?.passed, true);
	assert.deepEqual(report.tools?.map((tool) => tool.name), ["subagent"]);
	assert.ok((report.totals?.tokens ?? 0) > 0);
});
