/**
 * Context Compaction
 *
 * When conversations exceed the context window, older messages are summarized
 * by the LLM. The summary preserves key context while reducing token count.
 *
 * Key features:
 * - Token estimation using chars/4 heuristic (intentionally overestimates)
 * - Cut point finding that never orphans toolResult messages
 * - File operation tracking across compaction cycles
 * - LLM-powered summarization with merge support
 */

import type { AgentMessage, AgentContext } from "../agent/types.js";
import type { AssistantMessage, Message, Model, StreamFunction, Usage } from "@my-agent/ai";
import type { CompactionDetails } from "./types.js";
import { defaultConvertToLlm } from "../agent/convert.js";

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Estimate token count for a message.
 * Uses chars/4 heuristic which intentionally overestimates.
 * Overestimating is safer - we compact slightly early rather than hitting the limit.
 */
export function estimateTokens(message: AgentMessage): number {
  // Custom messages - handle different types
  if ("role" in message && message.role === "custom") {
    // Generic custom messages have content
    if ("content" in message && typeof message.content === "string") {
      return message.content.length / 4;
    }
    // Compaction and branch summaries have summary field
    if ("summary" in message && typeof message.summary === "string") {
      return message.summary.length / 4;
    }
    // Bash execution messages
    if ("output" in message && typeof message.output === "string") {
      return (message.command.length + message.output.length) / 4;
    }
    return 0;
  }

  if (!("role" in message)) return 0;

  switch (message.role) {
    case "user": {
      if (typeof message.content === "string") {
        return message.content.length / 4;
      }
      let tokens = 0;
      for (const block of message.content) {
        if (block.type === "text") {
          tokens += block.text.length / 4;
        } else if (block.type === "image") {
          // Images are roughly 1200 tokens
          tokens += 1200;
        }
      }
      return tokens;
    }

    case "assistant": {
      let tokens = 0;
      for (const block of message.content) {
        if (block.type === "text") {
          tokens += block.text.length / 4;
        } else if (block.type === "thinking") {
          tokens += block.text.length / 4;
        } else if (block.type === "tool_call") {
          tokens += (block.name.length + block.arguments.length) / 4;
        }
      }
      return tokens;
    }

    case "toolResult": {
      let tokens = 0;
      for (const block of message.content) {
        if (block.type === "text") {
          tokens += block.text.length / 4;
        } else if (block.type === "image") {
          tokens += 1200;
        }
      }
      return tokens;
    }

    default:
      return 0;
  }
}

/**
 * Estimate total tokens for a list of messages using the chars/4 heuristic.
 * Prefer `measureContextTokens` when available — it uses provider-reported
 * usage for the prefix up through the last assistant turn and only estimates
 * the trailing tail.
 */
export function estimateContextTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
}

/**
 * Sum a Usage record into total context tokens.
 *
 * Pi-Mono prefers `usage.totalTokens` when the provider reports it. Our
 * Usage shape doesn't carry `totalTokens`, so we always sum the components.
 * Cache reads and writes are real context tokens that the provider charges
 * for and that count against the context window, so they're included.
 */
export function calculateContextTokens(usage: Usage): number {
  return (
    (usage.inputTokens || 0) +
    (usage.outputTokens || 0) +
    (usage.cacheReadTokens || 0) +
    (usage.cacheWriteTokens || 0)
  );
}

/**
 * Find the last assistant message that carries usable usage data.
 *
 * Skips aborted and error messages — their usage is unreliable (often
 * partial / phantom) and shouldn't anchor the context-window estimate.
 */
function getLastAssistantUsageInfo(
  messages: AgentMessage[],
): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      "role" in msg &&
      msg.role === "assistant" &&
      msg.usage &&
      msg.stopReason !== "aborted" &&
      msg.stopReason !== "error"
    ) {
      return { usage: msg.usage, index: i };
    }
  }
  return undefined;
}

export interface ContextTokenMeasurement {
  /** Best estimate of the tokens that will be sent on the next LLM call. */
  tokens: number;
  /** Tokens taken from the last assistant message's reported Usage (0 if none). */
  usageTokens: number;
  /** Tokens estimated for messages after the last assistant Usage anchor. */
  trailingTokens: number;
  /**
   * Index of the assistant message whose Usage was used as the anchor, or
   * `null` if no usage was found and the count is fully estimated.
   */
  lastUsageIndex: number | null;
}

