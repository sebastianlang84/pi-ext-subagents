import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getFinalOutput, type SingleResult, type SubagentDetails } from "./run.js";

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };
export type DisplayTone = "success" | "error" | "warning" | "running";

export interface ResultDisplaySection {
	heading?: string;
	status?: DisplayTone;
	meta?: string;
	task?: string;
	error?: string;
	items: DisplayItem[];
	skippedItems: number;
	finalOutput?: string;
	usage?: string;
}

export interface ResultDisplayModel {
	emptyText?: string;
	header?: string;
	tone?: DisplayTone;
	sections: ResultDisplaySection[];
	footer?: string;
	expandHint: boolean;
	expanded: boolean;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function isErrorResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function sliceItems(items: DisplayItem[], limit?: number): { items: DisplayItem[]; skippedItems: number } {
	if (!limit || items.length <= limit) return { items, skippedItems: 0 };
	return { items: items.slice(-limit), skippedItems: items.length - limit };
}

function resultSection(result: SingleResult, expanded: boolean, limit?: number): ResultDisplaySection {
	const allItems = getDisplayItems(result.messages);
	const { items, skippedItems } = sliceItems(allItems, expanded ? undefined : limit);
	const error = isErrorResult(result) ? result.errorMessage : undefined;
	return {
		heading: result.step ? `Step ${result.step}: ${result.agent}` : result.agent,
		status: isErrorResult(result) ? "error" : result.exitCode === -1 ? "running" : "success",
		meta: result.agentSource,
		task: expanded ? result.task : undefined,
		error,
		items,
		skippedItems,
		finalOutput: expanded ? getFinalOutput(result.messages).trim() || undefined : undefined,
		usage: formatUsageStats(result.usage, result.model) || undefined,
	};
}

function aggregateUsage(results: SingleResult[]) {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

export function buildResultDisplayModel(
	result: Pick<AgentToolResult<SubagentDetails>, "content" | "details">,
	expanded: boolean,
	collapsedItemCount: number,
): ResultDisplayModel {
	const details = result.details;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return {
			emptyText: text?.type === "text" ? text.text : "(no output)",
			sections: [],
			expandHint: false,
			expanded,
		};
	}

	if (details.mode === "single" && details.results.length === 1) {
		const r = details.results[0];
		const section = resultSection(r, expanded, collapsedItemCount);
		return {
			header: `${r.agent} (${r.agentSource})`,
			tone: section.status,
			sections: [section],
			expandHint: !expanded && getDisplayItems(r.messages).length > collapsedItemCount,
			expanded,
		};
	}

	if (details.mode === "chain") {
		const successCount = details.results.filter((r) => r.exitCode === 0).length;
		const allSucceeded = successCount === details.results.length;
		const sections = details.results.map((r) => resultSection(r, expanded, expanded ? undefined : 5));
		return {
			header: `chain ${successCount}/${details.results.length} steps`,
			tone: allSucceeded ? "success" : "error",
			sections,
			footer: formatUsageStats(aggregateUsage(details.results)) || undefined,
			expandHint: !expanded,
			expanded,
		};
	}

	const running = details.results.filter((r) => r.exitCode === -1).length;
	const successCount = details.results.filter((r) => r.exitCode === 0).length;
	const failCount = details.results.filter((r) => r.exitCode > 0).length;
	const done = successCount + failCount;
	return {
		header: `parallel ${running > 0 ? `${done}/${details.results.length} done, ${running} running` : `${successCount}/${details.results.length} tasks`}`,
		tone: running > 0 ? "running" : failCount > 0 ? "warning" : "success",
		sections: details.results.map((r) => resultSection(r, expanded && running === 0, expanded ? undefined : 5)),
		footer: running > 0 ? undefined : formatUsageStats(aggregateUsage(details.results)) || undefined,
		expandHint: !expanded,
		expanded,
	};
}

export function stringifyResultDisplayModel(model: ResultDisplayModel): string {
	if (model.emptyText) return model.emptyText;
	const lines = [`${model.tone ?? ""} ${model.header ?? ""}`.trim()];
	for (const section of model.sections) {
		lines.push(`## ${section.heading ?? "output"} ${section.status ?? ""}`.trim());
		if (section.task) lines.push(`task: ${section.task}`);
		if (section.skippedItems) lines.push(`... ${section.skippedItems} earlier items`);
		for (const item of section.items) lines.push(item.type === "text" ? item.text : `tool:${item.name}`);
		if (section.finalOutput) lines.push(`final: ${section.finalOutput}`);
		if (section.usage) lines.push(`usage: ${section.usage}`);
	}
	if (model.footer) lines.push(`total: ${model.footer}`);
	if (model.expandHint) lines.push("(Ctrl+O to expand)");
	return lines.join("\n");
}
