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
import type { AssistantMessage, Message, Model, StreamFunction } from "@my-agent/ai";
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
 * Estimate total tokens for a list of messages.
 */
export function estimateContextTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
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

const SUMMARIZATION_PROMPT = `Summarize the following conversation between a user and an AI coding assistant.

Focus on:
1. What tasks were being worked on
2. What decisions were made and why
3. What files were modified and what changes were made
4. Any important context or constraints mentioned
5. Current state and what was being worked on most recently

Be concise but preserve all information needed to continue the work.
Do NOT include greetings, pleasantries, or meta-commentary.

<conversation>
{CONVERSATION}
</conversation>`;

const UPDATE_SUMMARIZATION_PROMPT = `Update the following summary with new conversation context.
Merge the new information into a cohesive summary, keeping all important details.

<previous-summary>
{PREVIOUS_SUMMARY}
</previous-summary>

<new-conversation>
{CONVERSATION}
</new-conversation>`;

// ============================================================================
// Summarization
// ============================================================================

/**
 * Format messages for the summarization prompt.
 */
function formatMessagesForSummary(messages: Message[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join(" ");
      if (text) parts.push(`User: ${text}`);
    } else if (msg.role === "assistant") {
      const textParts = msg.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text);
      const toolCalls = msg.content
        .filter((c) => c.type === "tool_call")
        .map((c) => `[tool: ${(c as { name: string }).name}]`);
      const text = [...textParts, ...toolCalls].join(" ");
      if (text) parts.push(`Assistant: ${text}`);
    } else if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text.slice(0, 200))
        .join(" ");
      if (text) parts.push(`Tool(${msg.toolName}): ${text}...`);
    }
  }

  return parts.join("\n\n");
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

  const prompt = options?.previousSummary
    ? UPDATE_SUMMARIZATION_PROMPT
        .replace("{PREVIOUS_SUMMARY}", options.previousSummary)
        .replace("{CONVERSATION}", formatted)
    : SUMMARIZATION_PROMPT.replace("{CONVERSATION}", formatted);

  // Handle both sync and async stream functions (registry.stream() returns Promise<EventStream>)
  const streamOrPromise = streamFn(
    model,
    {
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

  // Enrich summary with file list
  let enrichedSummary = summary;
  if (details.readFiles.length > 0 || details.modifiedFiles.length > 0) {
    enrichedSummary += "\n\n---\nFiles involved in this session:";
    if (details.readFiles.length > 0) {
      enrichedSummary += `\nRead: ${details.readFiles.join(", ")}`;
    }
    if (details.modifiedFiles.length > 0) {
      enrichedSummary += `\nModified: ${details.modifiedFiles.join(", ")}`;
    }
  }

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
 */
export function shouldCompact(
  messages: AgentMessage[],
  contextWindow: number,
  reserveTokens: number
): boolean {
  const currentTokens = estimateContextTokens(messages);
  const limit = contextWindow - effectiveReserveTokens(contextWindow, reserveTokens);
  return currentTokens > limit;
}
