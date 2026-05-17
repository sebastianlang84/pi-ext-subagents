#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_FIXTURES_PATH = "docs/benchmarks/subagent-routing-fixtures.json";

const VALID_ORCHESTRATIONS = new Set(["none", "single", "parallel", "chain", "parallel-then-synthesis"]);
const VALID_GROUPS = new Set(["positive", "negative", "schema-gravity"]);

export function loadJsonFile(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function asArray(value, label) {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
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
		const expected = asArray(fixture.expectedOrchestrations, `fixture ${fixture.id} expectedOrchestrations`);
		if (expected.length === 0) throw new Error(`fixture ${fixture.id} must have expectedOrchestrations.`);
		for (const orchestration of expected) {
			if (!VALID_ORCHESTRATIONS.has(orchestration)) throw new Error(`fixture ${fixture.id} invalid expected orchestration: ${orchestration}`);
		}
		const disallowed = fixture.disallowed === undefined ? [] : asArray(fixture.disallowed, `fixture ${fixture.id} disallowed`);
		for (const orchestration of disallowed) {
			if (!VALID_ORCHESTRATIONS.has(orchestration)) throw new Error(`fixture ${fixture.id} invalid disallowed orchestration: ${orchestration}`);
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
			if (!VALID_ORCHESTRATIONS.has(decision.orchestration)) {
				throw new Error(`run ${run.condition} fixture ${decision.fixtureId} has invalid orchestration: ${decision.orchestration}`);
			}
			if (decision.synthesisPhase !== undefined && typeof decision.synthesisPhase !== "boolean") {
				throw new Error(`run ${run.condition} fixture ${decision.fixtureId} synthesisPhase must be boolean when provided.`);
			}
			if (decision.mainFinalJudgment !== undefined && typeof decision.mainFinalJudgment !== "boolean") {
				throw new Error(`run ${run.condition} fixture ${decision.fixtureId} mainFinalJudgment must be boolean when provided.`);
			}
		}
	}
	return doc;
}

function isReducerUse(decision) {
	return decision.orchestration === "parallel-then-synthesis" || decision.synthesisPhase === true;
}

function isOverdelegation(decision) {
	return decision.orchestration === "single" || decision.orchestration === "parallel" || decision.orchestration === "chain" || isReducerUse(decision);
}

export function scoreDecision(fixture, decision) {
	if (!decision) {
		return {
			fixtureId: fixture.id,
			group: fixture.group,
			label: "fail",
			reason: "missing decision",
			falsePositive: false,
			schemaGravityFalsePositive: false,
		};
	}

	const expected = new Set(fixture.expectedOrchestrations);
	const disallowed = new Set(fixture.disallowed ?? []);
	const reducerUse = isReducerUse(decision);
	const expectedMode = expected.has(decision.orchestration);
	const disallowedMode = disallowed.has(decision.orchestration);
	const missingSynthesis = fixture.requiresSynthesis === true && !reducerUse;
	const unexpectedSynthesis = fixture.requiresSynthesis !== true && reducerUse;

	if (fixture.group === "schema-gravity" && unexpectedSynthesis) {
		return {
			fixtureId: fixture.id,
			group: fixture.group,
			label: "schema-gravity-fail",
			reason: "unexpected reducer/synthesis use",
			falsePositive: true,
			schemaGravityFalsePositive: true,
		};
	}

	if (disallowedMode || missingSynthesis || unexpectedSynthesis || !expectedMode) {
		return {
			fixtureId: fixture.id,
			group: fixture.group,
			label: "fail",
			reason: disallowedMode
				? "disallowed orchestration"
				: missingSynthesis
					? "missing reducer/synthesis phase"
					: unexpectedSynthesis
						? "unexpected reducer/synthesis phase"
						: "orchestration did not match expected set",
			falsePositive: fixture.group !== "positive" && isOverdelegation(decision),
			schemaGravityFalsePositive: false,
		};
	}

	return {
		fixtureId: fixture.id,
		group: fixture.group,
		label: "pass",
		reason: "expected orchestration",
		falsePositive: false,
		schemaGravityFalsePositive: false,
	};
}

function rate(numerator, denominator) {
	return denominator === 0 ? null : numerator / denominator;
}

