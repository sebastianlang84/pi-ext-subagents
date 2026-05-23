import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const extensionModule = await jiti.import("../src/index.ts");
const executionModule = await jiti.import("../src/execution.ts");
const importedExtension = await jiti.import("../src/index.ts", { default: true });
const extension = typeof importedExtension === "function" ? importedExtension : importedExtension.default;
const { buildParallelToolResult, createContextScoutTool, createSubagentTool } = extensionModule;
const { executeSubagentPlan } = executionModule;

function registerExtension(deps) {
	if (deps) return createSubagentTool(deps);
	return registerTools().find((tool) => tool.name === "subagent");
}

function registerTools() {
	const registered = [];
	extension({
		on() {},
		registerTool(tool) { registered.push(tool); },
	});
	return registered;
}

function writeProjectAgent(project, name = "project-agent", extraFrontmatter = "") {
	const file = path.join(project, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const extra = extraFrontmatter ? `\n${extraFrontmatter}` : "";
	fs.writeFileSync(file, `---\nname: ${name}\ndescription: Project controlled${extra}\n---\n\nSystem prompt\n`);
}

function testCtx(cwd, overrides = {}) {
	return { cwd, hasUI: false, ui: { confirm: async () => false }, ...overrides };
}

function recordingRunner(calls) {
	return async (options) => {
		const call = {
			defaultCwd: options.defaultCwd,
			cwd: options.cwd,
			agentName: options.agentName,
			task: options.task,
			step: options.step,
		};
		if (options.timeoutMs !== undefined) call.timeoutMs = options.timeoutMs;
		if (options.maxOutputChars !== undefined) call.maxOutputChars = options.maxOutputChars;
		if (options.outputMode !== undefined) call.outputMode = options.outputMode;
		calls.push(call);
		const agent = options.agents.find((candidate) => candidate.name === options.agentName);
		return agentResult(options.agentName, `output:${options.task}`, 0, {
			agentSource: agent?.source ?? "unknown",
			task: options.task,
			step: options.step,
		});
	};
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

test("execution module runs a normalized plan through injected adapters", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-execution-plan-"));
	const calls = [];
	const result = await executeSubagentPlan(
		{ mode: "single", agentScope: "user", confirmProjectAgents: true, steps: [{ agent: "runner", task: "run" }] },
		testCtx(root),
		{
			deps: {
				discoverAgents: () => ({
					agents: [{ name: "runner", description: "Runner", source: "user", filePath: "runner.md", systemPrompt: "" }],
					projectAgentsDir: null,
					invalidAgents: [],
				}),
				runSingleAgent: recordingRunner(calls),
			},
		},
	);

	assert.equal(result.isError, undefined);
	assert.equal(result.content[0].text, "output:run");
	assert.equal(result.details.mode, "single");
	assert.deepEqual(calls, [{ defaultCwd: root, cwd: undefined, agentName: "runner", task: "run", step: undefined }]);
});

test("parallel tool results mark partial failures as errors and surface diagnostics", () => {
	const results = [
		agentResult("ok", "done"),
		agentResult("bad", "", 1, { stderr: "spawn failed" }),
		agentResult("stopped", "   ", 0, { errorMessage: "model stopped", stopReason: "error" }),
		agentResult("aborted", "partial", 1, { errorMessage: "Subagent was aborted.", stopReason: "aborted" }),
	];
	const result = buildParallelToolResult(results, {
		mode: "parallel",
		agentScope: "user",
		projectAgentsDir: null,
		invalidAgents: [],
		results,
	});

	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Parallel: 1\/4 succeeded/);
	assert.match(result.content[0].text, /\[bad\] failed: spawn failed/);
	assert.match(result.content[0].text, /\[stopped\] failed: model stopped/);
	assert.match(result.content[0].text, /\[aborted\] failed: Subagent was aborted\./);
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

test("extension loads and registers subagent and context_scout tools", () => {
	const tools = registerTools();
	assert.deepEqual(tools.map((tool) => tool.name), ["subagent", "context_scout"]);
	for (const tool of tools) {
		assert.equal(typeof tool.execute, "function");
		assert.ok(tool.parameters);
	}
});

test("context_scout runs fixed scout with read-only tool allowlist", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-scout-"));
	const calls = [];
	const tool = createContextScoutTool({
		discoverAgents: () => ({
			agents: [{
				name: "scout",
				description: "Scout",
				source: "user",
				filePath: "scout.md",
				systemPrompt: "Scout prompt",
				tools: ["read", "bash", "codemap_status", "codemap_search", "codemap_context"],
			}],
			projectAgentsDir: null,
			invalidAgents: [],
		}),
		runSingleAgent: async (options) => {
			calls.push(options);
			return agentResult("scout", "## Evidence\n- src/index.ts:1-3 — relevant", 0, { agentSource: "user", task: options.task });
		},
	});

	const result = await tool.execute("id", { question: "Which files define the tool?", scope: "src" }, undefined, undefined, testCtx(root));

	assert.equal(result.isError, undefined);
	assert.match(result.content[0].text, /src\/index\.ts:1-3/);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].agentName, "scout");
	assert.equal(calls[0].agents[0].name, "scout");
	assert.deepEqual(calls[0].agents[0].tools, ["read", "codemap_status", "codemap_search"]);
	assert.match(calls[0].task, /Do not make final review findings/);
});

