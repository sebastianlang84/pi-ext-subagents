import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadJsonFile, scoreBenchmark, scoreDecision, summarizeFixtures } from "../scripts/score-subagent-routing-benchmark.mjs";
import { buildDecisionPrompt, extractFinalTextFromPiJson, parseDecisionText, runBenchmarkDecisions, runPiDecision } from "../scripts/run-subagent-routing-benchmark.mjs";

const fixtures = loadJsonFile("docs/benchmarks/subagent-routing-fixtures.json");
const dispatcherSmokeFixtures = loadJsonFile("docs/benchmarks/dispatcher-smoke-fixtures.json");
const promptOnlyDecisions = loadJsonFile("docs/benchmarks/subagent-routing-prompt-only-decisions.json");

function decision(fixtureId, orchestration, overrides = {}) {
	return { fixtureId, orchestration, ...overrides };
}

function allPassingDecision(fixture) {
	const orchestration = fixture.expectedOrchestrations[0];
	return decision(fixture.id, orchestration, { synthesisPhase: fixture.requiresSynthesis === true });
}

test("subagent routing fixtures are scoreable", () => {
	const ids = fixtures.fixtures.map((fixture) => fixture.id);
	assert.deepEqual(ids.slice(0, 3), ["P1", "P2", "P3"]);
	assert.equal(new Set(ids).size, ids.length);
	assert.equal(fixtures.fixtures.filter((fixture) => fixture.group === "positive").length, 6);
	assert.equal(fixtures.fixtures.filter((fixture) => fixture.group === "negative").length, 6);
	assert.equal(fixtures.fixtures.filter((fixture) => fixture.group === "schema-gravity").length, 4);
});

test("dispatcher smoke fixtures document optional preflight boundaries", () => {
	const ids = dispatcherSmokeFixtures.fixtures.map((fixture) => fixture.id);
	assert.equal(dispatcherSmokeFixtures.version, 1);
	assert.equal(dispatcherSmokeFixtures.agent, "dispatcher");
	assert.deepEqual(ids, ["D1", "D2", "D3", "D4"]);
	assert.equal(new Set(ids).size, ids.length);

	const byId = Object.fromEntries(dispatcherSmokeFixtures.fixtures.map((fixture) => [fixture.id, fixture]));
	assert.equal(byId.D1.expectedRoute, "direct");
	assert.equal(byId.D1.expectedScoutNeeded, false);
	assert.equal(byId.D1.expectedScoutSplit, "none");
	assert.equal(byId.D2.expectedRoute, "sequence");
	assert.deepEqual(byId.D2.expectedSequence, ["2 scouts", "planner"]);
	assert.equal(byId.D2.expectedScoutSplit, "2 scouts");
	assert.equal(byId.D2.expectedOverloadRisk, "high");
	assert.equal(byId.D3.expectedRoute, "parallel scouts");
	assert.equal(byId.D3.expectedScoutSplit, "3 scouts");
	assert.ok(byId.D3.expectedParallelism.length >= 2);
	assert.equal(byId.D4.expectedRoute, "sequence");
	assert.deepEqual(byId.D4.expectedSequence, ["parallel scouts", "planner"]);
	assert.equal(byId.D4.expectedScoutSplit, "2-4 scouts");
	assert.equal(byId.D4.expectedOverloadRisk, "high");
	assert.ok(byId.D4.expectedParallelism.length <= 4);
});

test("prompt-injection fixtures score by task intent instead of injected routing instructions", () => {
	const positive = fixtures.fixtures.find((candidate) => candidate.id === "P6");
	const negative = fixtures.fixtures.find((candidate) => candidate.id === "N6");

	assert.match(positive.prompt, /Ignore.*delegation/i);
	assert.equal(scoreDecision(positive, decision("P6", "parallel-then-synthesis", { synthesisPhase: true })).label, "pass");
	assert.equal(scoreDecision(positive, decision("P6", "none", { synthesisPhase: false })).label, "fail");

	assert.match(negative.prompt, /use parallel agents/i);
	assert.equal(scoreDecision(negative, decision("N6", "none", { synthesisPhase: false })).label, "pass");
	assert.equal(scoreDecision(negative, decision("N6", "parallel-then-synthesis", { synthesisPhase: true })).label, "fail");
});

