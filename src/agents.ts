/**
 * Agent discovery, provenance, and repo-agent trust helpers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "global" | "repo" | "both";
export type AgentSource = "global" | "repo";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface InvalidAgentDiagnostic {
	source: AgentSource;
	filePath: string;
	reason: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	repoAgentsDir: string | null;
	invalidAgents: InvalidAgentDiagnostic[];
}

export interface RepoAgentTrustDecision {
	requiresApproval: boolean;
	repoAgents: AgentConfig[];
	reason?: string;
}

const MUTATION_CAPABLE_TOOLS = new Set(["bash", "write", "edit"]);
const MAX_DIAGNOSTIC_FIELD_CHARS = 120;
const MAX_DIAGNOSTIC_PATH_CHARS = 300;
const MAX_DIAGNOSTIC_AGENTS = 8;

export function normalizeAgentScope(value: unknown): AgentScope | undefined {
	switch (value) {
		case undefined:
		case "global":
			return "global";
		case "repo":
			return "repo";
		case "both":
			return "both";
		default:
			return undefined;
	}
}

export function formatAgentSource(source: AgentSource): AgentSource {
	return source;
}

function normalizeRequiredString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTools(value: unknown): { tools?: string[]; error?: string } {
	if (value === undefined || value === null) return {};
	if (typeof value !== "string") return { error: "frontmatter tools must be a comma-separated string" };
	const tools = value
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	return tools.length > 0 ? { tools } : {};
}

export function loadAgentsFromDir(
	dir: string,
	source: AgentSource,
): { agents: AgentConfig[]; invalidAgents: InvalidAgentDiagnostic[] } {
	const agents: AgentConfig[] = [];
	const invalidAgents: InvalidAgentDiagnostic[] = [];

	if (!fs.existsSync(dir)) return { agents, invalidAgents };

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		invalidAgents.push({ source, filePath: dir, reason: `Unable to read agent directory: ${String(error)}` });
		return { agents, invalidAgents };
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch (error) {
			invalidAgents.push({ source, filePath, reason: `Unable to read agent file: ${String(error)}` });
			continue;
		}

		let parsed: { frontmatter: Record<string, unknown>; body: string };
		try {
			parsed = parseFrontmatter<Record<string, unknown>>(content);
		} catch (error) {
			invalidAgents.push({ source, filePath, reason: `Malformed frontmatter: ${String(error)}` });
			continue;
		}

		const name = normalizeRequiredString(parsed.frontmatter.name);
		const description = normalizeRequiredString(parsed.frontmatter.description);
		if (!name || !description) {
			invalidAgents.push({ source, filePath, reason: "Missing required frontmatter: name and description" });
			continue;
		}

		const normalizedTools = normalizeTools(parsed.frontmatter.tools);
		if (normalizedTools.error) {
			invalidAgents.push({ source, filePath, reason: normalizedTools.error });
			continue;
		}

		agents.push({
			name,
			description,
			tools: normalizedTools.tools,
			model: normalizeOptionalString(parsed.frontmatter.model),
			systemPrompt: parsed.body,
			source,
			filePath,
		});
	}

	return { agents, invalidAgents };
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestRepoAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scopeInput: AgentScope): AgentDiscoveryResult {
	const scope = normalizeAgentScope(scopeInput) ?? "global";
	const globalDir = path.join(getAgentDir(), "agents");
	const repoAgentsDir = findNearestRepoAgentsDir(cwd);

	const globalDiscovery = scope === "repo" ? { agents: [], invalidAgents: [] } : loadAgentsFromDir(globalDir, "global");
	const repoDiscovery = scope === "global" || !repoAgentsDir ? { agents: [], invalidAgents: [] } : loadAgentsFromDir(repoAgentsDir, "repo");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of globalDiscovery.agents) agentMap.set(agent.name, agent);
		// Repo-local agents intentionally override same-named global agents only when both sources are enabled.
		for (const agent of repoDiscovery.agents) agentMap.set(agent.name, agent);
	} else if (scope === "global") {
		for (const agent of globalDiscovery.agents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of repoDiscovery.agents) agentMap.set(agent.name, agent);
	}

	return {
		agents: Array.from(agentMap.values()),
		repoAgentsDir,
		invalidAgents: [...globalDiscovery.invalidAgents, ...repoDiscovery.invalidAgents],
	};
}

export function getRepoAgentTrustDecision(
	agents: AgentConfig[],
	requestedNames: Iterable<string>,
	confirmRepoAgents: boolean,
): RepoAgentTrustDecision {
	if (!confirmRepoAgents) return { requiresApproval: false, repoAgents: [] };
	const requested = new Set(requestedNames);
	const repoAgents = agents.filter((agent) => agent.source === "repo" && requested.has(agent.name));
	if (repoAgents.length === 0) return { requiresApproval: false, repoAgents };
	return {
		requiresApproval: true,
		repoAgents,
		reason: "Repo-local agents are repo-controlled and require trust approval before execution.",
	};
}

function realpathOrOriginal(filePath: string): string {
	try {
		return fs.realpathSync.native(filePath);
	} catch {
		return filePath;
	}
}

function sanitizeDiagnosticValue(value: string, maxChars: number): string {
	const sanitized = value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim();
	if (sanitized.length <= maxChars) return sanitized;
	return `${sanitized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatPathWithRealpath(filePath: string): string {
	const realpath = realpathOrOriginal(filePath);
	const formatted = realpath === filePath ? filePath : `${filePath} -> ${realpath}`;
	return sanitizeDiagnosticValue(formatted, MAX_DIAGNOSTIC_PATH_CHARS);
}

function formatDiagnosticField(value: string): string {
	return sanitizeDiagnosticValue(value, MAX_DIAGNOSTIC_FIELD_CHARS);
}

function formatDiagnosticToolList(tools: string[]): string {
	return sanitizeDiagnosticValue(tools.join(", "), MAX_DIAGNOSTIC_FIELD_CHARS);
}

export function getMutationCapableTools(agent: Pick<AgentConfig, "tools">): string[] {
	if (!agent.tools) return [];
	const declaredTools = new Set(agent.tools.map((tool) => tool.trim().toLowerCase()));
	return [...MUTATION_CAPABLE_TOOLS].filter((tool) => declaredTools.has(tool));
}

export function formatRepoAgentTrustDiagnostics(repoAgents: AgentConfig[], repoAgentsDir: string | null): string {
	const lines: string[] = [];
	const listedAgents = repoAgents.slice(0, MAX_DIAGNOSTIC_AGENTS);
	const remainingAgents = repoAgents.length - listedAgents.length;
	const mutationWarnings = repoAgents
		.map((agent) => ({ agent, tools: getMutationCapableTools(agent) }))
		.filter((entry) => entry.tools.length > 0);
	const listedMutationWarnings = mutationWarnings.slice(0, MAX_DIAGNOSTIC_AGENTS);
	const remainingMutationWarnings = mutationWarnings.length - listedMutationWarnings.length;

	if (mutationWarnings.length > 0) {
		const warningText = listedMutationWarnings
			.map((entry) => `${formatDiagnosticField(entry.agent.name)} (${entry.tools.join(", ")})`)
			.join("; ");
		lines.push(
			`Warning: mutation-capable repo-agent tools requested: ${warningText}${remainingMutationWarnings > 0 ? `; +${remainingMutationWarnings} more` : ""}.`,
		);
	}

	lines.push(`Repo agents dir: ${repoAgentsDir ? formatPathWithRealpath(repoAgentsDir) : "(unknown)"}`);
	lines.push("Repo agent details:");
	for (const agent of listedAgents) {
		const name = formatDiagnosticField(agent.name);
		const model = agent.model ? formatDiagnosticField(agent.model) : "(default)";
		const tools = agent.tools?.length ? formatDiagnosticToolList(agent.tools) : "(not declared; Pi defaults may apply)";
		lines.push(`- ${name}: model=${model}; tools=${tools}; file=${formatPathWithRealpath(agent.filePath)}`);
	}
	if (remainingAgents > 0) lines.push(`- ... ${remainingAgents} more repo agent${remainingAgents === 1 ? "" : "s"}`);
	return lines.join("\n");
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${formatAgentSource(a.source)}): ${a.description}`).join("; "),
		remaining,
	};
}
