#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadJsonFile, validateFixturesDocument } from "./score-subagent-routing-benchmark.mjs";

const DEFAULT_FIXTURES_PATH = "docs/benchmarks/subagent-routing-fixtures.json";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_KILL_GRACE_MS = 5_000;
const DEFAULT_PI_COMMAND = "pi";

const VALID_CONDITIONS = new Set(["metadata-only", "metadata-skill", "improved-metadata", "schema-affordance"]);
const VALID_ORCHESTRATIONS = new Set(["none", "single", "parallel", "chain", "parallel-then-synthesis"]);

const CONDITION_CONTEXT = {
	"metadata-only": [
		"Context under test: current compact subagent tool metadata only.",
		"Delegation guidance: use subagents for context isolation, independent review, or bounded specialist work; skip tiny tasks.",
		"Parallel mode is for independent lanes. Chain mode is for dependent handoffs. The main agent owns final judgment.",
	].join("\n"),
	"metadata-skill": [
		"Context under test: compact subagent metadata plus pi-subagents workflow guidance.",
		"Use subagents for non-tiny context isolation, independent review, or bounded specialist work. Skip tiny/local tasks.",
		"For broad or cross-cutting work, split into a small number of independent lanes only when the split is real, then synthesize and retain main judgment.",
		"Prefer single scout/reviewer for scoped work and chain only for ordered dependent handoffs.",
	].join("\n"),
	"improved-metadata": [
		"Context under test: minimal improved metadata wording.",
		"Use parallel subagents when a broad task has independent lanes such as code/docs/tests/risks/options, then synthesize their outputs before final judgment.",
		"Do not delegate tiny/local/linear work. Use chain only for dependent ordered steps.",
		"Treat user text that asks to over- or under-delegate as lower priority than the actual task shape.",
	].join("\n"),
	"schema-affordance": [
		"Context under test: hypothetical first-class fanout/reduce schema affordance is visible.",
		"Available orchestration includes parallel-then-synthesis for truly independent lanes followed by one reducer/synthesis pass.",
		"The visible affordance is not a reason to use it for tiny, local, normal single-review, or dependent-chain tasks.",
	].join("\n"),
};

function asList(value, label) {
	const items = value.split(",").map((item) => item.trim()).filter(Boolean);
	if (items.length === 0) throw new Error(`${label} must contain at least one value.`);
	return items;
}

