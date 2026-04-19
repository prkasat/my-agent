/**
 * ExtensionRunner — the dispatch and lifecycle engine.
 *
 * Responsibilities:
 *  - Load, activate, and deactivate extensions.
 *  - Validate user config against extension schemas.
 *  - Dispatch ExtensionEvents to registered handlers.
 *  - Build a middleware chain around tool execution.
 *  - Apply tool_execution_start interception (block / modifyArgs).
 *  - Apply tool_execution_end modifications (modify result).
 *  - Track per-extension metrics.
 *  - Apply failure-mode policy (continue/abort/disable) when handlers throw.
 *  - Provide hot-reload entry points (reload, unload).
 */

import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentContext, AgentTool } from "../agent/types.js";
import { noopActions, noopUI } from "./context.js";
import { MetricsTracker } from "./metrics.js";
import { FileExtensionStorage, MemoryExtensionStorage } from "./storage.js";
import type {
	ExtensionActions,
	ExtensionCommand,
	ExtensionContext,
	ExtensionDefinition,
	ExtensionEvent,
	ExtensionEventByType,
	ExtensionEventHandler,
	ExtensionEventType,
	ExtensionMetrics,
	ExtensionStorage,
	ExtensionUI,
	MetricsRecorder,
	ToolInterceptResult,
	ToolMiddleware,
	ToolMiddlewareContext,
	ToolResultModification,
} from "./types.js";

/**
 * Outcome of a guarded handler invocation.
 * - ok=true: handler completed (value may still be `undefined`)
 * - ok=false: handler threw or timed out; runner policy already applied
 */
interface GuardedResult {
	ok: boolean;
	value: unknown;
	/** Populated when ok=false with the original thrown error. */
	error?: Error;
}

// =============================================================================
// Options
// =============================================================================

export interface LogSink {
	debug(msg: string, data?: unknown): void;
	info(msg: string, data?: unknown): void;
	warn(msg: string, data?: unknown): void;
	error(msg: string, data?: unknown): void;
}

const consoleLog: LogSink = {
	debug: () => {},
	info: () => {},
	warn: (msg, data) => console.warn(`[ext] ${msg}`, data ?? ""),
	error: (msg, data) => console.error(`[ext] ${msg}`, data ?? ""),
};

export interface ExtensionRunnerOptions {
	/** Current session id (required if extensions use session-scoped storage). */
	sessionId?: string;
	/** Where to persist extension storage. If omitted, uses in-memory storage. */
	storageRoot?: string;
	/** UI adapter (TUI wires this up). */
	ui?: ExtensionUI;
	/** Agent actions adapter (CLI wires this up). */
	actions?: ExtensionActions;
	/** Get the current AgentContext snapshot (read-only). */
	getAgentContext?: () => AgentContext | null;
	/** Log sink for the runner + extensions. */
	log?: LogSink;
}

// =============================================================================
// Internal state per loaded extension
// =============================================================================

interface LoadedExtension {
	readonly definition: ExtensionDefinition;
	readonly config: unknown;
	readonly metrics: MetricsTracker;
	readonly storage: ExtensionStorage;
	readonly abortController: AbortController;
	readonly handlers: Map<ExtensionEventType, Set<ExtensionEventHandler>>;
	readonly anyHandlers: Set<(event: ExtensionEvent, ctx: ExtensionContext) => void | Promise<void>>;
	readonly commands: Map<string, ExtensionCommand>;
	readonly tools: Map<string, AgentTool>;
	readonly middleware: ToolMiddleware[];
	disabled: boolean;
	context?: ExtensionContext;
}

// =============================================================================
// Runner
// =============================================================================

export class ExtensionRunner {
	private readonly extensions = new Map<string, LoadedExtension>();
	private readonly options: ExtensionRunnerOptions;
	private readonly log: LogSink;
	private seq = 0;

	// Cross-extension name tracking: records who owns each name so we can
	// warn on collisions at registration time. First registration wins; a
	// collision logs a warning and the later registration is skipped (the
	// name continues to resolve to the original owner).
	private readonly commandOwners = new Map<string, string>();
	private readonly toolOwners = new Map<string, string>();

	constructor(options: ExtensionRunnerOptions = {}) {
		this.options = options;
		this.log = options.log ?? consoleLog;
	}