/**
 * Measure context tokens, preferring real provider Usage over chars/4.
 *
 * The context sent to the LLM on the *next* turn is approximately:
 *   {tokens that produced the last assistant turn} + {messages added since}
 * The first term is precisely what `usage.inputTokens + usage.outputTokens`
 * accounts for, because the provider already counted those tokens. The
 * second term is the only thing we still have to estimate.
 *
 * When no assistant message has reported usage yet (cold start, before the
 * first turn completes), this falls back to a fully-estimated count.
 */
export function measureContextTokens(
  messages: AgentMessage[],
): ContextTokenMeasurement {
  const usageInfo = getLastAssistantUsageInfo(messages);

  if (!usageInfo) {
    const estimated = estimateContextTokens(messages);
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }

  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index,
  };
}

// ============================================================================
// Cut Point Finding
// ============================================================================

/**
 * Find a valid cut point in the message list.
 *
 * Rules:
 * - Keep at least keepRecentTokens of recent context
 * - Never cut at a toolResult (would orphan it from its tool call)
 */
export function findCutPoint(messages: AgentMessage[], keepRecentTokens: number): number {
  if (messages.length === 0) return 0;

  // Walk backwards, accumulating tokens
  let tokens = 0;
  let cutIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    tokens += estimateTokens(messages[i]);
    if (tokens >= keepRecentTokens) {
      cutIndex = i;
      break;
    }
  }

  // If total tokens < keepRecentTokens, don't cut anything.
  // This handles smaller context windows where keepRecentTokens exceeds total context.
  if (cutIndex === messages.length) {
    return 0;
  }

  // Adjust: don't cut at a toolResult (would orphan it)
  while (cutIndex < messages.length) {
    const msg = messages[cutIndex];
    if ("role" in msg && msg.role === "toolResult") {
      cutIndex++;
    } else {
      break;
    }
  }

  return Math.max(0, cutIndex);
}

// ============================================================================
// File Operation Tracking
// ============================================================================

/**
 * Extract file operations from messages.
 * Tracks which files were read and modified for context preservation.
 */
