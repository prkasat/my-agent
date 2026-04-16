/**
 * Branch Summarization
 *
 * When navigating away from a branch, generates a summary of the abandoned
 * path so context isn't lost. This helps the LLM understand what was tried
 * before and avoid repeating mistakes.
 */

import type { AgentMessage } from "../agent/types.js";
import type { AssistantMessage, Message, Model, StreamFunction } from "@my-agent/ai";
import type { BranchSummaryDetails, SessionEntry, MessageEntry } from "./types.js";
import { defaultConvertToLlm } from "../agent/convert.js";

// ============================================================================
// Prompts
// ============================================================================

const BRANCH_SUMMARY_PROMPT = `Summarize what was attempted in this conversation branch that is being abandoned.

Focus on:
1. What approach was being tried
2. What worked and what didn't
3. Any errors or issues encountered
4. Files that were modified
5. Key learnings that should inform the next approach

Be concise but preserve information that would help avoid repeating mistakes.

<branch-conversation>
{CONVERSATION}
</branch-conversation>`;

// ============================================================================
// File Operations
// ============================================================================

/**
 * Extract file operations from messages.
 */
function extractFileOperations(messages: AgentMessage[]): BranchSummaryDetails {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();
  let messageCount = 0;

  for (const msg of messages) {
    if (!("role" in msg)) continue;

    if (msg.role === "user" || msg.role === "assistant") {
      messageCount++;
    }

    if (msg.role !== "assistant") continue;

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
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return {
    readFiles: [...readFiles],
    modifiedFiles: [...modifiedFiles],
    messageCount,
  };
}

// ============================================================================
// Message Formatting
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
      // Include errors, truncate success output
      const isError = msg.isError;
      const text = msg.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => isError ? c.text : c.text.slice(0, 100))
        .join(" ");
      if (text) {
        const suffix = isError ? " [ERROR]" : "...";
        parts.push(`Tool(${msg.toolName}): ${text}${suffix}`);
      }
    }
  }

  return parts.join("\n\n");
}

// ============================================================================
// Entry Extraction
// ============================================================================

/**
 * Extract messages from session entries.
 */
function extractMessagesFromEntries(entries: SessionEntry[]): AgentMessage[] {
  const messages: AgentMessage[] = [];

  for (const entry of entries) {
    if (entry.type === "message") {
      messages.push((entry as MessageEntry).message);
    }
  }

  return messages;
}

// ============================================================================
// Branch Summary Generation
// ============================================================================

export interface BranchSummaryResult {
  /** Generated summary */
  summary: string;
  /** Branch metadata */
  details: BranchSummaryDetails;
}

export interface GenerateBranchSummaryOptions {
  /** Model to use for summarization */
  model: Model;
  /** Stream function for LLM calls */
  streamFn: StreamFunction;
  /** API key for LLM */
  apiKey?: string;
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * Generate a summary for an abandoned branch.
 *
 * @param entries - Session entries from the abandoned branch
 * @param options - Generation options
 * @returns Summary and metadata
 */
export async function generateBranchSummary(
  entries: SessionEntry[],
  options: GenerateBranchSummaryOptions
): Promise<BranchSummaryResult> {
  const messages = extractMessagesFromEntries(entries);
  const details = extractFileOperations(messages);

  // If no messages, return empty summary
  if (messages.length === 0) {
    return { summary: "", details };
  }

  // Convert to LLM messages and format
  const llmMessages = defaultConvertToLlm(messages);
  const formatted = formatMessagesForSummary(llmMessages);

  // If too short, don't bother with LLM call - but still include file details
  if (formatted.length < 100) {
    let summary = `Brief exploration: ${formatted.slice(0, 200)}`;

    // Append file list even for short summaries
    if (details.readFiles.length > 0 || details.modifiedFiles.length > 0) {
      summary += "\n\nFiles touched:";
      if (details.readFiles.length > 0) {
        summary += `\n- Read: ${details.readFiles.join(", ")}`;
      }
      if (details.modifiedFiles.length > 0) {
        summary += `\n- Modified: ${details.modifiedFiles.join(", ")}`;
      }
    }

    return { summary, details };
  }

  const prompt = BRANCH_SUMMARY_PROMPT.replace("{CONVERSATION}", formatted);

  // Handle both sync and async stream functions (registry.stream() returns Promise<EventStream>)
  const streamOrPromise = options.streamFn(
    options.model,
    {
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    {
      maxTokens: 2048,
      apiKey: options.apiKey,
      signal: options.signal,
    }
  );
  const stream = streamOrPromise instanceof Promise ? await streamOrPromise : streamOrPromise;

  const result: AssistantMessage = await stream.result();
  let summary = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

  // Append file list
  if (details.readFiles.length > 0 || details.modifiedFiles.length > 0) {
    summary += "\n\nFiles touched:";
    if (details.readFiles.length > 0) {
      summary += `\n- Read: ${details.readFiles.join(", ")}`;
    }
    if (details.modifiedFiles.length > 0) {
      summary += `\n- Modified: ${details.modifiedFiles.join(", ")}`;
    }
  }

  return { summary, details };
}

/**
 * Check if a branch should have a summary generated.
 *
 * Heuristics:
 * - At least 2 messages (user + assistant exchange)
 * - Or has file modifications (work was done)
 */
export function shouldGenerateBranchSummary(entries: SessionEntry[]): boolean {
  const messages = extractMessagesFromEntries(entries);

  // At least one exchange
  if (messages.length >= 2) return true;

  // Check for file modifications
  for (const msg of messages) {
    if (!("role" in msg) || msg.role !== "assistant") continue;

    for (const block of msg.content) {
      if (block.type === "tool_call") {
        if (["write", "Write", "edit", "Edit"].includes(block.name)) {
          return true;
        }
      }
    }
  }

  return false;
}
