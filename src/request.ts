import type { AgentScope } from "./agents.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_TIMEOUT_MS = 2_147_483_647;

export type SubagentMode = "single" | "parallel" | "chain";

export type OutputMode = "summary" | "full";

export interface RuntimeControls {
	timeoutMs?: number;
	maxOutputChars?: number;
	outputMode?: OutputMode;
}

export interface RequestTask extends RuntimeControls {
	agent?: string;
	task?: string;
	cwd?: string;
}

export interface SubagentParams extends RuntimeControls {
	agent?: string;
	task?: string;
	tasks?: RequestTask[];
	chain?: RequestTask[];
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
}

export interface ExecutionStep extends RuntimeControls {
	agent: string;
	task: string;
	cwd?: string;
	step?: number;
}

export interface ExecutionPlan {
	mode: SubagentMode;
	agentScope: AgentScope;
	confirmProjectAgents: boolean;
	steps: ExecutionStep[];
}

export class RequestValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RequestValidationError";
	}
}

function hasNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function fieldProvided(value: unknown): boolean {
	return value !== undefined && value !== null;
}

function validatePositiveInteger(value: unknown, label: string, max?: number): number | undefined {
	if (!fieldProvided(value)) return undefined;
	if (!Number.isInteger(value) || (value as number) <= 0 || (max !== undefined && (value as number) > max)) {
		const suffix = max === undefined ? "" : ` up to ${max}`;
		throw new RequestValidationError(`${label} must be a positive integer${suffix} when provided.`);
	}
	return value as number;
}

function validateOutputMode(value: unknown, label: string): OutputMode | undefined {
	if (!fieldProvided(value)) return undefined;
	if (value !== "summary" && value !== "full") {
		throw new RequestValidationError(`${label} must be "summary" or "full" when provided.`);
	}
	return value;
}

function runtimeControlsProvided(item: RuntimeControls): boolean {
	return fieldProvided(item.timeoutMs) || fieldProvided(item.maxOutputChars) || fieldProvided(item.outputMode);
}

function validateRuntimeControls(item: RuntimeControls, label: string): RuntimeControls {
	const controls: RuntimeControls = {};
	const timeoutMs = validatePositiveInteger(item.timeoutMs, `${label}.timeoutMs`, MAX_TIMEOUT_MS);
	const maxOutputChars = validatePositiveInteger(item.maxOutputChars, `${label}.maxOutputChars`);
	const outputMode = validateOutputMode(item.outputMode, `${label}.outputMode`);
	if (timeoutMs !== undefined) controls.timeoutMs = timeoutMs;
	if (maxOutputChars !== undefined) controls.maxOutputChars = maxOutputChars;
	if (outputMode !== undefined) controls.outputMode = outputMode;
	return controls;
}

function validateTaskItem(item: RequestTask, label: string): ExecutionStep {
	if (!hasNonEmptyString(item.agent)) throw new RequestValidationError(`${label}.agent must be a non-empty string.`);
	if (!hasNonEmptyString(item.task)) throw new RequestValidationError(`${label}.task must be a non-empty string.`);
	if (fieldProvided(item.cwd) && !hasNonEmptyString(item.cwd)) {
		throw new RequestValidationError(`${label}.cwd must be a non-empty string when provided.`);
	}
	return { agent: item.agent, task: item.task, cwd: item.cwd, ...validateRuntimeControls(item, label) };
}

export function normalizeSubagentRequest(params: SubagentParams): ExecutionPlan {
	const hasSingleFields = fieldProvided(params.agent) || fieldProvided(params.task) || fieldProvided(params.cwd) || runtimeControlsProvided(params);
	const hasParallelField = fieldProvided(params.tasks);
	const hasChainField = fieldProvided(params.chain);
	const modeCount = Number(hasSingleFields) + Number(hasParallelField) + Number(hasChainField);

	if (modeCount !== 1) {
		throw new RequestValidationError("Provide exactly one mode: single (agent/task), parallel (tasks), or chain (chain).");
	}

	const agentScope = params.agentScope ?? "user";
	const confirmProjectAgents = params.confirmProjectAgents ?? true;

	if (agentScope !== "user" && agentScope !== "project" && agentScope !== "both") {
		throw new RequestValidationError('agentScope must be one of "user", "project", or "both".');
	}

	if (hasSingleFields) {
		return {
			mode: "single",
			agentScope,
			confirmProjectAgents,
			steps: [validateTaskItem({ agent: params.agent, task: params.task, cwd: params.cwd, timeoutMs: params.timeoutMs, maxOutputChars: params.maxOutputChars, outputMode: params.outputMode }, "single")],
		};
	}

	if (hasParallelField) {
		if (!Array.isArray(params.tasks)) throw new RequestValidationError("tasks must be an array.");
		if (params.tasks.length === 0) throw new RequestValidationError("tasks must contain at least one task.");
		if (params.tasks.length > MAX_PARALLEL_TASKS) {
			throw new RequestValidationError(`Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
		}
		return {
			mode: "parallel",
			agentScope,
			confirmProjectAgents,
			steps: params.tasks.map((item, index) => validateTaskItem(item, `tasks[${index}]`)),
		};
	}

	if (!Array.isArray(params.chain)) throw new RequestValidationError("chain must be an array.");
	if (params.chain.length === 0) throw new RequestValidationError("chain must contain at least one step.");
	return {
		mode: "chain",
		agentScope,
		confirmProjectAgents,
		steps: params.chain.map((item, index) => ({ ...validateTaskItem(item, `chain[${index}]`), step: index + 1 })),
	};
}

export function requestedAgentNames(plan: ExecutionPlan): Set<string> {
	return new Set(plan.steps.map((step) => step.agent));
}