test("context_scout enforces query and file budgets from scout tool calls", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-scout-budget-"));
	const tool = createContextScoutTool({
		discoverAgents: () => ({
			agents: [{ name: "scout", description: "Scout", source: "user", filePath: "scout.md", systemPrompt: "", tools: ["read", "codemap_search"] }],
			projectAgentsDir: null,
			invalidAgents: [],
		}),
		runSingleAgent: async () => agentResult("scout", undefined, 0, {
			messages: [{
				role: "assistant",
				content: [
					{ type: "toolCall", name: "codemap_search", arguments: { query: "one" } },
					{ type: "toolCall", name: "codemap_search", arguments: { query: "two" } },
					{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", name: "read", arguments: { path: "b.ts" } },
					{ type: "text", text: "evidence" },
				],
			}],
		}),
	});

	const queryExceeded = await tool.execute("id-1", { question: "q", budget: { maxQueries: 1, maxFiles: 2 } }, undefined, undefined, testCtx(root));
	const fileExceeded = await tool.execute("id-2", { question: "q", budget: { maxQueries: 2, maxFiles: 1 } }, undefined, undefined, testCtx(root));

	assert.equal(queryExceeded.isError, true);
	assert.match(queryExceeded.content[0].text, /query budget exceeded/);
	assert.deepEqual(queryExceeded.details.budgetUsage, { queries: 2, files: ["a.ts", "b.ts"] });
	assert.equal(fileExceeded.isError, true);
	assert.match(fileExceeded.content[0].text, /file budget exceeded/);
});

test("context_scout enforces call cap and output cap", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-scout-cap-"));
	const tool = createContextScoutTool({
		discoverAgents: () => ({
			agents: [{ name: "scout", description: "Scout", source: "user", filePath: "scout.md", systemPrompt: "", tools: ["read"] }],
			projectAgentsDir: null,
			invalidAgents: [],
		}),
		runSingleAgent: async () => agentResult("scout", "x".repeat(500), 0),
	}, { maxCalls: 2 });

	const first = await tool.execute("id-1", { question: "q", budget: { maxOutputChars: 200 } }, undefined, undefined, testCtx(root));
	const second = await tool.execute("id-2", { question: "q" }, undefined, undefined, testCtx(root));
	const third = await tool.execute("id-3", { question: "q" }, undefined, undefined, testCtx(root));

	assert.equal(first.details.outputTruncated, true);
	assert.ok(first.content[0].text.length <= 200 + 1);
	assert.equal(second.isError, undefined);
	assert.equal(third.isError, true);
	assert.match(third.content[0].text, /call cap exceeded/);
});

