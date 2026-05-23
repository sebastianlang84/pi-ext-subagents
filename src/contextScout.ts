import * as os from "node:os";
import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { discoverAgents as defaultDiscoverAgents, type AgentConfig } from "./agents.js";
import { getFailureDiagnostic, isSuccessfulResult } from "./resultSummary.js";
import {
	getFinalOutput,
	runSingleAgent as defaultRunSingleAgent,
	type RunSingleAgentOptions,
	type SingleResult,
	type SubagentDetails,
} from "./run.js";

const DEFAULT_MAX_QUERIES = 3;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_OUTPUT_CHARS = 4000;
const DEFAULT_MAX_SCOUT_CALLS = 2;
const MIN_OUTPUT_CHARS = 200;
const MAX_OUTPUT_CHARS = 4000;
const MIN_BUDGET_VALUE = 1;
const MAX_BUDGET_VALUE = 20;
const SAFE_SCOUT_TOOLS = new Set(["read", "codemap_status", "codemap_search"]);
const FORBIDDEN_SCOUT_TOOLS = new Set(["subagent", "edit", "write"]);

export interface ContextScoutBudget {
	maxQueries: number;
	maxFiles: number;
	maxOutputChars: number;
}

export interface ContextScoutParams {
	question?: string;
	scope?: string;
	budget?: Partial<ContextScoutBudget>;
}

export interface ContextScoutBudgetUsage {
	queries: number;
	files: string[];
}

export interface ContextScoutDetails {
	agent: "scout";
	agentSource: "user" | "project" | "unknown";
	budget: ContextScoutBudget;
	budgetUsage: ContextScoutBudgetUsage;
	tools: string[];
	callsUsed: number;
	maxCalls: number;
	outputTruncated: boolean;
	result?: SingleResult;
}

export interface ContextScoutDeps {
	discoverAgents?: typeof defaultDiscoverAgents;
	runSingleAgent?: typeof defaultRunSingleAgent;
}

export interface ContextScoutToolOptions {
	maxCalls?: number;
	callCounter?: { value: number };
}

type ContextScoutToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];
type ContextScoutRunSingleAgent = NonNullable<ContextScoutDeps["runSingleAgent"]>;

const ContextScoutBudgetSchema = Type.Object({
	maxQueries: Type.Optional(Type.Integer({ description: `Default ${DEFAULT_MAX_QUERIES}; capped at ${MAX_BUDGET_VALUE}.` })),
	maxFiles: Type.Optional(Type.Integer({ description: `Read files. Default ${DEFAULT_MAX_FILES}; capped at ${MAX_BUDGET_VALUE}.` })),
	maxOutputChars: Type.Optional(Type.Integer({ description: `Default/cap ${DEFAULT_MAX_OUTPUT_CHARS}.` })),
});

const ContextScoutParamsSchema = Type.Object({
	question: Type.String({ description: "Narrow reviewer evidence question." }),
	scope: Type.Optional(Type.String({ description: "Changed paths, symbols, or limits." })),
	budget: Type.Optional(ContextScoutBudgetSchema),
});

function hasText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
	if (!Number.isInteger(value)) return fallback;
	return Math.max(min, Math.min(max, value as number));
}

function normalizeBudget(raw: ContextScoutParams["budget"]): ContextScoutBudget {
	return {
		maxQueries: clampInteger(raw?.maxQueries, DEFAULT_MAX_QUERIES, MIN_BUDGET_VALUE, MAX_BUDGET_VALUE),
		maxFiles: clampInteger(raw?.maxFiles, DEFAULT_MAX_FILES, MIN_BUDGET_VALUE, MAX_BUDGET_VALUE),
		maxOutputChars: clampInteger(raw?.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, MIN_OUTPUT_CHARS, MAX_OUTPUT_CHARS),
	};
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	const suffix = `\n\n[context_scout output truncated after ${maxChars} chars]`;
	return { text: `${text.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`, truncated: true };
}

