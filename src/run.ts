import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentScope, InvalidAgentDiagnostic } from "./agents.js";

const DEFAULT_AGENT_END_GRACE_MS = 2000;
const DEFAULT_AGENT_END_FORCE_KILL_MS = 1000;
const DEFAULT_ABORT_FORCE_KILL_MS = 5000;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_STDOUT_BUFFER_CHARS = 1024 * 1024;
const DEFAULT_MAX_JSON_LINE_CHARS = 1024 * 1024;
const DEFAULT_MAX_STORED_MESSAGES = 200;
const DEFAULT_MAX_STORED_MESSAGE_CHARS = 64 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;

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
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	invalidAgents?: InvalidAgentDiagnostic[];
	results: SingleResult[];
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface SpawnedProcess extends EventEmitter {
	stdin: Writable;
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export type ProcessSpawner = (
	command: string,
	args: string[],
	options: { cwd: string; shell: false; stdio: ["pipe", "pipe", "pipe"] },
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
	maxStdoutBufferChars?: number;
	maxJsonLineChars?: number;
	maxStoredMessages?: number;
	maxStoredMessageChars?: number;
	timeoutMs?: number;
	maxOutputChars?: number;
	outputMode?: "summary" | "full";
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

function positiveLimit(value: number | undefined, fallback: number): number {
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

function serializedLength(value: unknown): number {
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === "string" ? serialized.length : 0;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 3) return text.slice(0, Math.max(0, maxChars));
	return `${text.slice(0, maxChars - 3)}...`;
}

function isProcessFailureStopReason(stopReason?: string): boolean {
	return stopReason === "error" || stopReason === "aborted" || stopReason === "timeout";
}

function limitMessageForStorage(
	result: SingleResult,
	message: Message,
	maxStoredMessageChars: number,
	maxStderrBytes: number,
): Message {
	if (serializedLength(message) <= maxStoredMessageChars) return message;

	result.stderr = appendLimited(
		result.stderr,
		`Subagent message truncated after ${maxStoredMessageChars} chars.\n`,
		maxStderrBytes,
		"stderr",
	);

	const content = Array.isArray((message as any).content) ? (message as any).content : [];
	const textBudget = Math.max(0, maxStoredMessageChars - 200);
	const textParts = content.filter((part: any) => part?.type === "text");
	const perTextBudget = textParts.length > 0 ? Math.max(0, Math.floor(textBudget / textParts.length)) : 0;
	const truncated = {
		...(message as any),
		content: content.map((part: any) =>
			part?.type === "text" ? { ...part, text: truncateText(String(part.text ?? ""), perTextBudget) } : part,
		),
	} as Message;
	if (serializedLength(truncated) <= maxStoredMessageChars) return truncated;

	const fallback = { role: (message as any).role ?? "assistant", content: [{ type: "text", text: "" }] };
	const fallbackOverhead = serializedLength(fallback);
	const fallbackText = `[truncated after ${maxStoredMessageChars} chars]`;
	return {
		role: fallback.role,
		content: [{ type: "text", text: truncateText(fallbackText, Math.max(0, maxStoredMessageChars - fallbackOverhead)) }],
	} as Message;
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

function addMessageToResult(result: SingleResult, message: Message, maxStoredMessages: number, maxStderrBytes: number) {
	if (result.messages.length < maxStoredMessages) {
		result.messages.push(message);
		return;
	}
	if (!result.stderr.includes("Subagent message output limit reached")) {
		result.stderr = appendLimited(
			result.stderr,
			"Subagent message output limit reached; later message events were ignored.\n",
			maxStderrBytes,
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
	if (msg.stopReason && !isProcessFailureStopReason(result.stopReason)) result.stopReason = msg.stopReason;
	if (msg.errorMessage && !isProcessFailureStopReason(result.stopReason)) result.errorMessage = msg.errorMessage;
}

export async function runSingleAgent(options: RunSingleAgentOptions): Promise<SingleResult> {
	const agent = options.agents.find((a) => a.name === options.agentName);
	const maxStderrBytes = positiveLimit(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES);
	const maxStdoutBufferChars = positiveLimit(options.maxStdoutBufferChars, DEFAULT_MAX_STDOUT_BUFFER_CHARS);
	const maxJsonLineChars = positiveLimit(options.maxJsonLineChars, DEFAULT_MAX_JSON_LINE_CHARS);
	const maxStoredMessages = positiveLimit(options.maxStoredMessages, DEFAULT_MAX_STORED_MESSAGES);
	const maxStoredMessageChars = positiveLimit(options.maxStoredMessageChars, DEFAULT_MAX_STORED_MESSAGE_CHARS);

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

		const taskPrompt = `Task: ${options.task}`;
		let wasAborted = false;
		let timedOut = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const spawner = options.spawner ?? ((command, procArgs, procOptions) => spawn(command, procArgs, procOptions));
			const proc = spawner(invocation.command, invocation.args, {
				cwd: options.cwd ?? options.defaultCwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});

			let buffer = "";
			let resolved = false;
			let childClosed = false;
			let finalEventSeen = false;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
			let forceKillFallbackTimer: ReturnType<typeof setTimeout> | undefined;
			let abortFallbackTimer: ReturnType<typeof setTimeout> | undefined;
			let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
			let timeoutFallbackTimer: ReturnType<typeof setTimeout> | undefined;
			let abortHandler: (() => void) | undefined;

			const finish = (code: number) => {
				if (resolved) return;
				resolved = true;
				if (forceKillTimer) clearTimeout(forceKillTimer);
				if (forceKillFallbackTimer) clearTimeout(forceKillFallbackTimer);
				if (abortFallbackTimer) clearTimeout(abortFallbackTimer);
				if (timeoutTimer) clearTimeout(timeoutTimer);
				if (timeoutFallbackTimer) clearTimeout(timeoutFallbackTimer);
				if (options.signal && abortHandler) options.signal.removeEventListener("abort", abortHandler);
				resolve(code);
			};

			const scheduleTimer = options.now ?? setTimeout;

			const recordProcessError = (message: string) => {
				if (isProcessFailureStopReason(currentResult.stopReason)) return;
				currentResult.stopReason = "error";
				currentResult.errorMessage = message;
				currentResult.stderr = appendLimited(currentResult.stderr, `${message}\n`, maxStderrBytes, "stderr");
			};

			const failAndTerminate = (message: string) => {
				if (resolved) return;
				recordProcessError(message);
				if (childClosed) {
					finish(1);
					return;
				}
				proc.kill("SIGTERM");
				if (!abortFallbackTimer) {
					abortFallbackTimer = scheduleTimer(() => {
						if (!childClosed && !resolved) {
							proc.kill("SIGKILL");
							finish(1);
						}
					}, options.abortForceKillMs ?? DEFAULT_ABORT_FORCE_KILL_MS);
					abortFallbackTimer.unref?.();
				}
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				if (line.length > maxJsonLineChars) {
					failAndTerminate(`Subagent stdout JSON line exceeded ${maxJsonLineChars} chars.`);
					return;
				}
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
					const storedMsg = currentResult.messages.length < maxStoredMessages
						? limitMessageForStorage(currentResult, msg, maxStoredMessageChars, maxStderrBytes)
						: msg;
					addMessageToResult(currentResult, storedMsg, maxStoredMessages, maxStderrBytes);
					ingestAssistantUsage(currentResult, msg);
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					const msg = event.message as Message;
					const storedMsg = currentResult.messages.length < maxStoredMessages
						? limitMessageForStorage(currentResult, msg, maxStoredMessageChars, maxStderrBytes)
						: msg;
					addMessageToResult(currentResult, storedMsg, maxStoredMessages, maxStderrBytes);
					emitUpdate();
				}

				if (event.type === "agent_end") {
					emitUpdate();
					terminateAfterFinalEvent();
				}
			};

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
				if (resolved || isProcessFailureStopReason(currentResult.stopReason)) return;
				const chunk = data.toString();
				const parts = chunk.split("\n");
				if (parts.length === 1) {
					if (buffer.length + chunk.length > maxStdoutBufferChars) {
						buffer = "";
						failAndTerminate(`Subagent stdout buffer exceeded ${maxStdoutBufferChars} chars.`);
						return;
					}
					buffer += chunk;
					return;
				}

				processLine(buffer + parts[0]);
				if (resolved || isProcessFailureStopReason(currentResult.stopReason)) return;
				for (const line of parts.slice(1, -1)) {
					processLine(line);
					if (resolved || isProcessFailureStopReason(currentResult.stopReason)) return;
				}
				buffer = parts[parts.length - 1] || "";
				if (buffer.length > maxStdoutBufferChars) {
					buffer = "";
					failAndTerminate(`Subagent stdout buffer exceeded ${maxStdoutBufferChars} chars.`);
				}
			});

			proc.stderr.on("data", (data) => {
				if (resolved) return;
				currentResult.stderr = appendLimited(currentResult.stderr, data.toString(), maxStderrBytes, "stderr");
			});

			proc.on("close", (code) => {
				childClosed = true;
				if (isProcessFailureStopReason(currentResult.stopReason)) {
					finish(1);
					return;
				}
				if (buffer.trim()) {
					processLine(buffer);
					if (isProcessFailureStopReason(currentResult.stopReason)) {
						finish(1);
						return;
					}
				}
				finish(code ?? 0);
			});

			proc.on("error", (error) => {
				const message = error instanceof Error ? error.message : String(error);
				currentResult.stopReason = "error";
				currentResult.errorMessage = `Subagent process error: ${message}`;
				currentResult.stderr = appendLimited(
					currentResult.stderr,
					`${currentResult.errorMessage}\n`,
					maxStderrBytes,
					"stderr",
				);
				finish(1);
			});

			if (Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= MAX_TIMEOUT_MS) {
				timeoutTimer = scheduleTimer(() => {
					if (childClosed || resolved) return;
					timedOut = true;
					currentResult.stopReason = "timeout";
					currentResult.errorMessage = `Subagent timed out after ${options.timeoutMs}ms.`;
					currentResult.stderr = appendLimited(currentResult.stderr, `${currentResult.errorMessage}\n`, maxStderrBytes, "stderr");
					proc.kill("SIGTERM");
					timeoutFallbackTimer = scheduleTimer(() => {
						if (!childClosed && !resolved) {
							proc.kill("SIGKILL");
							finish(1);
						}
					}, options.abortForceKillMs ?? DEFAULT_ABORT_FORCE_KILL_MS);
					timeoutFallbackTimer.unref?.();
				}, options.timeoutMs);
				timeoutTimer.unref?.();
			}

			proc.stdin.on("error", () => {
				// Ignore EPIPE if Pi exits before consuming stdin; process close/error handles the result.
			});
			proc.stdin.write(taskPrompt);
			proc.stdin.end();

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

		currentResult.exitCode = (wasAborted || timedOut || currentResult.stopReason === "error") && exitCode === 0 ? 1 : exitCode;
		if (timedOut) {
			currentResult.stopReason = "timeout";
			currentResult.errorMessage ||= `Subagent timed out after ${options.timeoutMs}ms.`;
			if (!currentResult.stderr.includes("Subagent timed out")) {
				currentResult.stderr = appendLimited(currentResult.stderr, `${currentResult.errorMessage}\n`, maxStderrBytes, "stderr");
			}
		} else if (wasAborted) {
			currentResult.stopReason = "aborted";
			currentResult.errorMessage ||= "Subagent was aborted.";
			currentResult.stderr = appendLimited(currentResult.stderr, "Subagent was aborted.\n", maxStderrBytes, "stderr");
		} else if (currentResult.exitCode !== 0 && !currentResult.stopReason) {
			currentResult.stopReason = "error";
			if (!currentResult.stderr.trim()) {
				currentResult.errorMessage = `Subagent process exited with code ${currentResult.exitCode}.`;
			}
		}
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
