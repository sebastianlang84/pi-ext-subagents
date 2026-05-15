import * as os from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	discoverAgents as defaultDiscoverAgents,
	getProjectAgentTrustDecision,
	type AgentScope,
	type InvalidAgentDiagnostic,
} from "./agents.js";
import {
	normalizeSubagentRequest,
	requestedAgentNames,
	RequestValidationError,
	type ExecutionPlan,
	type SubagentParams,
} from "./request.js";
import { buildParallelToolResult, getFailureDiagnostic, isSuccessfulResult } from "./resultSummary.js";
import {
	getFinalOutput,
	runSingleAgent as defaultRunSingleAgent,
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
} from "./run.js";

const DEFAULT_MAX_CONCURRENCY = 4;

export type ProjectAgentConfirmer = (title: string, message: string) => Promise<boolean>;

export interface SubagentExecutionDeps {
	discoverAgents?: typeof defaultDiscoverAgents;
	runSingleAgent?: typeof defaultRunSingleAgent;
	confirmProjectAgents?: ProjectAgentConfirmer;
}

export interface SubagentExecutionContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		confirm(title: string, message: string): Promise<boolean>;
	};
}

export interface ExecuteSubagentPlanOptions {
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	deps?: SubagentExecutionDeps;
}

export type ExecuteSubagentRequestOptions = ExecuteSubagentPlanOptions;

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatInvalidAgentDiagnostics(invalidAgents: InvalidAgentDiagnostic[], maxItems = 5): string {
	if (invalidAgents.length === 0) return "";
	const listed = invalidAgents.slice(0, maxItems).map((diagnostic) => {
		const filePath = shortenPath(diagnostic.filePath);
		return `- ${diagnostic.source}: ${filePath}: ${diagnostic.reason}`;
	});
	const remaining = invalidAgents.length - listed.length;
	if (remaining > 0) listed.push(`- ... ${remaining} more invalid agent${remaining === 1 ? "" : "s"}`);
	return `Invalid agents:\n${listed.join("\n")}`;
}

