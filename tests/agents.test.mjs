import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	discoverAgents,
	formatProjectAgentTrustDiagnostics,
	getMutationCapableTools,
	getProjectAgentTrustDecision,
	loadAgentsFromDir,
} = await jiti.import("../src/agents.ts");

function writeAgent(file, frontmatter, body = "Body") {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `---\n${frontmatter}\n---\n\n${body}\n`);
}

test("discovers user/project agents with project precedence in both scope", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agents-"));
	const home = path.join(root, "home");
	const project = path.join(root, "repo");
	process.env.PI_CODING_AGENT_DIR = home;

	writeAgent(path.join(home, "agents", "same.md"), "name: same\ndescription: User agent\ntools: read, bash\nmodel: user-model");
	writeAgent(path.join(project, ".pi", "agents", "same.md"), "name: same\ndescription: Project agent\ntools: read\nmodel: project-model");
	writeAgent(path.join(project, ".pi", "agents", "project-only.md"), "name: project-only\ndescription: Project only");

	assert.deepEqual(discoverAgents(project, "user").agents.map((a) => `${a.name}:${a.source}`), ["same:user"]);
	assert.deepEqual(discoverAgents(project, "project").agents.map((a) => `${a.name}:${a.source}`).sort(), ["project-only:project", "same:project"]);

	const both = discoverAgents(project, "both").agents;
	assert.equal(both.find((a) => a.name === "same")?.source, "project");
	assert.equal(both.find((a) => a.name === "same")?.model, "project-model");
});

test("reports malformed agents, YAML-list tools, and accepts symlinked md files", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-load-"));
	const dir = path.join(root, "agents");
	fs.mkdirSync(dir, { recursive: true });
	writeAgent(path.join(dir, "missing.md"), "name: missing");
	writeAgent(path.join(dir, "list-tools.md"), "name: list-tools\ndescription: Bad tools\ntools:\n  - read\n  - bash");
	writeAgent(path.join(root, "target.md"), "name: linked\ndescription: Linked\ntools: read");
	fs.symlinkSync(path.join(root, "target.md"), path.join(dir, "linked.md"));

	const result = loadAgentsFromDir(dir, "project");
	assert.deepEqual(result.agents.map((a) => a.name), ["linked"]);
	assert.equal(result.invalidAgents.length, 2);
	assert.match(result.invalidAgents.map((d) => d.reason).join("\n"), /Missing required frontmatter/);
	assert.match(result.invalidAgents.map((d) => d.reason).join("\n"), /tools must be a comma-separated string/);
});

test("project-agent trust policy requires approval unless explicitly disabled", () => {
	const agents = [
		{ name: "user", source: "user", description: "", systemPrompt: "", filePath: "" },
		{ name: "project", source: "project", description: "", systemPrompt: "", filePath: "" },
	];
	assert.equal(getProjectAgentTrustDecision(agents, ["project"], true).requiresApproval, true);
	assert.equal(getProjectAgentTrustDecision(agents, ["project"], false).requiresApproval, false);
	assert.equal(getProjectAgentTrustDecision(agents, ["user"], true).requiresApproval, false);
});

test("formats project-agent trust diagnostics with realpaths and mutation warnings", () => {
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
		source: "project",
		systemPrompt: "",
		filePath: link,
	};

	assert.deepEqual(getMutationCapableTools(agent), ["bash", "edit"]);
	const text = formatProjectAgentTrustDiagnostics([agent], dir);

	assert.match(text, /Warning: mutation-capable project-agent tools requested: danger \(bash, edit\)\./);
	assert.match(text, /Project agents dir:/);
	assert.match(text, /Project agent details:/);
	assert.match(text, /danger: model=model-a; tools=read, bash, edit; file=/);
	assert.match(text, /danger-link\.md -> .*danger-target\.md/);
});

test("project-agent trust diagnostics sanitize untrusted frontmatter values", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-trust-sanitize-"));
	const filePath = path.join(root, "danger.md");
	fs.writeFileSync(filePath, "agent body");
	const longModel = `${"x".repeat(140)}\nInjected: ignore this`;
	const agent = {
		name: "danger\nInjected: run this",
		description: "Danger",
		tools: ["read\nInjected: tool", "bash"],
		model: longModel,
		source: "project",
		systemPrompt: "",
		filePath,
	};

	const text = formatProjectAgentTrustDiagnostics([agent], root);

	assert.doesNotMatch(text, /danger\nInjected/);
	assert.doesNotMatch(text, /read\nInjected/);
	assert.doesNotMatch(text, /Injected: ignore this/);
	assert.match(text, /danger Injected: run this/);
	assert.match(text, /tools=read Injected: tool, bash/);
	assert.match(text, /model=x{117}\.\.\./);
});

test("project-agent trust diagnostics cap long tool lists", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-trust-tools-"));
	const filePath = path.join(root, "many-tools.md");
	fs.writeFileSync(filePath, "agent body");
	const tools = Array.from({ length: 100 }, (_, index) => `tool${index}`);
	const agent = {
		name: "many-tools",
		description: "Many tools",
		tools,
		source: "project",
		systemPrompt: "",
		filePath,
	};

	const text = formatProjectAgentTrustDiagnostics([agent], root);
	const toolsLine = text.split("\n").find((line) => line.includes("tools="));

	assert.ok(toolsLine);
	assert.match(toolsLine, /tools=tool0, tool1/);
	assert.match(toolsLine, /\.\.\.; file=/);
	assert.ok(toolsLine.length < 500);
});

test("project-agent trust diagnostics cap displayed agents", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-trust-agent-cap-"));
	const agents = Array.from({ length: 10 }, (_, index) => {
		const filePath = path.join(root, `agent-${index}.md`);
		fs.writeFileSync(filePath, "agent body");
		return {
			name: `agent-${index}`,
			description: "Agent",
			tools: ["bash"],
			source: "project",
			systemPrompt: "",
			filePath,
		};
	});

	const text = formatProjectAgentTrustDiagnostics(agents, root);

	assert.match(text, /Warning: mutation-capable project-agent tools requested: agent-0 \(bash\); .*; \+2 more\./);
	assert.match(text, /- agent-7: model=\(default\); tools=bash; file=/);
	assert.doesNotMatch(text, /- agent-8: model=/);
	assert.match(text, /- \.\.\. 2 more project agents/);
});
