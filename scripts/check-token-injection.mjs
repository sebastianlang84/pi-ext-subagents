#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

export const TOKEN_INJECTION_FIELDS = ["description", "parameters", "promptSnippet", "promptGuidelines"];

export const defaultTokenInjectionBudgets = {};

export function estimateTokenInjectionTokens(text) {
	const normalized = String(text).replace(/\s+/g, " ").trim();
	return normalized.length === 0 ? 0 : Math.ceil(normalized.length / 4);
}

function fieldReport(text) {
	const normalized = String(text).replace(/\s+/g, " ").trim();
	return {
		characters: normalized.length,
		tokens: estimateTokenInjectionTokens(normalized),
	};
}

function sumFields(fields) {
	return {
		characters: fields.reduce((sum, field) => sum + field.characters, 0),
		tokens: fields.reduce((sum, field) => sum + field.tokens, 0),
	};
}

export async function collectSubagentToolRegistrations() {
	const jiti = createJiti(import.meta.url);
	const importedExtension = await jiti.import("../src/index.ts", { default: true });
	const extension = typeof importedExtension === "function" ? importedExtension : importedExtension.default;
	const tools = [];
	extension({ registerTool(tool) { tools.push(tool); } });
	return tools;
}

export function buildTokenInjectionReport(tools, generatedAt = new Date().toISOString()) {
	const toolReports = tools.map((tool) => {
		const fields = {
			description: fieldReport(tool.description ?? ""),
			parameters: fieldReport(JSON.stringify(tool.parameters ?? {}) ?? "{}"),
			promptSnippet: fieldReport(tool.promptSnippet ?? ""),
			promptGuidelines: fieldReport((tool.promptGuidelines ?? []).join("\n")),
		};
		return {
			name: tool.name,
			fields,
			total: sumFields(Object.values(fields)),
		};
	});
	return {
		generatedAt,
		estimator: "normalized-chars/4-ceil",
		fields: TOKEN_INJECTION_FIELDS,
		tools: toolReports,
		totals: sumFields(toolReports.map((tool) => tool.total)),
	};
}

export async function buildSubagentTokenInjectionReport(generatedAt) {
	return buildTokenInjectionReport(await collectSubagentToolRegistrations(), generatedAt);
}

export function evaluateTokenInjectionBudget(report, budgets = defaultTokenInjectionBudgets) {
	const issues = [];
	if (budgets.maxTokensPerTool !== undefined) {
		for (const tool of report.tools) {
			if (tool.total.tokens > budgets.maxTokensPerTool) {
				issues.push({
					label: tool.name,
					metric: "toolTokens",
					expected: `<= ${budgets.maxTokensPerTool}`,
					actual: tool.total.tokens,
				});
			}
		}
	}
	if (budgets.maxTotalTokens !== undefined && report.totals.tokens > budgets.maxTotalTokens) {
		issues.push({
			label: "all subagent tools",
			metric: "totalTokens",
			expected: `<= ${budgets.maxTotalTokens}`,
			actual: report.totals.tokens,
		});
	}
	return { passed: issues.length === 0, budgets, issues };
}

export function formatTokenInjectionIssues(issues) {
	return issues.map((issue) => `${issue.label} ${issue.metric} ${issue.actual} exceeds ${issue.expected}`).join("\n");
}

export function formatTokenInjectionBudgetFailure(report, issues) {
	const toolRows = report.tools.map((tool) => {
		const fields = TOKEN_INJECTION_FIELDS.map((name) => `${name}=${tool.fields[name].tokens}`).join(", ");
		return `- ${tool.name}: ${tool.total.tokens} tokens (${fields})`;
	});
	return [formatTokenInjectionIssues(issues), "Token injection report:", ...toolRows, `- total: ${report.totals.tokens} tokens`]
		.filter(Boolean)
		.join("\n");
}

function parseCliArgs(args) {
	const budgets = { ...defaultTokenInjectionBudgets };
	let gateEnabled = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const [name, inlineValue] = arg.split("=", 2);
		const value = inlineValue ?? args[i + 1];
		if (arg === "--budget-gate") {
			gateEnabled = true;
		} else if (name === "--max-tool-tokens") {
			budgets.maxTokensPerTool = parsePositiveInteger(name, value);
			gateEnabled = true;
			if (inlineValue === undefined) i++;
		} else if (name === "--max-total-tokens") {
			budgets.maxTotalTokens = parsePositiveInteger(name, value);
			gateEnabled = true;
			if (inlineValue === undefined) i++;
		} else if (arg === "--help") {
			console.log("Usage: check-token-injection.mjs [--max-tool-tokens N] [--max-total-tokens N]");
			process.exit(0);
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	const hasBudget = budgets.maxTokensPerTool !== undefined || budgets.maxTotalTokens !== undefined;
	if (gateEnabled && !hasBudget) throw new Error("--budget-gate requires --max-tool-tokens and/or --max-total-tokens");
	return { budgets, gateEnabled };
}

function parsePositiveInteger(name, value) {
	if (value === undefined || value.trim() === "") throw new Error(`${name} requires a value`);
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
	return parsed;
}

async function runCli() {
	const parsed = parseCliArgs(process.argv.slice(2));
	const report = await buildSubagentTokenInjectionReport();
	const gate = evaluateTokenInjectionBudget(report, parsed.budgets);
	console.log(JSON.stringify({ ...report, gate }, null, 2));
	if (parsed.gateEnabled && !gate.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runCli().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	});
}