test("context_scout fails closed when scout is missing or unsafe", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-scout-safe-"));
	const missing = createContextScoutTool({
		discoverAgents: () => ({ agents: [], projectAgentsDir: null, invalidAgents: [] }),
		runSingleAgent: async () => assert.fail("must not run"),
	});
	const unsafe = createContextScoutTool({
		discoverAgents: () => ({
			agents: [{ name: "scout", description: "Scout", source: "user", filePath: "scout.md", systemPrompt: "", tools: ["read", "subagent"] }],
			projectAgentsDir: null,
			invalidAgents: [],
		}),
		runSingleAgent: async () => assert.fail("must not run"),
	});
	const implicitTools = createContextScoutTool({
		discoverAgents: () => ({
			agents: [{ name: "scout", description: "Scout", source: "user", filePath: "scout.md", systemPrompt: "" }],
			projectAgentsDir: null,
			invalidAgents: [],
		}),
		runSingleAgent: async () => assert.fail("must not run"),
	});

	assert.match((await missing.execute("id", { question: "q" }, undefined, undefined, testCtx(root))).content[0].text, /not found/);
	assert.match((await unsafe.execute("id", { question: "q" }, undefined, undefined, testCtx(root))).content[0].text, /forbidden tools/);
	assert.match((await implicitTools.execute("id", { question: "q" }, undefined, undefined, testCtx(root))).content[0].text, /explicit tools/);
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

test("single mode passes runtime controls to execution and formats bounded summary output", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ext-runtime-single-"));
	const project = path.join(root, "repo");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	writeProjectAgent(project, "runner");
	const calls = [];
	const tool = registerExtension({ runSingleAgent: recordingRunner(calls) });

	const result = await tool.execute(
		"id",
		{ agent: "runner", task: "run", agentScope: "project", confirmProjectAgents: false, timeoutMs: 50, maxOutputChars: 6, outputMode: "summary" },
		undefined,
		undefined,
		testCtx(project),
	);

	assert.equal(result.isError, undefined);
	assert.equal(result.content[0].text, "[runner] completed: out...");
	assert.deepEqual(calls, [{ defaultCwd: project, cwd: undefined, agentName: "runner", task: "run", step: undefined, timeoutMs: 50, maxOutputChars: 6, outputMode: "summary" }]);
});

test("single mode discovers project agents from context cwd and executes from request cwd", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ext-cwd-single-"));
	const project = path.join(root, "repo");
	const runDir = path.join(root, "run-here");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	fs.mkdirSync(runDir, { recursive: true });
	writeProjectAgent(project, "runner");
	const calls = [];
	const tool = registerExtension({ runSingleAgent: recordingRunner(calls) });

	const result = await tool.execute(
		"id",
		{ agent: "runner", task: "run", agentScope: "project", confirmProjectAgents: false, cwd: runDir },
		undefined,
		undefined,
		testCtx(project),
	);

	assert.equal(result.isError, undefined);
	assert.equal(result.content[0].text, "output:run");
	assert.deepEqual(calls, [{ defaultCwd: project, cwd: runDir, agentName: "runner", task: "run", step: undefined }]);
});

test("parallel mode discovers project agents from context cwd and passes each task cwd to execution", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ext-cwd-parallel-"));
	const project = path.join(root, "repo");
	const cwdA = path.join(root, "a");
	const cwdB = path.join(root, "b");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	for (const dir of [cwdA, cwdB]) fs.mkdirSync(dir, { recursive: true });
	writeProjectAgent(project, "runner");
	const calls = [];
	const tool = registerExtension({ runSingleAgent: recordingRunner(calls) });

	const result = await tool.execute(
		"id",
		{
			agentScope: "project",
			confirmProjectAgents: false,
			tasks: [
				{ agent: "runner", task: "one", cwd: cwdA },
				{ agent: "runner", task: "two", cwd: cwdB },
			],
		},
		undefined,
		undefined,
		testCtx(project),
	);

	assert.equal(result.isError, undefined);
	assert.equal(result.details.results.length, 2);
	assert.deepEqual(
		calls.sort((left, right) => left.task.localeCompare(right.task)),
		[
			{ defaultCwd: project, cwd: cwdA, agentName: "runner", task: "one", step: undefined },
			{ defaultCwd: project, cwd: cwdB, agentName: "runner", task: "two", step: undefined },
		],
	);
});

test("parallel mode applies per-task output controls", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ext-runtime-parallel-"));
	const project = path.join(root, "repo");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	writeProjectAgent(project, "runner");
	const tool = registerExtension({ runSingleAgent: recordingRunner([]) });

	const result = await tool.execute(
		"id",
		{
			agentScope: "project",
			confirmProjectAgents: false,
			tasks: [
				{ agent: "runner", task: "short", maxOutputChars: 8 },
				{ agent: "runner", task: "full", outputMode: "full", maxOutputChars: 30 },
			],
		},
		undefined,
		undefined,
		testCtx(project),
	);

	assert.equal(result.isError, undefined);
	assert.match(result.content[0].text, /\[runner\] completed: outpu\.\.\./);
	assert.match(result.content[0].text, /\[runner\] completed: output:full/);
});

