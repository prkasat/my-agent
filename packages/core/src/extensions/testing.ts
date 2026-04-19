/**
 * Testing utilities for extension authors.
 *
 * These are intentionally small — the goal is to let an extension
 * activate() in isolation and have its handlers called with realistic
 * events, without spinning up a full agent loop.
 */

import type { AgentContext } from "../agent/types.js";
import { MetricsTracker } from "./metrics.js";
import { MemoryExtensionStorage } from "./storage.js";
import { noopActions, noopUI } from "./context.js";
import type {
	ExtensionActions,
	ExtensionContext,
	ExtensionDefinition,
	ExtensionEvent,
	ExtensionEventBase,
	ExtensionEventByType,
	ExtensionEventHandler,
	ExtensionEventType,
	ExtensionStorage,
	ExtensionUI,
	MetricsRecorder,
	ToolMiddleware,
} from "./types.js";
import { ExtensionRunner } from "./runner.js";

export interface MockUI extends ExtensionUI {
	readonly notifications: Array<{ message: string; level: "info" | "warn" | "error" }>;
	readonly selectCalls: Array<{ items: unknown[]; resolved: string | null }>;
	readonly confirmCalls: Array<{ message: string; resolved: boolean }>;
	readonly inputCalls: Array<{ message: string; resolved: string | null }>;
	/** Queue a response for the next select() call. */
	enqueueSelect(value: string | null): void;
	/** Queue a response for the next confirm() call. */
	enqueueConfirm(value: boolean): void;
	/** Queue a response for the next input() call. */
	enqueueInput(value: string | null): void;
}

export function createMockUI(): MockUI {
	const notifications: MockUI["notifications"] = [];
	const selectCalls: MockUI["selectCalls"] = [];
	const confirmCalls: MockUI["confirmCalls"] = [];
	const inputCalls: MockUI["inputCalls"] = [];
	const selectQueue: Array<string | null> = [];
	const confirmQueue: boolean[] = [];
	const inputQueue: Array<string | null> = [];

	return {
		notifications,
		selectCalls,
		confirmCalls,
		inputCalls,
		enqueueSelect(v) {
			selectQueue.push(v);
		},
		enqueueConfirm(v) {
			confirmQueue.push(v);
		},
		enqueueInput(v) {
			inputQueue.push(v);
		},
		async select(items) {
			const resolved = selectQueue.length > 0 ? selectQueue.shift()! : null;
			selectCalls.push({ items, resolved });
			return resolved;
		},
		async confirm(message, opts) {
			const resolved = confirmQueue.length > 0 ? confirmQueue.shift()! : (opts?.defaultValue ?? false);
			confirmCalls.push({ message, resolved });
			return resolved;
		},
		async input(message, opts) {
			const resolved =
				inputQueue.length > 0 ? inputQueue.shift()! : (opts?.defaultValue ?? null);
			inputCalls.push({ message, resolved });
			return resolved;
		},
		notify(message, level = "info") {
			notifications.push({ message, level });
		},
	};
}

export interface MockActions extends ExtensionActions {
	readonly sent: string[];
	readonly modelsSet: unknown[];
	readonly toolsSet: unknown[][];
}

export function createMockActions(): MockActions {
	const sent: string[] = [];
	const modelsSet: unknown[] = [];
	const toolsSet: unknown[][] = [];
	return {
		sent,
		modelsSet,
		toolsSet,
		sendMessage(content) {
			sent.push(content);
		},
		setModel(model) {
			modelsSet.push(model);
		},
		setActiveTools(tools) {
			toolsSet.push(tools);
		},
		fork: noopActions.fork,
		navigateTree: noopActions.navigateTree,
	};
}

export interface MockContextOptions {
	id?: string;
	config?: unknown;
	storage?: ExtensionStorage;
	ui?: ExtensionUI;
	actions?: ExtensionActions;
	agentContext?: AgentContext | null;
	sessionId?: string;
}

