import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadJsonFile, scoreBenchmark, scoreDecision, summarizeFixtures } from "../scripts/score-subagent-routing-benchmark.mjs";

const fixtures = loadJsonFile("docs/benchmarks/subagent-routing-fixtures.json");

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
	assert.equal(fixtures.fixtures.filter((fixture) => fixture.group === "positive").length, 5);
	assert.equal(fixtures.fixtures.filter((fixture) => fixture.group === "negative").length, 5);
	assert.equal(fixtures.fixtures.filter((fixture) => fixture.group === "schema-gravity").length, 4);
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
			total: 14,
			groups: {
				positive: 5,
				negative: 5,
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

test("benchmark scorer CLI validates fixtures when decisions are omitted", async () => {
	const { spawnSync } = await import("node:child_process");
	const result = spawnSync(process.execPath, ["scripts/score-subagent-routing-benchmark.mjs"], {
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.fixtures.total, 14);
	assert.equal(report.scoring.status, "not-run");
});

test("benchmark npm script validates fixtures", async () => {
	const { spawnSync } = await import("node:child_process");
	const result = spawnSync("npm", ["--silent", "run", "benchmark:subagent-routing"], {
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.fixtures.total, 14);
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
