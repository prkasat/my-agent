/**
 * Agent runtime: wires up the agent loop with streaming output.
 *
 * This module connects:
 * - Settings (model, provider, thinking level)
 * - OAuth/API key resolution
 * - Tools (read, write, edit, bash, grep, find, ls)
 * - Session persistence
 * - Streaming output to stdout
 */

import { stream, type Usage, getModel } from "@my-agent/ai";
import {
	type AgentContext,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentToolResult,
	type AskDecision,
	BASE_INSTRUCTIONS,
	BUILTIN_READ_TOOL_NAMES,
	CostTracker,
	type ExtensionUI,
	type PermissionAskContext,
	type SessionCosts,
	type SessionManager,
	agentLoop,
	buildSystemPrompt,
	createAllTools,
	createAutoCompactorWithPersistence,
	createPermissionChecker,
	defaultConvertToLlm,
	discoverProjectContext,
} from "@my-agent/core";
import type { AuthStorage } from "../config/auth-storage.js";
import type { Settings } from "../config/settings.js";
import { loadExtensionsForRun } from "./extensions.js";
import { resolveConfiguredModel } from "./model-registry.js";
import { hashText, trace } from "./trace.js";

export interface RuntimeConfig {
	cwd: string;
	settings: Settings;
	authStorage: AuthStorage;
	session: SessionManager;
	signal?: AbortSignal;
	askPermission?: (ctx: PermissionAskContext) => Promise<AskDecision>;
	disableExtensions?: boolean;
	resourceExtensionEntries?: string[];
	extensionUI?: ExtensionUI;
}

export interface RuntimeToolProfile {
	toolCallId: string;
	toolName: string;
	durationMs: number;
	isError: boolean;
	outputText?: string;
	details?: unknown;
}

export interface RuntimeCompactionProfile {
	tokensBefore: number;
	tokensAfter: number;
	cutIndex: number;
	summaryLength: number;
	durationMs?: number;
}

export interface RuntimeProfile {
	totalDurationMs: number;
	firstTokenLatencyMs?: number;
	sessionLoadDurationMs: number;
	projectContextDurationMs: number;
	extensionLoadDurationMs: number;
	turnCount: number;
	costs: SessionCosts;
	toolCalls: RuntimeToolProfile[];
	compactions: RuntimeCompactionProfile[];
	memory: {
		rss: number;
		heapUsed: number;
		heapTotal: number;
		external: number;
	};
}

export interface RuntimeResult {
	messages: AgentMessage[];
	aborted: boolean;
	error?: string;
	profile: RuntimeProfile;
}

/**
 * Run the agent with a prompt and stream output to the provided callbacks.
 */
