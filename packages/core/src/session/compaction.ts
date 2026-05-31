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

import type { AssistantMessage, Message, Model, StreamFunctionLike, Usage } from "@my-agent/ai";
import { defaultConvertToLlm } from "../agent/convert.js";
import { calculateUsageCost } from "../agent/cost-tracker.js";
import type { AgentMessage } from "../agent/types.js";
import type { CompactionDetails, CompactionEvaluation } from "./types.js";

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
		(usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
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
	const fields = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0];
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
	const inputSide = (usage.inputTokens || 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
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
function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
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
export function measureContextTokens(messages: AgentMessage[]): ContextTokenMeasurement {
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
 * Result of finding a cut point, including split-turn information.
 */
export interface CutPointResult {
	/** Index of first message to keep */
	firstKeptIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not at a turn boundary) */
	isSplitTurn: boolean;
}

/**
 * Find the user message that starts the turn containing the given index.
 * Returns -1 if no user message is found before the index.
 */
function findTurnStartIndex(messages: AgentMessage[], fromIndex: number): number {
	for (let i = fromIndex; i >= 0; i--) {
		const msg = messages[i];
		if ("role" in msg && msg.role === "user") {
			return i;
		}
		// Custom messages that convert to user content also start turns
		if ("role" in msg && msg.role === "custom" && "type" in msg) {
			const type = msg.type;
			// Branch summaries and compaction summaries start turns
			if (type === "branch_summary" || type === "compaction_summary") {
				return i;
			}
			// Extension messages with sendToLlm: true convert to user messages
			if (type === "extension" && "sendToLlm" in msg && (msg as { sendToLlm?: boolean }).sendToLlm === true) {
				return i;
			}
		}
	}
	return -1;
}

/**
 * Check if a message is a valid cut point (not a toolResult).
 */
function isValidCutPoint(msg: AgentMessage): boolean {
	if (!("role" in msg)) return false;
	// Never cut at toolResult — would orphan it from its tool_call
	return msg.role !== "toolResult";
}

/**
 * Find a valid cut point in the message list with split-turn information.
 *
 * Internal function that returns full CutPointResult including whether the
 * cut occurs mid-turn. Used by compact() for split-turn compaction.
 */
function findCutPointWithSplitInfo(
	messages: AgentMessage[],
	keepRecentTokens: number,
	forceProgress = false,
): CutPointResult {
	const noCut: CutPointResult = { firstKeptIndex: 0, turnStartIndex: -1, isSplitTurn: false };
	if (messages.length === 0) return noCut;

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
	// But when forceProgress is set (provider Usage says we're over limit),
	// we MUST drop something to avoid livelock.
	if (cutIndex === messages.length) {
		if (!forceProgress) return noCut;
		if (messages.length < 2) return noCut;
		// Force-cut at half the messages, clamped to keep at least 1 message
		cutIndex = Math.max(1, Math.min(messages.length - 1, Math.floor(messages.length / 2)));
	}

	// Adjust: don't cut at a toolResult (would orphan it from its tool_call).
	// First try advancing forward to find a valid cut point.
	const originalCutIndex = cutIndex;
	while (cutIndex < messages.length) {
		const msg = messages[cutIndex];
		if (!isValidCutPoint(msg)) {
			cutIndex++;
		} else {
			break;
		}
	}

	// If we advanced past all messages (all trailing toolResults), look backward
	// for the last valid cut point instead. This handles contexts that end with
	// pending tool results (common when resuming after tool execution).
	if (cutIndex >= messages.length && originalCutIndex > 0) {
		cutIndex = originalCutIndex - 1;
		while (cutIndex > 0) {
			const msg = messages[cutIndex];
			if (isValidCutPoint(msg)) {
				break;
			}
			cutIndex--;
		}
	}

	cutIndex = Math.max(0, cutIndex);
	if (cutIndex === 0 || cutIndex >= messages.length) return noCut;

	// Determine if this is a split turn. A split occurs when the cut lands
	// mid-turn (after the turn start, before the turn ends). Cuts exactly at
	// turn boundaries (user messages, branch_summary, compaction_summary,
	// extension with sendToLlm) are NOT splits.
	const _cutMsg = messages[cutIndex];
	const turnStartIndex = findTurnStartIndex(messages, cutIndex);
	// Cut is at a turn boundary if turnStartIndex equals cutIndex, or if
	// no turn start was found (turnStartIndex === -1, e.g., leading assistant).
	const isAtTurnBoundary = turnStartIndex === cutIndex || turnStartIndex === -1;

	return {
		firstKeptIndex: cutIndex,
		turnStartIndex: isAtTurnBoundary ? -1 : turnStartIndex,
		isSplitTurn: !isAtTurnBoundary,
	};
}

/**
 * Find a valid cut point in the message list.
 *
 * Rules:
 * - Keep at least keepRecentTokens of recent context
 * - Never cut at a toolResult (would orphan it from its tool call)
 *
 * When `forceProgress` is true and the chars/4 estimate would otherwise
 * keep ALL messages, the function still returns a non-zero cut so the
 * auto-compactor can make progress. This handles cases where provider
 * Usage reports overflow but chars/4 underestimates (cached/thinking turns).
 *
 * @returns Index of the first message to keep (0 means no cut needed)
 */
export function findCutPoint(messages: AgentMessage[], keepRecentTokens: number, forceProgress = false): number {
	return findCutPointWithSplitInfo(messages, keepRecentTokens, forceProgress).firstKeptIndex;
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
	existing?: Partial<CompactionDetails>,
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
 * Structured summarization prompt that produces a consistent, scannable format.
 * The explicit sections help the model organize information and make it easier
 * for the resuming assistant to quickly find what it needs.
 */
const SUMMARIZATION_INSTRUCTIONS = `Create a structured context checkpoint summary using this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if covering different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

## Key Decisions
- [Important decisions made and their reasoning]

## Next Steps
- [What needs to happen next to continue the work]

Be concise but preserve all information needed to continue without re-asking. Do NOT include greetings, meta-commentary, or invitations to continue the conversation.`;

const SUMMARIZATION_INSTRUCTIONS_WITH_PRIOR = `${SUMMARIZATION_INSTRUCTIONS}

A previous summary is provided in <previous-summary>. Merge its content with the new conversation into ONE cohesive summary — do not append, do not duplicate.`;

/**
 * Prompt for summarizing the prefix portion of a split turn.
 * When a single turn is too large to keep, we split it and summarize
 * only the prefix while keeping the recent suffix intact.
 */
const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

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
const PROMPT_WRAPPER_TAGS = ["conversation", "previous-summary", "read-files", "modified-files"] as const;

// Match opening (`<tag>`, `<tag/>`) AND closing (`</tag>`) variants of any
// wrapper tag. Tolerates whitespace and case variation. The `/?` after the
// optional `/` covers self-closing forms like `<conversation/>`.
const WRAPPER_TAG_RE = new RegExp(`<\\s*(/?)\\s*(${PROMPT_WRAPPER_TAGS.join("|")})\\s*(/?)\\s*>`, "gi");

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
 * Strip file-operation footers from a summary to avoid duplicating them
 * when the summary is reused directly without re-summarization.
 */
const FILE_FOOTER_RE = /\n\n<(read-files|modified-files)>[\s\S]*?<\/\1>/gi;
function stripFileFooters(summary: string): string {
	return summary.replace(FILE_FOOTER_RE, "");
}

/**
 * Parse file-operation footers from a summary to recover read/modified files.
 * Used when resuming from a persisted compaction_summary where previousCompaction
 * details are not available in memory.
 */
const READ_FILES_RE = /<read-files>([\s\S]*?)<\/read-files>/i;
const MODIFIED_FILES_RE = /<modified-files>([\s\S]*?)<\/modified-files>/i;
function parseFileFooters(summary: string): { readFiles: string[]; modifiedFiles: string[] } {
	const readMatch = READ_FILES_RE.exec(summary);
	const modifiedMatch = MODIFIED_FILES_RE.exec(summary);
	return {
		readFiles: readMatch
			? readMatch[1]
					.trim()
					.split("\n")
					.filter((p) => p.trim())
			: [],
		modifiedFiles: modifiedMatch
			? modifiedMatch[1]
					.trim()
					.split("\n")
					.filter((p) => p.trim())
			: [],
	};
}

/**
 * Generate a compaction summary using the LLM.
 *
 * `options.onUsage` is invoked once with the summary call's `usage` (if
 * the provider reports any) so a caller wiring a budget cap can charge
 * the side LLM call against the same session total.
 */
export async function generateCompactionSummary(
	messages: AgentMessage[],
	model: Model,
	streamFn: StreamFunctionLike,
	options?: {
		previousSummary?: string;
		apiKey?: string;
		signal?: AbortSignal;
		onUsage?: (usage: Usage) => void;
	},
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
	const sections: string[] = [`<conversation>\n${escapeWrapperTags(formatted)}\n</conversation>`];
	if (options?.previousSummary) {
		sections.push(`<previous-summary>\n${escapeWrapperTags(options.previousSummary)}\n</previous-summary>`);
	}
	sections.push(options?.previousSummary ? SUMMARIZATION_INSTRUCTIONS_WITH_PRIOR : SUMMARIZATION_INSTRUCTIONS);
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
		},
	);
	const stream = streamOrPromise instanceof Promise ? await streamOrPromise : streamOrPromise;

	const result: AssistantMessage = await stream.result();
	if (result.usage && options?.onUsage) {
		options.onUsage(result.usage);
	}
	// The LLM can echo wrapper tags from the transcript verbatim. Re-apply
	// escape on output so persisted summaries never carry literal wrapper-
	// close tokens that could break future prompt interpolation.
	return escapeWrapperTags(
		result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(""),
	);
}

