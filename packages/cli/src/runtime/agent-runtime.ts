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

import {
  agentLoop,
  BASE_INSTRUCTIONS,
  BUILTIN_READ_TOOL_NAMES,
  buildSystemPrompt,
  createAllTools,
  createPermissionChecker,
  createAutoCompactorWithPersistence,
  defaultConvertToLlm,
  discoverProjectContext,
  SessionManager,
  type AgentContext,
  type AgentLoopConfig,
  type AgentMessage,
  type AskDecision,
  type PermissionAskContext,
} from "@my-agent/core";
import { stream } from "@my-agent/ai";
import type { Settings } from "../config/settings.js";
import type { AuthStorage } from "../config/auth-storage.js";
import { loadExtensionsForRun } from "./extensions.js";
import { resolveConfiguredModel } from "./model-registry.js";

export interface RuntimeConfig {
  cwd: string;
  settings: Settings;
  authStorage: AuthStorage;
  session: SessionManager;
  signal?: AbortSignal;
  askPermission?: (ctx: PermissionAskContext) => Promise<AskDecision>;
}

export interface RuntimeResult {
  messages: AgentMessage[];
  aborted: boolean;
  error?: string;
}

/**
 * Run the agent with a prompt and stream output to the provided callbacks.
 */
export async function runAgent(
  prompt: string,
  config: RuntimeConfig,
  callbacks: {
    onText?: (text: string) => void;
    onToolStart?: (toolName: string, toolCallId: string) => void;
    onToolEnd?: (toolName: string, isError: boolean) => void;
    onThinking?: (text: string) => void;
    onTurnStart?: () => void;
    onTurnEnd?: () => void;
  } = {},
): Promise<RuntimeResult> {
  const { cwd, settings, authStorage, session, signal, askPermission } = config;

  // Resolve the configured model against current auth state.
  const { model } = await resolveConfiguredModel(settings, authStorage);

  // Build system prompt with project context
  // Support SYSTEM.md override and APPEND_SYSTEM.md
  const homeDir =
    (typeof process !== "undefined" && process.env.HOME) || ".";
  const globalDir = `${homeDir}/.my-agent`;
  const projectContext = await discoverProjectContext(cwd, globalDir);

  // Load extensions for this run. Extensions are trusted local modules.
  let currentContext: AgentContext | null = null;
  const extensionRuntime = await loadExtensionsForRun({
    cwd,
    globalDir,
    settings,
    sessionId: session.getSessionId(),
    getAgentContext: () => currentContext,
  });

  const transformedPrompt = extensionRuntime
    ? await extensionRuntime.runner.dispatchUserInput(prompt)
    : prompt;

  // Create tools (built-ins + extension tools)
  const toolsRecord = createAllTools(cwd);
  const tools = [
    ...Object.values(toolsRecord),
    ...(extensionRuntime?.runner.getAllTools() ?? []),
  ];

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
    extensionContext: extensionRuntime
      ? [`Loaded extensions: ${extensionRuntime.loadedIds.join(", ") || "none"}`]
      : [],
  });

  // Build messages from session history + new prompt
  const sessionContext = session.buildSessionContext();
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
  const streamOptions = settings.thinkingLevel !== "off"
    ? { thinkingLevel: settings.thinkingLevel as ThinkingLevel }
    : undefined;

  // Create auto-compactor if enabled
  const autoCompactor = settings.compaction.enabled
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
      })
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
          return { action: "block", reason: extDecision.reason };
        }
        if ("modifiedArgs" in extDecision) {
          nextArgs = extDecision.modifiedArgs;
        }
      }

      const permissionResult = await permissionChecker.check({ ...ctx, args: nextArgs });
      if (permissionResult.action === "block") {
        return permissionResult;
      }

      return nextArgs === ctx.args ? { action: "allow" } : { action: "allow", modifiedArgs: nextArgs };
    },
    afterToolCall: async (ctx) => {
      if (!extensionRuntime) return undefined;
      return await extensionRuntime.runner.dispatchToolEnd(
        ctx.toolCall.id,
        ctx.toolCall.name,
        ctx.result,
        ctx.isError,
        0,
      );
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
          callbacks.onTurnStart?.();
          await extensionRuntime?.runner.dispatch({ type: "turn_start", turnIndex: event.turnIndex } as any);
          break;

        case "turn_end":
          callbacks.onTurnEnd?.();
          await extensionRuntime?.runner.dispatch({
            type: "turn_end",
            turnIndex: event.turnIndex,
            usage: event.usage,
          } as any);
          break;

        case "message_start":
          await extensionRuntime?.runner.dispatch({ type: "message_start", message: event.message } as any);
          break;

        case "message_update":
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

        case "tool_execution_start":
          toolNames.set(event.toolCallId, event.toolName);
          toolStartedAt.set(event.toolCallId, Date.now());
          callbacks.onToolStart?.(event.toolName, event.toolCallId);
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
          callbacks.onToolEnd?.(toolName, event.isError);
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

  return {
    messages: context.messages,
    aborted,
    error,
  };
}

/**
 * Format a tool name for display.
 */
export function formatToolName(name: string): string {
  return name.replace(/_/g, " ");
}