export interface MockContext extends ExtensionContext {
	readonly handlers: Map<ExtensionEventType, Set<ExtensionEventHandler>>;
	readonly anyHandlers: Set<(e: ExtensionEvent, ctx: ExtensionContext) => void | Promise<void>>;
	readonly middleware: ToolMiddleware[];
	readonly metricsTracker: MetricsTracker;
	/** Emit a fake event to all registered handlers. */
	emit<T extends ExtensionEventType>(
		event: Omit<ExtensionEventByType<T>, keyof ExtensionEventBase> & { type: T },
	): Promise<unknown[]>;
}

/**
 * Create a standalone context for unit-testing extension code.
 *
 * The returned context has a real handler registry (so registerCommand,
 * on, use, etc. work), and an emit() method that lets you fire events
 * synchronously and collect the handler return values.
 */
export function createMockContext(options: MockContextOptions = {}): MockContext {
	const id = options.id ?? "mock-extension";
	const metricsTracker = new MetricsTracker();
	const storage = options.storage ?? new MemoryExtensionStorage();
	const ui = options.ui ?? createMockUI();
	const actions = options.actions ?? createMockActions();
	const abort = new AbortController();
	const agentCtx = options.agentContext ?? null;

	const handlers = new Map<ExtensionEventType, Set<ExtensionEventHandler>>();
	const anyHandlers = new Set<(e: ExtensionEvent, ctx: ExtensionContext) => void | Promise<void>>();
	const middleware: ToolMiddleware[] = [];
	const commands = new Map<string, import("./types.js").ExtensionCommand>();
	const tools = new Map<string, import("../agent/types.js").AgentTool>();

	let seq = 0;

	const ctx: MockContext = {
		id,
		config: options.config ?? {},
		storage,
		ui,
		actions,
		get metrics() {
			return metricsTracker.snapshot();
		},
		recorder: metricsTracker as MetricsRecorder,
		signal: abort.signal,
		log: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		},
		getAgentContext: () => agentCtx,
		on(event, handler) {
			let set = handlers.get(event);
			if (!set) {
				set = new Set();
				handlers.set(event, set);
			}
			set.add(handler as unknown as ExtensionEventHandler);
			return () => {
				set!.delete(handler as unknown as ExtensionEventHandler);
			};
		},
		onAny(handler) {
			anyHandlers.add(handler);
			return () => {
				anyHandlers.delete(handler);
			};
		},
		registerCommand(cmd) {
			commands.set(cmd.name, cmd);
			return () => {
				commands.delete(cmd.name);
			};
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
			return () => {
				tools.delete(tool.name);
			};
		},
		use(mw) {
			middleware.push(mw);
			return () => {
				const i = middleware.indexOf(mw);
				if (i !== -1) middleware.splice(i, 1);
			};
		},
		handlers,
		anyHandlers,
		middleware,
		metricsTracker,
		async emit(event) {
			const base: ExtensionEventBase = {
				seq: ++seq,
				sessionId: options.sessionId ?? "test-session",
				timestamp: Date.now(),
			};
			const full = { ...base, ...event } as ExtensionEvent;
			const results: unknown[] = [];
			const set = handlers.get(event.type);
			if (set) {
				for (const h of set) {
					const r = await (h as ExtensionEventHandler)(full as never, ctx);
					results.push(r);
				}
			}
			for (const any of anyHandlers) {
				await any(full, ctx);
			}
			return results;
		},
	};

	return ctx;
}

/**
 * Full end-to-end runner harness — activates an extension through the
 * real ExtensionRunner so tool interception and middleware are exercised.
 */
export async function activateForTest(
	definition: ExtensionDefinition,
	options?: {
		userConfig?: unknown;
		sessionId?: string;
		ui?: ExtensionUI;
		actions?: ExtensionActions;
	},
): Promise<ExtensionRunner> {
	const runner = new ExtensionRunner({
		sessionId: options?.sessionId ?? "test-session",
		ui: options?.ui ?? createMockUI(),
		actions: options?.actions ?? createMockActions(),
	});
	await runner.load(definition, options?.userConfig);
	return runner;
}
