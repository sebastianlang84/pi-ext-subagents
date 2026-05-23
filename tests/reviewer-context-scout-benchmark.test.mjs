import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPromptOnlyPreflightReport, loadJsonFile, scoreBenchmark, scoreDecision, summarizeFixtures } from "../scripts/score-reviewer-context-scout-benchmark.mjs";

const fixtures = loadJsonFile("docs/benchmarks/reviewer-context-scout-fixtures.json");

function decision(fixtureId, overrides = {}) {
	return { fixtureId, scoutCalls: 0, evidenceKinds: [], outputChars: 0, ...overrides };
}

function allPassingDecision(fixture) {
	if (!fixture.expectedScoutUse) return decision(fixture.id);
	return decision(fixture.id, {
		scoutCalls: 1,
		subagentCalls: [{ agent: "scout", purpose: "fixture evidence" }],
		evidenceKinds: fixture.requiredEvidence ?? [],
		evidenceRefs: fixture.requiredEvidenceRefs ?? [],
		evidenceSeparated: true,
		outputChars: 1000,
	});
}

function writeAgent(filePath, frontmatter) {
	fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n\nAgent body.\n`);
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
		subagentCalls: [{ agent: "scout", purpose: "contract and call sites" }],
		evidenceKinds: ["api-contract", "call-sites"],
		evidenceRefs: fixture.requiredEvidenceRefs,
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
		if (fixture.id === "P1") return decision("P1", { scoutCalls: 3, recursionViolation: true, evidenceKinds: ["api-contract"], subagentCalls: [{ agent: "worker" }, { agent: "scout" }, { agent: "scout" }] });
		if (fixture.id === "A1") return decision("A1", { scoutCalls: 1, subagentCalls: [{ agent: "scout" }], mutationToolViolation: true, finalJudgmentDelegated: true });
		return allPassingDecision(fixture);
	});
	const report = scoreBenchmark(fixtures, { runs: [{ condition: "prompt-only", decisions: bad }] });

	assert.equal(report.gate.passed, false);
	assert.ok(report.gate.issues.some((issue) => issue.metric === "passRate"));
	assert.ok(report.gate.issues.some((issue) => issue.metric === "recursionViolation"));
	assert.ok(report.gate.issues.some((issue) => issue.metric === "mutationToolViolation"));
	assert.ok(report.gate.issues.some((issue) => issue.metric === "finalJudgmentDelegated"));
	assert.ok(report.gate.issues.some((issue) => issue.metric === "nonScoutSubagentCall"));
	assert.ok(report.gate.issues.some((issue) => issue.metric === "missingSeededEvidence"));
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
		subagentCalls: [{ agent: "scout" }, { agent: "scout" }],
		evidenceKinds: ["api-contract", "call-sites"],
		evidenceRefs: fixture.requiredEvidenceRefs,
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

test("scoreDecision flags non-scout subagent calls", () => {
	const fixture = fixtures.fixtures.find((candidate) => candidate.id === "P1");
	const result = scoreDecision(fixture, decision("P1", {
		scoutCalls: 1,
		evidenceKinds: ["api-contract", "call-sites"],
		evidenceSeparated: true,
		subagentCalls: [{ agent: "worker" }],
	}));

	assert.equal(result.label, "fail");
	assert.equal(result.reason, "non-scout subagent call");
	assert.equal(result.nonScoutSubagentCall, true);
});

test("scoreDecision requires seeded file-line evidence", () => {
	const fixture = fixtures.fixtures.find((candidate) => candidate.id === "P1");
	const missing = scoreDecision(fixture, decision("P1", {
		scoutCalls: 1,
		subagentCalls: [{ agent: "scout" }],
		evidenceKinds: ["api-contract", "call-sites"],
		evidenceSeparated: true,
	}));
	const wrongRange = scoreDecision(fixture, decision("P1", {
		scoutCalls: 1,
		subagentCalls: [{ agent: "scout" }],
		evidenceKinds: ["api-contract", "call-sites"],
		evidenceRefs: fixture.requiredEvidenceRefs.map((ref) => ref.kind === "api-contract" ? { ...ref, startLine: 200, endLine: 210 } : ref),
		evidenceSeparated: true,
	}));
	const wrongKind = scoreDecision(fixture, decision("P1", {
		scoutCalls: 1,
		subagentCalls: [{ agent: "scout" }],
		evidenceKinds: ["api-contract", "call-sites"],
		evidenceRefs: fixture.requiredEvidenceRefs.map((ref) => ref.kind === "api-contract" ? { ...ref, kind: "wrong-kind" } : ref),
		evidenceSeparated: true,
	}));
	const wrongPath = scoreDecision(fixture, decision("P1", {
		scoutCalls: 1,
		subagentCalls: [{ agent: "scout" }],
		evidenceKinds: ["api-contract", "call-sites"],
		evidenceRefs: fixture.requiredEvidenceRefs.map((ref) => ref.kind === "api-contract" ? { ...ref, path: "README.md" } : ref),
		evidenceSeparated: true,
	}));

	assert.equal(missing.label, "fail");
	assert.match(missing.reason, /missing seeded evidence/);
	assert.equal(missing.missingSeededEvidence, true);
	assert.equal(wrongRange.label, "fail");
	assert.equal(wrongRange.missingSeededEvidence, true);
	assert.equal(wrongKind.missingSeededEvidence, true);
	assert.equal(wrongPath.missingSeededEvidence, true);
});

test("scoreBenchmark rejects unknown fixture references", () => {
	assert.throws(() => scoreBenchmark(fixtures, { runs: [{ condition: "prompt-only", decisions: [decision("missing")] }] }), /unknown fixture/);
});

test("prompt-only preflight fails when reviewer lacks subagent", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-context-scout-preflight-"));
	const reviewerPath = path.join(tmp, "reviewer.md");
	const scoutPath = path.join(tmp, "scout.md");
	writeAgent(reviewerPath, "name: reviewer\ndescription: Reviewer\ntools: read, bash");
	writeAgent(scoutPath, "name: scout\ndescription: Scout\ntools: read, bash");

	const report = buildPromptOnlyPreflightReport({ reviewerAgentPath: reviewerPath, scoutAgentPath: scoutPath });

	assert.equal(report.preflight.status, "fail");
	assert.ok(report.preflight.issues.some((issue) => issue.role === "reviewer" && issue.metric === "requiredTool"));
});

test("prompt-only preflight passes scoped reviewer and scout tools", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-context-scout-preflight-"));
	const reviewerPath = path.join(tmp, "reviewer.md");
	const scoutPath = path.join(tmp, "scout.md");
	writeAgent(reviewerPath, "name: reviewer\ndescription: Reviewer\ntools: read, bash, subagent");
	writeAgent(scoutPath, "name: scout\ndescription: Scout\ntools: read, bash");

	const report = buildPromptOnlyPreflightReport({ reviewerAgentPath: reviewerPath, scoutAgentPath: scoutPath });

	assert.equal(report.preflight.status, "pass");
	assert.deepEqual(report.preflight.issues, []);
});

test("prompt-only preflight rejects non-scout scout agent and YAML-list tools", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-context-scout-preflight-"));
	const reviewerPath = path.join(tmp, "reviewer.md");
	const wrongScoutPath = path.join(tmp, "wrong-scout.md");
	const listScoutPath = path.join(tmp, "list-scout.md");
	writeAgent(reviewerPath, "name: reviewer\ndescription: Reviewer\ntools: read, bash, subagent");
	writeAgent(wrongScoutPath, "name: worker\ndescription: Wrong scout\ntools: read, bash");
	writeAgent(listScoutPath, "name: scout\ndescription: Bad tools\ntools:\n  - read\n  - bash");

	const wrongName = buildPromptOnlyPreflightReport({ reviewerAgentPath: reviewerPath, scoutAgentPath: wrongScoutPath });
	const badTools = buildPromptOnlyPreflightReport({ reviewerAgentPath: reviewerPath, scoutAgentPath: listScoutPath });

	assert.equal(wrongName.preflight.status, "fail");
	assert.ok(wrongName.preflight.issues.some((issue) => issue.role === "scout" && issue.metric === "agentName"));
	assert.equal(badTools.preflight.status, "fail");
	assert.ok(badTools.preflight.issues.some((issue) => issue.role === "scout" && issue.metric === "agentConfigReadable"));
});

test("scoreBenchmark rejects overbroad evidence refs", () => {
	assert.throws(() => scoreBenchmark(fixtures, {
		runs: [{ condition: "prompt-only", decisions: fixtures.fixtures.map((fixture) => {
			if (fixture.id === "P1") return decision("P1", {
				scoutCalls: 1,
				subagentCalls: [{ agent: "scout" }],
				evidenceKinds: ["api-contract", "call-sites"],
				evidenceRefs: [{ kind: "api-contract", path: "docs/plans/reviewer-context-scout.md", startLine: 1, endLine: 200 }],
				evidenceSeparated: true,
			});
			return allPassingDecision(fixture);
		}) }],
	}), /span at most 80 lines/);
});

test("scoreBenchmark requires scout call logs to match scoutCalls", () => {
	assert.throws(() => scoreBenchmark(fixtures, {
		runs: [{ condition: "prompt-only", decisions: fixtures.fixtures.map((fixture) => {
			if (fixture.id === "P1") return decision("P1", { scoutCalls: 1, evidenceKinds: ["api-contract", "call-sites"], evidenceSeparated: true });
			return allPassingDecision(fixture);
		}) }],
	}), /subagentCalls length must match scoutCalls/);
	assert.throws(() => scoreBenchmark(fixtures, {
		runs: [{ condition: "prompt-only", decisions: fixtures.fixtures.map((fixture) => {
			if (fixture.id === "N1") return decision("N1", { scoutCalls: 0, subagentCalls: [{ agent: "scout" }] });
			return allPassingDecision(fixture);
		}) }],
	}), /subagentCalls length must match scoutCalls/);
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
