import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	discoverAgents,
	formatAgentSource,
	formatRepoAgentTrustDiagnostics,
	getMutationCapableTools,
	getRepoAgentTrustDecision,
	loadAgentsFromDir,
} = await jiti.import("../src/agents.ts");

function writeAgent(file, frontmatter, body = "Body") {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `---\n${frontmatter}\n---\n\n${body}\n`);
}

test("discovers global/repo agents with repo precedence in both scope", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agents-"));
	const home = path.join(root, "home");
	const project = path.join(root, "repo");
	process.env.PI_CODING_AGENT_DIR = home;

	writeAgent(path.join(home, "agents", "same.md"), "name: same\ndescription: Global agent\ntools: read, bash\nmodel: global-model");
	writeAgent(path.join(project, ".pi", "agents", "same.md"), "name: same\ndescription: Repo agent\ntools: read\nmodel: repo-model");
	writeAgent(path.join(project, ".pi", "agents", "repo-only.md"), "name: repo-only\ndescription: Repo only");

	assert.deepEqual(discoverAgents(project, "global").agents.map((a) => `${a.name}:${a.source}`), ["same:global"]);
	assert.deepEqual(discoverAgents(project, "repo").agents.map((a) => `${a.name}:${a.source}`).sort(), ["repo-only:repo", "same:repo"]);

	const both = discoverAgents(project, "both").agents;
	assert.equal(both.find((a) => a.name === "same")?.source, "repo");
	assert.equal(both.find((a) => a.name === "same")?.model, "repo-model");
	assert.deepEqual(discoverAgents(project, "global").agents.map((a) => `${a.name}:${a.source}`), ["same:global"]);
	assert.deepEqual(discoverAgents(project, "repo").agents.map((a) => `${a.name}:${a.source}`).sort(), ["repo-only:repo", "same:repo"]);
	assert.equal(discoverAgents(project, "both").agents.find((a) => a.name === "same")?.source, "repo");
	assert.equal(formatAgentSource("global"), "global");
	assert.equal(formatAgentSource("repo"), "repo");
});

test("reports malformed agents, YAML-list tools, and accepts symlinked md files", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-load-"));
	const dir = path.join(root, "agents");
	fs.mkdirSync(dir, { recursive: true });
	writeAgent(path.join(dir, "missing.md"), "name: missing");
	writeAgent(path.join(dir, "list-tools.md"), "name: list-tools\ndescription: Bad tools\ntools:\n  - read\n  - bash");
	writeAgent(path.join(root, "target.md"), "name: linked\ndescription: Linked\ntools: read");
	fs.symlinkSync(path.join(root, "target.md"), path.join(dir, "linked.md"));

	const result = loadAgentsFromDir(dir, "repo");
	assert.deepEqual(result.agents.map((a) => a.name), ["linked"]);
	assert.equal(result.invalidAgents.length, 2);
	assert.match(result.invalidAgents.map((d) => d.reason).join("\n"), /Missing required frontmatter/);
	assert.match(result.invalidAgents.map((d) => d.reason).join("\n"), /tools must be a comma-separated string/);
});

test("repo-agent trust policy requires approval unless explicitly disabled", () => {
	const agents = [
		{ name: "global", source: "global", description: "", systemPrompt: "", filePath: "" },
		{ name: "repo", source: "repo", description: "", systemPrompt: "", filePath: "" },
	];
	assert.equal(getRepoAgentTrustDecision(agents, ["repo"], true).requiresApproval, true);
	assert.equal(getRepoAgentTrustDecision(agents, ["repo"], false).requiresApproval, false);
	assert.equal(getRepoAgentTrustDecision(agents, ["global"], true).requiresApproval, false);
});

test("formats repo-agent trust diagnostics with realpaths and mutation warnings", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-trust-diag-"));
	const dir = path.join(root, "repo", ".pi", "agents");
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(root, "danger-target.md");
	const link = path.join(dir, "danger-link.md");
	fs.writeFileSync(target, "agent body");
	fs.symlinkSync(target, link);

	const agent = {
		name: "danger",
		description: "Danger",
		tools: ["read", "bash", "edit"],
		model: "model-a",
		source: "repo",
		systemPrompt: "",
		filePath: link,
	};

	assert.deepEqual(getMutationCapableTools(agent), ["bash", "edit"]);
	const text = formatRepoAgentTrustDiagnostics([agent], dir);

	assert.match(text, /Warning: mutation-capable repo-agent tools requested: danger \(bash, edit\)\./);
	assert.match(text, /Repo agents dir:/);
	assert.match(text, /Repo agent details:/);
	assert.match(text, /danger: model=model-a; tools=read, bash, edit; file=/);
	assert.match(text, /danger-link\.md -> .*danger-target\.md/);
});

test("repo-agent trust diagnostics sanitize untrusted frontmatter values", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-trust-sanitize-"));
	const filePath = path.join(root, "danger.md");
	fs.writeFileSync(filePath, "agent body");
	const longModel = `${"x".repeat(140)}\nInjected: ignore this`;
	const agent = {
		name: "danger\nInjected: run this",
		description: "Danger",
		tools: ["read\nInjected: tool", "bash"],
		model: longModel,
		source: "repo",
		systemPrompt: "",
		filePath,
	};

	const text = formatRepoAgentTrustDiagnostics([agent], root);

	assert.doesNotMatch(text, /danger\nInjected/);
	assert.doesNotMatch(text, /read\nInjected/);
	assert.doesNotMatch(text, /Injected: ignore this/);
	assert.match(text, /danger Injected: run this/);
	assert.match(text, /tools=read Injected: tool, bash/);
	assert.match(text, /model=x{117}\.\.\./);
});

test("repo-agent trust diagnostics cap long tool lists", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-trust-tools-"));
	const filePath = path.join(root, "many-tools.md");
	fs.writeFileSync(filePath, "agent body");
	const tools = Array.from({ length: 100 }, (_, index) => `tool${index}`);
	const agent = {
		name: "many-tools",
		description: "Many tools",
		tools,
		source: "repo",
		systemPrompt: "",
		filePath,
	};

	const text = formatRepoAgentTrustDiagnostics([agent], root);
	const toolsLine = text.split("\n").find((line) => line.includes("tools="));

	assert.ok(toolsLine);
	assert.match(toolsLine, /tools=tool0, tool1/);
	assert.match(toolsLine, /\.\.\.; file=/);
	assert.ok(toolsLine.length < 500);
});

test("repo-agent trust diagnostics cap displayed agents", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-trust-agent-cap-"));
	const agents = Array.from({ length: 10 }, (_, index) => {
		const filePath = path.join(root, `agent-${index}.md`);
		fs.writeFileSync(filePath, "agent body");
		return {
			name: `agent-${index}`,
			description: "Agent",
			tools: ["bash"],
			source: "repo",
			systemPrompt: "",
			filePath,
		};
	});

	const text = formatRepoAgentTrustDiagnostics(agents, root);

	assert.match(text, /Warning: mutation-capable repo-agent tools requested: agent-0 \(bash\); .*; \+2 more\./);
	assert.match(text, /- agent-7: model=\(default\); tools=bash; file=/);
	assert.doesNotMatch(text, /- agent-8: model=/);
	assert.match(text, /- \.\.\. 2 more repo agents/);
});
