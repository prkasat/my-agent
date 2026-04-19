/**
 * Audit logging utilities for tool execution.
 *
 * Provides structured logging of tool executions for debugging and analysis.
 * Logs are stored in a rotating file or can be sent to a custom handler.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSecrets, redactValue } from "./redact.js";

/**
 * Audit log entry for a tool execution.
 */
export interface AuditLogEntry {
	/** ISO timestamp */
	timestamp: string;
	/** Tool name */
	tool: string;
	/** Tool call ID */
	toolCallId: string;
	/** Execution duration in milliseconds */
	durationMs: number;
	/** Exit status: "success", "error", "timeout", "aborted" */
	status: "success" | "error" | "timeout" | "aborted";
	/** Exit code (for bash tool) */
	exitCode?: number;
	/** Error message (if status is error) */
	error?: string;
	/** Working directory */
	cwd?: string;
	/** Command executed (for bash tool, truncated) */
	command?: string;
	/** Whether output was truncated */
	truncated?: boolean;
	/** Path to full output file (if truncated) */
	fullOutputPath?: string;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Audit logger configuration.
 */
export interface AuditLoggerConfig {
	/** Enable audit logging. Default: true */
	enabled?: boolean;
	/** Log directory. Default: ~/.my-agent/logs */
	logDir?: string;
	/** Maximum log file size in bytes. Default: 10MB */
	maxFileSize?: number;
	/** Maximum number of log files to keep. Default: 10 */
	maxFiles?: number;
	/** Custom log handler (overrides file logging) */
	handler?: (entry: AuditLogEntry) => void;
	/**
	 * Redact known secret patterns (API keys, bearer tokens, KEY=value
	 * env exports, etc.) from `command`, `error`, and `metadata` before
	 * persistence. Default: true. Disable only if you have a separate
	 * upstream redaction step or are auditing in a sealed environment
	 * where the log is never shared.
	 */
	redactSecrets?: boolean;
}

const DEFAULT_LOG_DIR = join(homedir(), ".my-agent", "logs");
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_FILES = 10;
const LOG_FILE_PREFIX = "audit-";
const LOG_FILE_SUFFIX = ".jsonl";

/**
 * Global audit logger instance.
 */
let globalLogger: AuditLogger | null = null;

/**
 * Audit logger class.
 */
export class AuditLogger {
	private config: Required<Omit<AuditLoggerConfig, "handler">> & { handler?: (entry: AuditLogEntry) => void };
	private currentLogFile: string | null = null;
	private currentFileSize = 0;

	constructor(config?: AuditLoggerConfig) {
		this.config = {
			enabled: config?.enabled ?? true,
			logDir: config?.logDir ?? DEFAULT_LOG_DIR,
			maxFileSize: config?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
			maxFiles: config?.maxFiles ?? DEFAULT_MAX_FILES,
			redactSecrets: config?.redactSecrets ?? true,
			handler: config?.handler,
		};
	}

	/**
	 * Log a tool execution.
	 *
	 * Applies secret redaction (when enabled) BEFORE handing off to the
	 * custom handler or the file writer, so neither path sees raw
	 * secrets in command/error/metadata.
	 */
	log(entry: AuditLogEntry): void {
		if (!this.config.enabled) return;

		const sanitized = this.config.redactSecrets ? this.redactEntry(entry) : entry;

		// Use custom handler if provided
		if (this.config.handler) {
			this.config.handler(sanitized);
			return;
		}

		// Write to file
		this.writeToFile(sanitized);
	}

	private redactEntry(entry: AuditLogEntry): AuditLogEntry {
		// Cheap reference-equality check: only allocate a new object if
		// at least one field needs rewriting. Most successful tool calls
		// have no secrets to redact and stay reference-stable.
		const command = entry.command !== undefined ? redactSecrets(entry.command) : undefined;
		const error = entry.error !== undefined ? redactSecrets(entry.error) : undefined;
		const metadata =
			entry.metadata !== undefined ? (redactValue(entry.metadata) as Record<string, unknown>) : undefined;
		return {
			...entry,
			...(entry.command !== undefined ? { command } : {}),
			...(entry.error !== undefined ? { error } : {}),
			...(entry.metadata !== undefined ? { metadata } : {}),
		};
	}

	/**
	 * Create a log entry helper for a tool execution.
	 */
	startExecution(tool: string, toolCallId: string, metadata?: Record<string, unknown>): ExecutionLogger {
		return new ExecutionLogger(this, tool, toolCallId, metadata);
	}

	private writeToFile(entry: AuditLogEntry): void {
		try {
			// Ensure log directory exists
			if (!existsSync(this.config.logDir)) {
				mkdirSync(this.config.logDir, { recursive: true });
			}

			const line = `${JSON.stringify(entry)}\n`;
			const lineBytes = Buffer.byteLength(line, "utf-8");

			// Rotate if needed before getting the log file
			if (this.currentFileSize + lineBytes > this.config.maxFileSize) {
				this.rotateLogFile();
			}

			// Get or create current log file (after potential rotation)
			const logFile = this.getCurrentLogFile();

			// Write entry
			appendFileSync(logFile, line);
			this.currentFileSize += lineBytes;
		} catch {
			// Silently ignore logging errors
		}
	}

