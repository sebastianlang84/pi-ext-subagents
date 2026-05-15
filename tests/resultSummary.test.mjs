import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildParallelResultSummary, defaultResultSummaryPolicy } = await jiti.import("../src/resultSummary.ts");

function agentResult(agent, text, exitCode = 0, overrides = {}) {
	return {
		agent,
		agentSource: "user",
		task: `task-${agent}`,
		exitCode,
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		messages: text
			? [{ role: "assistant", content: [{ type: "text", text }] }]
			: [],
		...overrides,
	};
}

test("parallel result summary truncates previews through the policy seam", () => {
	const longOutput = "x".repeat(101);
	const summary = buildParallelResultSummary([agentResult("ok", longOutput)]);

	assert.equal(summary.isError, false);
	assert.match(summary.text, new RegExp(`\\[ok\\] completed: ${"x".repeat(100)}\\.\\.\\.`));
});

test("parallel result summary accepts custom classification and truncation policy", () => {
	const summary = buildParallelResultSummary(
		[agentResult("custom", "ignored", 1, { stderr: "stderr diagnostic" })],
		{
			...defaultResultSummaryPolicy,
			previewChars: 3,
			classify: () => "completed",
			getSuccessfulOutput: () => "abcdef",
		},
	);

	assert.equal(summary.successCount, 1);
	assert.equal(summary.isError, false);
	assert.match(summary.text, /\[custom\] completed: abc\.\.\./);
	assert.doesNotMatch(summary.text, /stderr diagnostic/);
});

test("parallel result summary accepts custom failure diagnostics", () => {
	const summary = buildParallelResultSummary(
		[agentResult("custom", "assistant partial", 1, { errorMessage: "default diagnostic", stderr: "stderr diagnostic" })],
		{
			...defaultResultSummaryPolicy,
			getFailureDiagnostic: () => "custom diagnostic",
		},
	);

	assert.equal(summary.successCount, 0);
	assert.equal(summary.isError, true);
	assert.match(summary.text, /\[custom\] failed: custom diagnostic/);
	assert.doesNotMatch(summary.text, /default diagnostic|stderr diagnostic|assistant partial/);
});