function summarizeRun(fixtureDoc, run) {
	const fixtures = fixtureDoc.fixtures;
	const byId = new Map(run.decisions.map((decision) => [decision.fixtureId, decision]));
	const results = fixtures.map((fixture) => scoreDecision(fixture, byId.get(fixture.id)));
	const groupTotals = new Map();
	for (const result of results) {
		const current = groupTotals.get(result.group) ?? { total: 0, pass: 0, fail: 0, falsePositive: 0, schemaGravityFalsePositive: 0 };
		current.total++;
		if (result.label === "pass" || result.label === "acceptable") current.pass++;
		else current.fail++;
		if (result.falsePositive) current.falsePositive++;
		if (result.schemaGravityFalsePositive) current.schemaGravityFalsePositive++;
		groupTotals.set(result.group, current);
	}
	const groups = Object.fromEntries([...groupTotals.entries()].map(([group, summary]) => [group, {
		...summary,
		passRate: rate(summary.pass, summary.total),
		falsePositiveRate: rate(summary.falsePositive, summary.total),
		schemaGravityFalsePositiveRate: rate(summary.schemaGravityFalsePositive, summary.total),
	}]));
	return {
		condition: run.condition,
		model: run.model,
		groups,
		results,
	};
}

function evaluateThresholds(fixtureDoc, runs) {
	const thresholds = {
		positivePassRate: 0.85,
		negativeFalsePositiveRate: 0.15,
		maxSkillPositiveRateDelta: 0.05,
		maxSchemaFalsePositiveDelta: 0.05,
		...(fixtureDoc.thresholds ?? {}),
	};
	const issues = [];
	for (const run of runs) {
		const positiveRate = run.groups.positive?.passRate;
		if (positiveRate !== null && positiveRate !== undefined && positiveRate < thresholds.positivePassRate) {
			issues.push({ condition: run.condition, metric: "positivePassRate", expected: `>= ${thresholds.positivePassRate}`, actual: positiveRate });
		}
		const negativeFp = run.groups.negative?.falsePositiveRate;
		if (negativeFp !== null && negativeFp !== undefined && negativeFp > thresholds.negativeFalsePositiveRate) {
			issues.push({ condition: run.condition, metric: "negativeFalsePositiveRate", expected: `<= ${thresholds.negativeFalsePositiveRate}`, actual: negativeFp });
		}
	}

	const byCondition = new Map(runs.map((run) => [run.condition, run]));
	const skill = byCondition.get("metadata-skill")?.groups.positive?.passRate;
	const improved = byCondition.get("improved-metadata")?.groups.positive?.passRate;
	if (skill !== undefined && improved !== undefined && improved < skill - thresholds.maxSkillPositiveRateDelta) {
		issues.push({
			condition: "improved-metadata",
			metric: "positiveRateDeltaFromSkill",
			expected: `>= metadata-skill - ${thresholds.maxSkillPositiveRateDelta}`,
			actual: improved - skill,
		});
	}

	const metadataSchemaFp = byCondition.get("metadata-only")?.groups["schema-gravity"]?.schemaGravityFalsePositiveRate;
	const schemaFp = byCondition.get("schema-affordance")?.groups["schema-gravity"]?.schemaGravityFalsePositiveRate;
	if (metadataSchemaFp !== undefined && schemaFp !== undefined && schemaFp > metadataSchemaFp + thresholds.maxSchemaFalsePositiveDelta) {
		issues.push({
			condition: "schema-affordance",
			metric: "schemaGravityFalsePositiveDelta",
			expected: `<= metadata-only + ${thresholds.maxSchemaFalsePositiveDelta}`,
			actual: schemaFp - metadataSchemaFp,
		});
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
	const gate = evaluateThresholds(fixtureDoc, runs);
	return {
		version: fixtureDoc.version ?? 1,
		runs,
		gate,
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

export function summarizeFixtures(fixtureDoc) {
	validateFixturesDocument(fixtureDoc);
	const groups = {};
	for (const fixture of fixtureDoc.fixtures) groups[fixture.group] = (groups[fixture.group] ?? 0) + 1;
	return {
		version: fixtureDoc.version ?? 1,
		fixtures: {
			total: fixtureDoc.fixtures.length,
			groups,
		},
		scoring: {
			status: "not-run",
			decisionsRequired: true,
		},
	};
}

function usage() {
	return [
		"Usage: score-subagent-routing-benchmark.mjs [--fixtures fixtures.json] [--decisions decisions.json] [--threshold-gate]",
		"",
		"Without --decisions, the command validates fixtures and prints a fixture summary.",
		"",
		"Decisions shape:",
		'{ "runs": [{ "condition": "metadata-only", "decisions": [{ "fixtureId": "P1", "orchestration": "parallel-then-synthesis", "synthesisPhase": true }] }] }',
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