export function extractFileOperations(
  messages: AgentMessage[],
  existing?: Partial<CompactionDetails>
): CompactionDetails {
  const readFiles = new Set<string>(existing?.readFiles ?? []);
  const modifiedFiles = new Set<string>(existing?.modifiedFiles ?? []);

  for (const msg of messages) {
    if (!("role" in msg) || msg.role !== "assistant") continue;

    for (const block of msg.content) {
      if (block.type !== "tool_call") continue;

      try {
        const args = JSON.parse(block.arguments);
        const path = args.path || args.file_path;

        switch (block.name) {
          case "read":
          case "Read":
            if (path) readFiles.add(path);
            break;
          case "write":
          case "Write":
          case "edit":
          case "Edit":
            if (path) modifiedFiles.add(path);
            break;
          case "bash":
          case "Bash":
            // Could parse bash commands for file operations, but skip for now
            break;
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return {
    readFiles: [...readFiles],
    modifiedFiles: [...modifiedFiles],
    tokensAfter: 0, // Filled after compaction
  };
}

// ============================================================================
// Summarization Prompts
// ============================================================================

/**
 * System prompt scoping the model to "summarize, do not continue."
 *
 * The summarization LLM receives a serialized transcript as its USER
 * message. Without an explicit "do not continue the conversation"
 * instruction at the system level, models commonly try to answer the
 * questions inside the transcript instead of summarizing them.
 */
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/**
 * Body of the summarization request appended after the transcript.
 *
 * Bullet-list focus areas keep the summary small and consistent across
 * compaction rounds. Tracked file operations are emitted by the calling
 * code as XML sections (<read-files>, <modified-files>) AFTER the
 * summary text — those are deterministic and don't need the LLM.
 */
const SUMMARIZATION_INSTRUCTIONS = `Summarize the conversation above into a structured handoff that the AI assistant can use to continue the work seamlessly. Focus on:

1. The user's most recent request and any in-flight task
2. Decisions made and the reasoning behind them
3. Files modified and the nature of the changes
4. Constraints, conventions, or preferences the assistant must keep honoring
5. The state of work right before this summary (what was just completed, what's next)

Be concise but preserve all information needed to continue without re-asking. Do NOT include greetings, meta-commentary, or invitations to continue the conversation.`;

const SUMMARIZATION_INSTRUCTIONS_WITH_PRIOR = `${SUMMARIZATION_INSTRUCTIONS}

A previous summary is provided in <previous-summary>. Merge its content with the new conversation into ONE cohesive summary — do not append, do not duplicate.`;

/** Maximum chars per tool result in the serialized summary input. */
export const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate a tool result for summarization. Keeps the head and adds an
 * explicit truncation marker so the summarizer knows information was
 * elided. We always need SOME of the result (file paths, error
 * messages, structural cues) but rarely the full body.
 */
function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncated} more characters truncated]`;
}

// ============================================================================
// Summarization
// ============================================================================

/**
 * Serialize a conversation into a flat transcript for the summarization LLM.
 *
 * Structured per-turn markers ([User], [Assistant], [Assistant thinking],
 * [Assistant tool calls], [Tool result]) help the model grasp the turn
 * structure without re-engaging with the transcript as a live chat.
 *
 * Tool results are truncated to TOOL_RESULT_MAX_CHARS — full results are
 * not needed for an effective summary, and unbounded tool output (e.g.,
 * a 200KB grep result) would otherwise blow the summarization budget.
 */
function formatMessagesForSummary(messages: Message[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("");
      if (text) parts.push(`[User]: ${text}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "thinking") {
          thinkingParts.push(block.text);
        } else if (block.type === "tool_call") {
          let argsStr = "";
          try {
            const args = JSON.parse(block.arguments) as Record<string, unknown>;
            argsStr = Object.entries(args)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(", ");
          } catch {
            // Malformed arguments — fall back to the raw string. Better
            // to expose the broken call than silently drop it from the
            // summary.
            argsStr = block.arguments;
          }
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }

      if (thinkingParts.length > 0) {
        parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
      }
      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join("\n")}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      }
    } else if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (text) {
        const label = msg.isError ? "Tool result (error)" : "Tool result";
        parts.push(`[${label} ${msg.toolName}]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
      }
    }
  }

  return parts.join("\n\n");
}

/**
 * Format file operations as XML sections appended after the summary.
 * Empty when both lists are empty.
 */
function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.slice().sort().join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.slice().sort().join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

/**
 * Generate a compaction summary using the LLM.
 */
export async function generateCompactionSummary(
  messages: AgentMessage[],
  model: Model,
  streamFn: StreamFunction,
  options?: {
    previousSummary?: string;
    apiKey?: string;
    signal?: AbortSignal;
  }
): Promise<string> {
  const llmMessages = defaultConvertToLlm(messages);
  const formatted = formatMessagesForSummary(llmMessages);

  // Structured prompt body: <conversation> then optional
  // <previous-summary> then instructions. Wrapping the transcript in
  // an XML section makes the boundary between "what to summarize" and
  // "the instruction" unambiguous so the model doesn't mistake the
  // last user turn in the transcript for a fresh request.
  const sections: string[] = [`<conversation>\n${formatted}\n</conversation>`];
  if (options?.previousSummary) {
    sections.push(`<previous-summary>\n${options.previousSummary}\n</previous-summary>`);
  }
  sections.push(
    options?.previousSummary
      ? SUMMARIZATION_INSTRUCTIONS_WITH_PRIOR
      : SUMMARIZATION_INSTRUCTIONS,
  );
  const prompt = sections.join("\n\n");

  // Handle both sync and async stream functions (registry.stream() returns Promise<EventStream>)
  const streamOrPromise = streamFn(
    model,
    {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    {
      maxTokens: 4096,
      apiKey: options?.apiKey,
      signal: options?.signal,
    }
  );
  const stream = streamOrPromise instanceof Promise ? await streamOrPromise : streamOrPromise;

  const result: AssistantMessage = await stream.result();
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// ============================================================================
// Compaction Result
// ============================================================================

export interface CompactionResult {
  /** Generated summary */
  summary: string;
  /** Messages to keep (after cut point) */
  keptMessages: AgentMessage[];
  /** Index where cut occurred */
  cutIndex: number;
  /** ID of first kept entry (for session manager) */
  firstKeptEntryId?: string;
  /** Compaction metadata */
  details: CompactionDetails;
}

// ============================================================================
// Main Compaction Function
// ============================================================================

export interface CompactOptions {
  /** Minimum tokens of recent context to keep */
  keepRecentTokens: number;
  /** Model to use for summarization */
  model: Model;
  /** Stream function for LLM calls */
  streamFn: StreamFunction;
  /** Previous compaction details (for file tracking) */
  previousCompaction?: CompactionDetails;
  /** Previous summary (for merging) */
  previousSummary?: string;
  /** API key for LLM */
  apiKey?: string;
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * Perform compaction on a message list.
 *
 * Returns the compacted state (summary + kept messages).
 * The caller is responsible for persisting via SessionManager.
 */
export async function compact(
  messages: AgentMessage[],
  options: CompactOptions
): Promise<CompactionResult> {
  const cutIndex = findCutPoint(messages, options.keepRecentTokens);

  // Nothing to compact
  if (cutIndex <= 0) {
    return {
      summary: options.previousSummary ?? "",
      keptMessages: messages,
      cutIndex: 0,
      details: extractFileOperations(messages, options.previousCompaction),
    };
  }

  const messagesToSummarize = messages.slice(0, cutIndex);
  const keptMessages = messages.slice(cutIndex);

  // Strip prior compaction summaries from the summarization input.
  //
  // Why: my-agent stores compaction summaries as `role: "custom"` messages
  // and converts them to user messages via customMessageToLlm just before
  // the LLM call. The previous filter only matched `role: "user"` and so
  // missed the custom variant entirely — meaning each new compaction would
  // feed the prior summary in BOTH as part of `messagesToSummarize` (via
  // defaultConvertToLlm) AND as `previousSummary` in the prompt. That
  // doubled the summary every round and caused unbounded drift.
  //
  // Fix: filter custom-role compaction_summary messages out of the input.
  // If the caller didn't pass `previousSummary` (e.g., after a session
  // reload there's no in-memory state), recover it from the most recent
  // compaction_summary we found, so its content isn't lost.
  let inferredPreviousSummary: string | undefined;
  const filteredToSummarize: AgentMessage[] = [];
  for (const msg of messagesToSummarize) {
    // Custom-role compaction summary — drop, capture content as fallback
    if (
      "role" in msg &&
      msg.role === "custom" &&
      "type" in msg &&
      msg.type === "compaction_summary"
    ) {
      if ("summary" in msg && typeof (msg as { summary: unknown }).summary === "string") {
        // Last one wins — most recent compaction summary
        inferredPreviousSummary = (msg as { summary: string }).summary;
      }
      continue;
    }
    // Legacy user-role summary prefix (older sessions before custom-role)
    if ("role" in msg && msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((c): c is { type: "text"; text: string } => c.type === "text")
                .map((c) => c.text)
                .join("")
            : "";
      if (
        content.startsWith("[Conversation summary") ||
        content.startsWith("[Previous conversation")
      ) {
        if (!inferredPreviousSummary) inferredPreviousSummary = content;
        continue;
      }
    }
    filteredToSummarize.push(msg);
  }

  // Caller-supplied previousSummary takes precedence; fall back to the
  // one we discovered in the message list (covers session reloads).
  const effectivePreviousSummary = options.previousSummary ?? inferredPreviousSummary;

  // Generate summary (using filtered messages to avoid duplication)
  const summary = await generateCompactionSummary(
    filteredToSummarize,
    options.model,
    options.streamFn,
    {
      previousSummary: effectivePreviousSummary,
      apiKey: options.apiKey,
      signal: options.signal,
    }
  );

  // Track file operations
  const details = extractFileOperations(messagesToSummarize, options.previousCompaction);
  details.tokensAfter = estimateContextTokens(keptMessages) + summary.length / 4;

  // Enrich summary with file-operation XML sections so future calls
  // (and human readers) can quickly recover what files this branch
  // has touched without re-parsing the prose.
  const enrichedSummary = summary + formatFileOperations(details.readFiles, details.modifiedFiles);

  return {
    summary: enrichedSummary,
    keptMessages,
    cutIndex,
    details,
  };
}

// ============================================================================
// Compaction Check
// ============================================================================

/**
 * Effective reserve tokens, clamped to half the context window.
 *
 * Why: with a small-context model (e.g., 8K) and the default reserveTokens
 * (16K), an unclamped `limit = contextWindow - reserveTokens` goes negative,
 * which makes `shouldCompact` return true unconditionally and the downstream
 * cut-point math collapse the kept tail to a single message. Capping at half
 * the window keeps the limit positive and the percentages meaningful.
 *
 * Both `shouldCompact` and `createAutoCompactor` MUST agree on this clamp,
 * otherwise they disagree about whether compaction is needed.
 */
export function effectiveReserveTokens(
  contextWindow: number,
  reserveTokens: number
): number {
  return Math.min(reserveTokens, Math.floor(contextWindow / 2));
}

/**
 * Check if compaction is needed based on token count.
 *
 * Uses provider Usage when available so that the trigger matches what the
 * model actually charges for, not the chars/4 overestimate. Falls back to
 * the heuristic when no assistant turn has reported usage yet.
 */
export function shouldCompact(
  messages: AgentMessage[],
  contextWindow: number,
  reserveTokens: number
): boolean {
  const currentTokens = measureContextTokens(messages).tokens;
  const limit = contextWindow - effectiveReserveTokens(contextWindow, reserveTokens);
  return currentTokens > limit;
}
