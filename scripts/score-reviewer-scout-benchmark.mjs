#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const DEFAULT_FIXTURES_PATH = "docs/benchmarks/reviewer-scout-fixtures.json";
const DEFAULT_REVIEWER_AGENT_PATH = `${process.env.HOME ?? ""}/.pi/agent/agents/reviewer.md`;
const DEFAULT_SCOUT_AGENT_PATH = `${process.env.HOME ?? ""}/.pi/agent/agents/scout.md`;
const VALID_GROUPS = new Set(["positive", "negative", "adversarial"]);
const ALLOWED_SCOUT_AGENT = "scout";
const REVIEWER_FORBIDDEN_TOOLS = new Set(["bash", "edit", "write"]);
const SCOUT_FORBIDDEN_TOOLS = new Set(["subagent", "edit", "write"]);
const MAX_EVIDENCE_REF_SPAN_LINES = 80;

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

function asPositiveInteger(value, label) {
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
	return value;
}

function validateEvidenceRef(ref, label) {
	if (!ref || typeof ref !== "object") throw new Error(`${label} must be an object.`);
	if (typeof ref.kind !== "string" || ref.kind.trim() === "") throw new Error(`${label}.kind must be a non-empty string.`);
	if (typeof ref.path !== "string" || ref.path.trim() === "") throw new Error(`${label}.path must be a non-empty string.`);
	const startLine = asPositiveInteger(ref.startLine, `${label}.startLine`);
	const endLine = asPositiveInteger(ref.endLine, `${label}.endLine`);
	if (endLine < startLine) throw new Error(`${label}.endLine must be greater than or equal to startLine.`);
	if (endLine - startLine + 1 > MAX_EVIDENCE_REF_SPAN_LINES) {
		throw new Error(`${label} must span at most ${MAX_EVIDENCE_REF_SPAN_LINES} lines.`);
	}
}

function evidenceRefMatches(required, actual) {
	return required.kind === actual.kind
		&& required.path === actual.path
		&& actual.startLine <= required.endLine
		&& actual.endLine >= required.startLine;
}