export async function runAgent(
	prompt: string,
	config: RuntimeConfig,
	callbacks: {
		onText?: (text: string) => void;
		onToolStart?: (toolName: string, toolCallId: string, args: unknown) => void;
		onToolEnd?: (
			toolName: string,
			isError: boolean,
			info: { toolCallId: string; result: AgentToolResult | undefined; durationMs: number },
		) => void;
		onThinking?: (text: string) => void;
		onTurnStart?: (turnIndex: number) => void;
		onTurnEnd?: (info: { turnIndex: number; usage?: Usage; costs: SessionCosts }) => void;
	} = {},
): Promise<RuntimeResult> {
	const {
		cwd,
		settings,
		authStorage,
		session,
		signal,
		askPermission,
		disableExtensions,
		resourceExtensionEntries,
		extensionUI,
	} = config;
	const runStartedAt = Date.now();
	let firstTokenAt: number | undefined;
	let completedTurnCount = 0;
	const toolProfiles: RuntimeToolProfile[] = [];
	const compactionProfiles: RuntimeCompactionProfile[] = [];
	const costTracker = new CostTracker();

	trace("runtime", "agent.start", {
		cwd,
		sessionId: session.getSessionId(),
		promptHash: hashText(prompt),
		promptLength: prompt.length,
	});

	// Resolve the configured model against current auth state.
	const { key: resolvedModelKey, model } = await resolveConfiguredModel(settings, authStorage);
	trace("runtime", "model.resolved", {
		configuredModel: settings.model,
		resolvedModel: resolvedModelKey,
		provider: model.provider,
	});

	// Build system prompt with project context
	// Support SYSTEM.md override and APPEND_SYSTEM.md
	const homeDir = (typeof process !== "undefined" && process.env.HOME) || ".";
	const globalDir = `${homeDir}/.my-agent`;
	const projectContextStartedAt = Date.now();
	const projectContext = await discoverProjectContext(cwd, globalDir);
	const projectContextDurationMs = Date.now() - projectContextStartedAt;
	trace("runtime", "project_context.discovered", {
		durationMs: projectContextDurationMs,
		hasSystemOverride: Boolean(projectContext.systemOverride),
		hasSystemAppend: Boolean(projectContext.systemAppend),
		projectContextFiles: projectContext.projectContext.length,
	});

	// Load extensions for this run. Extensions are trusted local modules.
	let currentContext: AgentContext | null = null;
	const extensionLoadStartedAt = Date.now();
	const extensionRuntime = disableExtensions
		? undefined
		: await loadExtensionsForRun({
				cwd,
				globalDir,
				settings,
				sessionId: session.getSessionId(),
				getAgentContext: () => currentContext,
				extraEntries: resourceExtensionEntries,
				ui: extensionUI,
			});
	const extensionLoadDurationMs = Date.now() - extensionLoadStartedAt;
	trace("extensions", "loaded", {
		disabled: Boolean(disableExtensions),
		loadedIds: extensionRuntime?.loadedIds ?? [],
		warnings: extensionRuntime?.warnings ?? [],
		durationMs: extensionLoadDurationMs,
	});

	const transformedPrompt = extensionRuntime ? await extensionRuntime.runner.dispatchUserInput(prompt) : prompt;
	if (transformedPrompt !== prompt) {
		trace("extensions", "user_input.transformed", {
			originalHash: hashText(prompt),
			transformedHash: hashText(transformedPrompt),
		});
	}

	// Create tools (built-ins + extension tools)
	const toolsRecord = createAllTools(cwd);
	const tools = [...Object.values(toolsRecord), ...(extensionRuntime?.runner.getAllTools() ?? [])];

	// Use SYSTEM.md override if found, otherwise base instructions
	let baseInstructions = projectContext.systemOverride ?? BASE_INSTRUCTIONS;
	// Append APPEND_SYSTEM.md content if found
	if (projectContext.systemAppend) {
		baseInstructions = `${baseInstructions}\n\n${projectContext.systemAppend}`;
	}

	const systemPrompt = buildSystemPrompt({
		baseInstructions,
		cwd,
		tools,
		projectContext: projectContext.projectContext,
		extensionContext: extensionRuntime ? [`Loaded extensions: ${extensionRuntime.loadedIds.join(", ") || "none"}`] : [],
	});

	trace("runtime", "system_prompt.built", {
		hash: hashText(systemPrompt),
		length: systemPrompt.length,
		toolCount: tools.length,
	});

	// Build messages from session history + new prompt
	const sessionLoadStartedAt = Date.now();
	const sessionContext = session.buildSessionContext();
	const sessionLoadDurationMs = Date.now() - sessionLoadStartedAt;
	trace("runtime", "session.loaded", {
		sessionId: session.getSessionId(),
		messageCount: sessionContext.messages.length,
		durationMs: sessionLoadDurationMs,
	});
	const userMessage: AgentMessage = {
		role: "user",
		content: transformedPrompt,
		timestamp: Date.now(),
	};

	// Create context
	const context: AgentContext = {
		systemPrompt,
		messages: [...sessionContext.messages],
		tools,
		model,
	};
	currentContext = context;

	// Map thinkingLevel to stream options (supports all provider levels)
	type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
	const streamOptions =
		settings.thinkingLevel !== "off" ? { thinkingLevel: settings.thinkingLevel as ThinkingLevel } : undefined;

	// Create auto-compactor if enabled
	let pendingCompactionStartedAt: number | undefined;
	const autoCompactorBase = settings.compaction.enabled
		? createAutoCompactorWithPersistence({
				settings: {
					enabled: true,
					reserveTokens: settings.compaction.reserveTokens,
					keepRecentTokens: settings.compaction.keepRecentTokens,
				},
				sessionManager: session,
				streamFn: (m, ctx, opts) => stream(m, ctx, opts),
				getApiKey: async (provider: string) => authStorage.resolveApiKey(provider),
				signal,
				costTracker,
				onCompaction: (result) => {
					const profile: RuntimeCompactionProfile = {
						tokensBefore: result.tokensBefore,
						tokensAfter: result.tokensAfter,
						cutIndex: result.cutIndex,
						summaryLength: result.summary.length,
						durationMs: pendingCompactionStartedAt ? Date.now() - pendingCompactionStartedAt : undefined,
					};
					compactionProfiles.push(profile);
					trace("runtime", "compaction", profile);
				},
			})
		: undefined;
	const autoCompactor = autoCompactorBase
		? Object.assign(
				async (context: AgentContext, nextSignal?: AbortSignal) => {
					pendingCompactionStartedAt = Date.now();
					try {
						return await autoCompactorBase(context, nextSignal);
					} finally {
						pendingCompactionStartedAt = undefined;
					}
				},
				{ reset: () => autoCompactorBase.reset() },
			)
		: undefined;

	const permissionMode = settings.permissionMode === "strict" ? "deny" : settings.permissionMode;
	const permissionChecker = createPermissionChecker(permissionMode, {
		knownReadOnly: new Set(BUILTIN_READ_TOOL_NAMES),
		onAsk: askPermission,
	});

	// Build config
	const loopConfig: AgentLoopConfig = {
		streamFn: (m, ctx, opts) => stream(m, ctx, opts),
		streamOptions,
		convertToLlm: defaultConvertToLlm,
		getApiKey: async (provider: string) => authStorage.resolveApiKey(provider),
		transformContext: autoCompactor,
		costTracker,
		resolveModel: (id) => {
			try {
				return getModel(id);
			} catch {
				return undefined;
			}
		},
		maxTurns: settings.maxTurns,
		maxRetries: settings.retry.enabled ? settings.retry.maxRetries : 0,
		beforeToolCall: async (ctx) => {
			let nextArgs = ctx.args;

			if (extensionRuntime) {
				const extDecision = await extensionRuntime.runner.dispatchToolStart(
					ctx.toolCall.id,
					ctx.toolCall.name,
					nextArgs,
				);
				if (extDecision.action === "block") {
					trace("extensions", "tool.intercept", {
						toolName: ctx.toolCall.name,
						action: "block",
						reason: extDecision.reason,
					});
					return { action: "block", reason: extDecision.reason };
				}
				if ("modifiedArgs" in extDecision) {
					trace("extensions", "tool.intercept", {
						toolName: ctx.toolCall.name,
						action: "modify",
						args: extDecision.modifiedArgs,
					});
					nextArgs = extDecision.modifiedArgs;
				}
			}

			const permissionResult = await permissionChecker.check({ ...ctx, args: nextArgs });
			trace("permissions", "tool.check", {
				toolName: ctx.toolCall.name,
				action: permissionResult.action,
			});
			if (permissionResult.action === "block") {
				return permissionResult;
			}

			return nextArgs === ctx.args ? { action: "allow" } : { action: "allow", modifiedArgs: nextArgs };
		},
		afterToolCall: async (ctx) => {
			if (!extensionRuntime) return undefined;
			const modification = await extensionRuntime.runner.dispatchToolEnd(
				ctx.toolCall.id,
				ctx.toolCall.name,
				ctx.result,
				ctx.isError,
				0,
			);
			if (modification) {
				trace("extensions", "tool.result_modified", {
					toolName: ctx.toolCall.name,
					hasContent: Boolean(modification.content),
					hasDetails: Boolean(modification.details),
					isError: modification.isError,
				});
			}
			return modification;
		},
	};

	// Append user message to session
	session.appendMessage(userMessage);

	// Track where new messages start (after session history)
	const newMessagesStartIndex = context.messages.length;

	// Run agent loop
	const eventStream = agentLoop([userMessage], context, loopConfig, { signal });

	let aborted = false;
	let error: string | undefined;
	const toolNames = new Map<string, string>(); // toolCallId -> toolName
	const toolStartedAt = new Map<string, number>();
	const persistedToolResultIds = new Set<string>(); // Track which tool results we've persisted this run

	// Process events - ALWAYS consume all events even if aborted
	// This ensures agent_end runs and any synthesized cancelled results are processed
	try {
		await extensionRuntime?.runner.dispatch({ type: "session_start", sessionId: session.getSessionId() } as any);

		for await (const event of eventStream) {
			// Track abort state but DON'T break - let the loop finish naturally
			if (signal?.aborted) {
				aborted = true;
			}

			switch (event.type) {
				case "turn_start":
					callbacks.onTurnStart?.(event.turnIndex);
					await extensionRuntime?.runner.dispatch({ type: "turn_start", turnIndex: event.turnIndex } as any);
					break;

				case "turn_end": {
					completedTurnCount += 1;
					const costs = costTracker.getSummary();
					callbacks.onTurnEnd?.({ turnIndex: event.turnIndex, usage: event.usage, costs });
					trace("runtime", "turn.end", {
						turnIndex: event.turnIndex,
						usage: event.usage,
						totalCost: costs.totalCost,
						totalInputTokens: costs.totalInputTokens,
						totalOutputTokens: costs.totalOutputTokens,
					});
					await extensionRuntime?.runner.dispatch({
						type: "turn_end",
						turnIndex: event.turnIndex,
						usage: event.usage,
					} as any);
					break;
				}

				case "message_start":
					await extensionRuntime?.runner.dispatch({ type: "message_start", message: event.message } as any);
					break;

				case "message_update":
					if (
						firstTokenAt === undefined &&
						(event.event.type === "text_delta" || event.event.type === "thinking_delta")
					) {
						firstTokenAt = Date.now();
						trace("runtime", "first_token", { latencyMs: firstTokenAt - runStartedAt });
					}
					if (event.event.type === "text_delta") {
						callbacks.onText?.(event.event.text);
					} else if (event.event.type === "thinking_delta") {
						callbacks.onThinking?.(event.event.text);
					}
					await extensionRuntime?.runner.dispatch({ type: "message_update", event: event.event } as any);
					break;

				case "message_end":
					// Persist assistant message to session
					session.appendMessage(event.message);
					await extensionRuntime?.runner.dispatch({ type: "message_end", message: event.message } as any);
					break;

				case "assistant_retry":
					trace("runtime", "assistant.retry", {
						attempt: event.attempt,
						maxRetries: event.maxRetries,
						delayMs: event.delayMs,
					});
					break;

				case "tool_execution_start":
					if (firstTokenAt === undefined) {
						firstTokenAt = Date.now();
						trace("runtime", "first_token", { latencyMs: firstTokenAt - runStartedAt, source: "tool" });
					}
					toolNames.set(event.toolCallId, event.toolName);
					toolStartedAt.set(event.toolCallId, Date.now());
					callbacks.onToolStart?.(event.toolName, event.toolCallId, event.args);
					trace("runtime", "tool.start", { toolName: event.toolName, toolCallId: event.toolCallId, args: event.args });
					await extensionRuntime?.runner.dispatch({
						type: "tool_execution_start",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
					} as any);
					break;

				case "tool_execution_end": {
					const toolName = toolNames.get(event.toolCallId) ?? "unknown";
					const durationMs = Date.now() - (toolStartedAt.get(event.toolCallId) ?? Date.now());
					const outputText = event.result?.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					toolProfiles.push({
						toolCallId: event.toolCallId,
						toolName,
						durationMs,
						isError: event.isError,
						outputText: outputText || undefined,
						details: event.result?.details,
					});
					callbacks.onToolEnd?.(toolName, event.isError, {
						toolCallId: event.toolCallId,
						result: event.result,
						durationMs,
					});
					trace("runtime", "tool.end", {
						toolName,
						toolCallId: event.toolCallId,
						isError: event.isError,
						durationMs,
						outputText,
					});
					// Persist tool result to session
					if (event.result) {
						session.appendMessage({
							role: "toolResult",
							toolCallId: event.toolCallId,
							toolName,
							content: event.result.content,
							isError: event.isError,
							timestamp: Date.now(),
						});
						persistedToolResultIds.add(event.toolCallId);
					}
					await extensionRuntime?.runner.dispatch({
						type: "tool_execution_end",
						toolCallId: event.toolCallId,
						toolName,
						result: event.result,
						isError: event.isError,
						durationMs,
					} as any);
					toolNames.delete(event.toolCallId);
					toolStartedAt.delete(event.toolCallId);
					break;
				}

				case "agent_end":
					if (event.reason === "error") {
						error = event.error;
					}
					if (event.reason === "aborted") {
						aborted = true;
					}
					await extensionRuntime?.runner.dispatch({
						type: "agent_end",
						reason: event.reason,
						...(event.error ? { error: event.error } : {}),
					} as any);
					break;
			}
		}

		// After loop completes, check for any cancelled tool results that the agent loop
		// added directly to context.messages but we didn't receive events for.
		// Only scan NEW messages (after session history) to avoid duplicating historical results.
		for (let i = newMessagesStartIndex; i < context.messages.length; i++) {
			const msg = context.messages[i];
			if (
				msg.role === "toolResult" &&
				"toolCallId" in msg &&
				typeof msg.toolCallId === "string" &&
				!persistedToolResultIds.has(msg.toolCallId)
			) {
				session.appendMessage(msg as AgentMessage);
			}
		}
	} finally {
		await extensionRuntime?.runner.dispatch({
			type: "session_end",
			reason: aborted ? "aborted" : error ? "error" : "complete",
		} as any);
		await extensionRuntime?.dispose();
		// Always flush session to disk, even on error
		session.flush();
	}

	const memory = process.memoryUsage();
	const profile: RuntimeProfile = {
		totalDurationMs: Date.now() - runStartedAt,
		firstTokenLatencyMs: firstTokenAt ? firstTokenAt - runStartedAt : undefined,
		sessionLoadDurationMs,
		projectContextDurationMs,
		extensionLoadDurationMs,
		turnCount: completedTurnCount,
		costs: costTracker.getSummary(),
		toolCalls: toolProfiles,
		compactions: compactionProfiles,
		memory: {
			rss: memory.rss,
			heapUsed: memory.heapUsed,
			heapTotal: memory.heapTotal,
			external: memory.external,
		},
	};

	trace("runtime", "agent.end", {
		sessionId: session.getSessionId(),
		aborted,
		error,
		messageCount: context.messages.length,
		profile,
	});

	return {
		messages: context.messages,
		aborted,
		error,
		profile,
	};
}

export function formatRuntimeProfile(profile: RuntimeProfile): string {
	return [
		`profile: total=${profile.totalDurationMs}ms first-token=${profile.firstTokenLatencyMs ?? "n/a"}ms session-load=${profile.sessionLoadDurationMs}ms project-context=${profile.projectContextDurationMs}ms extensions=${profile.extensionLoadDurationMs}ms`,
		`usage: in=${profile.costs.totalInputTokens} out=${profile.costs.totalOutputTokens} cache-read=${profile.costs.totalCacheReadTokens} cache-write=${profile.costs.totalCacheWriteTokens} cost=$${profile.costs.totalCost.toFixed(4)}`,
		`activity: turns=${profile.turnCount} tools=${profile.toolCalls.length} compactions=${profile.compactions.length} rss=${Math.round(profile.memory.rss / 1024 / 1024)}MiB heap=${Math.round(profile.memory.heapUsed / 1024 / 1024)}MiB`,
	].join("\n");
}

/**
 * Format a tool name for display.
 */
export function formatToolName(name: string): string {
	return name.replace(/_/g, " ");
}