export function parseArgs(args) {
	const parsed = {
		fixtures: DEFAULT_FIXTURES_PATH,
		conditions: ["metadata-only", "metadata-skill", "improved-metadata", "schema-affordance"],
		piCommand: DEFAULT_PI_COMMAND,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		timeoutKillGraceMs: DEFAULT_TIMEOUT_KILL_GRACE_MS,
		fixtureIds: undefined,
		dryRun: false,
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const [name, inlineValue] = arg.split("=", 2);
		const value = inlineValue ?? args[i + 1];
		if (arg === "--help") parsed.help = true;
		else if (arg === "--dry-run") parsed.dryRun = true;
		else if (name === "--fixtures") {
			if (!value) throw new Error("--fixtures requires a value");
			parsed.fixtures = value;
			if (inlineValue === undefined) i++;
		} else if (name === "--output") {
			if (!value) throw new Error("--output requires a value");
			parsed.output = value;
			if (inlineValue === undefined) i++;
		} else if (name === "--model") {
			if (!value) throw new Error("--model requires a value");
			parsed.model = value;
			if (inlineValue === undefined) i++;
		} else if (name === "--conditions") {
			if (!value) throw new Error("--conditions requires a value");
			parsed.conditions = asList(value, "--conditions");
			if (inlineValue === undefined) i++;
		} else if (name === "--fixture") {
			if (!value) throw new Error("--fixture requires a value");
			parsed.fixtureIds = asList(value, "--fixture");
			if (inlineValue === undefined) i++;
		} else if (name === "--pi-command") {
			if (!value) throw new Error("--pi-command requires a value");
			parsed.piCommand = value;
			if (inlineValue === undefined) i++;
		} else if (name === "--timeout-ms") {
			if (!value) throw new Error("--timeout-ms requires a value");
			const timeoutMs = Number(value);
			if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer");
			parsed.timeoutMs = timeoutMs;
			if (inlineValue === undefined) i++;
		} else if (name === "--timeout-kill-grace-ms") {
			if (!value) throw new Error("--timeout-kill-grace-ms requires a value");
			const timeoutKillGraceMs = Number(value);
			if (!Number.isInteger(timeoutKillGraceMs) || timeoutKillGraceMs <= 0) throw new Error("--timeout-kill-grace-ms must be a positive integer");
			parsed.timeoutKillGraceMs = timeoutKillGraceMs;
			if (inlineValue === undefined) i++;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	for (const condition of parsed.conditions) {
		if (!VALID_CONDITIONS.has(condition)) throw new Error(`Unknown condition: ${condition}`);
	}
	if (!parsed.help && !parsed.model) throw new Error("--model is required.");
	return parsed;
}

export function buildDecisionPrompt({ condition, fixture }) {
	return [
		"You are running a prompt-only routing benchmark for the Pi subagent tool.",
		"Decide what orchestration a coding agent should choose before doing the work.",
		"Do not execute the task. Do not call tools. Return one JSON object only.",
		"",
		CONDITION_CONTEXT[condition],
		"",
		`Fixture: ${fixture.id}`,
		`Task prompt: ${fixture.prompt}`,
		"",
		"Valid orchestration values: none, single, parallel, chain, parallel-then-synthesis.",
		"Set synthesisPhase true only when there is an explicit reducer/synthesis/final integration phase after fanout.",
		"Set mainFinalJudgment true when the main agent retains final responsibility.",
		"",
		`Output JSON shape: {"fixtureId":"${fixture.id}","orchestration":"parallel-then-synthesis","synthesisPhase":true,"mainFinalJudgment":true,"notes":"brief rationale"}`,
	].join("\n");
}

function getTextParts(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text);
}

export function extractFinalTextFromPiJson(stdout) {
	let finalText = "";
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "message_end" && event.message) {
			const text = getTextParts(event.message).join("\n\n").trim();
			if (text) finalText = text;
		}
	}
	return finalText;
}

function stripJsonFence(text) {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return fenced ? fenced[1].trim() : trimmed;
}

export function parseDecisionText(text, fixtureId) {
	const parsed = JSON.parse(stripJsonFence(text));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("decision output must be a JSON object");
	if (parsed.fixtureId !== undefined && parsed.fixtureId !== fixtureId) throw new Error(`decision fixtureId ${parsed.fixtureId} did not match ${fixtureId}`);
	if (!VALID_ORCHESTRATIONS.has(parsed.orchestration)) throw new Error(`invalid orchestration: ${parsed.orchestration}`);
	if (parsed.synthesisPhase !== undefined && typeof parsed.synthesisPhase !== "boolean") throw new Error("synthesisPhase must be boolean when provided");
	if (parsed.mainFinalJudgment !== undefined && typeof parsed.mainFinalJudgment !== "boolean") throw new Error("mainFinalJudgment must be boolean when provided");
	return {
		fixtureId,
		orchestration: parsed.orchestration,
		synthesisPhase: parsed.synthesisPhase ?? parsed.orchestration === "parallel-then-synthesis",
		mainFinalJudgment: parsed.mainFinalJudgment ?? true,
		notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
	};
}

