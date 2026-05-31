/**
 * Extension system types.
 *
 * Extensions are in-process plugins that can observe and modify agent behavior.
 * They run with full trust — same privileges as the host. MCP-style isolation
 * is out of scope here; the goal is a flexible API surface for first-party and
 * trusted third-party plugins.
 */

import type { AssistantMessage, AssistantMessageEvent, Model, Usage } from "@my-agent/ai";
import type { Static, TSchema } from "@sinclair/typebox";
import type { AgentContext, AgentTool, AgentToolResult } from "../agent/types.js";

// =============================================================================
// Events dispatched to extensions
// =============================================================================

/**
 * Base fields every event carries.
 */
export interface ExtensionEventBase {
	/** Monotonically-increasing event id within a session. */
	seq: number;
	/** Session this event belongs to. */
	sessionId: string;
	/** Wall-clock timestamp (ms). */
	timestamp: number;
}

export type ExtensionEvent =
	// --- Session lifecycle ---
	| (ExtensionEventBase & { type: "session_start"; sessionId: string })
	| (ExtensionEventBase & { type: "session_end"; reason: "complete" | "aborted" | "error" })
	| (ExtensionEventBase & { type: "session_loaded"; sessionId: string })
	| (ExtensionEventBase & { type: "session_saved"; sessionId: string })

	// --- Agent loop lifecycle ---
	| (ExtensionEventBase & { type: "agent_start" })
	| (ExtensionEventBase & { type: "agent_end"; reason: "complete" | "error" | "aborted" | "max_turns"; error?: string })
	| (ExtensionEventBase & { type: "turn_start"; turnIndex: number })
	| (ExtensionEventBase & { type: "turn_end"; turnIndex: number; usage?: Usage })

	// --- Message flow ---
	| (ExtensionEventBase & { type: "message_start"; message: Partial<AssistantMessage> })
	| (ExtensionEventBase & { type: "message_update"; event: AssistantMessageEvent })
	| (ExtensionEventBase & { type: "message_end"; message: AssistantMessage })
	| (ExtensionEventBase & { type: "user_input"; content: string })

	// --- Tool execution ---
	| (ExtensionEventBase & {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  })
	| (ExtensionEventBase & {
			type: "tool_execution_update";
			toolCallId: string;
			update: Partial<AgentToolResult>;
	  })
	| (ExtensionEventBase & {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult;
			isError: boolean;
			durationMs: number;
	  })

	// --- Context ---
	| (ExtensionEventBase & { type: "context_modified"; messageCount: number; tokensEstimate?: number })
	| (ExtensionEventBase & { type: "context_overflow"; tokensBefore: number; tokensAfter?: number })

	// --- Permissions ---
	| (ExtensionEventBase & { type: "permission_request"; toolName: string; args: unknown })
	| (ExtensionEventBase & { type: "permission_response"; toolName: string; granted: boolean })

	// --- Errors ---
	| (ExtensionEventBase & { type: "error"; source: string; error: string })

	// --- Agent state changes ---
	| (ExtensionEventBase & { type: "model_changed"; model: Model })
	| (ExtensionEventBase & { type: "tools_changed"; tools: string[] })

	// --- Commands ---
	| (ExtensionEventBase & { type: "command_executed"; command: string; args: string })

	// --- Extension lifecycle (dispatched to other extensions) ---
	| (ExtensionEventBase & { type: "extension_loaded"; extensionId: string })
	| (ExtensionEventBase & { type: "extension_unloaded"; extensionId: string });

export type ExtensionEventType = ExtensionEvent["type"];

export type ExtensionEventByType<T extends ExtensionEventType> = Extract<ExtensionEvent, { type: T }>;

// =============================================================================
// Tool interception
// =============================================================================

/**
 * Returned by a tool_execution_start handler to control execution.
 */
export type ToolInterceptResult =
	| { action: "allow" }
	| { action: "allow"; modifiedArgs: unknown }
	| { action: "block"; reason: string };

/**
 * Returned by a tool_execution_end handler to modify the result after execution.
 */
export interface ToolResultModification {
	content?: AgentToolResult["content"];
	details?: unknown;
	isError?: boolean;
}

// =============================================================================
// Middleware
// =============================================================================

export interface ToolMiddlewareContext {
	toolCallId: string;
	toolName: string;
	args: unknown;
	/** Populated after `next()` resolves. */
	result?: AgentToolResult;
	/** Populated if the tool threw or was blocked. */
	error?: Error;
	/** True when the extension runner blocked execution upstream. */
	blocked: boolean;
	/** Elapsed ms, populated after `next()`. */
	durationMs?: number;
}

