import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const importedExtension = await jiti.import("../src/index.ts", { default: true });
const extension = typeof importedExtension === "function" ? importedExtension : importedExtension.default;

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

test("extension loads and registers the subagent tool", () => {
	const tool = registerExtension();
	assert.equal(tool.name, "subagent");
	assert.equal(typeof tool.execute, "function");
	assert.ok(tool.parameters);
});

test("execute reports normalized invalid-mode errors", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ext-invalid-"));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
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
