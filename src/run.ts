import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EventEmitter } from "node:events";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, InvalidAgentDiagnostic } from "./agents.js";

const DEFAULT_AGENT_END_GRACE_MS = 2000;
const DEFAULT_AGENT_END_FORCE_KILL_MS = 1000;
const DEFAULT_ABORT_FORCE_KILL_MS = 5000;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_STORED_MESSAGES = 200;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: "user" | "project" | "both";
	projectAgentsDir: string | null;
	invalidAgents?: InvalidAgentDiagnostic[];
	results: SingleResult[];
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface SpawnedProcess extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export type ProcessSpawner = (
	command: string,
	args: string[],
	options: { cwd: string; shell: false; stdio: ["ignore", "pipe", "pipe"] },
) => SpawnedProcess;

export interface RunSingleAgentOptions {
	defaultCwd: string;
	agents: AgentConfig[];
	agentName: string;
	task: string;
	cwd?: string;
	step?: number;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	spawner?: ProcessSpawner;
	now?: typeof setTimeout;
	agentEndGraceMs?: number;
	agentEndForceKillMs?: number;
	abortForceKillMs?: number;
	maxStderrBytes?: number;
	maxStoredMessages?: number;
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function appendLimited(current: string, chunk: string, maxBytes: number, label: string): string {
	if (maxBytes <= 0 || current.length >= maxBytes) return current;
	if (current.length + chunk.length <= maxBytes) return current + chunk;
	const remaining = maxBytes - current.length;
	const suffix = `\n[${label} truncated after ${maxBytes} bytes]\n`;
	return current + chunk.slice(0, Math.max(0, remaining - suffix.length)) + suffix;
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			return msg.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n\n");
		}
	}
	return "";
}

export async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function addMessageToResult(result: SingleResult, message: Message, maxStoredMessages: number) {
	if (result.messages.length < maxStoredMessages) {
		result.messages.push(message);
		return;
	}
	if (!result.stderr.includes("Subagent message output limit reached")) {
		result.stderr = appendLimited(
			result.stderr,
			"Subagent message output limit reached; later message events were ignored.\n",
			DEFAULT_MAX_STDERR_BYTES,
			"stderr",
		);
	}
}

function ingestAssistantUsage(result: SingleResult, msg: Message) {
	if (msg.role !== "assistant") return;
	result.usage.turns++;
	const usage = msg.usage;
	if (usage) {
		result.usage.input += usage.input || 0;
		result.usage.output += usage.output || 0;
		result.usage.cacheRead += usage.cacheRead || 0;
		result.usage.cacheWrite += usage.cacheWrite || 0;
		result.usage.cost += usage.cost?.total || 0;
		result.usage.contextTokens = usage.totalTokens || 0;
	}
	if (!result.model && msg.model) result.model = msg.model;
	if (msg.stopReason) result.stopReason = msg.stopReason;
	if (msg.errorMessage) result.errorMessage = msg.errorMessage;
}

export async function runSingleAgent(options: RunSingleAgentOptions): Promise<SingleResult> {
	const agent = options.agents.find((a) => a.name === options.agentName);
	const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
	const maxStoredMessages = options.maxStoredMessages ?? DEFAULT_MAX_STORED_MESSAGES;

	if (!agent) {
		const available = options.agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: options.agentName,
			agentSource: "unknown",
			task: options.task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${options.agentName}". Available agents: ${available}.`,
			usage: emptyUsage(),
			step: options.step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: options.agentName,
		agentSource: agent.source,
		task: options.task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		step: options.step,
	};

	const emitUpdate = () => {
		options.onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: options.makeDetails([currentResult]),
		});
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${options.task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const spawner = options.spawner ?? ((command, procArgs, procOptions) => spawn(command, procArgs, procOptions));
			const proc = spawner(invocation.command, invocation.args, {
				cwd: options.cwd ?? options.defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			let resolved = false;
			let childClosed = false;
			let finalEventSeen = false;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
			let forceKillFallbackTimer: ReturnType<typeof setTimeout> | undefined;
			let abortFallbackTimer: ReturnType<typeof setTimeout> | undefined;
			let abortHandler: (() => void) | undefined;

			const finish = (code: number) => {
				if (resolved) return;
				resolved = true;
				if (forceKillTimer) clearTimeout(forceKillTimer);
				if (forceKillFallbackTimer) clearTimeout(forceKillFallbackTimer);
				if (abortFallbackTimer) clearTimeout(abortFallbackTimer);
				if (options.signal && abortHandler) options.signal.removeEventListener("abort", abortHandler);
				resolve(code);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					currentResult.stderr = appendLimited(
						currentResult.stderr,
						"Ignored malformed JSON event on subagent stdout.\n",
						maxStderrBytes,
						"stderr",
					);
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					addMessageToResult(currentResult, msg, maxStoredMessages);
					ingestAssistantUsage(currentResult, msg);
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					addMessageToResult(currentResult, event.message as Message, maxStoredMessages);
					emitUpdate();
				}

				if (event.type === "agent_end") {
					emitUpdate();
					terminateAfterFinalEvent();
				}
			};

			const scheduleTimer = options.now ?? setTimeout;

			const terminateAfterFinalEvent = () => {
				if (finalEventSeen || childClosed) return;
				finalEventSeen = true;
				forceKillTimer = scheduleTimer(() => {
					if (childClosed || resolved) return;
					proc.kill("SIGTERM");
					forceKillFallbackTimer = scheduleTimer(() => {
						if (childClosed || resolved) return;
						if (buffer.trim()) {
							processLine(buffer);
							buffer = "";
						}
						currentResult.stderr = appendLimited(
							currentResult.stderr,
							"Subagent process did not exit after agent_end; force-killed after final result.\n",
							maxStderrBytes,
							"stderr",
						);
						proc.kill("SIGKILL");
						finish(0);
					}, options.agentEndForceKillMs ?? DEFAULT_AGENT_END_FORCE_KILL_MS);
					forceKillFallbackTimer.unref?.();
				}, options.agentEndGraceMs ?? DEFAULT_AGENT_END_GRACE_MS);
				forceKillTimer.unref?.();
			};

			proc.stdout.on("data", (data) => {
				if (resolved) return;
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				if (resolved) return;
				currentResult.stderr = appendLimited(currentResult.stderr, data.toString(), maxStderrBytes, "stderr");
			});

			proc.on("close", (code) => {
				childClosed = true;
				if (buffer.trim()) processLine(buffer);
				finish(code ?? 0);
			});

			proc.on("error", (error) => {
				currentResult.stderr = appendLimited(
					currentResult.stderr,
					`Subagent process error: ${error instanceof Error ? error.message : String(error)}\n`,
					maxStderrBytes,
					"stderr",
				);
				finish(1);
			});

			if (options.signal) {
				const killProc = () => {
					wasAborted = true;
					if (!childClosed) proc.kill("SIGTERM");
					abortFallbackTimer = scheduleTimer(() => {
						if (!childClosed && !resolved) {
							proc.kill("SIGKILL");
							finish(1);
						}
					}, options.abortForceKillMs ?? DEFAULT_ABORT_FORCE_KILL_MS);
					abortFallbackTimer.unref?.();
				};
				abortHandler = killProc;
				if (options.signal.aborted) killProc();
				else options.signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		}
	}
}
