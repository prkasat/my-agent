import type { BeforeToolCallContext, BeforeToolCallResult } from "./types.js";

/**
 * Permission modes:
 * - "auto": all non-destructive operations allowed, destructive always blocked
 * - "read-only": only read operations allowed, all writes and executions blocked
 *
 * Destructive commands and protected paths are ALWAYS blocked regardless of mode.
 *
 * NOTE: Regex-based command parsing is inherently incomplete. A determined LLM
 * could bypass these checks via encoding tricks, scripting interpreters, or
 * uncommon command variants. For full safety, consider a real shell parser or
 * sandboxed execution environment. This is a pragmatic first layer of defense.
 */
export type PermissionMode = "auto" | "read-only";

/**
 * Patterns that indicate destructive or dangerous commands.
 * Covers: deletion, force operations, disk formatting, redirections to
 * sensitive locations, scripting interpreters, file-moving commands.
 */
const DESTRUCTIVE_PATTERNS = [
	// File deletion
	/\brm\s+(-[a-zA-Z]*[rf]|--recursive|--force)\b/,
	/\bsudo\s+rm\b/,
	/\bunlink\s+/,
	// Git destructive operations
	/\bgit\s+(reset\s+--hard|push\s+--force|push\s+-f\b|clean\s+-[fd])/,
	/\bgit\s+branch\s+-[dD]\b/,
	/\bgit\s+checkout\s+--\s/,
	// Database destructive
	/\bdrop\s+(table|database|index|schema)\b/i,
	/\btruncate\s+table\b/i,
	/\bdelete\s+from\b/i,
	// Process killing
	/\bkill\s+-9\b/,
	/\bkillall\b/,
	/\bpkill\b/,
	// Disk/system operations
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/>\s*\/dev\/sd[a-z]/,
	/\bchmod\s+777\b/,
	/\bchown\s+-R\b/,
	// Shell redirections that overwrite files
	/>\s*[^\s|&;]/, // single > redirect (overwrite)
	/\btee\s+(?!-a)/, // tee without -a (overwrites)
	// File moving/copying that could overwrite
	/\bmv\s+.*\s+\//,
	/\bcp\s+(-[a-zA-Z]*r|--recursive)/, // recursive copy
	// In-place file modification via common tools
	/\bsed\s+(-[a-zA-Z]*i|--in-place)\b/,
	/\bperl\s+(-[a-zA-Z]*i|--in-place)\b/,
	// Scripting interpreters that could do anything
	/\bpython[23]?\s+-c\b/,
	/\bruby\s+-e\b/,
	/\bnode\s+-e\b/,
	/\bperl\s+-e\b/,
	// Package managers (can modify system state)
	/\bnpm\s+(publish|unpublish)\b/,
	/\bcurl\s+.*\|\s*(ba)?sh/, // curl | sh pattern
	/\bwget\s+.*\|\s*(ba)?sh/,
];

/**
 * Patterns for protected file paths.
 * Checked against both tool args.path AND inside bash command strings.
 */
const PROTECTED_PATH_PATTERNS = [
	/\/etc\//,
	/\/usr\//,
	/\/sys\//,
	/\/boot\//,
	/\.env\b/,
	/credentials\.json\b/,
	/\.ssh\//,
	/\.aws\//,
	/\.gnupg\//,
	/\.npmrc\b/,
	/\.netrc\b/,
	/id_rsa/,
	/id_ed25519/,
	/\.pem\b/,
	/\.key\b/,
];

const WRITE_TOOLS = new Set(["write", "edit", "bash", "notebook_edit"]);

interface PermissionChecker {
	check: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult>;
}

export interface PermissionCheckerOptions {
	/** Additional tool names that require confirmation (tool-level overrides) */
	requireConfirmation?: Set<string>;
}

export function createPermissionChecker(
	mode: PermissionMode,
	options?: PermissionCheckerOptions,
): PermissionChecker {
	return {
		async check(ctx) {
			const { toolCall, args } = ctx;
			const typedArgs = args as Record<string, unknown>;

			// === Always blocked: destructive bash commands ===
			if (toolCall.name === "bash" && typeof typedArgs?.command === "string") {
				const cmd = typedArgs.command as string;

				// Check destructive patterns
				for (const pattern of DESTRUCTIVE_PATTERNS) {
					if (pattern.test(cmd)) {
						return { action: "block", reason: `Destructive command blocked: ${cmd}` };
					}
				}

				// Check if bash command references protected paths
				for (const pattern of PROTECTED_PATH_PATTERNS) {
					if (pattern.test(cmd)) {
						return { action: "block", reason: `Command references protected path: ${cmd}` };
					}
				}
			}

			// === Always blocked: protected paths via tool args ===
			const filePath = typedArgs?.path;
			if (typeof filePath === "string") {
				for (const pattern of PROTECTED_PATH_PATTERNS) {
					if (pattern.test(filePath)) {
						return { action: "block", reason: `Protected path: ${filePath}` };
					}
				}
			}

			// === Tool-level permission overrides ===
			if (options?.requireConfirmation?.has(toolCall.name)) {
				return { action: "block", reason: `Tool "${toolCall.name}" requires explicit confirmation` };
			}

			// === Read-only mode: block all write operations ===
			if (mode === "read-only" && WRITE_TOOLS.has(toolCall.name)) {
				return { action: "block", reason: "Write operations blocked in read-only mode" };
			}

			return { action: "allow" };
		},
	};
}