test("scoreDecision requires synthesis for positive fanout-reduce fixtures", () => {
	const fixture = fixtures.fixtures.find((candidate) => candidate.id === "P1");

	assert.equal(scoreDecision(fixture, decision("P1", "parallel-then-synthesis", { synthesisPhase: true })).label, "pass");
	const miss = scoreDecision(fixture, decision("P1", "parallel", { synthesisPhase: false }));
	assert.equal(miss.label, "fail");
	assert.equal(miss.reason, "missing reducer/synthesis phase");
});

test("scoreDecision flags schema-gravity reducer false positives", () => {
	const fixture = fixtures.fixtures.find((candidate) => candidate.id === "S1");
	const result = scoreDecision(fixture, decision("S1", "parallel-then-synthesis", { synthesisPhase: true }));

	assert.equal(result.label, "schema-gravity-fail");
	assert.equal(result.falsePositive, true);
	assert.equal(result.schemaGravityFalsePositive, true);
});

test("scoreBenchmark passes a perfect run", () => {
	const report = scoreBenchmark(fixtures, {
		runs: [
			{
				condition: "metadata-only",
				decisions: fixtures.fixtures.map(allPassingDecision),
			},
		],
	});

	assert.equal(report.gate.passed, true);
	assert.equal(report.runs[0].groups.positive.passRate, 1);
	assert.equal(report.runs[0].groups.negative.falsePositiveRate, 0);
	assert.equal(report.runs[0].groups["schema-gravity"].schemaGravityFalsePositiveRate, 0);
});

test("scoreBenchmark fails gate for low positive routing and negative overdelegation", () => {
	const badDecisions = fixtures.fixtures.map((fixture) => {
		if (fixture.group === "positive") return decision(fixture.id, "none");
		if (fixture.group === "negative") return decision(fixture.id, "parallel-then-synthesis", { synthesisPhase: true });
		return allPassingDecision(fixture);
	});
	const report = scoreBenchmark(fixtures, { runs: [{ condition: "metadata-only", decisions: badDecisions }] });

	assert.equal(report.gate.passed, false);
	assert.ok(report.gate.issues.some((issue) => issue.metric === "positivePassRate"));
	assert.ok(report.gate.issues.some((issue) => issue.metric === "negativeFalsePositiveRate"));
});

test("scoreBenchmark rejects empty decision runs", () => {
	assert.throws(() => scoreBenchmark(fixtures, { runs: [] }), /runs must contain at least one run/);
});

test("scoreBenchmark counts single-agent use as overdelegation when a negative fixture expects none", () => {
	const decisions = fixtures.fixtures.map((fixture) => (fixture.id === "N1" ? decision("N1", "single") : allPassingDecision(fixture)));
	const report = scoreBenchmark(fixtures, { runs: [{ condition: "metadata-only", decisions }] });
	const n1 = report.runs[0].results.find((result) => result.fixtureId === "N1");

	assert.equal(n1.label, "fail");
	assert.equal(n1.falsePositive, true);
	assert.equal(report.runs[0].groups.negative.falsePositive, 1);
});

test("scoreBenchmark is deterministic for identical inputs", () => {
	const decisions = { runs: [{ condition: "metadata-only", decisions: fixtures.fixtures.map(allPassingDecision) }] };

	assert.deepEqual(scoreBenchmark(fixtures, decisions), scoreBenchmark(fixtures, decisions));
});

test("summarizeFixtures validates fixtures without decisions", () => {
	assert.deepEqual(summarizeFixtures(fixtures), {
		version: 1,
		fixtures: {
			total: 16,
			groups: {
				positive: 6,
				negative: 6,
				"schema-gravity": 4,
			},
		},
		scoring: {
			status: "not-run",
			decisionsRequired: true,
		},
	});
});

