/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import * as os from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, getProjectAgentTrustDecision, type AgentScope, type InvalidAgentDiagnostic } from "./agents.js";
import { buildResultDisplayModel, type DisplayItem, type DisplayTone } from "./display.js";
import { normalizeSubagentRequest, requestedAgentNames, RequestValidationError } from "./request.js";
import {
	getFinalOutput,
	runSingleAgent,
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
} from "./run.js";

const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

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

function isSuccessfulResult(result: SingleResult): boolean {
	return result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted";
}

export function buildParallelResultSummary(results: SingleResult[]): { text: string; isError: boolean; successCount: number } {
	const successCount = results.filter(isSuccessfulResult).length;
	const summaries = results.map((r) => {
		const successful = isSuccessfulResult(r);
		const finalOutput = getFinalOutput(r.messages).trim();
		const errorMessage = r.errorMessage?.trim() ?? "";
		const stderr = r.stderr.trim();
		const output = successful ? finalOutput : errorMessage || stderr || finalOutput;
		const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
		return `[${r.agent}] ${successful ? "completed" : "failed"}: ${preview || "(no output)"}`;
	});
	return {
		text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
		isError: successCount !== results.length,
		successCount,
	};
}

export function buildParallelToolResult(results: SingleResult[], details: SubagentDetails) {
	const summary = buildParallelResultSummary(results);
	return {
		content: [{ type: "text" as const, text: summary.text }],
		details,
		isError: summary.isError || undefined,
	};
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

const TaskItem = Type.Object({
	agent: Type.String(),
	task: Type.String(),
	cwd: Type.Optional(Type.String()),
});

const ChainItem = Type.Object({
	agent: Type.String(),
	task: Type.String({ description: "Use {previous} for prior output." }),
	cwd: Type.Optional(Type.String()),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: "Agent source: user (default), project, or both.",
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	tasks: Type.Optional(Type.Array(TaskItem)),
	chain: Type.Optional(Type.Array(ChainItem)),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before project agents; default true.", default: true }),
	),
	cwd: Type.Optional(Type.String()),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Run subagents in isolated context: single, parallel, or chain. Default scope: user; set agentScope for project agents.",
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			let plan;
			try {
				plan = normalizeSubagentRequest(params);
			} catch (error) {
				const scope: AgentScope =
					params.agentScope === "project" || params.agentScope === "both" || params.agentScope === "user"
						? params.agentScope
						: "user";
				const discovery = discoverAgents(ctx.cwd, scope);
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

			const discovery = discoverAgents(ctx.cwd, plan.agentScope);
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

			const trustDecision = getProjectAgentTrustDecision(
				agents,
				requestedAgentNames(plan),
				plan.confirmProjectAgents,
			);
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

				const ok = await ctx.ui.confirm(
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

					const result = await runSingleAgent({
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

					const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
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

				const results = await mapWithConcurrencyLimit(plan.steps, MAX_CONCURRENCY, async (step, index) => {
					const result = await runSingleAgent({
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
			const result = await runSingleAgent({
				defaultCwd: ctx.cwd,
				agents,
				agentName: step.agent,
				task: step.task,
				cwd: step.cwd,
				signal,
				onUpdate,
				makeDetails: makeDetails("single"),
			});
			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			if (isError) {
				const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
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
		},
		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const model = buildResultDisplayModel(result as any, expanded, COLLAPSED_ITEM_COUNT);
			if (model.emptyText) return new Text(model.emptyText, 0, 0);

			const mdTheme = getMarkdownTheme();
			const iconFor = (tone?: DisplayTone) =>
				tone === "error"
					? theme.fg("error", "✗")
					: tone === "warning"
						? theme.fg("warning", "◐")
						: tone === "running"
							? theme.fg("warning", "⏳")
							: theme.fg("success", "✓");

			const renderDisplayItems = (items: DisplayItem[], skippedItems: number) => {
				let text = "";
				if (skippedItems > 0) text += theme.fg("muted", `... ${skippedItems} earlier items\n`);
				for (const item of items) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(`${iconFor(model.tone)} ${theme.fg("toolTitle", theme.bold(model.header ?? "subagent"))}`, 0, 0));

				for (const section of model.sections) {
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", section.heading ?? "output")} ${iconFor(section.status)}`, 0, 0),
					);
					if (section.task) container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", section.task), 0, 0));
					if (section.error) container.addChild(new Text(theme.fg("error", `Error: ${section.error}`), 0, 0));

					const toolCalls = section.items.filter((item) => item.type === "toolCall");
					const textItems = section.items.filter((item) => item.type === "text");
					for (const item of toolCalls) {
						container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
					}

					if (section.finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(section.finalOutput, 0, 0, mdTheme));
					} else if (textItems.length > 0) {
						container.addChild(new Text(renderDisplayItems(textItems, section.skippedItems), 0, 0));
					} else if (section.items.length === 0) {
						container.addChild(new Text(theme.fg("muted", section.status === "running" ? "(running...)" : "(no output)"), 0, 0));
					}

					if (section.usage) container.addChild(new Text(theme.fg("dim", section.usage), 0, 0));
				}

				if (model.footer) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${model.footer}`), 0, 0));
				}
				return container;
			}

			let text = `${iconFor(model.tone)} ${theme.fg("toolTitle", theme.bold(model.header ?? "subagent"))}`;
			for (const section of model.sections) {
				text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", section.heading ?? "output")} ${iconFor(section.status)}`;
				if (section.error) text += `\n${theme.fg("error", `Error: ${section.error}`)}`;
				if (section.items.length === 0) text += `\n${theme.fg("muted", section.status === "running" ? "(running...)" : "(no output)")}`;
				else text += `\n${renderDisplayItems(section.items, section.skippedItems)}`;
				if (model.sections.length === 1 && section.usage) text += `\n${theme.fg("dim", section.usage)}`;
			}
			if (model.footer) text += `\n\n${theme.fg("dim", `Total: ${model.footer}`)}`;
			if (model.expandHint) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}
