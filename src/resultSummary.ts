import { getFinalOutput, type SingleResult, type SubagentDetails } from "./run.js";

const DEFAULT_PREVIEW_CHARS = 100;

export type ResultSummaryStatus = "completed" | "failed";

export interface ResultSummaryPolicy {
	previewChars: number;
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
	return result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted" ? "completed" : "failed";
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

function truncatePreview(output: string, maxChars: number): string {
	return output.slice(0, maxChars) + (output.length > maxChars ? "..." : "");
}

export function buildParallelResultSummary(
	results: SingleResult[],
	policy: ResultSummaryPolicy = defaultResultSummaryPolicy,
): ParallelResultSummary {
	const entries = results.map((result) => {
		const status = policy.classify(result);
		const output = status === "completed" ? policy.getSuccessfulOutput(result) : policy.getFailureDiagnostic(result);
		const preview = truncatePreview(output, policy.previewChars);
		return {
			status,
			text: `[${result.agent}] ${status}: ${preview || "(no output)"}`,
		};
	});
	const successCount = entries.filter((entry) => entry.status === "completed").length;
	return {
		text: `Parallel: ${successCount}/${results.length} succeeded\n\n${entries.map((entry) => entry.text).join("\n\n")}`,
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
