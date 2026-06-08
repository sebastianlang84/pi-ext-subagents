import { getFinalOutput, type SingleResult, type SubagentDetails } from "./run.js";

const DEFAULT_PREVIEW_CHARS = 300;
const STORAGE_TRUNCATION_MARKER = /^\[truncated after \d+ chars\]$/;

export type ResultSummaryStatus = "completed" | "failed";

export interface ResultSummaryPolicy {
	previewChars: number | ((result: SingleResult, status: ResultSummaryStatus) => number);
	classify(result: SingleResult): ResultSummaryStatus;
	getSuccessfulOutput(result: SingleResult): string;
	getFailureDiagnostic(result: SingleResult): string;
}

export interface ParallelResultSummary {
	text: string;
	isError: boolean;
	successCount: number;
}

export function classifyResult(result: SingleResult): ResultSummaryStatus {
	return result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted" && result.stopReason !== "timeout" ? "completed" : "failed";
}

export function isSuccessfulResult(result: SingleResult): boolean {
	return classifyResult(result) === "completed";
}

export function getSuccessfulOutput(result: SingleResult): string {
	return getFinalOutput(result.messages).trim();
}

export function getFailureDiagnostic(result: SingleResult): string {
	const errorMessage = result.errorMessage?.trim() ?? "";
	const stderr = result.stderr.trim();
	return errorMessage || stderr || getFinalOutput(result.messages).trim();
}

export const defaultResultSummaryPolicy: ResultSummaryPolicy = {
	previewChars: DEFAULT_PREVIEW_CHARS,
	classify: classifyResult,
	getSuccessfulOutput,
	getFailureDiagnostic,
};

export function normalizeSummaryOutput(output: string): string {
	const trimmed = output.trim();
	if (!STORAGE_TRUNCATION_MARKER.test(trimmed)) return output;
	return "Output exceeded the subagent storage limit before a useful final brief could be preserved. Rerun with a narrower prompt and ask for a concise brief.";
}

export function truncatePreview(output: string, maxChars: number): string {
	const normalized = normalizeSummaryOutput(output);
	return normalized.slice(0, maxChars) + (normalized.length > maxChars ? "..." : "");
}

function getPreviewChars(policy: ResultSummaryPolicy, result: SingleResult, status: ResultSummaryStatus): number {
	return typeof policy.previewChars === "function" ? policy.previewChars(result, status) : policy.previewChars;
}

export function buildParallelResultSummary(
	results: SingleResult[],
	policy: ResultSummaryPolicy = defaultResultSummaryPolicy,
): ParallelResultSummary {
	const entries = results.map((result) => {
		const status = policy.classify(result);
		const output = status === "completed" ? policy.getSuccessfulOutput(result) : policy.getFailureDiagnostic(result);
		const preview = truncatePreview(output, getPreviewChars(policy, result, status));
		return {
			status,
			text: `[${result.agent}] ${status}: ${preview || "(no output)"}`,
		};
	});
	const successCount = entries.filter((entry) => entry.status === "completed").length;
	const body = entries.map((entry) => entry.text).join("\n\n");
	const header = results.length > 1 ? `Subagent results: ${successCount}/${results.length} succeeded\n\n` : "";
	return {
		text: `${header}${body}`,
		isError: successCount !== results.length,
		successCount,
	};
}

export function buildParallelToolResult(
	results: SingleResult[],
	details: SubagentDetails,
	policy: ResultSummaryPolicy = defaultResultSummaryPolicy,
) {
	const summary = buildParallelResultSummary(results, policy);
	return {
		content: [{ type: "text" as const, text: summary.text }],
		details,
		isError: summary.isError || undefined,
	};
}