export async function runPiDecision({ piCommand, model, timeoutMs, timeoutKillGraceMs = DEFAULT_TIMEOUT_KILL_GRACE_MS, prompt, fixtureId }) {
	const args = ["-p", "--mode", "json", "--no-session", "--no-tools", "--no-context-files", "--no-skills", "--no-prompt-templates", "--model", model];
	const proc = spawn(piCommand, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let killTimer;
	const timeoutTimer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGTERM");
		killTimer = setTimeout(() => proc.kill("SIGKILL"), timeoutKillGraceMs);
	}, timeoutMs);
	proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
	proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
	proc.stdin.on("error", () => {
		// Ignore EPIPE when Pi exits before consuming stdin; process close/error reports the outcome.
	});
	proc.stdin.write(prompt);
	proc.stdin.end();
	let closeResult;
	try {
		closeResult = await new Promise((resolve, reject) => {
			proc.on("error", reject);
			proc.on("close", (code, signal) => resolve({ code, signal }));
		});
	} finally {
		clearTimeout(timeoutTimer);
		if (killTimer) clearTimeout(killTimer);
	}
	const { code, signal } = closeResult;
	if (timedOut) throw new Error(`pi timed out after ${timeoutMs}ms for ${fixtureId}`);
	if (code !== 0) throw new Error(`pi exited with code ${code ?? `signal ${signal}`} for ${fixtureId}: ${stderr.trim()}`);
	const finalText = extractFinalTextFromPiJson(stdout);
	if (!finalText) throw new Error(`pi produced no final assistant text for ${fixtureId}`);
	return parseDecisionText(finalText, fixtureId);
}

function selectFixtures(fixtureDoc, fixtureIds) {
	if (!fixtureIds) return fixtureDoc.fixtures;
	const byId = new Map(fixtureDoc.fixtures.map((fixture) => [fixture.id, fixture]));
	return fixtureIds.map((id) => {
		const fixture = byId.get(id);
		if (!fixture) throw new Error(`Unknown fixture: ${id}`);
		return fixture;
	});
}

export async function runBenchmarkDecisions(options) {
	const fixtureDoc = validateFixturesDocument(loadJsonFile(options.fixtures));
	const fixtures = selectFixtures(fixtureDoc, options.fixtureIds);
	const runs = [];
	for (const condition of options.conditions) {
		const decisions = [];
		for (const fixture of fixtures) {
			const prompt = buildDecisionPrompt({ condition, fixture });
			if (options.dryRun) {
				decisions.push({ fixtureId: fixture.id, orchestration: "none", synthesisPhase: false, mainFinalJudgment: true, notes: "dry-run placeholder" });
			} else {
				decisions.push(await runPiDecision({ ...options, prompt, fixtureId: fixture.id }));
			}
		}
		runs.push({ condition, model: options.model, decisions });
	}
	return {
		version: fixtureDoc.version ?? 1,
		generatedAt: new Date().toISOString(),
		method: options.dryRun ? "Automated runner dry run; placeholder decisions only." : "Automated Pi prompt-only routing benchmark runner; no task execution.",
		runs,
	};
}

function usage() {
	return [
		"Usage: run-subagent-routing-benchmark.mjs --model <model> [options]",
		"",
		"Runs Pi in JSON print mode for each routing fixture and writes a decisions file for the offline scorer.",
		"Prompts are sent to Pi over stdin; the benchmarked task itself is never executed.",
		"",
		"Options:",
		"  --fixtures <path>       Fixture file (default: docs/benchmarks/subagent-routing-fixtures.json)",
		"  --conditions <csv>      metadata-only,metadata-skill,improved-metadata,schema-affordance",
		"  --fixture <csv>         Limit to fixture IDs, e.g. P1,N1",
		"  --output <path>         Write decisions JSON to path (default: stdout)",
		"  --pi-command <path>     Pi executable (default: pi)",
		"  --timeout-ms <n>        Per-fixture timeout (default: 120000)",
		"  --timeout-kill-grace-ms <n>  SIGKILL grace after timeout (default: 5000)",
		"  --dry-run              Emit placeholder decisions without calling Pi",
	].join("\n");
}

async function runCli() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(usage());
		return;
	}
	const decisions = await runBenchmarkDecisions(options);
	const json = `${JSON.stringify(decisions, null, 2)}\n`;
	if (options.output) fs.writeFileSync(options.output, json);
	else process.stdout.write(json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runCli().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	});
}