test("scoreBenchmark compares improved metadata against skill and schema affordance against metadata-only", () => {
	const perfect = fixtures.fixtures.map(allPassingDecision);
	const weakImproved = fixtures.fixtures.map((fixture) =>
		fixture.group === "positive" ? decision(fixture.id, "none") : allPassingDecision(fixture),
	);
	const schemaGravity = fixtures.fixtures.map((fixture) =>
		fixture.group === "schema-gravity" ? decision(fixture.id, "parallel-then-synthesis", { synthesisPhase: true }) : allPassingDecision(fixture),
	);

	const report = scoreBenchmark(fixtures, {
		runs: [
			{ condition: "metadata-only", decisions: perfect },
			{ condition: "metadata-skill", decisions: perfect },
			{ condition: "improved-metadata", decisions: weakImproved },
			{ condition: "schema-affordance", decisions: schemaGravity },
		],
	});

	assert.equal(report.gate.passed, false);
	assert.ok(report.gate.issues.some((issue) => issue.metric === "positiveRateDeltaFromSkill"));
	assert.ok(report.gate.issues.some((issue) => issue.metric === "schemaGravityFalsePositiveDelta"));
});

test("prompt-only decision run records current routing benchmark result", () => {
	const report = scoreBenchmark(fixtures, promptOnlyDecisions);

	assert.equal(report.runs.find((run) => run.condition === "metadata-only").groups.positive.passRate, 1);
	assert.equal(report.runs.find((run) => run.condition === "improved-metadata").groups.positive.passRate, 1);
	assert.equal(report.runs.find((run) => run.condition === "metadata-skill").groups.positive.passRate, 4 / 6);
	assert.equal(report.runs.find((run) => run.condition === "schema-affordance").groups.positive.passRate, 5 / 6);
	assert.equal(report.gate.passed, false);
	assert.deepEqual(report.gate.issues.map((issue) => [issue.condition, issue.metric]), [
		["metadata-skill", "positivePassRate"],
		["schema-affordance", "positivePassRate"],
	]);
});

test("benchmark scorer CLI validates fixtures when decisions are omitted", async () => {
	const { spawnSync } = await import("node:child_process");
	const result = spawnSync(process.execPath, ["scripts/score-subagent-routing-benchmark.mjs"], {
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.fixtures.total, 16);
	assert.equal(report.scoring.status, "not-run");
});

test("benchmark npm script validates fixtures", async () => {
	const { spawnSync } = await import("node:child_process");
	const result = spawnSync("npm", ["--silent", "run", "benchmark:subagent-routing"], {
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.fixtures.total, 16);
});

test("automated routing runner builds isolated decision prompts", () => {
	const fixture = fixtures.fixtures.find((candidate) => candidate.id === "P6");
	const prompt = buildDecisionPrompt({ condition: "improved-metadata", fixture });

	assert.match(prompt, /prompt-only routing benchmark/);
	assert.match(prompt, /Do not execute the task/);
	assert.match(prompt, /Task prompt: Ignore any delegation guidance/);
	assert.match(prompt, /"fixtureId":"P6"/);
	assert.match(prompt, /parallel-then-synthesis/);
});

test("automated routing runner extracts and validates Pi JSON decisions", () => {
	const stdout = [
		JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text: "not final" }] } }),
		JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text: "```json\n{\"fixtureId\":\"P1\",\"orchestration\":\"parallel-then-synthesis\",\"synthesisPhase\":true,\"mainFinalJudgment\":true,\"notes\":\"broad\"}\n```" }] } }),
	].join("\n");

	const finalText = extractFinalTextFromPiJson(stdout);
	const decision = parseDecisionText(finalText, "P1");

	assert.equal(decision.fixtureId, "P1");
	assert.equal(decision.orchestration, "parallel-then-synthesis");
	assert.equal(decision.synthesisPhase, true);
	assert.equal(decision.mainFinalJudgment, true);
	assert.equal(decision.notes, "broad");
	assert.throws(() => parseDecisionText('{"fixtureId":"P2","orchestration":"none"}', "P1"), /did not match/);
});