function makeError(content: string, details: ContextScoutDetails): AgentToolResult<ContextScoutDetails> {
	return { content: [{ type: "text", text: content }], details, isError: true };
}

function safeScoutAgent(agent: AgentConfig): { agent?: AgentConfig; error?: string } {
	if (!agent.tools || agent.tools.length === 0) {
		return { error: "Scout agent must declare explicit tools so context_scout can enforce a read-only allowlist." };
	}
	const normalizedTools = agent.tools.map((tool) => tool.trim()).filter(Boolean);
	const forbidden = normalizedTools.filter((tool) => FORBIDDEN_SCOUT_TOOLS.has(tool));
	if (forbidden.length > 0) {
		return { error: `Scout agent exposes forbidden tools: ${forbidden.join(", ")}.` };
	}
	const tools = normalizedTools.filter((tool) => SAFE_SCOUT_TOOLS.has(tool));
	if (!tools.includes("read")) return { error: "Scout agent must expose read." };
	return { agent: { ...agent, tools } };
}

function buildScoutTask(params: Required<Pick<ContextScoutParams, "question">> & Pick<ContextScoutParams, "scope">, budget: ContextScoutBudget): string {
	const scope = hasText(params.scope) ? params.scope.trim() : "(not specified)";
	return [
		"Answer this reviewer context-scout request with evidence only.",
		"Do not make final review findings; the reviewer owns judgment.",
		"Cite concrete files and line ranges where possible.",
		`Budget: max ${budget.maxQueries} CodeMap searches, ${budget.maxFiles} read files, ${budget.maxOutputChars} output chars.`,
		"Output: Summary, Evidence, Gaps, Confidence.",
		"",
		`Question: ${params.question.trim()}`,
		`Scope: ${scope}`,
	].join("\n");
}

function getToolCallName(part: Record<string, unknown>): string | undefined {
	if (typeof part.name === "string") return part.name;
	if (typeof part.toolName === "string") return part.toolName;
	return undefined;
}

