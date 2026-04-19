/**
 * Standalone bash command execution.
 *
 * Provides a unified bash execution implementation that can be used:
 * - By the bash tool for LLM-driven execution
 * - Directly by the TUI for user commands
 * - By other components that need shell execution
 */

import { type WriteStream, createWriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { type BashOperations, createLocalBashOperations } from "./bash.js";
import { redactSensitiveEnv, sanitizeOutput } from "./sanitize-output.js";
import { getTempFilePath } from "./temp-file-manager.js";
import { DEFAULT_MAX_BYTES, truncateTail } from "./truncate.js";

/**
 * Options for bash execution.
 */
export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Timeout in seconds */
	timeout?: number;
	/** Custom environment variables */
	env?: NodeJS.ProcessEnv;
}

/**
 * Result of bash execution.
 */
export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the command timed out */
	timedOut: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if exceeded threshold) */
	fullOutputPath?: string;
	/** Execution duration in milliseconds */
	durationMs: number;
	/** Human-readable exit status */
	exitStatus: string;
}

/**
 * Execute a bash command with optional streaming and cancellation support.
 *
 * Features:
 * - Output sanitization (ANSI stripping, control char removal)
 * - Tail truncation (keeps last N lines/bytes)
 * - Large output spill to temp file
 * - Timeout and cancellation support
 * - Exit code interpretation
 *
 * @param command The bash command to execute
 * @param cwd Working directory
 * @param options Execution options
 * @returns Execution result
 */
export async function executeBash(command: string, cwd: string, options?: BashExecutorOptions): Promise<BashResult> {
	return executeBashWithOperations(command, cwd, createLocalBashOperations(), options);
}

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const startTime = Date.now();
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;

	// Use StringDecoder to properly handle UTF-8 across chunk boundaries
	const decoder = new StringDecoder("utf-8");

	const onData = (data: Buffer) => {
		totalBytes += data.length;

		// Decode properly handling multibyte characters across chunk boundaries
		const decoded = decoder.write(data);

		// Sanitize output
		const text = sanitizeOutput(decoded);

		// Start spilling to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
			tempFilePath = getTempFilePath();
			tempFileStream = createWriteStream(tempFilePath);
			// Write all buffered chunks to file
			for (const chunk of outputChunks) {
				tempFileStream.write(chunk);
			}
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		// Keep rolling buffer for tail truncation
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift();
			if (removed === undefined) break;
			outputBytes -= removed.length;
		}

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	const flushDecoder = () => {
		// Flush any remaining bytes from the decoder
		const remaining = decoder.end();
		if (remaining) {
			const sanitized = sanitizeOutput(remaining);
			outputChunks.push(sanitized);
			if (tempFileStream) tempFileStream.write(sanitized);
		}
	};

	const buildResult = (exitCode: number | undefined, cancelled: boolean, timedOut: boolean): BashResult => {
		flushDecoder();

		if (tempFileStream) {
			tempFileStream.end();
		}

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		const durationMs = Date.now() - startTime;

		let exitStatus: string;
		if (cancelled) {
			exitStatus = "cancelled";
		} else if (timedOut) {
			exitStatus = `timed out after ${options?.timeout}s`;
		} else if (exitCode === undefined || exitCode === null) {
			exitStatus = "killed";
		} else {
			exitStatus = exitCode === 0 ? "success" : `code ${exitCode}`;
		}

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode,
			cancelled,
			timedOut,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
			durationMs,
			exitStatus,
		};
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
			timeout: options?.timeout,
			env: options?.env,
		});

		return buildResult(result.exitCode ?? undefined, false, false);
	} catch (err) {
		const error = err as Error;

		// Check for abort
		if (options?.signal?.aborted || error.message === "aborted") {
			return buildResult(undefined, true, false);
		}

		// Check for timeout
		if (error.message.startsWith("timeout:")) {
			return buildResult(undefined, false, true);
		}

		// Ensure cleanup happens even for unexpected errors
		flushDecoder();
		if (tempFileStream) {
			tempFileStream.end();
		}

		// Re-throw with redacted env
		const redactedMessage = redactSensitiveEnv(error.message);
		throw new Error(redactedMessage);
	}
}

/**
 * Execute a bash command and return simple output.
 * Convenience wrapper for simple use cases.
 *
 * @param command The bash command to execute
 * @param cwd Working directory
 * @param timeout Optional timeout in seconds
 * @returns Command output
 * @throws Error if command fails
 */
export async function exec(command: string, cwd: string, timeout?: number): Promise<string> {
	const result = await executeBash(command, cwd, { timeout });

	if (result.cancelled) {
		throw new Error("Command cancelled");
	}

	if (result.timedOut) {
		throw new Error(`Command timed out after ${timeout}s`);
	}

	if (result.exitCode !== 0) {
		throw new Error(`Command failed: ${result.exitStatus}\n${result.output}`);
	}

	return result.output;
}
