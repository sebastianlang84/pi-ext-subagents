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
import { type AgentScope } from "./agents.js";
import { buildResultDisplayModel, type DisplayItem, type DisplayTone } from "./display.js";
import { executeSubagentRequest, type SubagentExecutionDeps } from "./execution.js";
export {
	buildParallelResultSummary,
	buildParallelToolResult,
	classifyResult,
	defaultResultSummaryPolicy,
	getFailureDiagnostic,
	getSuccessfulOutput,
	isSuccessfulResult,
} from "./resultSummary.js";

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

type SubagentToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

type SubagentToolDeps = SubagentExecutionDeps;

export function createSubagentTool(deps: SubagentToolDeps = {}): SubagentToolDefinition {
	return {
		name: "subagent",
		label: "Subagent",
		description: "Delegate scoped work to specialized Pi subagents in isolated contexts. Supports single, parallel, and chain modes; default agent scope is user.",
		promptSnippet: "Delegate scoped work to isolated subagents; supports single, parallel, and chain.",
		promptGuidelines: [
			"Use subagent for context isolation, independent review, or bounded specialist work; skip tiny tasks.",
			"Give subagent prompts goal, scope, constraints, allowed paths/tools, stop conditions, and output shape; main agent owns final judgment.",
			"Use subagent parallel for independent lanes, chain for dependent handoffs, and project scope only for trusted repos.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeSubagentRequest(params, ctx, { signal, onUpdate, deps });
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
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(createSubagentTool());
}
