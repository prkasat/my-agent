import type { BeforeToolCallContext, BeforeToolCallResult } from "./types.js";

/**
 * Permission modes:
 * - "auto": destructive blocked, everything else allowed without prompting
 * - "ask":  destructive blocked, write tools trigger a user-confirmation
 *           callback (default-deny if no callback supplied)
 * - "deny": destructive blocked, ALL write tools blocked unconditionally
 * - "read-only": back-compat alias for "deny"
 *
 * Destructive commands and protected paths are ALWAYS blocked regardless
 * of mode — that floor never relaxes.
 *
 * NOTE: Regex-based command parsing is inherently incomplete. A
 * determined LLM could bypass these checks via encoding tricks, scripting
 * interpreters, or uncommon command variants. For full safety, consider
 * a real shell parser or sandboxed execution environment. This is a
 * pragmatic first layer of defense.
 */
export type PermissionMode = "auto" | "ask" | "deny" | "read-only";

/**
 * Decision returned by the user-confirmation callback for ask mode.
 *
 * - "allow_once":    permit this single tool call
 * - "allow_session": permit this AND every subsequent call to the same
 *                    tool name within the current PermissionChecker
 *                    instance (tab-style "always allow")
 * - "deny":          block this tool call
 */
export type AskDecision = "allow_once" | "allow_session" | "deny";

/**
 * Context passed to the ask callback so a UI can render a useful prompt.
 */
export interface PermissionAskContext {
	toolName: string;
	args: unknown;
	/** Bash-tool command, if applicable. */
	command?: string;
	/** Tool argument's `path` field, if applicable. */
	filePath?: string;
}

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

/**
 * Built-in tools known to be side-effecting. Always treated as writes
 * in ask/deny modes regardless of caller-supplied classification.
 */
const KNOWN_WRITE_TOOLS = new Set(["write", "edit", "bash", "notebook_edit"]);

/**
 * Names of the bundled side-effect-free tools. Exported as a constant
 * so a host that wants safe defaults can opt in explicitly:
 *
 *   createPermissionChecker("deny", {
 *     knownReadOnly: new Set(BUILTIN_READ_TOOL_NAMES),
 *   })
 *
 * The checker does NOT consult this list automatically. A previous
 * implementation auto-whitelisted these names, but Codex pass-5
 * showed that a host running in deny mode could be subverted by a
 * plugin/MCP tool registered with a colliding name (e.g. a custom
 * mutating tool named `read`). Identity-by-name is unreliable when
 * the tool registry is open, so safety classification is opt-in.
 */
export const BUILTIN_READ_TOOL_NAMES = ["read", "ls", "find", "grep"] as const;

interface PermissionChecker {
	check: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult>;
}

/**
 * Field names commonly used to carry filesystem paths across tool APIs.
 * Used by the protected-path floor so we don't have to guess at every
 * MCP/plugin tool's argument schema. NOT exhaustive — the path-shape
 * heuristic below is the backstop for fields we don't recognize.
 */
const PATH_FIELD_NAMES = new Set([
	"path", "paths",
	"filepath", "file_path", "filePath",
	"pathname", "pathName",
	"file", "files",
	"filename", "file_name", "fileName",
	"target", "targets",
	"source", "sources", "src",
	"dst", "dest", "destination",
	"keyfile", "key_file", "keyFile",
	"input", "inputs", "output", "outputs",
	"directory", "dir", "folder",
	"cwd", "root",
]);

/**
 * Heuristic: a string is "path-shaped" if it looks like a filesystem path
 * argument. Used to scan unknown fields without tripping on freeform text
 * that merely mentions a protected name (e.g. `content: "Don't commit .env"`,
 * a markdown note, an `oldString` for a code edit, etc.).
 *
 * Anchors only at the start of the string so prose containing the
 * substring is left alone. Recognized leading shapes:
 *   /abs/unix      ~/home-rel    ./rel    ../rel
 *   C:\windows     C:/forwardslash
 */
const PATH_SHAPE_RE = /^(\/|~\/?|\.\.?\/|[A-Za-z]:[\\/])/;

function looksLikePath(value: string): boolean {
	if (value.length === 0 || value.length > 4096) return false;
	if (/[\s\n\r\t]/.test(value)) return false; // Real paths don't have whitespace.
	return PATH_SHAPE_RE.test(value);
}

/**
 * Walk every leaf of the tool args (top-level, nested objects, arrays)
 * and yield only strings that PLAUSIBLY represent a filesystem path —
 * either because they live under a known path-named field, or because
 * they are path-shaped on their own.
 *
 * Why both filters: we cannot trust field names (custom MCP/plugin tools
 * use anything they like, Codex pass-7) and we cannot trust naked
 * substring matches against `.env` / `/etc/` / `id_rsa` (they break
 * legitimate write/edit content + test fixtures, Codex pass-8). Together
 * they cover the actual attack surface — secret-file reads through
 * whitelisted custom tools — without false-positives on prose.
 *
 * Depth is unbounded; JSON-shaped args (which is what we get from a
 * tool-call argument blob) cannot legally contain cycles, but a
 * defensive WeakSet shields us from a malformed Record that does.
 */
function* iterPathLikeValues(
	value: unknown,
	parentKey: string | null = null,
	seen = new WeakSet<object>(),
): Generator<string> {
	if (typeof value === "string") {
		const fromPathField = parentKey !== null && PATH_FIELD_NAMES.has(parentKey);
		if (fromPathField || looksLikePath(value)) yield value;
		return;
	}
	if (value && typeof value === "object") {
		if (seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			// Inherit the parent key — array elements under `paths: [...]`
			// should still be treated as path-bearing.
			for (const v of value) yield* iterPathLikeValues(v, parentKey, seen);
			return;
		}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			yield* iterPathLikeValues(v, k, seen);
		}
	}
}

