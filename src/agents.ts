/**
 * Agent discovery, provenance, and repo-agent trust helpers.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "global" | "repo" | "global+repo";
export type AgentScopeInput = AgentScope | "both" | "user" | "project";
export type AgentSource = "global" | "bundled" | "repo";

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
	configuredAgentDirs?: string[];
	invalidAgents: InvalidAgentDiagnostic[];
}

export interface RepoAgentTrustDecision {
	requiresApproval: boolean;
	repoAgents: AgentConfig[];
	reason?: string;
}

interface LoadAgentsFromDirOptions {
	confineSymlinksToDir?: boolean;
	rejectRealpathsInside?: string[];
}

const MUTATION_CAPABLE_TOOLS = new Set(["bash", "write", "edit"]);
const MAX_DIAGNOSTIC_FIELD_CHARS = 120;
const MAX_DIAGNOSTIC_PATH_CHARS = 300;
const MAX_DIAGNOSTIC_AGENTS = 8;

export function normalizeAgentScope(value: unknown): AgentScope | undefined {
	switch (value) {
		case undefined:
		case "global":
		case "user":
			return "global";
		case "repo":
		case "project":
			return "repo";
		case "global+repo":
		case "both":
			return "global+repo";
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

function realpathOrOriginal(filePath: string): string {
	try {
		return fs.realpathSync.native(filePath);
	} catch {
		return filePath;
	}
}

function realpathIfPossible(filePath: string): string | undefined {
	try {
		return fs.realpathSync.native(filePath);
	} catch {
		return undefined;
	}
}

function isSameOrInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function loadAgentsFromDir(
	dir: string,
	source: AgentSource,
	options: LoadAgentsFromDirOptions = {},
): { agents: AgentConfig[]; invalidAgents: InvalidAgentDiagnostic[] } {
	const agents: AgentConfig[] = [];
	const invalidAgents: InvalidAgentDiagnostic[] = [];

	if (!fs.existsSync(dir)) return { agents, invalidAgents };

	const dirRealpath = realpathIfPossible(dir);
	if (options.confineSymlinksToDir && !dirRealpath) {
		invalidAgents.push({ source, filePath: dir, reason: "Unable to resolve agent directory realpath" });
		return { agents, invalidAgents };
	}

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
		const fileRealpath = realpathIfPossible(filePath);
		if (!fileRealpath) {
			invalidAgents.push({ source, filePath, reason: "Unable to resolve agent file realpath" });
			continue;
		}
		if (options.confineSymlinksToDir && dirRealpath && !isSameOrInside(dirRealpath, fileRealpath)) {
			invalidAgents.push({ source, filePath, reason: "Agent file symlink escapes its trusted agent directory" });
			continue;
		}
		const rejectedRoot = options.rejectRealpathsInside?.find((root) => isSameOrInside(root, fileRealpath));
		if (rejectedRoot) {
			invalidAgents.push({ source, filePath, reason: `Agent file realpath resolves inside a disallowed directory: ${rejectedRoot}` });
			continue;
		}

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

function findNearestGitRoot(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		if (isDirectory(path.join(currentDir, ".git"))) return currentDir;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function expandTilde(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

function getBundledAgentsDir(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
}

function getConfiguredAgentDirs(cwd: string, repoAgentsDir: string | null): { dirs: string[]; invalidAgents: InvalidAgentDiagnostic[] } {
	const dirs: string[] = [];
	const invalidAgents: InvalidAgentDiagnostic[] = [];
	const configPath = path.join(getAgentDir(), "extensions", "subagents.json");
	if (!fs.existsSync(configPath)) return { dirs, invalidAgents };

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch (error) {
		invalidAgents.push({ source: "global", filePath: configPath, reason: `Unable to parse subagents config: ${String(error)}` });
		return { dirs, invalidAgents };
	}
	if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { agentDirs?: unknown }).agentDirs)) {
		invalidAgents.push({ source: "global", filePath: configPath, reason: "subagents config must contain an agentDirs array" });
		return { dirs, invalidAgents };
	}

	const repoRoot = findNearestGitRoot(cwd);
	const repoRootRealpath = repoRoot ? realpathIfPossible(repoRoot) : undefined;
	const repoAgentsRealpath = repoAgentsDir ? realpathIfPossible(repoAgentsDir) : undefined;
	const seen = new Set<string>();
	for (const [index, value] of (parsed as { agentDirs: unknown[] }).agentDirs.entries()) {
		if (typeof value !== "string" || value.trim().length === 0) {
			invalidAgents.push({ source: "global", filePath: configPath, reason: `agentDirs[${index}] must be a non-empty string` });
			continue;
		}
		const expanded = path.normalize(expandTilde(value.trim()));
		if (!path.isAbsolute(expanded)) {
			invalidAgents.push({ source: "global", filePath: configPath, reason: `agentDirs[${index}] must be absolute or ~/ based` });
			continue;
		}
		const real = realpathIfPossible(expanded);
		if (!real || !isDirectory(real)) {
			invalidAgents.push({ source: "global", filePath: configPath, reason: `agentDirs[${index}] does not resolve to a readable directory` });
			continue;
		}
		if (repoRootRealpath && isSameOrInside(repoRootRealpath, real)) {
			invalidAgents.push({ source: "global", filePath: configPath, reason: `agentDirs[${index}] resolves inside the current repository and cannot bypass repo-agent trust` });
			continue;
		}
		if (repoAgentsRealpath && isSameOrInside(repoAgentsRealpath, real)) {
			invalidAgents.push({ source: "global", filePath: configPath, reason: `agentDirs[${index}] resolves inside repo .pi/agents and cannot bypass repo-agent trust` });
			continue;
		}
		if (!seen.has(real)) {
			seen.add(real);
			dirs.push(real);
		}
	}
	return { dirs, invalidAgents };
}

function setIfAbsent(agentMap: Map<string, AgentConfig>, agents: AgentConfig[]): void {
	for (const agent of agents) {
		if (!agentMap.has(agent.name)) agentMap.set(agent.name, agent);
	}
}

export function discoverAgents(cwd: string, scopeInput: unknown): AgentDiscoveryResult {
	const scope = normalizeAgentScope(scopeInput) ?? "global";
	const globalDir = path.join(getAgentDir(), "agents");
	const bundledDir = getBundledAgentsDir();
	const repoAgentsDir = findNearestRepoAgentsDir(cwd);
	const configured = scope === "repo" ? { dirs: [], invalidAgents: [] } : getConfiguredAgentDirs(cwd, repoAgentsDir);
	const repoRoot = findNearestGitRoot(cwd);
	const repoRootRealpath = repoRoot ? realpathIfPossible(repoRoot) : undefined;
	const rejectGlobalRealpathsInside = [repoRootRealpath, repoAgentsDir ? realpathIfPossible(repoAgentsDir) : undefined].filter(
		(Boolean),
	) as string[];

	const invalidAgents: InvalidAgentDiagnostic[] = [...configured.invalidAgents];
	const globalAgents: AgentConfig[] = [];
	if (scope !== "repo") {
		for (const dir of configured.dirs) {
			const discovery = loadAgentsFromDir(dir, "global", { confineSymlinksToDir: true, rejectRealpathsInside: rejectGlobalRealpathsInside });
			globalAgents.push(...discovery.agents);
			invalidAgents.push(...discovery.invalidAgents);
		}
		const userDiscovery = loadAgentsFromDir(globalDir, "global");
		globalAgents.push(...userDiscovery.agents);
		invalidAgents.push(...userDiscovery.invalidAgents);
		const bundledDiscovery = loadAgentsFromDir(bundledDir, "bundled");
		globalAgents.push(...bundledDiscovery.agents);
		invalidAgents.push(...bundledDiscovery.invalidAgents);
	}

	const repoDiscovery =
		scope === "global" || !repoAgentsDir
			? { agents: [], invalidAgents: [] }
			: loadAgentsFromDir(repoAgentsDir, "repo", { confineSymlinksToDir: true });
	invalidAgents.push(...repoDiscovery.invalidAgents);

	const agentMap = new Map<string, AgentConfig>();
	if (scope === "global") {
		setIfAbsent(agentMap, globalAgents);
	} else if (scope === "repo") {
		for (const agent of repoDiscovery.agents) agentMap.set(agent.name, agent);
	} else {
		setIfAbsent(agentMap, globalAgents);
		// Repo-local agents intentionally override same-named global/bundled agents only when both sources are enabled.
		for (const agent of repoDiscovery.agents) agentMap.set(agent.name, agent);
	}

	return {
		agents: Array.from(agentMap.values()),
		repoAgentsDir,
		configuredAgentDirs: configured.dirs,
		invalidAgents,
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
