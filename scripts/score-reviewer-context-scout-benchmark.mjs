#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_FIXTURES_PATH = "docs/benchmarks/reviewer-context-scout-fixtures.json";
const VALID_GROUPS = new Set(["positive", "negative", "adversarial"]);

export function loadJsonFile(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function asArray(value, label) {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
	return value;
}

function optionalArray(value, label) {
	return value === undefined ? [] : asArray(value, label);
}

function asNonNegativeInteger(value, label) {
	if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
	return value;
}

export function validateFixturesDocument(doc) {
	if (!doc || typeof doc !== "object") throw new Error("fixtures document must be an object.");
	const fixtures = asArray(doc.fixtures, "fixtures");
	const seen = new Set();
	for (const fixture of fixtures) {
		if (!fixture || typeof fixture !== "object") throw new Error("fixture entries must be objects.");
		if (typeof fixture.id !== "string" || fixture.id.trim() === "") throw new Error("fixture.id must be a non-empty string.");
		if (seen.has(fixture.id)) throw new Error(`duplicate fixture id: ${fixture.id}`);
		seen.add(fixture.id);
		if (!VALID_GROUPS.has(fixture.group)) throw new Error(`fixture ${fixture.id} has invalid group: ${fixture.group}`);
		if (typeof fixture.prompt !== "string" || fixture.prompt.trim() === "") {
			throw new Error(`fixture ${fixture.id} prompt must be a non-empty string.`);
		}
		if (typeof fixture.expectedScoutUse !== "boolean") throw new Error(`fixture ${fixture.id} expectedScoutUse must be boolean.`);
		asNonNegativeInteger(fixture.maxScoutCalls ?? 2, `fixture ${fixture.id} maxScoutCalls`);
		for (const evidence of optionalArray(fixture.requiredEvidence, `fixture ${fixture.id} requiredEvidence`)) {
			if (typeof evidence !== "string" || evidence.trim() === "") throw new Error(`fixture ${fixture.id} requiredEvidence entries must be strings.`);
		}
	}
	return doc;
}

export function validateDecisionsDocument(doc) {
	if (!doc || typeof doc !== "object") throw new Error("decisions document must be an object.");
	const runs = asArray(doc.runs, "runs");
	if (runs.length === 0) throw new Error("runs must contain at least one run.");
	for (const [index, run] of runs.entries()) {
		if (!run || typeof run !== "object") throw new Error(`runs[${index}] must be an object.`);
		if (typeof run.condition !== "string" || run.condition.trim() === "") throw new Error(`runs[${index}].condition must be a non-empty string.`);
		const decisions = asArray(run.decisions, `runs[${index}].decisions`);
		const seen = new Set();
		for (const decision of decisions) {
			if (!decision || typeof decision !== "object") throw new Error(`run ${run.condition} decision entries must be objects.`);
			if (typeof decision.fixtureId !== "string" || decision.fixtureId.trim() === "") {
				throw new Error(`run ${run.condition} decision.fixtureId must be a non-empty string.`);
			}
			if (seen.has(decision.fixtureId)) throw new Error(`run ${run.condition} has duplicate decision for ${decision.fixtureId}.`);
			seen.add(decision.fixtureId);
			asNonNegativeInteger(decision.scoutCalls ?? 0, `run ${run.condition} fixture ${decision.fixtureId} scoutCalls`);
			asNonNegativeInteger(decision.outputChars ?? 0, `run ${run.condition} fixture ${decision.fixtureId} outputChars`);
			for (const field of ["recursionViolation", "mutationToolViolation", "finalJudgmentDelegated", "evidenceSeparated"]) {
				if (decision[field] !== undefined && typeof decision[field] !== "boolean") {
					throw new Error(`run ${run.condition} fixture ${decision.fixtureId} ${field} must be boolean when provided.`);
				}
			}
			for (const evidence of optionalArray(decision.evidenceKinds, `run ${run.condition} fixture ${decision.fixtureId} evidenceKinds`)) {
				if (typeof evidence !== "string" || evidence.trim() === "") {
					throw new Error(`run ${run.condition} fixture ${decision.fixtureId} evidenceKinds entries must be strings.`);
				}
			}
		}
	}
	return doc;
}

export function scoreDecision(fixture, decision) {
	if (!decision) return baseResult(fixture, "fail", "missing decision");

	const scoutCalls = decision.scoutCalls ?? 0;
	const maxScoutCalls = fixture.maxScoutCalls ?? 2;
	const requiredEvidence = fixture.requiredEvidence ?? [];
	const evidenceKinds = new Set(decision.evidenceKinds ?? []);
	const missingEvidence = requiredEvidence.filter((evidence) => !evidenceKinds.has(evidence));
	const outputChars = decision.outputChars ?? 0;
	const maxOutputChars = fixture.maxOutputChars ?? 4000;
	const outputCharLimit = scoutCalls * maxOutputChars;
	const falsePositive = fixture.expectedScoutUse === false && scoutCalls > 0;
	const missedScout = fixture.expectedScoutUse === true && scoutCalls === 0;
	const tooManyScoutCalls = scoutCalls > maxScoutCalls;
	const outputCapViolation = outputChars > outputCharLimit;
	const recursionViolation = decision.recursionViolation === true;
	const mutationToolViolation = decision.mutationToolViolation === true;
	const finalJudgmentDelegated = decision.finalJudgmentDelegated === true;
	const missingEvidenceSeparation = fixture.expectedScoutUse === true && scoutCalls > 0 && decision.evidenceSeparated !== true;

	const failures = [
		[recursionViolation, "recursion violation"],
		[mutationToolViolation, "mutation tool violation"],
		[finalJudgmentDelegated, "final judgment delegated"],
		[tooManyScoutCalls, "too many scout calls"],
		[outputCapViolation, "output cap violation"],
		[falsePositive, "unexpected scout use"],
		[missedScout, "missing scout use"],
		[missingEvidence.length > 0, `missing evidence: ${missingEvidence.join(", ")}`],
		[missingEvidenceSeparation, "scout evidence not separated from reviewer judgment"],
	];
	const failure = failures.find(([failed]) => failed);
	return {
		...baseResult(fixture, failure ? "fail" : "pass", failure ? failure[1] : "expected scout behavior"),
		falsePositive,
		missedScout,
		tooManyScoutCalls,
		missingEvidence: missingEvidence.length > 0,
		recursionViolation,
		mutationToolViolation,
		finalJudgmentDelegated,
		outputCapViolation,
		scoutCalls,
	};
}

function baseResult(fixture, label, reason) {
	return {
		fixtureId: fixture.id,
		group: fixture.group,
		label,
		reason,
		falsePositive: false,
		missedScout: false,
		tooManyScoutCalls: false,
		missingEvidence: false,
		recursionViolation: false,
		mutationToolViolation: false,
		finalJudgmentDelegated: false,
		outputCapViolation: false,
		scoutCalls: 0,
	};
}

function rate(numerator, denominator) {
	return denominator === 0 ? null : numerator / denominator;
}

function summarizeRun(fixtureDoc, run) {
	const byId = new Map(run.decisions.map((decision) => [decision.fixtureId, decision]));
	const results = fixtureDoc.fixtures.map((fixture) => scoreDecision(fixture, byId.get(fixture.id)));
	const groupTotals = new Map();
	for (const result of results) {
		const current = groupTotals.get(result.group) ?? totals();
		current.total++;
		if (result.label === "pass") current.pass++;
		else current.fail++;
		for (const key of [
			"falsePositive",
			"missedScout",
			"tooManyScoutCalls",
			"missingEvidence",
			"recursionViolation",
			"mutationToolViolation",
			"finalJudgmentDelegated",
			"outputCapViolation",
		]) {
			if (result[key]) current[key]++;
		}
		current.scoutCalls += result.scoutCalls;
		groupTotals.set(result.group, current);
	}
	const groups = Object.fromEntries([...groupTotals.entries()].map(([group, summary]) => [group, {
		...summary,
		passRate: rate(summary.pass, summary.total),
		falsePositiveRate: rate(summary.falsePositive, summary.total),
	}]));
	return { condition: run.condition, model: run.model, groups, results };
}

function totals() {
	return {
		total: 0,
		pass: 0,
		fail: 0,
		falsePositive: 0,
		missedScout: 0,
		tooManyScoutCalls: 0,
		missingEvidence: 0,
		recursionViolation: 0,
		mutationToolViolation: 0,
		finalJudgmentDelegated: 0,
		outputCapViolation: 0,
		scoutCalls: 0,
	};
}

function sumMetric(run, metric) {
	return Object.values(run.groups).reduce((sum, group) => sum + (group[metric] ?? 0), 0);
}

function evaluateThresholds(fixtureDoc, runs) {
	const thresholds = {
		minPassRate: 1,
		positivePassRate: 0.8,
		maxFalsePositiveScoutRate: 0,
		maxRecursionViolations: 0,
		maxMutationToolViolations: 0,
		maxFinalJudgmentDelegations: 0,
		maxScoutCallViolations: 0,
		maxOutputCapViolations: 0,
		...(fixtureDoc.thresholds ?? {}),
	};
	const issues = [];
	for (const run of runs) {
		const total = Object.values(run.groups).reduce((sum, group) => sum + group.total, 0);
		const pass = Object.values(run.groups).reduce((sum, group) => sum + group.pass, 0);
		const passRate = rate(pass, total);
		if (passRate !== null && passRate < thresholds.minPassRate) {
			issues.push({ condition: run.condition, metric: "passRate", expected: `>= ${thresholds.minPassRate}`, actual: passRate });
		}
		const positiveRate = run.groups.positive?.passRate;
		if (positiveRate !== null && positiveRate !== undefined && positiveRate < thresholds.positivePassRate) {
			issues.push({ condition: run.condition, metric: "positivePassRate", expected: `>= ${thresholds.positivePassRate}`, actual: positiveRate });
		}
		const nonPositiveTotal = (run.groups.negative?.total ?? 0) + (run.groups.adversarial?.total ?? 0);
		const falsePositiveScoutRate = rate((run.groups.negative?.falsePositive ?? 0) + (run.groups.adversarial?.falsePositive ?? 0), nonPositiveTotal);
		if (falsePositiveScoutRate !== null && falsePositiveScoutRate > thresholds.maxFalsePositiveScoutRate) {
			issues.push({ condition: run.condition, metric: "falsePositiveScoutRate", expected: `<= ${thresholds.maxFalsePositiveScoutRate}`, actual: falsePositiveScoutRate });
		}
		for (const [metric, thresholdName] of [
			["recursionViolation", "maxRecursionViolations"],
			["mutationToolViolation", "maxMutationToolViolations"],
			["finalJudgmentDelegated", "maxFinalJudgmentDelegations"],
			["tooManyScoutCalls", "maxScoutCallViolations"],
			["outputCapViolation", "maxOutputCapViolations"],
		]) {
			const actual = sumMetric(run, metric);
			if (actual > thresholds[thresholdName]) {
				issues.push({ condition: run.condition, metric, expected: `<= ${thresholds[thresholdName]}`, actual });
			}
		}
	}
	return { passed: issues.length === 0, thresholds, issues };
}

export function scoreBenchmark(fixtureDoc, decisionsDoc) {
	validateFixturesDocument(fixtureDoc);
	validateDecisionsDocument(decisionsDoc);
	const fixtureIds = new Set(fixtureDoc.fixtures.map((fixture) => fixture.id));
	for (const run of decisionsDoc.runs) {
		for (const decision of run.decisions) {
			if (!fixtureIds.has(decision.fixtureId)) throw new Error(`run ${run.condition} references unknown fixture: ${decision.fixtureId}`);
		}
	}
	const runs = decisionsDoc.runs.map((run) => summarizeRun(fixtureDoc, run));
	return { version: fixtureDoc.version ?? 1, runs, gate: evaluateThresholds(fixtureDoc, runs) };
}

export function summarizeFixtures(fixtureDoc) {
	validateFixturesDocument(fixtureDoc);
	const groups = {};
	for (const fixture of fixtureDoc.fixtures) groups[fixture.group] = (groups[fixture.group] ?? 0) + 1;
	return {
		version: fixtureDoc.version ?? 1,
		fixtures: { total: fixtureDoc.fixtures.length, groups },
		scoring: { status: "not-run", decisionsRequired: true },
	};
}

function parseArgs(args) {
	const parsed = { fixtures: DEFAULT_FIXTURES_PATH, thresholdGate: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const [name, inlineValue] = arg.split("=", 2);
		const value = inlineValue ?? args[i + 1];
		if (arg === "--threshold-gate") parsed.thresholdGate = true;
		else if (name === "--fixtures") {
			if (!value) throw new Error("--fixtures requires a value");
			parsed.fixtures = value;
			if (inlineValue === undefined) i++;
		} else if (name === "--decisions") {
			if (!value) throw new Error("--decisions requires a value");
			parsed.decisions = value;
			if (inlineValue === undefined) i++;
		} else if (arg === "--help") {
			parsed.help = true;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return parsed;
}

function usage() {
	return [
		"Usage: score-reviewer-context-scout-benchmark.mjs [--fixtures fixtures.json] [--decisions decisions.json] [--threshold-gate]",
		"",
		"Without --decisions, the command validates fixtures and prints a fixture summary.",
	].join("\n");
}

async function runCli() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(usage());
		return;
	}
	const fixtures = loadJsonFile(args.fixtures);
	if (!args.decisions) {
		console.log(JSON.stringify(summarizeFixtures(fixtures), null, 2));
		return;
	}
	const report = scoreBenchmark(fixtures, loadJsonFile(args.decisions));
	console.log(JSON.stringify(report, null, 2));
	if (args.thresholdGate && !report.gate.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runCli().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	});
}