export type ToolMiddleware = (ctx: ToolMiddlewareContext, next: () => Promise<void>) => Promise<void>;

// =============================================================================
// UI adapter (TUI wires up a real impl; tests use a mock)
// =============================================================================

export interface UISelectItem {
	value: string;
	label: string;
	description?: string;
}

export interface ExtensionUI {
	/** Show a list of items, resolve with the selected value, or null on cancel. */
	select(items: UISelectItem[], options?: { title?: string }): Promise<string | null>;
	/** Show a yes/no prompt. */
	confirm(message: string, options?: { defaultValue?: boolean }): Promise<boolean>;
	/** Show a text input prompt. */
	input(message: string, options?: { defaultValue?: string; password?: boolean }): Promise<string | null>;
	/** Show a non-blocking notification. */
	notify(message: string, level?: "info" | "warn" | "error"): void;
}

// =============================================================================
// Agent action surface (what an extension can do to the agent)
// =============================================================================

export interface ExtensionActions {
	/** Inject a user message into the conversation. */
	sendMessage(content: string): void;
	/** Switch the active model. */
	setModel(model: Model): void;
	/** Enable/disable tools for subsequent turns. */
	setActiveTools(tools: AgentTool[]): void;
	/** Fork the current session at this point; resolves with the new session id. */
	fork(): Promise<string>;
	/** Jump to a different node in the session tree. */
	navigateTree(nodeId: string): Promise<void>;
}

// =============================================================================
// Storage
// =============================================================================

/**
 * Scope controls where a value persists.
 *  - "session": tied to the current session; cleared when session is deleted.
 *  - "global":  persists across all sessions for this extension.
 */
export type StorageScope = "session" | "global";

export interface ExtensionStorage {
	get<T = unknown>(key: string, scope?: StorageScope): T | undefined;
	set<T = unknown>(key: string, value: T, scope?: StorageScope): void;
	delete(key: string, scope?: StorageScope): boolean;
	keys(scope?: StorageScope): string[];
	/** Clear everything in the given scope (or both scopes if omitted). */
	clear(scope?: StorageScope): void;
}

// =============================================================================
// Metrics
// =============================================================================

export interface ExtensionMetrics {
	/** Sum of Usage.inputTokens + Usage.outputTokens attributed to this extension. */
	tokensUsed: number;
	/** External API calls made (tracked via recordApiCall). */
	apiCalls: number;
	/** Total time spent executing this extension's handlers. */
	executionTimeMs: number;
	/** Errors thrown by extension handlers. */
	errors: number;
	/** Timestamp of first activity. */
	firstActiveAt?: number;
	/** Timestamp of last activity. */
	lastActiveAt?: number;
}

export interface MetricsRecorder {
	recordTokens(n: number): void;
	recordApiCall(): void;
	recordExecution(ms: number): void;
	recordError(): void;
}

// =============================================================================
// Extension definition
// =============================================================================

export type ExtensionFailureMode = "continue" | "abort" | "disable";

export interface ExtensionMetadata {
	/** Unique identifier (kebab-case recommended). */
	id: string;
	/** Human-readable name. */
	name: string;
	/** Description shown in marketplaces / settings UI. */
	description?: string;
	/** Semver of the extension itself. */
	version: string;
	/** Semver range of the extension API this was built against. */
	apiVersion?: string;
	/** Author or organization. */
	author?: string;
	/** What this extension needs from the host. Purely descriptive today. */
	permissions?: string[];
	/** Other extension ids that must be loaded first. */
	requires?: string[];
	/** Other extension ids that are nice-to-have. */
	optionalRequires?: string[];
	/**
	 * What to do when a handler in this extension throws.
	 *  - "continue" (default): log, count as error, continue dispatch
	 *  - "abort":   rethrow so the host can decide
	 *  - "disable": auto-disable this extension after the first error
	 */
	failureMode?: ExtensionFailureMode;
	/**
	 * Max ms any single handler may run before being considered failed.
	 *
	 * **Advisory only.** The runner cannot force-kill a non-cooperative
	 * promise; on timeout it records an error, applies the configured
	 * `failureMode`, and returns. The underlying work keeps running until
	 * it finishes on its own. Extensions that need real cancellation must
	 * observe `ctx.signal` (which fires on unload) and wire their own
	 * `AbortController` / abort-aware APIs.
	 */
	handlerTimeoutMs?: number;
	/** Whether this extension supports hot-reload. Default: true. */
	hotReloadable?: boolean;
}

/**
 * Typed event handler.
 *
 * Handlers may return nothing, a modification, or a Promise of either.
 * For `tool_execution_start` the return type narrows to `ToolInterceptResult`.
 * For `tool_execution_end` it narrows to `ToolResultModification`.
 * For `user_input` it may return a transformed string.
 */
