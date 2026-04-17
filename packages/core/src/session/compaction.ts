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
import type { CompactionDetails, CompactionEvaluation } from "./types.js";
import { defaultConvertToLlm } from "../agent/convert.js";
import { calculateUsageCost } from "../agent/cost-tracker.js";

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
 * Decide whether a Usage record is trustworthy enough to anchor the
 * context-window estimate.
 *
 * Reject:
 * - all-zero usage: the openai-compatible provider initializes
 *   `usage = { inputTokens: 0, outputTokens: 0 }` BEFORE the API has
 *   reported anything, so a missing-usage response is indistinguishable
 *   from a "real" zero-token turn. Falling back to chars/4 is strictly
 *   safer than anchoring on a phantom zero.
 * - non-finite values (NaN / Infinity): malformed providers shouldn't be
 *   able to silently disable compaction.
 * - negative values: nonsensical; treat as missing.
 *
 * A turn legitimately costs > 0 tokens, so dropping pure-zero records is
 * not a real false-negative.
 */
function isUsableUsage(usage: Usage | undefined): usage is Usage {
  if (!usage) return false;
  const fields = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens ?? 0,
    usage.cacheWriteTokens ?? 0,
  ];
  for (const v of fields) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return false;
  }
  // Prompt-side accounting must be present. A record like
  // `{ inputTokens: 0, outputTokens: 10 }` looks "non-zero" but
  // misrepresents the prompt cost — treating it as the anchor would
  // bill the whole prefix as just the output side and mask overflow.
  // Cache reads/writes also cover prompt-side accounting (they are
  // tokens the model loaded from cache instead of input), so any of
  // those qualifies as "the prompt has been measured."
  const inputSide =
    (usage.inputTokens || 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);
  return inputSide > 0;
}

/**
 * Find the last assistant message that carries usable usage data.
 *
 * Skips aborted and error messages — their usage is unreliable (often
 * partial / phantom) and shouldn't anchor the context-window estimate.
 * Also skips messages whose usage is structurally zero / malformed (see
 * `isUsableUsage`).
 */
function getLastAssistantUsageInfo(
  messages: AgentMessage[],
): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      "role" in msg &&
      msg.role === "assistant" &&
      msg.stopReason !== "aborted" &&
      msg.stopReason !== "error" &&
      isUsableUsage(msg.usage)
    ) {
      return { usage: msg.usage as Usage, index: i };
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
 *
 * When `forceProgress` is true and the chars/4 estimate would otherwise
 * keep ALL messages (because the visible content is small even though
 * provider Usage says we're over the limit — typical of cached / thinking
 * heavy turns), the function still returns a non-zero cut so the auto-
 * compactor can make progress instead of silently looping. The fallback
 * keeps the last assistant turn's tail intact (so the conversation has
 * something to anchor on) but drops the older oldest turn at minimum.
 */