function formatAvailableAgents(agents: { name: string; source: string }[]): string {
	return agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

export async function executeSubagentRequest(
	params: SubagentParams,
	ctx: SubagentExecutionContext,
	options: ExecuteSubagentRequestOptions = {},
): Promise<AgentToolResult<SubagentDetails>> {
	const discoverAgentsImpl = options.deps?.discoverAgents ?? defaultDiscoverAgents;
	let plan: ExecutionPlan;
	try {
		plan = normalizeSubagentRequest(params);
	} catch (error) {
		const scope: AgentScope =
			params.agentScope === "project" || params.agentScope === "both" || params.agentScope === "user"
				? params.agentScope
				: "user";
		const discovery = discoverAgentsImpl(ctx.cwd, scope);
		const mode = params.chain !== undefined ? "chain" : params.tasks !== undefined ? "parallel" : "single";
		const message = error instanceof RequestValidationError ? error.message : `Invalid parameters: ${String(error)}`;
		const available = formatAvailableAgents(discovery.agents);
		const invalidDiagnostics = formatInvalidAgentDiagnostics(discovery.invalidAgents);
		return {
			content: [{ type: "text", text: `${message}\nAvailable agents: ${available}${invalidDiagnostics ? `\n${invalidDiagnostics}` : ""}` }],
			details: { mode, agentScope: scope, projectAgentsDir: discovery.projectAgentsDir, invalidAgents: discovery.invalidAgents, results: [] },
			isError: true,
		};
	}

	return executeSubagentPlan(plan, ctx, options);
}

export async function executeSubagentPlan(
	plan: ExecutionPlan,
	ctx: SubagentExecutionContext,
	options: ExecuteSubagentPlanOptions = {},
): Promise<AgentToolResult<SubagentDetails>> {
	const discoverAgentsImpl = options.deps?.discoverAgents ?? defaultDiscoverAgents;
	const runSingleAgentImpl = options.deps?.runSingleAgent ?? defaultRunSingleAgent;
	const confirmProjectAgents = options.deps?.confirmProjectAgents ?? ctx.ui.confirm.bind(ctx.ui);
	const { signal, onUpdate } = options;

	const discovery = discoverAgentsImpl(ctx.cwd, plan.agentScope);
	const agents = discovery.agents;

	const makeDetails =
		(mode: "single" | "parallel" | "chain") =>
		(results: SingleResult[]): SubagentDetails => ({
			mode,
			agentScope: plan.agentScope,
			projectAgentsDir: discovery.projectAgentsDir,
			invalidAgents: discovery.invalidAgents,
			results,
		});

	const availableAgentNames = new Set(agents.map((agent) => agent.name));
	const missingAgents = [...requestedAgentNames(plan)].filter((agentName) => !availableAgentNames.has(agentName));
	if (missingAgents.length > 0) {
		const available = formatAvailableAgents(agents);
		const invalidDiagnostics = formatInvalidAgentDiagnostics(discovery.invalidAgents);
		const missing = missingAgents.map((name) => `"${name}"`).join(", ");
		return {
			content: [
				{
					type: "text",
					text: `Unknown agent${missingAgents.length === 1 ? "" : "s"}: ${missing}.\nAvailable agents: ${available}${invalidDiagnostics ? `\n${invalidDiagnostics}` : ""}`,
				},
			],
			details: makeDetails(plan.mode)([]),
			isError: true,
		};
	}

	const trustDecision = getProjectAgentTrustDecision(agents, requestedAgentNames(plan), plan.confirmProjectAgents);
	if (trustDecision.requiresApproval) {
		const names = trustDecision.projectAgents.map((a) => a.name).join(", ");
		const dir = discovery.projectAgentsDir ?? "(unknown)";
		if (!ctx.hasUI) {
			return {
				content: [
					{
						type: "text",
						text: `Canceled: project-local agents require interactive confirmation in this mode. Set confirmProjectAgents: false only for trusted repositories.\nAgents: ${names}\nSource: ${dir}`,
					},
				],
				details: makeDetails(plan.mode)([]),
				isError: true,
			};
		}

		const ok = await confirmProjectAgents(
			"Run project-local agents?",
			`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
		);
		if (!ok) {
			return {
				content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
				details: makeDetails(plan.mode)([]),
			};
		}
	}

	if (plan.mode === "chain") {
		const results: SingleResult[] = [];
		let previousOutput = "";

		for (let i = 0; i < plan.steps.length; i++) {
			const step = plan.steps[i];
			const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

			const chainUpdate: OnUpdateCallback | undefined = onUpdate
				? (partial) => {
						const currentResult = partial.details?.results[0];
						if (currentResult) {
							onUpdate({
								content: partial.content,
								details: makeDetails("chain")([...results, currentResult]),
							});
						}
					}
				: undefined;

			const result = await runSingleAgentImpl({
				defaultCwd: ctx.cwd,
				agents,
				agentName: step.agent,
				task: taskWithContext,
				cwd: step.cwd,
				step: i + 1,
				signal,
				onUpdate: chainUpdate,
				makeDetails: makeDetails("chain"),
			});
			results.push(result);

			if (!isSuccessfulResult(result)) {
				const errorMsg = getFailureDiagnostic(result) || "(no output)";
				return {
					content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
					details: makeDetails("chain")(results),
					isError: true,
				};
			}
			previousOutput = getFinalOutput(result.messages);
		}
		return {
			content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
			details: makeDetails("chain")(results),
		};
	}

	if (plan.mode === "parallel") {
		const allResults: SingleResult[] = plan.steps.map((step) => ({
			agent: step.agent,
			agentSource: "unknown",
			task: step.task,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		}));

		const emitParallelUpdate = () => {
			if (onUpdate) {
				const running = allResults.filter((r) => r.exitCode === -1).length;
				const done = allResults.filter((r) => r.exitCode !== -1).length;
				onUpdate({
					content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
					details: makeDetails("parallel")([...allResults]),
				});
			}
		};

		const results = await mapWithConcurrencyLimit(plan.steps, DEFAULT_MAX_CONCURRENCY, async (step, index) => {
			const result = await runSingleAgentImpl({
				defaultCwd: ctx.cwd,
				agents,
				agentName: step.agent,
				task: step.task,
				cwd: step.cwd,
				signal,
				onUpdate: (partial) => {
					if (partial.details?.results[0]) {
						allResults[index] = partial.details.results[0];
						emitParallelUpdate();
					}
				},
				makeDetails: makeDetails("parallel"),
			});
			allResults[index] = result;
			emitParallelUpdate();
			return result;
		});

		return buildParallelToolResult(results, makeDetails("parallel")(results));
	}

	const step = plan.steps[0];
	const result = await runSingleAgentImpl({
		defaultCwd: ctx.cwd,
		agents,
		agentName: step.agent,
		task: step.task,
		cwd: step.cwd,
		signal,
		onUpdate,
		makeDetails: makeDetails("single"),
	});
	if (!isSuccessfulResult(result)) {
		const errorMsg = getFailureDiagnostic(result) || "(no output)";
		return {
			content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
			details: makeDetails("single")([result]),
			isError: true,
		};
	}
	return {
		content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
		details: makeDetails("single")([result]),
	};
}