export type ExtensionEventHandler<T extends ExtensionEventType = ExtensionEventType> = (
	event: ExtensionEventByType<T>,
	ctx: ExtensionContext,
) =>
	| undefined
	| ToolInterceptResult
	| ToolResultModification
	| string
	| Promise<undefined | ToolInterceptResult | ToolResultModification | string>;

export interface ExtensionCommand {
	/** Command name, without the leading slash. */
	name: string;
	/** One-line description. */
	description?: string;
	/** Execute the command. */
	execute: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

/**
 * A config schema: either a Typebox schema (preferred — already a dep) or
 * a plain validator function. The runner validates user-supplied config
 * against this before calling activate().
 */
export interface ExtensionConfigSchema<TSchemaT extends TSchema = TSchema> {
	schema: TSchemaT;
	/** Defaults merged into user config before validation. */
	defaults?: Partial<Static<TSchemaT>>;
}

/**
 * The definition an extension module exports.
 *
 * Typical shape:
 *   export const metadata = { id: "git-tools", name: "Git Tools", version: "1.0.0" }
 *   export const config = { schema: T.Object({ ... }), defaults: { ... } }
 *   export function activate(ctx) { ... }
 */
export interface ExtensionDefinition<TConfig = unknown> {
	metadata: ExtensionMetadata;
	/**
	 * Config schema. If provided, user config is validated against it
	 * and passed to activate() as ctx.config.
	 */
	config?: ExtensionConfigSchema;
	/**
	 * Called once when the extension loads. Register handlers, tools,
	 * commands, and middleware here.
	 */
	activate(ctx: ExtensionContext<TConfig>): void | Promise<void>;
	/**
	 * Called once when the extension is unloaded (disable or reload).
	 * Extensions should release resources here.
	 */
	deactivate?(ctx: ExtensionContext<TConfig>): void | Promise<void>;
	/**
	 * Hot-reload: called before the module is torn down so state can be
	 * preserved. Return value is passed to onAfterReload of the new instance.
	 */
	onBeforeReload?(ctx: ExtensionContext<TConfig>): unknown;
	/**
	 * Hot-reload: called on the new instance after reload with the state
	 * captured by the previous instance's onBeforeReload.
	 */
	onAfterReload?(state: unknown, ctx: ExtensionContext<TConfig>): void;
}

// =============================================================================
// Context passed to activate() and handlers
// =============================================================================

export interface ExtensionContext<TConfig = unknown> {
	/** The extension's own id. */
	readonly id: string;
	/** Validated config (merged with defaults). */
	readonly config: TConfig;

	// --- Registration ---
	/** Subscribe to a typed event. Returns an unsubscribe function. */
	on<T extends ExtensionEventType>(event: T, handler: ExtensionEventHandler<T>): () => void;
	/** Subscribe to every event. */
	onAny(handler: (event: ExtensionEvent, ctx: ExtensionContext) => void | Promise<void>): () => void;
	/** Register a slash command. */
	registerCommand(cmd: ExtensionCommand): () => void;
	/** Register a tool that becomes available to the agent. */
	registerTool(tool: AgentTool): () => void;
	/** Install tool-execution middleware. Applied in registration order. */
	use(middleware: ToolMiddleware): () => void;

	// --- Surface ---
	readonly storage: ExtensionStorage;
	readonly ui: ExtensionUI;
	readonly actions: ExtensionActions;
	readonly metrics: Readonly<ExtensionMetrics>;
	/** Lets the extension attribute tokens / API calls to itself. */
	readonly recorder: MetricsRecorder;

	// --- Host introspection ---
	/** Current agent context snapshot (read-only — use actions to mutate). */
	getAgentContext(): Readonly<AgentContext> | null;
	/** Signal that fires when the extension is being unloaded. */
	readonly signal: AbortSignal;

	// --- Logging (routed through host logger, tagged with extension id) ---
	readonly log: {
		debug(msg: string, data?: unknown): void;
		info(msg: string, data?: unknown): void;
		warn(msg: string, data?: unknown): void;
		error(msg: string, data?: unknown): void;
	};
}

// =============================================================================
// Manifest (on-disk / package.json metadata)
// =============================================================================

export interface ExtensionManifest {
	/** Absolute path to the extension's entry module. */
	entry: string;
	/** Metadata parsed from the extension module. */
	metadata: ExtensionMetadata;
	/** User config (raw, pre-validation). */
	userConfig?: unknown;
	/** True when the extension should not be loaded. */
	disabled?: boolean;
}
