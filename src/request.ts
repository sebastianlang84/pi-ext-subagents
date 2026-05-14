import type { AgentScope } from "./agents.js";

const MAX_PARALLEL_TASKS = 8;

export type SubagentMode = "single" | "parallel" | "chain";

export interface RequestTask {
	agent?: string;
	task?: string;
	cwd?: string;
}

export interface SubagentParams {
	agent?: string;
	task?: string;
	tasks?: RequestTask[];
	chain?: RequestTask[];
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
}

export interface ExecutionStep {
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

function validateTaskItem(item: RequestTask, label: string): ExecutionStep {
	if (!hasNonEmptyString(item.agent)) throw new RequestValidationError(`${label}.agent must be a non-empty string.`);
	if (!hasNonEmptyString(item.task)) throw new RequestValidationError(`${label}.task must be a non-empty string.`);
	if (fieldProvided(item.cwd) && !hasNonEmptyString(item.cwd)) {
		throw new RequestValidationError(`${label}.cwd must be a non-empty string when provided.`);
	}
	return { agent: item.agent, task: item.task, cwd: item.cwd };
}

export function normalizeSubagentRequest(params: SubagentParams): ExecutionPlan {
	const hasSingleFields = fieldProvided(params.agent) || fieldProvided(params.task) || fieldProvided(params.cwd);
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
			steps: [validateTaskItem({ agent: params.agent, task: params.task, cwd: params.cwd }, "single")],
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