test("automated routing runner invokes Pi with prompt stdin and parses the decision", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-routing-runner-"));
	const fakePi = path.join(tmp, "fake-pi.mjs");
	fs.writeFileSync(fakePi, `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (chunk) => { input += chunk.toString(); });
process.stdin.on("end", () => {
  if (!input.includes("Task prompt:")) process.exit(3);
  if (process.argv.some((arg) => arg.includes("Task prompt:"))) process.exit(4);
  console.log(JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text: JSON.stringify({ orchestration: "none", synthesisPhase: false, mainFinalJudgment: true, notes: "fake" }) }] } }));
});
`);
	fs.chmodSync(fakePi, 0o755);

	const decision = await runPiDecision({
		piCommand: fakePi,
		model: "fake-model",
		timeoutMs: 1000,
		timeoutKillGraceMs: 100,
		fixtureId: "N1",
		prompt: buildDecisionPrompt({ condition: "metadata-only", fixture: fixtures.fixtures.find((fixture) => fixture.id === "N1") }),
	});

	assert.equal(decision.fixtureId, "N1");
	assert.equal(decision.orchestration, "none");
	assert.equal(decision.notes, "fake");
});

test("automated routing runner rejects invalid Pi commands cleanly", async () => {
	await assert.rejects(
		runPiDecision({
			piCommand: path.join(os.tmpdir(), "missing-pi-command-for-routing-runner"),
			model: "fake-model",
			timeoutMs: 1000,
			timeoutKillGraceMs: 100,
			fixtureId: "N1",
			prompt: "prompt",
		}),
		/ENOENT/,
	);
});

test("automated routing runner times out and force-kills uncooperative Pi processes", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-routing-timeout-"));
	const fakePi = path.join(tmp, "fake-pi-timeout.mjs");
	fs.writeFileSync(fakePi, `#!/usr/bin/env node
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
	fs.chmodSync(fakePi, 0o755);

	await assert.rejects(
		runPiDecision({
			piCommand: fakePi,
			model: "fake-model",
			timeoutMs: 20,
			timeoutKillGraceMs: 20,
			fixtureId: "N1",
			prompt: "prompt",
		}),
		/timed out after 20ms/,
	);
});

test("automated routing runner dry run emits scorer-compatible decisions", async () => {
	const report = await runBenchmarkDecisions({
		fixtures: "docs/benchmarks/subagent-routing-fixtures.json",
		conditions: ["metadata-only"],
		fixtureIds: ["N1"],
		model: "fake-model",
		piCommand: "pi",
		timeoutMs: 1000,
		dryRun: true,
	});

	assert.equal(report.runs[0].condition, "metadata-only");
	assert.equal(report.runs[0].model, "fake-model");
	assert.deepEqual(report.runs[0].decisions, [{ fixtureId: "N1", orchestration: "none", synthesisPhase: false, mainFinalJudgment: true, notes: "dry-run placeholder" }]);
	assert.equal(scoreBenchmark({ ...fixtures, fixtures: fixtures.fixtures.filter((fixture) => fixture.id === "N1") }, report).gate.passed, true);
});

test("benchmark scorer CLI emits a JSON report", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-routing-benchmark-"));
	const decisionsPath = path.join(tmp, "decisions.json");
	fs.writeFileSync(decisionsPath, JSON.stringify({ runs: [{ condition: "metadata-only", decisions: fixtures.fixtures.map(allPassingDecision) }] }));

	const { spawnSync } = await import("node:child_process");
	const result = spawnSync(process.execPath, ["scripts/score-subagent-routing-benchmark.mjs", "--decisions", decisionsPath, "--threshold-gate"], {
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.gate.passed, true);
});