/**
 * Generate a summary for the prefix portion of a split turn.
 *
 * When a single turn exceeds the token budget, we keep the recent suffix
 * and summarize just the prefix to provide context for the kept portion.
 */
export async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model,
	streamFn: StreamFunctionLike,
	options?: {
		apiKey?: string;
		signal?: AbortSignal;
		onUsage?: (usage: Usage) => void;
	},
): Promise<string> {
	const llmMessages = defaultConvertToLlm(messages);
	const formatted = formatMessagesForSummary(llmMessages);

	const prompt = `<conversation>\n${escapeWrapperTags(formatted)}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;

	const streamOrPromise = streamFn(
		model,
		{
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		},
		{
			maxTokens: 2048, // Smaller budget for turn prefix
			apiKey: options?.apiKey,
			signal: options?.signal,
		},
	);
	const stream = streamOrPromise instanceof Promise ? await streamOrPromise : streamOrPromise;

	const result: AssistantMessage = await stream.result();
	if (result.usage && options?.onUsage) {
		options.onUsage(result.usage);
	}
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
	/**
	 * The summarization LLM call's reported usage. Exposed separately so the
	 * caller can charge a live cost tracker AFTER the compaction entry has
	 * been durably persisted, keeping disk and in-memory state in sync.
	 */
	summaryUsage?: Usage;
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
	const priorSummaryTokens = options?.previousSummary ? options.previousSummary.length / 4 : 0;
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
		if (!lower.includes(path.toLowerCase()) && !lower.includes(basename.toLowerCase())) {
			missingFiles.push(path);
		}
	}
	if (missingFiles.length > 0) {
		warnings.push(`${missingFiles.length} tracked file(s) missing from summary text`);
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
	/** Stream function for LLM calls (sync or async) */
	streamFn: StreamFunctionLike;
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
	 * keepRecentTokens. Set when provider-Usage reports overflow to avoid
	 * livelock where the auto-compactor triggers but findCutPoint returns 0.
	 */
	forceProgress?: boolean;
	/**
	 * Cost tracker for the summarization LLM call. When provided, the call's
	 * usage is passed through recordTurn so it counts toward maxCostPerSession.
	 */
	costTracker?: CompactionCostHook;
}

/**
 * Perform compaction on a message list.
 *
 * Handles two compaction modes:
 * 1. Normal: Cut at a turn boundary, summarize history before the cut
 * 2. Split-turn: Cut mid-turn, generate parallel summaries for history
 *    and the turn's prefix to provide context for the kept suffix
 *
 * Returns the compacted state (summary + kept messages).
 * The caller is responsible for persisting via SessionManager.
 */
export async function compact(messages: AgentMessage[], options: CompactOptions): Promise<CompactionResult> {
	const cutResult = findCutPointWithSplitInfo(messages, options.keepRecentTokens, options.forceProgress ?? false);

	// Nothing to compact
	if (cutResult.firstKeptIndex <= 0) {
		return {
			summary: options.previousSummary ?? "",
			keptMessages: messages,
			cutIndex: 0,
			details: extractFileOperations(messages, options.previousCompaction),
		};
	}

	const { firstKeptIndex, turnStartIndex, isSplitTurn } = cutResult;
	const keptMessages = messages.slice(firstKeptIndex);

	// For split turns, we summarize history (before turn start) and turn prefix
	// (turn start to cut point) separately, then merge them.
	const historyEnd = isSplitTurn ? turnStartIndex : firstKeptIndex;
	const messagesToSummarize = messages.slice(0, historyEnd);
	const turnPrefixMessages = isSplitTurn ? messages.slice(turnStartIndex, firstKeptIndex) : [];

	// Strip prior compaction summaries from the summarization input to avoid
	// doubling summaries each round. Recover previousSummary and cost snapshot
	// from the most recent compaction_summary if caller didn't pass them.
	// Also scan turnPrefixMessages for split turns where turnStartIndex is 0.
	let inferredPreviousSummary: string | undefined;
	let inferredPriorCumulativeCost: number | undefined;

	const extractCompactionInfo = (msg: AgentMessage): boolean => {
		if ("role" in msg && msg.role === "custom" && "type" in msg && msg.type === "compaction_summary") {
			if ("summary" in msg && typeof (msg as { summary: unknown }).summary === "string") {
				inferredPreviousSummary = (msg as { summary: string }).summary;
			}
			const raw = (msg as { priorCumulativeCost?: unknown }).priorCumulativeCost;
			if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
				inferredPriorCumulativeCost = raw;
			}
			return true;
		}
		return false;
	};

	const filteredToSummarize: AgentMessage[] = [];
	for (const msg of messagesToSummarize) {
		if (extractCompactionInfo(msg)) continue;
		filteredToSummarize.push(msg);
	}

	// For split turns, also filter compaction_summary from turnPrefixMessages.
	// This handles resumed sessions where turnStartIndex is 0.
	const filteredTurnPrefix: AgentMessage[] = [];
	for (const msg of turnPrefixMessages) {
		if (extractCompactionInfo(msg)) continue;
		filteredTurnPrefix.push(msg);
	}

	const effectivePreviousSummary = options.previousSummary ?? inferredPreviousSummary;

	// Track total summary cost for the priorCumulativeCost snapshot.
	// For split-turn compaction, we aggregate usage from both LLM calls.
	// Cost tracking is atomic: we buffer usage during LLM calls and only
	// charge the costTracker after all calls complete successfully. This
	// prevents budget leaks when one split-turn call succeeds but the
	// other fails.
	let summaryCallCost = 0;
	let aggregatedUsage: Usage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
	// Buffer for deferred charging after all calls complete
	const bufferedUsages: Usage[] = [];

	const handleUsage = (usage: Usage) => {
		// Buffer usage for deferred charging (don't charge immediately)
		bufferedUsages.push(usage);
		aggregatedUsage = {
			inputTokens: (aggregatedUsage.inputTokens || 0) + (usage.inputTokens || 0),
			outputTokens: (aggregatedUsage.outputTokens || 0) + (usage.outputTokens || 0),
			cacheReadTokens: (aggregatedUsage.cacheReadTokens || 0) + (usage.cacheReadTokens || 0),
			cacheWriteTokens: (aggregatedUsage.cacheWriteTokens || 0) + (usage.cacheWriteTokens || 0),
		};
		const turnCost = calculateUsageCost(options.model, usage);
		if (Number.isFinite(turnCost) && turnCost > 0) {
			summaryCallCost += turnCost;
		}
	};

	// Charge costTracker for all buffered usages after all calls complete
	const commitUsageToTracker = () => {
		if (options.costTracker) {
			for (const usage of bufferedUsages) {
				options.costTracker.recordTurn(options.model, usage, -1);
			}
		}
	};

	let summary: string;

	if (isSplitTurn && filteredTurnPrefix.length > 0) {
		// Generate summaries sequentially. On any failure, commit whatever
		// usage we've buffered so far — the provider already billed us for
		// successful calls, so the live tracker must reflect that even if
		// the overall compaction fails. This prevents budget drift where
		// billed spend vanishes from our accounting on partial failure.
		let historyResult: string;
		let turnPrefixResult: string;
		try {
			if (filteredToSummarize.length > 0) {
				historyResult = await generateCompactionSummary(filteredToSummarize, options.model, options.streamFn, {
					previousSummary: effectivePreviousSummary,
					apiKey: options.apiKey,
					signal: options.signal,
					onUsage: handleUsage,
				});
			} else {
				// Strip file footers when reusing prior summary directly to avoid duplication
				historyResult = stripFileFooters(effectivePreviousSummary ?? "");
			}

			turnPrefixResult = await generateTurnPrefixSummary(filteredTurnPrefix, options.model, options.streamFn, {
				apiKey: options.apiKey,
				signal: options.signal,
				onUsage: handleUsage,
			});
		} catch (err) {
			// Commit any buffered usage before rethrowing — we were billed
			// for successful calls even if the overall compaction fails.
			// Also check budget: if the partial charge exceeded the cap, wrap
			// the original error so the caller knows to stop rather than
			// proceeding under fail-open policy.
			commitUsageToTracker();
			if (options.costTracker?.isBudgetExceeded?.()) {
				const budgetErr = new Error("Cost budget exceeded after partial compaction");
				(budgetErr as any).cause = err;
				throw budgetErr;
			}
			throw err;
		}
		// Both calls succeeded — commit all buffered usage
		commitUsageToTracker();
		// Merge into single summary (skip history section if empty)
		summary = historyResult
			? `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`
			: `**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else {
		// Non-split-turn compaction: just generate history summary.
		// Skip LLM call when no new messages to summarize - reuse prior summary.
		if (filteredToSummarize.length > 0) {
			summary = await generateCompactionSummary(filteredToSummarize, options.model, options.streamFn, {
				previousSummary: effectivePreviousSummary,
				apiKey: options.apiKey,
				signal: options.signal,
				onUsage: handleUsage,
			});
			// Commit charges after successful generation
			commitUsageToTracker();
		} else if (effectivePreviousSummary) {
			// Strip existing file footers to avoid duplication - they'll be
			// re-added via formatFileOperations with the merged file lists.
			summary = stripFileFooters(effectivePreviousSummary);
		} else {
			summary = "";
		}
	}

	// Track file operations from all summarized messages (history + turn prefix).
	// When previousCompaction is not available (fresh-process resume), parse file
	// footers from the previous summary text to avoid losing tracked paths.
	const allSummarizedMessages = [...messagesToSummarize, ...turnPrefixMessages];
	const existingDetails: Partial<CompactionDetails> =
		options.previousCompaction ?? (effectivePreviousSummary ? parseFileFooters(effectivePreviousSummary) : {});
	const details = extractFileOperations(allSummarizedMessages, existingDetails);
	details.tokensAfter = estimateContextTokens(keptMessages) + summary.length / 4;

	// Snapshot cumulative cost for restart recovery. Includes:
	// 1. Prior compaction's snapshot (in-memory or recovered from compaction_summary)
	// 2. All assistant turns being folded into this summary
	// 3. The summarization LLM call(s) themselves
	const previousSnapshot = options.previousCompaction?.priorCumulativeCost ?? inferredPriorCumulativeCost ?? 0;
	let priorCumulativeCost = previousSnapshot;
	for (const msg of allSummarizedMessages) {
		if ("role" in msg && msg.role === "assistant" && msg.usage) {
			const turnCost = calculateUsageCost(options.model, msg.usage);
			if (Number.isFinite(turnCost) && turnCost > 0) {
				priorCumulativeCost += turnCost;
			}
		}
	}
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

	// Include summaryCallCost in summaryUsage so the persistence wrapper
	// charges the same value that's in priorCumulativeCost. This uses the
	// best available estimate: authoritative usage.cost when available,
	// otherwise token-based pricing via calculateUsageCost. This keeps
	// live tracker and persisted snapshot in sync even for mixed reporting.
	const finalUsage: Usage | undefined =
		bufferedUsages.length > 0
			? {
					...aggregatedUsage,
					cost: summaryCallCost,
				}
			: undefined;

	return {
		summary: enrichedSummary,
		keptMessages,
		cutIndex: firstKeptIndex,
		details,
		summaryUsage: finalUsage,
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
export function effectiveReserveTokens(contextWindow: number, reserveTokens: number): number {
	return Math.min(reserveTokens, Math.floor(contextWindow / 2));
}

/**
 * Check if compaction is needed based on token count.
 *
 * Uses provider Usage when available so that the trigger matches what the
 * model actually charges for, not the chars/4 overestimate. Falls back to
 * the heuristic when no assistant turn has reported usage yet.
 */
export function shouldCompact(messages: AgentMessage[], contextWindow: number, reserveTokens: number): boolean {
	const currentTokens = measureContextTokens(messages).tokens;
	const limit = contextWindow - effectiveReserveTokens(contextWindow, reserveTokens);
	return currentTokens > limit;
}