	private getCurrentLogFile(): string {
		if (this.currentLogFile && existsSync(this.currentLogFile)) {
			return this.currentLogFile;
		}

		// Create new log file with timestamp + random suffix for uniqueness
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const randomSuffix = Math.random().toString(36).slice(2, 8);
		this.currentLogFile = join(this.config.logDir, `${LOG_FILE_PREFIX}${timestamp}-${randomSuffix}${LOG_FILE_SUFFIX}`);
		this.currentFileSize = 0;

		// Initialize file
		writeFileSync(this.currentLogFile, "");

		// Clean up old logs after creating the new file
		this.cleanupOldLogs();

		return this.currentLogFile;
	}

	private rotateLogFile(): void {
		this.currentLogFile = null;
		this.currentFileSize = 0;
		// Cleanup happens in getCurrentLogFile() after the new file is created
	}

	private cleanupOldLogs(): void {
		try {
			const files = readdirSync(this.config.logDir)
				.filter((f) => f.startsWith(LOG_FILE_PREFIX) && f.endsWith(LOG_FILE_SUFFIX))
				.map((f) => ({
					name: f,
					path: join(this.config.logDir, f),
					mtime: statSync(join(this.config.logDir, f)).mtimeMs,
				}))
				.sort((a, b) => b.mtime - a.mtime);

			// Remove excess files
			const toRemove = files.slice(this.config.maxFiles);
			for (const file of toRemove) {
				rmSync(file.path, { force: true });
			}
		} catch {
			// Ignore cleanup errors
		}
	}

	/**
	 * Get recent audit log entries.
	 */
	getRecentEntries(limit = 100): AuditLogEntry[] {
		const entries: AuditLogEntry[] = [];

		try {
			// Sort by modification time (newest first) to handle random filename suffixes
			const files = readdirSync(this.config.logDir)
				.filter((f) => f.startsWith(LOG_FILE_PREFIX) && f.endsWith(LOG_FILE_SUFFIX))
				.map((f) => {
					const fullPath = join(this.config.logDir, f);
					return { path: fullPath, mtime: statSync(fullPath).mtimeMs };
				})
				.sort((a, b) => b.mtime - a.mtime)
				.map((f) => f.path);

			for (const file of files) {
				if (entries.length >= limit) break;

				const content = readFileSync(file, "utf-8") as string;
				const lines = content.trim().split("\n").filter(Boolean).reverse();

				for (const line of lines) {
					if (entries.length >= limit) break;
					try {
						entries.push(JSON.parse(line));
					} catch {
						// Skip invalid lines
					}
				}
			}
		} catch {
			// Return what we have
		}

		return entries;
	}
}

/**
 * Helper class for tracking a single tool execution.
 */
export class ExecutionLogger {
	private startTime = Date.now();
	private logger: AuditLogger;
	private tool: string;
	private toolCallId: string;
	private metadata?: Record<string, unknown>;

	constructor(logger: AuditLogger, tool: string, toolCallId: string, metadata?: Record<string, unknown>) {
		this.logger = logger;
		this.tool = tool;
		this.toolCallId = toolCallId;
		this.metadata = metadata;
	}

	/**
	 * Log successful completion.
	 */
	success(details?: Partial<AuditLogEntry>): void {
		this.log("success", details);
	}

	/**
	 * Log error.
	 */
	error(error: string | Error, details?: Partial<AuditLogEntry>): void {
		const errorMessage = error instanceof Error ? error.message : error;
		this.log("error", { ...details, error: errorMessage });
	}

	/**
	 * Log timeout.
	 */
	timeout(details?: Partial<AuditLogEntry>): void {
		this.log("timeout", details);
	}

	/**
	 * Log abort.
	 */
	abort(details?: Partial<AuditLogEntry>): void {
		this.log("aborted", details);
	}

	private log(status: AuditLogEntry["status"], details?: Partial<AuditLogEntry>): void {
		const entry: AuditLogEntry = {
			timestamp: new Date().toISOString(),
			tool: this.tool,
			toolCallId: this.toolCallId,
			durationMs: Date.now() - this.startTime,
			status,
			...details,
			metadata: { ...this.metadata, ...details?.metadata },
		};

		this.logger.log(entry);
	}
}

/**
 * Get the global audit logger instance.
 */
export function getAuditLogger(): AuditLogger {
	if (!globalLogger) {
		globalLogger = new AuditLogger();
	}
	return globalLogger;
}

/**
 * Configure the global audit logger.
 */
export function configureAuditLogger(config: AuditLoggerConfig): void {
	globalLogger = new AuditLogger(config);
}

/**
 * Disable audit logging globally.
 */
export function disableAuditLogging(): void {
	globalLogger = new AuditLogger({ enabled: false });
}