function formatEvidenceRef(ref) {
	return `${ref.kind}:${ref.path}:${ref.startLine}-${ref.endLine}`;
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
		for (const [index, ref] of optionalArray(fixture.requiredEvidenceRefs, `fixture ${fixture.id} requiredEvidenceRefs`).entries()) {
			validateEvidenceRef(ref, `fixture ${fixture.id} requiredEvidenceRefs[${index}]`);
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
			const scoutCalls = asNonNegativeInteger(decision.scoutCalls ?? 0, `run ${run.condition} fixture ${decision.fixtureId} scoutCalls`);
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
			for (const [refIndex, ref] of optionalArray(decision.evidenceRefs, `run ${run.condition} fixture ${decision.fixtureId} evidenceRefs`).entries()) {
				validateEvidenceRef(ref, `run ${run.condition} fixture ${decision.fixtureId} evidenceRefs[${refIndex}]`);
			}
			const subagentCalls = optionalArray(decision.subagentCalls, `run ${run.condition} fixture ${decision.fixtureId} subagentCalls`);
			if (subagentCalls.length !== scoutCalls) {
				throw new Error(`run ${run.condition} fixture ${decision.fixtureId} subagentCalls length must match scoutCalls.`);
			}
			for (const [callIndex, call] of subagentCalls.entries()) {
				if (!call || typeof call !== "object") {
					throw new Error(`run ${run.condition} fixture ${decision.fixtureId} subagentCalls[${callIndex}] must be an object.`);
				}
				if (typeof call.agent !== "string" || call.agent.trim() === "") {
					throw new Error(`run ${run.condition} fixture ${decision.fixtureId} subagentCalls[${callIndex}].agent must be a non-empty string.`);
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
	const requiredEvidenceRefs = fixture.requiredEvidenceRefs ?? [];
	const evidenceRefs = decision.evidenceRefs ?? [];
	const missingEvidenceRefs = requiredEvidenceRefs.filter((required) => !evidenceRefs.some((actual) => evidenceRefMatches(required, actual)));
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
	const subagentCalls = decision.subagentCalls ?? [];
	const nonScoutSubagentCall = subagentCalls.some((call) => call.agent !== ALLOWED_SCOUT_AGENT);
	const missingEvidenceSeparation = fixture.expectedScoutUse === true && scoutCalls > 0 && decision.evidenceSeparated !== true;

	const failures = [
		[recursionViolation, "recursion violation"],
		[mutationToolViolation, "mutation tool violation"],
		[finalJudgmentDelegated, "final judgment delegated"],
		[nonScoutSubagentCall, "non-scout subagent call"],
		[tooManyScoutCalls, "too many scout calls"],
		[outputCapViolation, "output cap violation"],
		[falsePositive, "unexpected scout use"],
		[missedScout, "missing scout use"],
		[missingEvidence.length > 0, `missing evidence: ${missingEvidence.join(", ")}`],
		[missingEvidenceRefs.length > 0, `missing seeded evidence: ${missingEvidenceRefs.map(formatEvidenceRef).join(", ")}`],
		[missingEvidenceSeparation, "scout evidence not separated from reviewer judgment"],
	];
	const failure = failures.find(([failed]) => failed);
	return {
		...baseResult(fixture, failure ? "fail" : "pass", failure ? failure[1] : "expected scout behavior"),
		falsePositive,
		missedScout,
		tooManyScoutCalls,
		missingEvidence: missingEvidence.length > 0,
		missingSeededEvidence: missingEvidenceRefs.length > 0,
		recursionViolation,
		mutationToolViolation,
		finalJudgmentDelegated,
		nonScoutSubagentCall,
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
		missingSeededEvidence: false,
		recursionViolation: false,
		mutationToolViolation: false,
		finalJudgmentDelegated: false,
		nonScoutSubagentCall: false,
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
			"missingSeededEvidence",
			"recursionViolation",
			"mutationToolViolation",
			"finalJudgmentDelegated",
			"nonScoutSubagentCall",
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
		missingSeededEvidence: 0,
		recursionViolation: 0,
		mutationToolViolation: 0,
		finalJudgmentDelegated: 0,
		nonScoutSubagentCall: 0,
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
		maxNonScoutSubagentCalls: 0,
		maxSeededEvidenceMisses: 0,
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
			["nonScoutSubagentCall", "maxNonScoutSubagentCalls"],
			["missingSeededEvidence", "maxSeededEvidenceMisses"],
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

function parseAgentFrontmatter(text, filePath) {
	const { frontmatter } = parseFrontmatter(text);
	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name || !description) throw new Error("Missing required frontmatter: name and description");
	if (frontmatter.tools !== undefined && typeof frontmatter.tools !== "string") {
		throw new Error("frontmatter tools must be a comma-separated string");
	}
	const tools = typeof frontmatter.tools === "string"
		? frontmatter.tools.split(",").map((tool) => tool.trim()).filter(Boolean)
		: [];
	return { filePath, name, tools };
}

function readAgentConfig(filePath) {
	return parseAgentFrontmatter(fs.readFileSync(filePath, "utf8"), filePath);
}

function expandHome(filePath) {
	if (filePath === "~") return process.env.HOME ?? filePath;
	if (filePath.startsWith("~/")) return `${process.env.HOME ?? ""}/${filePath.slice(2)}`;
	return filePath;
}

function normalizedToolSet(agent) {
	return new Set(agent.tools.map((tool) => tool.trim().toLowerCase()).filter(Boolean));
}

function addMissingAgentIssue(issues, role, filePath, error) {
	issues.push({ role, filePath, metric: "agentConfigReadable", expected: "readable agent file with frontmatter", actual: error instanceof Error ? error.message : String(error) });
}

export function buildPromptOnlyPreflightReport({ reviewerAgentPath = DEFAULT_REVIEWER_AGENT_PATH, scoutAgentPath = DEFAULT_SCOUT_AGENT_PATH } = {}) {
	const issues = [];
	let reviewer;
	let scout;
	try {
		reviewer = readAgentConfig(expandHome(reviewerAgentPath));
	} catch (error) {
		addMissingAgentIssue(issues, "reviewer", reviewerAgentPath, error);
	}
	try {
		scout = readAgentConfig(expandHome(scoutAgentPath));
	} catch (error) {
		addMissingAgentIssue(issues, "scout", scoutAgentPath, error);
	}
	if (reviewer) {
		const tools = normalizedToolSet(reviewer);
		if (!tools.has("subagent")) issues.push({ role: "reviewer", filePath: reviewer.filePath, metric: "requiredTool", expected: "subagent", actual: reviewer.tools });
		for (const tool of REVIEWER_FORBIDDEN_TOOLS) {
			if (tools.has(tool)) issues.push({ role: "reviewer", filePath: reviewer.filePath, metric: "forbiddenTool", expected: `no ${tool}`, actual: reviewer.tools });
		}
	}
	if (scout) {
		if (scout.name !== ALLOWED_SCOUT_AGENT) issues.push({ role: "scout", filePath: scout.filePath, metric: "agentName", expected: ALLOWED_SCOUT_AGENT, actual: scout.name });
		const tools = normalizedToolSet(scout);
		for (const tool of SCOUT_FORBIDDEN_TOOLS) {
			if (tools.has(tool)) issues.push({ role: "scout", filePath: scout.filePath, metric: "forbiddenTool", expected: `no ${tool}`, actual: scout.tools });
		}
	}
	return {
		version: 1,
		preflight: {
			status: issues.length === 0 ? "pass" : "fail",
			reviewer: reviewer ? { filePath: reviewer.filePath, name: reviewer.name, tools: reviewer.tools } : undefined,
			scout: scout ? { filePath: scout.filePath, name: scout.name, tools: scout.tools } : undefined,
			issues,
		},
	};
}

function parseArgs(args) {
	const parsed = { fixtures: DEFAULT_FIXTURES_PATH, thresholdGate: false, reviewerAgent: DEFAULT_REVIEWER_AGENT_PATH, scoutAgent: DEFAULT_SCOUT_AGENT_PATH };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const [name, inlineValue] = arg.split("=", 2);
		const value = inlineValue ?? args[i + 1];
		if (arg === "--threshold-gate") parsed.thresholdGate = true;
		else if (arg === "--agent-preflight") parsed.agentPreflight = true;
		else if (name === "--fixtures") {
			if (!value) throw new Error("--fixtures requires a value");
			parsed.fixtures = value;
			if (inlineValue === undefined) i++;
		} else if (name === "--decisions") {
			if (!value) throw new Error("--decisions requires a value");
			parsed.decisions = value;
			if (inlineValue === undefined) i++;
		} else if (name === "--reviewer-agent") {
			if (!value) throw new Error("--reviewer-agent requires a value");
			parsed.reviewerAgent = value;
			if (inlineValue === undefined) i++;
		} else if (name === "--scout-agent") {
			if (!value) throw new Error("--scout-agent requires a value");
			parsed.scoutAgent = value;
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
		"Usage: score-reviewer-scout-benchmark.mjs [--fixtures fixtures.json] [--decisions decisions.json] [--threshold-gate]",
		"       score-reviewer-scout-benchmark.mjs --agent-preflight [--reviewer-agent reviewer.md] [--scout-agent scout.md] [--threshold-gate]",
		"",
		"Without --decisions, the command validates fixtures and prints a fixture summary.",
		"With --agent-preflight, the command checks whether prompt-only reviewer→scout trials are runnable.",
	].join("\n");
}

async function runCli() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(usage());
		return;
	}
	if (args.agentPreflight) {
		const report = buildPromptOnlyPreflightReport({ reviewerAgentPath: args.reviewerAgent, scoutAgentPath: args.scoutAgent });
		console.log(JSON.stringify(report, null, 2));
		if (args.thresholdGate && report.preflight.status !== "pass") process.exitCode = 1;
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
