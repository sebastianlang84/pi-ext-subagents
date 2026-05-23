import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadJsonFile, scoreBenchmark, scoreDecision, summarizeFixtures } from "../scripts/score-reviewer-context-scout-benchmark.mjs";

const fixtures = loadJsonFile("docs/benchmarks/reviewer-context-scout-fixtures.json");

function decision(fixtureId, overrides = {}) {
	return { fixtureId, scoutCalls: 0, evidenceKinds: [], outputChars: 0, ...overrides };
}

function allPassingDecision(fixture) {
	if (!fixture.expectedScoutUse) return decision(fixture.id);
	return decision(fixture.id, {
		scoutCalls: 1,
		evidenceKinds: fixture.requiredEvidence ?? [],
		evidenceSeparated: true,
		outputChars: 1000,
	});
}

test("reviewer context scout fixtures are summarizable without decisions", () => {
	assert.deepEqual(summarizeFixtures(fixtures), {
		version: 1,
		fixtures: {
			total: 5,
			groups: {
				negative: 1,
				positive: 3,
				adversarial: 1,
			},
		},
		scoring: {
			status: "not-run",
			decisionsRequired: true,
		},
	});
});

test("reviewer context scout fixtures cover intended groups", () => {
	const ids = fixtures.fixtures.map((fixture) => fixture.id);
	assert.deepEqual(ids, ["N1", "P1", "P2", "P3", "A1"]);
	assert.equal(new Set(ids).size, ids.length);
	assert.equal(fixtures.fixtures.filter((fixture) => fixture.expectedScoutUse).length, 3);
});

test("scoreDecision passes bounded evidence-only scout use", () => {
	const fixture = fixtures.fixtures.find((candidate) => candidate.id === "P1");
	const result = scoreDecision(fixture, decision("P1", {
		scoutCalls: 1,
		evidenceKinds: ["api-contract", "call-sites"],
		evidenceSeparated: true,
	}));

	assert.equal(result.label, "pass");
	assert.equal(result.reason, "expected scout behavior");
});

test("scoreDecision flags false-positive scout use on tiny reviews", () => {
	const fixture = fixtures.fixtures.find((candidate) => candidate.id === "N1");
	const result = scoreDecision(fixture, decision("N1", { scoutCalls: 1, evidenceSeparated: true }));

	assert.equal(result.label, "fail");
	assert.equal(result.reason, "too many scout calls");
	assert.equal(result.falsePositive, true);
});

test("scoreBenchmark passes a perfect reviewer-scout run", () => {
	const report = scoreBenchmark(fixtures, {
		runs: [{ condition: "prompt-only", decisions: fixtures.fixtures.map(allPassingDecision) }],
	});

	assert.equal(report.gate.passed, true);
	assert.equal(report.runs[0].groups.positive.passRate, 1);
	assert.equal(report.runs[0].groups.negative.falsePositiveRate, 0);
	assert.equal(report.runs[0].groups.adversarial.falsePositiveRate, 0);
});

test("scoreBenchmark fails guardrail violations", () => {
	const bad = fixtures.fixtures.map((fixture) => {
		if (fixture.id === "P1") return decision("P1", { scoutCalls: 3, recursionViolation: true, evidenceKinds: ["api-contract"] });
		if (fixture.id === "A1") return decision("A1", { scoutCalls: 1, mutationToolViolation: true, finalJudgmentDelegated: true });
		return allPassingDecision(fixture);
	});
	const report = scoreBenchmark(fixtures, { runs: [{ condition: "prompt-only", decisions: bad }] });

	assert.equal(report.gate.passed, false);
	assert.ok(report.gate.issues.some((issue) => issue.metric === "passRate"));
	assert.ok(report.gate.issues.some((issue) => issue.metric === "recursionViolation"));
	assert.ok(report.gate.issues.some((issue) => issue.metric === "mutationToolViolation"));
	assert.ok(report.gate.issues.some((issue) => issue.metric === "finalJudgmentDelegated"));
	assert.ok(report.gate.issues.some((issue) => issue.metric === "tooManyScoutCalls"));
	assert.ok(report.gate.issues.some((issue) => issue.metric === "falsePositiveScoutRate"));
});

test("scoreBenchmark fails incomplete runs", () => {
	const positiveOnly = fixtures.fixtures.filter((fixture) => fixture.group === "positive").map(allPassingDecision);
	const report = scoreBenchmark(fixtures, { runs: [{ condition: "prompt-only", decisions: positiveOnly }] });

	assert.equal(report.gate.passed, false);
	assert.ok(report.gate.issues.some((issue) => issue.metric === "passRate"));
});

test("scoreDecision treats output cap as per scout call", () => {
	const fixture = fixtures.fixtures.find((candidate) => candidate.id === "P1");
	const result = scoreDecision(fixture, decision("P1", {
		scoutCalls: 2,
		evidenceKinds: ["api-contract", "call-sites"],
		evidenceSeparated: true,
		outputChars: 6000,
	}));

	assert.equal(result.label, "pass");
});

test("scoreDecision allows no output when scoutCalls is zero", () => {
	const fixture = fixtures.fixtures.find((candidate) => candidate.id === "N1");
	const result = scoreDecision(fixture, decision("N1", { outputChars: 1 }));

	assert.equal(result.label, "fail");
	assert.equal(result.reason, "output cap violation");
});

test("scoreBenchmark rejects unknown fixture references", () => {
	assert.throws(() => scoreBenchmark(fixtures, { runs: [{ condition: "prompt-only", decisions: [decision("missing")] }] }), /unknown fixture/);
});

test("reviewer context scout benchmark CLI validates fixtures when decisions are omitted", async () => {
	const { spawnSync } = await import("node:child_process");
	const result = spawnSync(process.execPath, ["scripts/score-reviewer-context-scout-benchmark.mjs"], {
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.fixtures.total, 5);
	assert.equal(report.scoring.status, "not-run");
});

test("reviewer context scout benchmark CLI emits a JSON report", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-context-scout-benchmark-"));
	const decisionsPath = path.join(tmp, "decisions.json");
	fs.writeFileSync(decisionsPath, JSON.stringify({ runs: [{ condition: "prompt-only", decisions: fixtures.fixtures.map(allPassingDecision) }] }));

	const { spawnSync } = await import("node:child_process");
	const result = spawnSync(process.execPath, ["scripts/score-reviewer-context-scout-benchmark.mjs", "--decisions", decisionsPath, "--threshold-gate"], {
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.gate.passed, true);
});
