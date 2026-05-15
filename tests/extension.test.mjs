import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const extensionModule = await jiti.import("../src/index.ts");
const importedExtension = await jiti.import("../src/index.ts", { default: true });
const extension = typeof importedExtension === "function" ? importedExtension : importedExtension.default;
const { buildParallelToolResult } = extensionModule;

function registerExtension() {
	let registered;
	extension({ registerTool(tool) { registered = tool; } });
	return registered;
}

function writeProjectAgent(project, name = "project-agent") {
	const file = path.join(project, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `---\nname: ${name}\ndescription: Project controlled\n---\n\nSystem prompt\n`);
}

function agentResult(agent, text, exitCode = 0, overrides = {}) {
	return {
		agent,
		agentSource: "user",
		task: `task-${agent}`,
		exitCode,
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		messages: text
			? [{ role: "assistant", content: [{ type: "text", text }] }]
			: [],
		...overrides,
	};
}

test("parallel tool results mark partial failures as errors and surface diagnostics", () => {
	const results = [
		agentResult("ok", "done"),
		agentResult("bad", "", 1, { stderr: "spawn failed" }),
		agentResult("stopped", "   ", 0, { errorMessage: "model stopped", stopReason: "error" }),
	];
	const result = buildParallelToolResult(results, {
		mode: "parallel",
		agentScope: "user",
		projectAgentsDir: null,
		invalidAgents: [],
		results,
	});

	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Parallel: 1\/3 succeeded/);
	assert.match(result.content[0].text, /\[bad\] failed: spawn failed/);
	assert.match(result.content[0].text, /\[stopped\] failed: model stopped/);
});

test("parallel summaries prefer failure diagnostics over partial assistant output", () => {
	const results = [
		agentResult("bad", "misleading partial assistant text", 1, {
			errorMessage: "child exited 1",
			stderr: "spawn failed",
		}),
	];
	const result = buildParallelToolResult(results, {
		mode: "parallel",
		agentScope: "user",
		projectAgentsDir: null,
		invalidAgents: [],
		results,
	});

	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /\[bad\] failed: child exited 1/);
	assert.doesNotMatch(result.content[0].text, /misleading partial assistant text/);
});

test("extension loads and registers the subagent tool", () => {
	const tool = registerExtension();
	assert.equal(tool.name, "subagent");
	assert.equal(typeof tool.execute, "function");
	assert.ok(tool.parameters);
});

test("package manifest pi.extensions points to the source entrypoint", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
	assert.deepEqual(packageJson.pi?.extensions, ["./src/index.ts"]);
	assert.equal(fs.existsSync(path.join(process.cwd(), "src", "index.ts")), true);
});

test("execute reports normalized invalid-mode errors", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ext-invalid-"));
	const home = path.join(root, "home");
	process.env.PI_CODING_AGENT_DIR = home;
	fs.mkdirSync(path.join(home, "agents"), { recursive: true });
	fs.writeFileSync(path.join(home, "agents", "broken.md"), "---\nname: broken\n---\n\nBody\n");
	const tool = registerExtension();
	const result = await tool.execute(
		"id",
		{ agent: "a", task: "x", tasks: [{ agent: "b", task: "y" }] },
		undefined,
		undefined,
		{ cwd: root, hasUI: false, ui: { confirm: async () => false } },
	);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Provide exactly one mode/);
	assert.match(result.content[0].text, /Invalid agents:/);
	assert.equal(result.details.invalidAgents.length, 1);
});

test("execute reports invalid requested agents before spawning", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ext-invalid-agent-"));
	const project = path.join(root, "repo");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(project, ".pi", "agents", "broken.md"), "---\nname: broken\n---\n\nBody\n");
	const tool = registerExtension();

	const result = await tool.execute(
		"id",
		{ agent: "broken", task: "run", agentScope: "project", confirmProjectAgents: false },
		undefined,
		undefined,
		{ cwd: project, hasUI: false, ui: { confirm: async () => assert.fail("must not prompt or spawn") } },
	);

	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Unknown agent: "broken"/);
	assert.match(result.content[0].text, /Invalid agents:/);
	assert.match(result.content[0].text, /Missing required frontmatter/);
	assert.equal(result.details.invalidAgents.length, 1);
	assert.equal(result.details.results.length, 0);
});

test("project-local agents fail closed in headless mode by default", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ext-headless-"));
	const project = path.join(root, "repo");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	writeProjectAgent(project, "danger");
	const tool = registerExtension();

	const result = await tool.execute(
		"id",
		{ agent: "danger", task: "run", agentScope: "project" },
		undefined,
		undefined,
		{ cwd: project, hasUI: false, ui: { confirm: async () => assert.fail("must not prompt without UI") } },
	);

	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /require interactive confirmation/);
	assert.equal(result.details.results.length, 0);
});

test("interactive project-local confirmation can cancel before execution", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ext-confirm-"));
	const project = path.join(root, "repo");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	writeProjectAgent(project, "danger");
	const tool = registerExtension();
	let prompted = false;

	const result = await tool.execute(
		"id",
		{ agent: "danger", task: "run", agentScope: "project" },
		undefined,
		undefined,
		{ cwd: project, hasUI: true, ui: { confirm: async () => { prompted = true; return false; } } },
	);

	assert.equal(prompted, true);
	assert.match(result.content[0].text, /not approved/);
	assert.equal(result.details.results.length, 0);
});