export interface PermissionCheckerOptions {
	/**
	 * Additional tool names that require confirmation (tool-level
	 * overrides). In auto mode these are blocked outright; in ask mode
	 * they go through the onAsk prompt; in deny mode they are blocked.
	 */
	requireConfirmation?: Set<string>;
	/**
	 * Additional tool names known to be side-effect-free. Extends
	 * KNOWN_READ_TOOLS so callers can register custom tools (read_url,
	 * docs_lookup, etc.) without forcing them through ask prompts.
	 */
	knownReadOnly?: Set<string>;
	/**
	 * User-confirmation callback for "ask" mode. Receives the tool's
	 * name + arguments and returns a decision. Default-deny if absent
	 * (so a misconfigured ask mode fails closed, never silently
	 * permissive).
	 */
	onAsk?: (ctx: PermissionAskContext) => Promise<AskDecision>;
}

export function createPermissionChecker(
	mode: PermissionMode,
	options?: PermissionCheckerOptions,
): PermissionChecker {
	// Per-checker memory of "allow_session" decisions so a user who
	// approved a tool once isn't prompted again for the same tool name
	// in the same session.
	const sessionAllowed = new Set<string>();

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
			// Walk every PATH-LIKE string in the args (top-level, nested)
			// rather than only `args.path`. A custom read tool whitelisted
			// via knownReadOnly may carry the target under `filePath`,
			// `file_path`, `pathname`, etc., so the floor must run on
			// every plausible path field (Codex Tier-2 pass-7) — but it
			// must NOT trip on prose/content that merely mentions a
			// protected name like `.env` or `/etc/...` in a markdown
			// note, an oldString diff, or a test fixture (Codex Tier-2
			// pass-8). `iterPathLikeValues` filters on path-shape OR
			// path-named field to cover the actual attack surface
			// without false-positives on freeform text.
			for (const candidate of iterPathLikeValues(typedArgs)) {
				for (const pattern of PROTECTED_PATH_PATTERNS) {
					if (pattern.test(candidate)) {
						return { action: "block", reason: `Protected path: ${candidate}` };
					}
				}
			}

			// === Classify the tool ===
			// Fail-closed model: a tool is "write-like" (and thus subject
			// to ask/deny gating) UNLESS the host explicitly marks it
			// safe via knownReadOnly. There is no name-based built-in
			// allowlist — a host's tool registry is open (MCP, plugins,
			// re-exported core tools), and trusting "read"/"ls"/"find"/"grep"
			// by name lets a custom mutating tool registered with a
			// colliding name bypass deny mode entirely (Codex pass-5).
			//
			// Hosts that want the bundled safe defaults pass:
			//   knownReadOnly: new Set(BUILTIN_READ_TOOL_NAMES)
			// — opt-in is explicit and visible in code review.
			//
			// requireConfirmation is a HARD OVERRIDE: any tool listed
			// there is gated regardless of read/write classification.
			//
			// KNOWN_WRITE_TOOLS is non-overridable: a host passing
			// `knownReadOnly: new Set(['bash'])` MUST NOT bypass the
			// gating for built-in writes.
			//
			// Final precedence (highest first):
			//   requireConfirmation → KNOWN_WRITE_TOOLS → knownReadOnly
			//                       → unknown (write-like)
			const isExplicitlyConfirmed =
				options?.requireConfirmation?.has(toolCall.name) === true;
			const isKnownWrite = KNOWN_WRITE_TOOLS.has(toolCall.name);
			const isKnownRead =
				!isExplicitlyConfirmed &&
				!isKnownWrite &&
				options?.knownReadOnly?.has(toolCall.name) === true;
			// Auto mode preserves its old generous behavior — only
			// known-writes and requireConfirmation tools matter there;
			// everything else allowed. Ask/deny use the fail-closed
			// classification so unknown custom tools don't slip through.
			const isWriteForAuto = isKnownWrite || isExplicitlyConfirmed;
			const isWriteForAskDeny = !isKnownRead;

			// === Deny / read-only mode: block all writes (fail-closed) ===
			if ((mode === "deny" || mode === "read-only") && isWriteForAskDeny) {
				return { action: "block", reason: "Write operations blocked in deny mode" };
			}

			// === Ask mode: prompt for writes (and unknowns); default-deny without callback ===
			if (mode === "ask" && isWriteForAskDeny) {
				if (sessionAllowed.has(toolCall.name)) {
					return { action: "allow" };
				}
				if (!options?.onAsk) {
					return {
						action: "block",
						reason: `Ask mode requires an onAsk callback; defaulting to deny for "${toolCall.name}"`,
					};
				}
				const askCtx: PermissionAskContext = {
					toolName: toolCall.name,
					args,
					command:
						typeof typedArgs?.command === "string"
							? (typedArgs.command as string)
							: undefined,
					filePath:
						typeof typedArgs?.path === "string"
							? (typedArgs.path as string)
							: undefined,
				};
				const decision = await options.onAsk(askCtx);
				if (decision === "allow_once") return { action: "allow" };
				if (decision === "allow_session") {
					sessionAllowed.add(toolCall.name);
					return { action: "allow" };
				}
				return {
					action: "block",
					reason: `User denied execution of "${toolCall.name}"`,
				};
			}

			// === Auto mode: requireConfirmation tools still need explicit allow ===
			// Pre-existing behavior: in auto mode, a tool listed in
			// requireConfirmation is blocked outright (because there's no
			// callback to ask). Preserved for back-compat.
			if (mode === "auto" && isWriteForAuto && isExplicitlyConfirmed) {
				return {
					action: "block",
					reason: `Tool "${toolCall.name}" requires explicit confirmation`,
				};
			}

			return { action: "allow" };
		},
	};
}