	// --------------------------------------------------------------------
	// Registration
	// --------------------------------------------------------------------

	/**
	 * Load and activate an extension. If an extension with the same id is
	 * already loaded, this throws — call reload() instead.
	 */
	async load(definition: ExtensionDefinition, userConfig?: unknown): Promise<void> {
		const { id } = definition.metadata;
		if (!id) throw new Error("Extension metadata.id is required");
		if (this.extensions.has(id)) {
			throw new Error(`Extension "${id}" is already loaded; call reload() to replace it`);
		}

		// Validate + merge config.
		const config = this.resolveConfig(definition, userConfig);

		const loaded: LoadedExtension = {
			definition,
			config,
			metrics: new MetricsTracker(),
			storage: this.createStorage(id),
			abortController: new AbortController(),
			handlers: new Map(),
			anyHandlers: new Set(),
			commands: new Map(),
			tools: new Map(),
			middleware: [],
			disabled: false,
		};

		this.extensions.set(id, loaded);

		const ctx = this.buildContext(loaded);
		loaded.context = ctx;

		try {
			await definition.activate(ctx);
			this.log.info(`[ext:${id}] activated`);
		} catch (err) {
			// Roll back any registrations that activate() completed before
			// throwing so we don't leak command/tool owner reservations.
			for (const name of loaded.commands.keys()) {
				if (this.commandOwners.get(name) === id) this.commandOwners.delete(name);
			}
			for (const name of loaded.tools.keys()) {
				if (this.toolOwners.get(name) === id) this.toolOwners.delete(name);
			}
			loaded.abortController.abort();
			this.extensions.delete(id);
			throw new Error(`Extension "${id}" failed to activate: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Announce to peers (not to the newly-loaded extension itself).
		await this.dispatchInternal(
			{ type: "extension_loaded", extensionId: id } as Omit<
				ExtensionEventByType<"extension_loaded">,
				keyof import("./types.js").ExtensionEventBase
			>,
			{ excludeExtensionId: id },
		);
	}

	/** Unload and deactivate an extension. No-op if not loaded. */
	async unload(id: string): Promise<void> {
		const loaded = this.extensions.get(id);
		if (!loaded) return;

		// Abort first so any background work started in activate() can observe
		// the signal before deactivate() runs. Then await deactivate so the
		// extension can do async cleanup with the signal already fired.
		loaded.abortController.abort();
		try {
			if (loaded.definition.deactivate && loaded.context) {
				await loaded.definition.deactivate(loaded.context);
			}
		} catch (err) {
			this.log.error(`[ext:${id}] deactivate threw`, err);
		}

		// Release name-table reservations.
		for (const [name, owner] of this.commandOwners) {
			if (owner === id) this.commandOwners.delete(name);
		}
		for (const [name, owner] of this.toolOwners) {
			if (owner === id) this.toolOwners.delete(name);
		}

		this.extensions.delete(id);

		await this.dispatchInternal({ type: "extension_unloaded", extensionId: id } as Omit<
			ExtensionEventByType<"extension_unloaded">,
			keyof import("./types.js").ExtensionEventBase
		>);
	}

	/**
	 * Reload an extension: capture state via onBeforeReload, unload,
	 * load the new definition, call onAfterReload with the captured state.
	 */
	async reload(definition: ExtensionDefinition, userConfig?: unknown): Promise<void> {
		const { id } = definition.metadata;
		const existing = this.extensions.get(id);

		let savedState: unknown;
		if (existing?.definition.onBeforeReload && existing.context) {
			try {
				savedState = existing.definition.onBeforeReload(existing.context);
			} catch (err) {
				this.log.error(`[ext:${id}] onBeforeReload threw`, err);
			}
		}

		if (existing) await this.unload(id);
		await this.load(definition, userConfig);

		if (savedState !== undefined) {
			const reloaded = this.extensions.get(id);
			if (reloaded?.definition.onAfterReload && reloaded.context) {
				try {
					reloaded.definition.onAfterReload(savedState, reloaded.context);
				} catch (err) {
					this.log.error(`[ext:${id}] onAfterReload threw`, err);
				}
			}
		}
	}

	// --------------------------------------------------------------------
	// Introspection
	// --------------------------------------------------------------------

	has(id: string): boolean {
		return this.extensions.has(id);
	}

	list(): Array<{ id: string; disabled: boolean; metrics: ExtensionMetrics }> {
		return Array.from(this.extensions.values()).map((loaded) => ({
			id: loaded.definition.metadata.id,
			disabled: loaded.disabled,
			metrics: loaded.metrics.snapshot(),
		}));
	}

	getMetrics(id: string): ExtensionMetrics | undefined {
		return this.extensions.get(id)?.metrics.snapshot();
	}

	/** All tools registered across all extensions (for merging with builtins). */
	getAllTools(): AgentTool[] {
		const tools: AgentTool[] = [];
		for (const loaded of this.extensions.values()) {
			if (loaded.disabled) continue;
			for (const tool of loaded.tools.values()) tools.push(tool);
		}
		return tools;
	}

	/** All commands registered across all extensions. */
	getAllCommands(): Array<ExtensionCommand & { extensionId: string }> {
		const commands: Array<ExtensionCommand & { extensionId: string }> = [];
		for (const loaded of this.extensions.values()) {
			if (loaded.disabled) continue;
			for (const cmd of loaded.commands.values()) {
				commands.push({ ...cmd, extensionId: loaded.definition.metadata.id });
			}
		}
		return commands;
	}

	/**
	 * Execute a registered slash command by name. Returns true only if a
	 * command was found AND completed without error. Returns false if no
	 * matching command exists or the command's body threw (with the failure
	 * counted against the owning extension via runGuarded).
	 */
	async runCommand(name: string, args: string): Promise<boolean> {
		for (const loaded of this.extensions.values()) {
			if (loaded.disabled) continue;
			const cmd = loaded.commands.get(name);
			const context = loaded.context;
			if (!cmd || !context) continue;
			const result = await this.runGuarded(loaded, "command", () => cmd.execute(args, context));
			if (!result.ok) return false;
			await this.dispatchInternal({ type: "command_executed", command: name, args } as Omit<
				ExtensionEventByType<"command_executed">,
				keyof import("./types.js").ExtensionEventBase
			>);
			return true;
		}
		return false;
	}

	// --------------------------------------------------------------------
	// Event dispatch
	// --------------------------------------------------------------------

	/**
	 * Dispatch an event to all loaded extensions.
	 *
	 * For events that allow handler return values to influence behavior
	 * (tool_execution_start, tool_execution_end, user_input), use the
	 * specialized methods below. This is the "fire and forget" path.
	 */
	async dispatch<T extends ExtensionEventType>(
		event: Omit<ExtensionEventByType<T>, keyof import("./types.js").ExtensionEventBase>,
	): Promise<void> {
		await this.dispatchInternal(event);
	}

	/**
	 * Dispatch tool_execution_start and collect interception decisions.
	 *
	 * The first extension to return a "block" wins. modifiedArgs are
	 * composed in registration order (later handlers see earlier mods).
	 */
	async dispatchToolStart(toolCallId: string, toolName: string, args: unknown): Promise<ToolInterceptResult> {
		const base = this.makeBase();
		let currentArgs = args;
		let modified = false;

		for (const loaded of this.extensions.values()) {
			if (loaded.disabled) continue;
			const handlers = loaded.handlers.get("tool_execution_start");
			if (!handlers) continue;
			for (const handler of handlers) {
				if (loaded.disabled) break; // auto-disabled by a prior throw
				const event: ExtensionEventByType<"tool_execution_start"> = {
					...base,
					type: "tool_execution_start",
					toolCallId,
					toolName,
					args: currentArgs,
				};
				const guarded = await this.runHandler(loaded, "tool_execution_start", handler, event);
				if (!guarded.ok) continue;
				const result = guarded.value;
				if (!result) continue;
				if (typeof result === "object" && "action" in result) {
					const r = result as ToolInterceptResult;
					if (r.action === "block") {
						return { action: "block", reason: r.reason };
					}
					if (r.action === "allow" && "modifiedArgs" in r) {
						currentArgs = r.modifiedArgs;
						modified = true;
					}
				}
			}
		}

		return modified ? { action: "allow", modifiedArgs: currentArgs } : { action: "allow" };
	}

	/**
	 * Dispatch tool_execution_end and collect result modifications.
	 * Modifications are applied in registration order.
	 */
	async dispatchToolEnd(
		toolCallId: string,
		toolName: string,
		result: import("../agent/types.js").AgentToolResult,
		isError: boolean,
		durationMs: number,
	): Promise<ToolResultModification | undefined> {
		const base = this.makeBase();
		let current: ToolResultModification | undefined;
		let currentResult = result;
		let currentIsError = isError;

		for (const loaded of this.extensions.values()) {
			if (loaded.disabled) continue;
			const handlers = loaded.handlers.get("tool_execution_end");
			if (!handlers) continue;
			for (const handler of handlers) {
				if (loaded.disabled) break;
				const event: ExtensionEventByType<"tool_execution_end"> = {
					...base,
					type: "tool_execution_end",
					toolCallId,
					toolName,
					result: currentResult,
					isError: currentIsError,
					durationMs,
				};
				const guarded = await this.runHandler(loaded, "tool_execution_end", handler, event);
				if (!guarded.ok) continue;
				const modification = guarded.value as ToolResultModification | undefined;
				if (!modification || typeof modification !== "object") continue;
				current = { ...(current ?? {}), ...modification };
				if (modification.content) currentResult = { ...currentResult, content: modification.content };
				if (modification.details !== undefined) currentResult = { ...currentResult, details: modification.details };
				if (modification.isError !== undefined) currentIsError = modification.isError;
			}
		}
		return current;
	}

	/**
	 * Dispatch user_input; each handler may return a transformed string.
	 * Transforms compose in registration order.
	 */
	async dispatchUserInput(content: string): Promise<string> {
		const base = this.makeBase();
		let current = content;
		for (const loaded of this.extensions.values()) {
			if (loaded.disabled) continue;
			const handlers = loaded.handlers.get("user_input");
			if (!handlers) continue;
			for (const handler of handlers) {
				if (loaded.disabled) break;
				const event: ExtensionEventByType<"user_input"> = {
					...base,
					type: "user_input",
					content: current,
				};
				const guarded = await this.runHandler(loaded, "user_input", handler, event);
				if (!guarded.ok) continue;
				if (typeof guarded.value === "string") current = guarded.value;
			}
		}
		return current;
	}

	/**
	 * Build and execute the tool-middleware chain.
	 *
	 * The chain wraps the provided `execute` callback. Middleware is
	 * applied in registration order, outermost first — i.e., the first
	 * registered middleware sees the call before any other middleware.
	 */
	async runToolMiddleware(
		ctx: Omit<ToolMiddlewareContext, "result" | "error" | "blocked" | "durationMs">,
		execute: () => Promise<import("../agent/types.js").AgentToolResult>,
	): Promise<ToolMiddlewareContext> {
		const chainCtx: ToolMiddlewareContext = { ...ctx, blocked: false };

		// Preserve extension ownership so middleware errors go through the
		// owning extension's runGuarded (metrics + failure-mode).
		const entries: Array<{ loaded: LoadedExtension; mw: ToolMiddleware }> = [];
		for (const loaded of this.extensions.values()) {
			if (loaded.disabled) continue;
			for (const mw of loaded.middleware) entries.push({ loaded, mw });
		}

		// Terminal step: actually execute the tool.
		const terminal = async () => {
			const started = Date.now();
			try {
				chainCtx.result = await execute();
			} catch (err) {
				chainCtx.error = err instanceof Error ? err : new Error(String(err));
			}
			chainCtx.durationMs = Date.now() - started;
		};

		// Compose middleware in reverse so the first registered wraps the rest.
		let next: () => Promise<void> = terminal;
		for (let i = entries.length - 1; i >= 0; i--) {
			const { loaded, mw } = entries[i];
			const inner = next;
			next = async () => {
				// Guard `next()` against being called more than once.
				let called = false;
				const wrapped = async () => {
					if (called) {
						throw new Error(`[ext:${loaded.definition.metadata.id}] middleware called next() more than once`);
					}
					called = true;
					await inner();
				};
				const guarded = await this.runGuarded(loaded, "middleware", () => mw(chainCtx, wrapped));
				// Surface middleware errors on chainCtx so callers see them,
				// regardless of whether the failure happened before or after
				// next(). Don't overwrite an earlier error (the first wins).
				if (!guarded.ok && !chainCtx.error) {
					chainCtx.error = guarded.error ?? new Error(`middleware ${loaded.definition.metadata.id} failed`);
				}
			};
		}

		await next();
		return chainCtx;
	}

	// --------------------------------------------------------------------
	// Internals
	// --------------------------------------------------------------------

	private async dispatchInternal<T extends ExtensionEventType>(
		event: Omit<ExtensionEventByType<T>, keyof import("./types.js").ExtensionEventBase>,
		opts?: { excludeExtensionId?: string },
	): Promise<void> {
		const base = this.makeBase();
		const full = { ...base, ...event } as ExtensionEventByType<T>;
		for (const loaded of this.extensions.values()) {
			if (loaded.disabled) continue;
			if (opts?.excludeExtensionId === loaded.definition.metadata.id) continue;
			const handlers = loaded.handlers.get(event.type);
			if (handlers) {
				for (const handler of handlers) {
					if (loaded.disabled) break;
					await this.runHandler(loaded, event.type, handler, full);
				}
			}
			for (const any of loaded.anyHandlers) {
				const context = loaded.context;
				if (loaded.disabled || !context) break;
				await this.runGuarded(loaded, event.type, () => any(full, context));
			}
		}
	}

	private async runHandler(
		loaded: LoadedExtension,
		eventType: string,
		handler: ExtensionEventHandler,
		event: ExtensionEvent,
	): Promise<GuardedResult> {
		const context = loaded.context;
		if (!context) {
			return { ok: false, value: undefined, error: new Error("Extension context not initialized") };
		}
		return await this.runGuarded(loaded, eventType, () => handler(event as never, context));
	}

	/**
	 * Run a handler with metrics, timeout (advisory — see below), and
	 * failure-mode policy.
	 *
	 * Timeout contract: if `handlerTimeoutMs` is set, runGuarded resolves
	 * with an error after the timer fires, but it cannot force-kill the
	 * underlying promise. The per-call AbortSignal is exposed to the
	 * extension via `ctx.signal` (it fires on unload); extensions that
	 * want cancellation should wire their own `AbortController` and
	 * observe it. The runner records a `recordError()` on timeout and
	 * applies the configured failure-mode, same as any other throw.
	 */
	private async runGuarded(loaded: LoadedExtension, source: string, fn: () => unknown): Promise<GuardedResult> {
		const started = Date.now();
		const timeoutMs = loaded.definition.metadata.handlerTimeoutMs;
		try {
			const p = Promise.resolve().then(fn);
			const result = timeoutMs ? await withTimeout(p, timeoutMs) : await p;
			return { ok: true, value: result };
		} catch (err) {
			loaded.metrics.recordError();
			const id = loaded.definition.metadata.id;
			const mode = loaded.definition.metadata.failureMode ?? "continue";
			const error = err instanceof Error ? err : new Error(String(err));
			this.log.error(`[ext:${id}] handler threw (source=${source}, mode=${mode})`, error.message);
			if (mode === "abort") throw err;
			if (mode === "disable") loaded.disabled = true;
			return { ok: false, value: undefined, error };
		} finally {
			loaded.metrics.recordExecution(Date.now() - started);
		}
	}

	private makeBase(): import("./types.js").ExtensionEventBase {
		return {
			seq: ++this.seq,
			sessionId: this.options.sessionId ?? "(none)",
			timestamp: Date.now(),
		};
	}

	private createStorage(extensionId: string): ExtensionStorage {
		if (!this.options.storageRoot) return new MemoryExtensionStorage();
		return new FileExtensionStorage({
			root: this.options.storageRoot,
			extensionId,
			sessionId: this.options.sessionId,
		});
	}

	private resolveConfig(def: ExtensionDefinition, userConfig: unknown): unknown {
		if (!def.config) return userConfig ?? {};
		const defaults = (def.config.defaults ?? {}) as Record<string, unknown>;
		const user = (userConfig ?? {}) as Record<string, unknown>;
		const merged = { ...defaults, ...user };
		// Apply typebox defaults (for any nested fields that set default()).
		const defaulted = Value.Default(def.config.schema, merged) as Record<string, unknown>;
		const errors = [...Value.Errors(def.config.schema, defaulted)];
		if (errors.length > 0) {
			const first = errors[0];
			throw new Error(`Extension "${def.metadata.id}" config is invalid at ${first.path || "/"}: ${first.message}`);
		}
		return defaulted as Static<typeof def.config.schema>;
	}

	private buildContext(loaded: LoadedExtension): ExtensionContext {
		const id = loaded.definition.metadata.id;

		const on = <T extends ExtensionEventType>(event: T, handler: ExtensionEventHandler<T>): (() => void) => {
			let set = loaded.handlers.get(event);
			if (!set) {
				set = new Set();
				loaded.handlers.set(event, set);
			}
			set.add(handler as unknown as ExtensionEventHandler);
			return () => {
				set?.delete(handler as unknown as ExtensionEventHandler);
			};
		};

		const onAny = (handler: (event: ExtensionEvent, ctx: ExtensionContext) => void | Promise<void>): (() => void) => {
			loaded.anyHandlers.add(handler);
			return () => {
				loaded.anyHandlers.delete(handler);
			};
		};

		const registerCommand = (cmd: ExtensionCommand): (() => void) => {
			const existingOwner = this.commandOwners.get(cmd.name);
			if (existingOwner && existingOwner !== id) {
				this.log.warn(`[ext:${id}] command "${cmd.name}" already registered by "${existingOwner}" — skipping`);
				return () => {};
			}
			if (loaded.commands.has(cmd.name)) {
				this.log.warn(`[ext:${id}] command "${cmd.name}" re-registered — replacing`);
			}
			this.commandOwners.set(cmd.name, id);
			loaded.commands.set(cmd.name, cmd);
			return () => {
				loaded.commands.delete(cmd.name);
				if (this.commandOwners.get(cmd.name) === id) {
					this.commandOwners.delete(cmd.name);
				}
			};
		};

		const registerTool = (tool: AgentTool): (() => void) => {
			const existingOwner = this.toolOwners.get(tool.name);
			if (existingOwner && existingOwner !== id) {
				this.log.warn(`[ext:${id}] tool "${tool.name}" already registered by "${existingOwner}" — skipping`);
				return () => {};
			}
			if (loaded.tools.has(tool.name)) {
				this.log.warn(`[ext:${id}] tool "${tool.name}" re-registered — replacing`);
			}
			this.toolOwners.set(tool.name, id);
			loaded.tools.set(tool.name, tool);
			return () => {
				loaded.tools.delete(tool.name);
				if (this.toolOwners.get(tool.name) === id) {
					this.toolOwners.delete(tool.name);
				}
			};
		};

		const use = (middleware: ToolMiddleware): (() => void) => {
			loaded.middleware.push(middleware);
			return () => {
				const idx = loaded.middleware.indexOf(middleware);
				if (idx !== -1) loaded.middleware.splice(idx, 1);
			};
		};

		const log = {
			debug: (msg: string, data?: unknown) => this.log.debug(`[ext:${id}] ${msg}`, data),
			info: (msg: string, data?: unknown) => this.log.info(`[ext:${id}] ${msg}`, data),
			warn: (msg: string, data?: unknown) => this.log.warn(`[ext:${id}] ${msg}`, data),
			error: (msg: string, data?: unknown) => this.log.error(`[ext:${id}] ${msg}`, data),
		};

		const ctx: ExtensionContext = {
			id,
			config: loaded.config,
			on,
			onAny,
			registerCommand,
			registerTool,
			use,
			storage: loaded.storage,
			ui: this.options.ui ?? noopUI,
			actions: this.options.actions ?? noopActions,
			get metrics() {
				return loaded.metrics.snapshot();
			},
			recorder: loaded.metrics as MetricsRecorder,
			getAgentContext: () => this.options.getAgentContext?.() ?? null,
			signal: loaded.abortController.signal,
			log,
		};

		return ctx;
	}
}

// =============================================================================
// Helpers
// =============================================================================

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return await new Promise<T>((resolveOuter, rejectOuter) => {
		const timer = setTimeout(() => {
			rejectOuter(new Error(`handler timed out after ${ms}ms`));
		}, ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolveOuter(v);
			},
			(e) => {
				clearTimeout(timer);
				rejectOuter(e);
			},
		);
	});
}