export function findCutPoint(
  messages: AgentMessage[],
  keepRecentTokens: number,
  forceProgress = false,
): number {
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

  // If total tokens < keepRecentTokens, normally don't cut anything.
  // But when the caller has independent evidence (provider Usage) that
  // the context IS over the model's window, we MUST drop something —
  // otherwise the auto-compactor will livelock: trigger says "compact",
  // findCutPoint says "nothing to cut", context unchanged, repeat.
  if (cutIndex === messages.length) {
    if (!forceProgress) return 0;
    // Need at least one kept message AND one summarized message; with
    // fewer than 2 messages there's nothing meaningful to compact, even
    // under forceProgress, so bail out rather than produce an empty
    // summary or an orphaned tail.
    if (messages.length < 2) return 0;
    // Force-cut at half the messages, then snap forward past any
    // toolResult so we don't orphan a tool_call. This is a degraded
    // path; the regular keepRecentTokens budget still wins whenever
    // it can. clamped to keep at least 1 message in the kept tail.
    cutIndex = Math.max(1, Math.min(messages.length - 1, Math.floor(messages.length / 2)));
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
 * Neutralize XML-style wrapper tags inside untrusted content so a
 * malicious or accidental `<conversation>` / `</previous-summary>`
 * (etc.) inside a tool result, file path, or prior summary cannot
 * break out of the wrappers we use in the structured summarization
 * prompt.
 *
 * Both OPENING and CLOSING forms must be escaped:
 * - Closing tag in user content can split our real wrapper early.
 * - Opening tag in user content goes unmatched until our REAL closing
 *   tag, effectively re-scoping later prompt text into the injected
 *   "section" the model perceives.
 *
 * Why a defense at all: the wrappers are framing for the LLM, not a
 * security boundary, but tag injection lets an attacker (or a normal
 * user pasting source code that happens to include the markers) change
 * the apparent boundaries of the transcript and the instructions.
 * Replacing only the angle brackets with their HTML entity keeps the
 * text human-readable while preventing the prompt's real wrappers from
 * being confused with text inside them.
 */
const PROMPT_WRAPPER_TAGS = [
  "conversation",
  "previous-summary",
  "read-files",
  "modified-files",
] as const;

// Match opening (`<tag>`, `<tag/>`) AND closing (`</tag>`) variants of any
// wrapper tag. Tolerates whitespace and case variation. The `/?` after the
// optional `/` covers self-closing forms like `<conversation/>`.
const WRAPPER_TAG_RE = new RegExp(
  `<\\s*(/?)\\s*(${PROMPT_WRAPPER_TAGS.join("|")})\\s*(/?)\\s*>`,
  "gi",
);

function escapeWrapperTags(text: string): string {
  return text.replace(WRAPPER_TAG_RE, (_, lead: string, name: string, trail: string) => {
    return `&lt;${lead}${name.toLowerCase()}${trail}&gt;`;
  });
}

/**
 * Format file operations as XML sections appended after the summary.
 * Empty when both lists are empty.
 *
 * File paths are passed through `escapeWrapperTags` so a path containing
 * literally `</read-files>` cannot break the section out of the section.
 * Path semantics survive because `&lt;` etc. are not valid in real paths.
 */
function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    const safe = readFiles.slice().sort().map(escapeWrapperTags).join("\n");
    sections.push(`<read-files>\n${safe}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    const safe = modifiedFiles.slice().sort().map(escapeWrapperTags).join("\n");
    sections.push(`<modified-files>\n${safe}\n</modified-files>`);
  }
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

/**
 * Generate a compaction summary using the LLM.
 *
 * `options.onUsage` is invoked once with the summary call's `usage` (if
 * the provider reports any) so a caller wiring a budget cap can charge
 * the side LLM call against the same session total. Without this hook
 * the summarization call would spend outside the cap and a session
 * sitting near the limit could silently overdraw via auto-compaction.
 * Codex budget-fix pass-6 finding.
 */
export async function generateCompactionSummary(
  messages: AgentMessage[],
  model: Model,
  streamFn: StreamFunction,
  options?: {
    previousSummary?: string;
    apiKey?: string;
    signal?: AbortSignal;
    onUsage?: (usage: Usage) => void;
  }
): Promise<string> {
  const llmMessages = defaultConvertToLlm(messages);
  const formatted = formatMessagesForSummary(llmMessages);

  // Structured prompt body: <conversation> then optional
  // <previous-summary> then instructions. Wrapping the transcript in
  // an XML section makes the boundary between "what to summarize" and
  // "the instruction" unambiguous so the model doesn't mistake the
  // last user turn in the transcript for a fresh request.
  //
  // Both inputs come from untrusted sources (user prompts, tool output,
  // model-generated prior summaries that may have echoed user content),
  // so they MUST be escaped against `</conversation>` / sibling
  // injections before being interpolated into the wrappers.
  const sections: string[] = [
    `<conversation>\n${escapeWrapperTags(formatted)}\n</conversation>`,
  ];
  if (options?.previousSummary) {
    sections.push(
      `<previous-summary>\n${escapeWrapperTags(options.previousSummary)}\n</previous-summary>`,
    );
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
  if (result.usage && options?.onUsage) {
    options.onUsage(result.usage);
  }
  // Defensive layer (Codex pass-8): even with input escape and the
  // "summarize-do-not-continue" system prompt, the LLM CAN echo back
  // attacker wrapper tags from the transcript verbatim. Persisting
  // that text and later interpolating it into the next compaction's
  // <previous-summary> block (or the [Previous conversation summary]
  // user message at replay) would let an injected `</previous-summary>`
  // close the wrapper of the downstream prompt. Re-apply the escape on
  // the OUTPUT so persisted summaries never carry literal wrapper-close
  // tokens. We don't try to scrub "imperative" prose — that's an
  // unsolved AI safety problem and a heuristic scrub is more dangerous
  // than the bug it tries to fix.
  return escapeWrapperTags(
    result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join(""),
  );
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
// Self-Evaluation
// ============================================================================

/**
 * Post-compaction sanity check. Returns a CompactionEvaluation describing
 * the size delta and any tracked files that were dropped from the summary
 * text. Never throws — the goal is to surface degraded outputs so the
 * caller can act, not to abort compaction.
 *
 * Failure modes detected:
 * - Empty / whitespace-only summary (LLM returned nothing usable).
 * - Summary token estimate larger than the input it summarized
 *   (compaction made the context worse, not better).
 * - Tracked file paths missing from the summary text (the tool-call
 *   trace shows we read/wrote the file, but the summary doesn't
 *   mention it — useful for catching summaries that drop critical
 *   state).
 *
 * `summarizedMessages` is the list that was actually fed to the LLM
 * (post-filtering of prior compaction summaries). When the LLM was
 * also asked to merge a `previousSummary` (multi-round compaction),
 * pass it via `options.previousSummary` so its tokens count toward
 * `tokensBefore` and the size-regression check stops false-flagging
 * the merged output as "larger than the input." Codex self-eval
 * pass-1 finding.
 */
export function evaluateCompaction(
  summarizedMessages: AgentMessage[],
  summary: string,
  trackedFiles: { readFiles: string[]; modifiedFiles: string[] },
  options?: { previousSummary?: string },
): CompactionEvaluation {
  const transcriptTokens = estimateContextTokens(summarizedMessages);
  // Add the prior summary's token estimate so multi-round compactions
  // measure the FULL input the LLM was asked to digest. Without this,
  // a small new transcript merged with a large prior summary would
  // look like the model "blew up" the input even when the merged
  // summary is well-shaped.
  const priorSummaryTokens = options?.previousSummary
    ? options.previousSummary.length / 4
    : 0;
  const tokensBefore = transcriptTokens + priorSummaryTokens;
  const trimmed = summary.trim();
  const tokensAfterSummary = trimmed.length / 4;
  // Guard against divide-by-zero when there was nothing to summarize.
  // Treat as savingsRatio = 0 (perfect compression of nothing).
  const savingsRatio = tokensBefore > 0 ? tokensAfterSummary / tokensBefore : 0;

  const warnings: string[] = [];

  if (trimmed.length === 0) {
    warnings.push("compaction produced an empty summary");
  }

  // Only flag size regression when the input was non-trivial. A 50-char
  // input that summarizes to 60 chars isn't a real regression — the
  // wrapper / framing dominates. Threshold matches the "didn't bother
  // compacting" case in findCutPoint's clamp behavior.
  if (tokensBefore >= 100 && tokensAfterSummary > tokensBefore) {
    warnings.push(
      `summary (${Math.round(tokensAfterSummary)} tok) is larger than the input it summarized (${Math.round(tokensBefore)} tok)`,
    );
  }

  // Tracked-files check: a tracked path that doesn't appear anywhere in
  // the summary text is suspicious. This is a substring match, so a
  // basename-only summary mention still passes.
  //
  // We check the FULL path AND its basename — the LLM commonly shortens
  // paths in summaries, and we don't want to false-flag those.
  const missingFiles: string[] = [];
  const lower = trimmed.toLowerCase();
  const allTracked = [...trackedFiles.readFiles, ...trackedFiles.modifiedFiles];
  // Dedupe so the same file mentioned in both lists doesn't double-count.
  const seen = new Set<string>();
  for (const path of allTracked) {
    if (seen.has(path)) continue;
    seen.add(path);
    const basename = path.split("/").pop() ?? path;
    if (
      !lower.includes(path.toLowerCase()) &&
      !lower.includes(basename.toLowerCase())
    ) {
      missingFiles.push(path);
    }
  }
  if (missingFiles.length > 0) {
    warnings.push(
      `${missingFiles.length} tracked file(s) missing from summary text`,
    );
  }

  return {
    tokensBefore,
    tokensAfterSummary,
    savingsRatio,
    missingFiles,
    warnings,
  };
}

// ============================================================================
// Main Compaction Function
// ============================================================================

/**
 * Minimal cost-tracker shape consumed by compaction. Defined here as
 * a structural type so `compact()` does not have to import the full
 * CostTracker class (which would create a layering loop with
 * cost-tracker.ts importing helpers from this file). Any object with
 * these methods qualifies — production code passes the live tracker;
 * tests can pass a stub.
 */
export interface CompactionCostHook {
  recordTurn: (model: Model, usage: Usage, turnIndex: number) => void;
  isBudgetExceeded: () => boolean;
}

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
  /**
   * Force a non-zero cut even when chars/4 says all messages fit inside
   * keepRecentTokens. Set this when the caller has provider-Usage
   * evidence that the context is over the model's window — otherwise
   * findCutPoint will return 0 and the auto-compactor will livelock.
   */
  forceProgress?: boolean;
  /**
   * Cost tracker that the summarization LLM call should be charged
   * against. When omitted, the call is unmetered (legacy behavior).
   * When provided:
   *   - the summary call's `usage` is passed through `recordTurn` so
   *     it counts toward `maxCostPerSession`,
   *   - `isBudgetExceeded()` is checked before the agent loop is
   *     allowed to keep running on the result.
   * Codex budget-fix pass-6 finding.
   */
  costTracker?: CompactionCostHook;
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
  const cutIndex = findCutPoint(
    messages,
    options.keepRecentTokens,
    options.forceProgress ?? false,
  );

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
  // Rebuild the prior cumulative-cost snapshot from whichever
  // compaction_summary is in flight. This matters when a fresh
  // process compacts a session that already compacted before:
  // `options.previousCompaction` is only set in-memory by the
  // auto-compactor's continuation state, so on resume the caller
  // has no object to hand us — we MUST recover the snapshot from
  // the persisted compaction_summary message itself, otherwise the
  // new snapshot we write would only account for this round and
  // the prior spend would vanish from the session's accounting.
  // Codex budget-fix pass-5 finding.
  let inferredPriorCumulativeCost: number | undefined;
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
      const raw = (msg as { priorCumulativeCost?: unknown }).priorCumulativeCost;
      if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
        // Last one wins too — most recent snapshot carries the full chain.
        inferredPriorCumulativeCost = raw;
      }
      continue;
    }
    filteredToSummarize.push(msg);
  }

  // Caller-supplied previousSummary takes precedence; fall back to the
  // one we discovered in the message list (covers session reloads).
  const effectivePreviousSummary = options.previousSummary ?? inferredPreviousSummary;

  // Generate summary (using filtered messages to avoid duplication).
  // Charge the summarization LLM call against the session budget when
  // a tracker is wired in — otherwise this call would spend outside
  // `maxCostPerSession` and a near-budget session could silently
  // overdraw via auto-compaction. Codex budget-fix pass-6 finding.
  //
  // We ALSO capture the summary call's cost locally (regardless of
  // whether a tracker was passed) so it can be folded into the
  // persisted `priorCumulativeCost` snapshot. The live tracker is
  // for in-process accounting; the snapshot is what survives a
  // restart. Without folding, the side spend is lost on resume.
  // Codex budget-fix pass-7 finding.
  let summaryCallCost = 0;
  const summary = await generateCompactionSummary(
    filteredToSummarize,
    options.model,
    options.streamFn,
    {
      previousSummary: effectivePreviousSummary,
      apiKey: options.apiKey,
      signal: options.signal,
      onUsage: (usage) => {
        const turnCost = calculateUsageCost(options.model, usage);
        if (Number.isFinite(turnCost) && turnCost > 0) {
          summaryCallCost = turnCost;
        }
        if (options.costTracker) {
          // Use turnIndex -1 as a sentinel for "ancillary spend"
          // (compaction/branch-summary), distinct from numbered
          // user-facing turns. The tracker doesn't dedupe by
          // turnIndex, so this is purely for the turnCosts log.
          options.costTracker.recordTurn(options.model, usage, -1);
        }
      },
    }
  );

  // Track file operations
  const details = extractFileOperations(messagesToSummarize, options.previousCompaction);
  details.tokensAfter = estimateContextTokens(keptMessages) + summary.length / 4;

  // Snapshot cumulative cost of every non-aborted/non-error assistant
  // message being folded into this summary, PLUS any prior compaction's
  // snapshot (so a multi-round compaction chain keeps accumulating).
  // The cost tracker reads this on resume to rebuild cumulative spend
  // — without it, compaction would erase prior spend from the context
  // and a fresh process could blow past maxCostPerSession.
  // Codex budget-fix pass-4 finding.
  //
  // Seed order of precedence:
  //   1. options.previousCompaction — in-memory continuation (same-process
  //      auto-compactor already knows the running total).
  //   2. inferredPriorCumulativeCost — recovered from a compaction_summary
  //      inside `messagesToSummarize`. Covers fresh-process re-compaction:
  //      without this, the new snapshot would only reflect this round and
  //      silently erase the previously persisted accumulated spend.
  //      Codex budget-fix pass-5 finding.
  //   3. 0 — genuinely no prior compaction anywhere in the chain.
  //
  // Per-turn cost uses the same formula the live tracker uses so that
  // token-only providers (e.g. Anthropic, which does NOT emit
  // usage.cost on every turn) still contribute their spend to the
  // snapshot. Before this, `typeof msg.usage?.cost === "number"` silently
  // dropped every such turn and a restart-then-resume lost their dollars.
  // Codex budget-fix pass-5 finding.
  const previousSnapshot =
    options.previousCompaction?.priorCumulativeCost ??
    inferredPriorCumulativeCost ??
    0;
  let priorCumulativeCost = previousSnapshot;
  for (const msg of messagesToSummarize) {
    if ("role" in msg && msg.role === "assistant" && msg.usage) {
      // Snapshot ALL assistant turns with valid usage — including
      // `error` and `aborted`. The previous filter dropped both,
      // which created a hole: a live-billed error/aborted turn that
      // was later compacted away would vanish from the only
      // restart-replayable record (the priorCumulativeCost snapshot).
      // Live recordTurn and loadFromMessages both count these turns;
      // the snapshot must agree or restart re-opens budget headroom.
      // Codex budget-fix pass-8 finding.
      const turnCost = calculateUsageCost(options.model, msg.usage);
      if (Number.isFinite(turnCost) && turnCost > 0) {
        priorCumulativeCost += turnCost;
      }
    }
  }
  // Include the summarization LLM call's own cost in the snapshot so
  // it survives a restart. Without this, restart-then-resume reads a
  // priorCumulativeCost that excludes every prior summary call and
  // the budget under-counts. Codex budget-fix pass-7 finding.
  priorCumulativeCost += summaryCallCost;
  details.priorCumulativeCost = priorCumulativeCost;

  // Self-eval against the post-filter input so the size ratio reflects
  // what the LLM actually saw. Pass the prior summary too — when a
  // multi-round compaction merges a large prior summary with a small
  // new transcript, omitting it would make the merged output look
  // larger than its input. The XML file-operations footer that we
  // append below is deterministic and not a measure of summary quality,
  // so it's evaluated against the raw LLM output.
  details.evaluation = evaluateCompaction(
    filteredToSummarize,
    summary,
    {
      readFiles: details.readFiles,
      modifiedFiles: details.modifiedFiles,
    },
    { previousSummary: effectivePreviousSummary },
  );

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
