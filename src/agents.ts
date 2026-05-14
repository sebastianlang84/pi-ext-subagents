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

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