test("chain mode discovers project agents from context cwd and passes each step cwd", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ext-cwd-chain-"));
	const project = path.join(root, "repo");
	const cwdA = path.join(root, "a");
	const cwdB = path.join(root, "b");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	for (const dir of [cwdA, cwdB]) fs.mkdirSync(dir, { recursive: true });
	writeProjectAgent(project, "runner");
	const calls = [];
	const tool = registerExtension({ runSingleAgent: recordingRunner(calls) });

	const result = await tool.execute(
		"id",
		{
			agentScope: "project",
			confirmProjectAgents: false,
			chain: [
				{ agent: "runner", task: "first", cwd: cwdA },
				{ agent: "runner", task: "second {previous}", cwd: cwdB },
			],
		},
		undefined,
		undefined,
		testCtx(project),
	);

	assert.equal(result.isError, undefined);
	assert.equal(result.content[0].text, "output:second output:first");
	assert.deepEqual(calls, [
		{ defaultCwd: project, cwd: cwdA, agentName: "runner", task: "first", step: 1 },
		{ defaultCwd: project, cwd: cwdB, agentName: "runner", task: "second output:first", step: 2 },
	]);
});

test("chain mode uses bounded prior output for handoff when controls are set", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ext-runtime-chain-"));
	const project = path.join(root, "repo");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	writeProjectAgent(project, "runner");
	const calls = [];
	const tool = registerExtension({ runSingleAgent: recordingRunner(calls) });

	const result = await tool.execute(
		"id",
		{
			agentScope: "project",
			confirmProjectAgents: false,
			chain: [
				{ agent: "runner", task: "first", maxOutputChars: 6 },
				{ agent: "runner", task: "second {previous}" },
			],
		},
		undefined,
		undefined,
		testCtx(project),
	);

	assert.equal(result.isError, undefined);
	assert.equal(calls[1].task, "second out...");
});

test("project-agent discovery uses context cwd, not the requested execution cwd", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ext-cwd-discovery-"));
	const project = path.join(root, "repo");
	const runProject = path.join(root, "run-repo");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	writeProjectAgent(project, "ctx-agent");
	writeProjectAgent(runProject, "run-agent");
	const tool = registerExtension({ runSingleAgent: async () => assert.fail("must not execute unknown agents") });

	const result = await tool.execute(
		"id",
		{ agent: "run-agent", task: "run", agentScope: "project", confirmProjectAgents: false, cwd: runProject },
		undefined,
		undefined,
		testCtx(project),
	);

	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Unknown agent: "run-agent"/);
	assert.match(result.content[0].text, /Available agents: ctx-agent \(project\)/);
	assert.equal(result.details.projectAgentsDir, path.join(project, ".pi", "agents"));
});

test("project-local agents fail closed in headless mode by default", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ext-headless-"));
	const project = path.join(root, "repo");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	writeProjectAgent(project, "danger", "tools: read, bash\nmodel: model-a");
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
	assert.match(result.content[0].text, /Warning: mutation-capable project-agent tools requested: danger \(bash\)\./);
	assert.match(result.content[0].text, /Project agents dir:/);
	assert.match(result.content[0].text, /danger: model=model-a; tools=read, bash; file=/);
	assert.equal(result.details.results.length, 0);
});

test("interactive project-local confirmation can cancel before execution", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ext-confirm-"));
	const project = path.join(root, "repo");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	writeProjectAgent(project, "danger", "tools: read, write");
	const tool = registerExtension();
	let promptMessage = "";

	const result = await tool.execute(
		"id",
		{ agent: "danger", task: "run", agentScope: "project" },
		undefined,
		undefined,
		{
			cwd: project,
			hasUI: true,
			ui: {
				confirm: async (_title, message) => {
					promptMessage = message;
					return false;
				},
			},
		},
	);

	assert.match(promptMessage, /Warning: mutation-capable project-agent tools requested: danger \(write\)\./);
	assert.match(promptMessage, /Project agent details:/);
	assert.match(promptMessage, /danger: model=\(default\); tools=read, write; file=/);
	assert.match(result.content[0].text, /not approved/);
	assert.equal(result.details.results.length, 0);
});