function getToolCallArgs(part: Record<string, unknown>): Record<string, unknown> {
	const args = part.arguments ?? part.args ?? part.input;
	return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function getPathArg(args: Record<string, unknown>): string | undefined {
	const raw = args.path ?? args.file_path ?? args.target;
	return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function measureBudgetUsage(result: SingleResult): ContextScoutBudgetUsage {
	const files = new Set<string>();
	let queries = 0;
	for (const message of result.messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (!part || typeof part !== "object") continue;
			const toolName = getToolCallName(part as Record<string, unknown>);
			if (!toolName) continue;
			const args = getToolCallArgs(part as Record<string, unknown>);
			if (toolName === "read") {
				const filePath = getPathArg(args);
				if (filePath) files.add(filePath);
			}
			if (toolName === "codemap_search") {
				queries++;
			}
		}
	}
	return { queries, files: [...files].sort() };
}

function budgetViolation(budget: ContextScoutBudget, usage: ContextScoutBudgetUsage): string | undefined {
	if (usage.queries > budget.maxQueries) return `Scout query budget exceeded (${usage.queries}/${budget.maxQueries}).`;
	if (usage.files.length > budget.maxFiles) return `Scout file budget exceeded (${usage.files.length}/${budget.maxFiles}).`;
	return undefined;
}

function makeDetails(
	budget: ContextScoutBudget,
	tools: string[],
	callsUsed: number,
	maxCalls: number,
	outputTruncated: boolean,
	result?: SingleResult,
	budgetUsage: ContextScoutBudgetUsage = { queries: 0, files: [] },
): ContextScoutDetails {
	return {
		agent: "scout",
		agentSource: result?.agentSource ?? "unknown",
		budget,
		budgetUsage,
		tools,
		callsUsed,
		maxCalls,
		outputTruncated,
		result,
	};
}

export function createContextScoutTool(deps: ContextScoutDeps = {}, options: ContextScoutToolOptions = {}): ContextScoutToolDefinition {
	const callCounter = options.callCounter ?? { value: 0 };
	const maxCalls = options.maxCalls ?? DEFAULT_MAX_SCOUT_CALLS;

	return {
		name: "context_scout",
		label: "Context Scout",
		description: "Ask the fixed scout agent for bounded reviewer evidence.",
		promptSnippet: "Ask fixed scout for bounded reviewer evidence.",
		parameters: ContextScoutParamsSchema,

		async execute(_toolCallId, params: ContextScoutParams, signal, onUpdate, ctx) {
			const budget = normalizeBudget(params.budget);
			const emptyDetails = makeDetails(budget, [], callCounter.value, maxCalls, false);
			if (!hasText(params.question)) return makeError("context_scout.question must be a non-empty string.", emptyDetails);
			if (callCounter.value >= maxCalls) return makeError(`context_scout call cap exceeded (${maxCalls} per reviewer task).`, emptyDetails);

			const discoverAgents = deps.discoverAgents ?? defaultDiscoverAgents;
			const discovery = discoverAgents(ctx.cwd, "user");
			const scout = discovery.agents.find((agent) => agent.name === "scout");
			if (!scout) return makeError("Scout agent not found in user agent scope.", emptyDetails);

			const safe = safeScoutAgent(scout);
			if (!safe.agent) return makeError(safe.error ?? "Scout agent is not safe for context_scout.", emptyDetails);

			callCounter.value++;
			const task = buildScoutTask({ question: params.question, scope: params.scope }, budget);
			const runSingleAgent = (deps.runSingleAgent ?? defaultRunSingleAgent) as ContextScoutRunSingleAgent;
			const makeSubagentDetails = (results: SingleResult[]): SubagentDetails => ({
				mode: "single",
				agentScope: "user",
				projectAgentsDir: discovery.projectAgentsDir,
				invalidAgents: discovery.invalidAgents,
				results,
			});
			const result = await runSingleAgent({
				defaultCwd: ctx.cwd,
				agents: [safe.agent],
				agentName: "scout",
				task,
				signal,
				onUpdate: onUpdate
					? (partial) => {
							const output = truncate(partial.content?.[0]?.text ?? "(running...)", budget.maxOutputChars);
							onUpdate({
								content: [{ type: "text", text: output.text }],
								details: makeDetails(budget, safe.agent!.tools ?? [], callCounter.value, maxCalls, output.truncated, partial.details?.results[0]),
							});
						}
					: undefined,
				makeDetails: makeSubagentDetails,
			} satisfies RunSingleAgentOptions);

			const output = truncate(getFinalOutput(result.messages) || "(no evidence returned)", budget.maxOutputChars);
			const usage = measureBudgetUsage(result);
			const details = makeDetails(budget, safe.agent.tools ?? [], callCounter.value, maxCalls, output.truncated, result, usage);
			if (!isSuccessfulResult(result)) {
				const diagnostic = getFailureDiagnostic(result) || output.text;
				return makeError(`Scout failed: ${diagnostic}`, details);
			}
			const budgetError = budgetViolation(budget, usage);
			if (budgetError) return makeError(budgetError, details);
			return { content: [{ type: "text", text: output.text }], details };
		},

		renderCall(args, theme) {
			const question = hasText(args.question) ? args.question.trim() : "...";
			const preview = question.length > 72 ? `${question.slice(0, 72)}...` : question;
			return new Text(`${theme.fg("toolTitle", theme.bold("context_scout"))}\n  ${theme.fg("dim", preview)}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ContextScoutDetails | undefined;
			const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const output = result.content?.[0]?.text ?? "(no output)";
			const tools = details?.tools?.length ? ` tools=${details.tools.join(",")}` : "";
			const cap = details ? ` calls=${details.callsUsed}/${details.maxCalls}` : "";
			return new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold("context_scout"))}${theme.fg("dim", `${cap}${tools}`)}\n${theme.fg("toolOutput", output)}`,
				0,
				0,
			);
		},
	};
}
