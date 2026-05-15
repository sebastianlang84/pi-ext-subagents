/**
 * Agent discovery, provenance, and project-agent trust helpers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project";

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
	projectAgentsDir: string | null;
	invalidAgents: InvalidAgentDiagnostic[];
}

export interface ProjectAgentTrustDecision {
	requiresApproval: boolean;
	projectAgents: AgentConfig[];
	reason?: string;
}

const MUTATION_CAPABLE_TOOLS = new Set(["bash", "write", "edit"]);
const MAX_DIAGNOSTIC_FIELD_CHARS = 120;
const MAX_DIAGNOSTIC_PATH_CHARS = 300;
const MAX_DIAGNOSTIC_AGENTS = 8;

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

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userDiscovery = scope === "project" ? { agents: [], invalidAgents: [] } : loadAgentsFromDir(userDir, "user");
	const projectDiscovery =
		scope === "user" || !projectAgentsDir
			? { agents: [], invalidAgents: [] }
			: loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userDiscovery.agents) agentMap.set(agent.name, agent);
		// Project-local agents intentionally override same-named user agents only when explicitly enabled.
		for (const agent of projectDiscovery.agents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userDiscovery.agents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectDiscovery.agents) agentMap.set(agent.name, agent);
	}

	return {
		agents: Array.from(agentMap.values()),
		projectAgentsDir,
		invalidAgents: [...userDiscovery.invalidAgents, ...projectDiscovery.invalidAgents],
	};
}

export function getProjectAgentTrustDecision(
	agents: AgentConfig[],
	requestedNames: Iterable<string>,
	confirmProjectAgents: boolean,
): ProjectAgentTrustDecision {
	if (!confirmProjectAgents) return { requiresApproval: false, projectAgents: [] };
	const requested = new Set(requestedNames);
	const projectAgents = agents.filter((agent) => agent.source === "project" && requested.has(agent.name));
	if (projectAgents.length === 0) return { requiresApproval: false, projectAgents };
	return {
		requiresApproval: true,
		projectAgents,
		reason: "Project-local agents are repo-controlled and require trust approval before execution.",
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

export function formatProjectAgentTrustDiagnostics(projectAgents: AgentConfig[], projectAgentsDir: string | null): string {
	const lines: string[] = [];
	const listedAgents = projectAgents.slice(0, MAX_DIAGNOSTIC_AGENTS);
	const remainingAgents = projectAgents.length - listedAgents.length;
	const mutationWarnings = projectAgents
		.map((agent) => ({ agent, tools: getMutationCapableTools(agent) }))
		.filter((entry) => entry.tools.length > 0);
	const listedMutationWarnings = mutationWarnings.slice(0, MAX_DIAGNOSTIC_AGENTS);
	const remainingMutationWarnings = mutationWarnings.length - listedMutationWarnings.length;

	if (mutationWarnings.length > 0) {
		const warningText = listedMutationWarnings
			.map((entry) => `${formatDiagnosticField(entry.agent.name)} (${entry.tools.join(", ")})`)
			.join("; ");
		lines.push(
			`Warning: mutation-capable project-agent tools requested: ${warningText}${remainingMutationWarnings > 0 ? `; +${remainingMutationWarnings} more` : ""}.`,
		);
	}

	lines.push(`Project agents dir: ${projectAgentsDir ? formatPathWithRealpath(projectAgentsDir) : "(unknown)"}`);
	lines.push("Project agent details:");
	for (const agent of listedAgents) {
		const name = formatDiagnosticField(agent.name);
		const model = agent.model ? formatDiagnosticField(agent.model) : "(default)";
		const tools = agent.tools?.length ? formatDiagnosticToolList(agent.tools) : "(not declared; Pi defaults may apply)";
		lines.push(`- ${name}: model=${model}; tools=${tools}; file=${formatPathWithRealpath(agent.filePath)}`);
	}
	if (remainingAgents > 0) lines.push(`- ... ${remainingAgents} more project agent${remainingAgents === 1 ? "" : "s"}`);
	return lines.join("\n");
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
