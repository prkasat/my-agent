/**
 * Bash tool for executing shell commands.
 *
 * Features:
 * - Output sanitization (ANSI stripping, control char removal)
 * - Tail truncation (keeps last N lines/bytes for error visibility)
 * - Large output spill to temp file
 * - Timeout and cancellation support
 * - Exit code interpretation
 * - Audit logging
 * - Pluggable operations for remote execution
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { type Static, Type } from "@sinclair/typebox";
import type { AgentTool } from "../agent/types.js";
import { getAuditLogger } from "./audit.js";
import { killProcessTree } from "./process-cleanup.js";
import { redactSensitiveEnv, sanitizeOutput } from "./sanitize-output.js";
import { getShellConfig, getShellEnv } from "./shell-utils.js";
import { cleanupTempFile, getTempFilePath, preserveTempFile } from "./temp-file-manager.js";
import type { ToolDefinition } from "./tool-definition.js";
import { wrapToolDefinition } from "./tool-definition.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	/** Execution duration in milliseconds */
	durationMs?: number;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (SSH, containers, etc.).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using local shell execution.
 *
 * This is useful for extensions that intercept bash execution while
 * still using the standard local shell behavior.
 */
export function createLocalBashOperations(): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) => {
			return new Promise((resolve, reject) => {
				const { shell, args } = getShellConfig();

				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
					return;
				}

				const child = spawn(shell, [...args, command], {
					cwd,
					detached: true,
					env: env ?? getShellEnv(),
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (signal) signal.removeEventListener("abort", onAbort);
					reject(err);
				});

				// Use 'exit' instead of 'close' to avoid hanging when detached
				// descendants hold stdio open after the shell process exits.
				child.on("exit", (code) => {
					child.stdout?.destroy();
					child.stderr?.destroy();
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (signal) signal.removeEventListener("abort", onAbort);

					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
						return;
					}
					resolve({ exitCode: code });
				});
			});
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (e.g., shell setup) */
	commandPrefix?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/** Whether to clean up temp files on success. Default: true */
	cleanupOnSuccess?: boolean;
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
	const ops = options?.operations ?? createLocalBashOperations();
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const cleanupOnSuccess = options?.cleanupOnSuccess ?? true;

	return {
		name: "bash",
		label: "bash",
		version: 1,
		description: `Execute a bash command. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file.`,
		promptSnippet: "Execute bash commands",
		parameters: bashSchema,
		async execute(toolCallId, { command, timeout }, signal, onUpdate) {
			const startTime = Date.now();
			const audit = getAuditLogger().startExecution("bash", toolCallId, {
				command: command.length > 200 ? `${command.slice(0, 200)}...` : command,
				cwd,
				timeout,
			});

			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const baseContext: BashSpawnContext = { command: resolvedCommand, cwd, env: getShellEnv() };
			const spawnContext = spawnHook ? spawnHook(baseContext) : baseContext;

			if (onUpdate) onUpdate({ content: [], details: undefined });

			return new Promise((resolve, reject) => {
				let tempFilePath: string | undefined;
				let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
				let totalBytes = 0;
				const chunks: string[] = [];
				let chunksBytes = 0;
				const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

				// Use StringDecoder to properly handle UTF-8 across chunk boundaries
				const decoder = new StringDecoder("utf-8");

				const handleData = (data: Buffer) => {
					totalBytes += data.length;

					// Decode properly handling multibyte characters across chunk boundaries
					const decoded = decoder.write(data);

					// Sanitize output (strip ANSI, normalize line endings, remove control chars)
					const sanitized = sanitizeOutput(decoded);

					// Spill to temp file once output exceeds in-memory threshold
					if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
						tempFilePath = getTempFilePath();
						tempFileStream = createWriteStream(tempFilePath);
						for (const chunk of chunks) tempFileStream.write(chunk);
					}
					if (tempFileStream) tempFileStream.write(sanitized);

					// Rolling buffer for tail truncation
					chunks.push(sanitized);
					chunksBytes += sanitized.length;
					while (chunksBytes > maxChunksBytes && chunks.length > 1) {
						const removed = chunks.shift();
						if (removed === undefined) break;
						chunksBytes -= removed.length;
					}

					if (onUpdate) {
						const fullText = chunks.join("");
						const truncation = truncateTail(fullText);
						onUpdate({
							content: [{ type: "text", text: truncation.content || "" }],
							details: {
								truncation: truncation.truncated ? truncation : undefined,
								fullOutputPath: tempFilePath,
								durationMs: Date.now() - startTime,
							},
						});
					}
				};

				ops
					.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					})
					.then(({ exitCode }) => {
						// Flush any remaining bytes from the decoder
						const remaining = decoder.end();
						if (remaining) {
							const sanitized = sanitizeOutput(remaining);
							chunks.push(sanitized);
							if (tempFileStream) tempFileStream.write(sanitized);
						}

						if (tempFileStream) tempFileStream.end();

						const fullOutput = chunks.join("");
						const truncation = truncateTail(fullOutput);
						const durationMs = Date.now() - startTime;

						let outputText = truncation.content || "(no output)";
						let details: BashToolDetails = { durationMs };

						if (truncation.truncated) {
							details = { truncation, fullOutputPath: tempFilePath, durationMs };
							const startLine = truncation.totalLines - truncation.outputLines + 1;
							const endLine = truncation.totalLines;

							if (truncation.lastLinePartial) {
								const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
								outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
							} else if (truncation.truncatedBy === "lines") {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
							} else {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
							}
						}

						if (exitCode !== 0 && exitCode !== null) {
							outputText += `\n\nCommand exited with code ${exitCode}`;

							// Preserve temp file on failure for debugging
							if (tempFilePath) preserveTempFile(tempFilePath);

							audit.error(`Exit ${exitCode}`, { exitCode, truncated: truncation.truncated });
							reject(new Error(outputText));
						} else {
							// Clean up temp file on success if configured
							if (cleanupOnSuccess && tempFilePath) {
								cleanupTempFile(tempFilePath);
								details.fullOutputPath = undefined;
							}

							audit.success({ exitCode: exitCode ?? 0, truncated: truncation.truncated });
							resolve({ content: [{ type: "text", text: outputText }], details });
						}
					})
					.catch((err: Error) => {
						// Flush any remaining bytes from the decoder
						const remaining = decoder.end();
						if (remaining) {
							const sanitized = sanitizeOutput(remaining);
							chunks.push(sanitized);
							if (tempFileStream) tempFileStream.write(sanitized);
						}

						if (tempFileStream) tempFileStream.end();
						const fullOutput = chunks.join("");

						// Preserve temp file on error for debugging
						if (tempFilePath) preserveTempFile(tempFilePath);

						// Redact sensitive env vars from error messages
						const redactedMessage = redactSensitiveEnv(err.message);

						if (err.message === "aborted") {
							let output = fullOutput;
							if (output) output += "\n\n";
							output += "Command aborted";
							audit.abort({ truncated: false });
							reject(new Error(output));
						} else if (err.message.startsWith("timeout:")) {
							const timeoutSecs = err.message.split(":")[1];
							let output = fullOutput;
							if (output) output += "\n\n";
							output += `Command timed out after ${timeoutSecs} seconds`;
							audit.timeout({ truncated: false });
							reject(new Error(output));
						} else {
							audit.error(redactedMessage);
							reject(new Error(redactedMessage));
						}
					});
			});
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
