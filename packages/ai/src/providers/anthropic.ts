import type {
	Model,
	Context,
	StreamOptions,
	AssistantMessageEvent,
	AssistantMessage,
	Usage,
	ThinkingLevel,
} from "../types.js";
import { EventStream } from "../utils/event-stream.js";

/**
 * Native Anthropic Messages API provider.
 *
 * Speaks the Anthropic API directly (not via openai-compatible) so we
 * unlock features the openai-compatible layer can't translate:
 *  - First-class thinking blocks with signatures (preserved on replay)
 *  - Prompt caching via `cache_control: { type: "ephemeral" }`
 *  - Native tool_use / tool_result content blocks
 *  - Anthropic-specific stop_reason values (end_turn, tool_use)
 *
 * Uses raw fetch + SSE parsing — no SDK dependency.
 */

interface AnthropicConfig {
	baseUrl?: string;
	envKey?: string;
	apiVersion?: string;
	/**
	 * If true, request prompt caching (`cache_control: ephemeral`) on the
	 * system prompt and tools block. Defaults to true; set false for
	 * providers that don't accept the field.
	 */
	enableCaching?: boolean;
	/**
	 * Identifier stamped on every emitted AssistantMessage as
	 * `message.provider`. The replay gate in convertMessages only trusts
	 * signed thinking when the source message has provider === "anthropic".
	 *
	 * Default: "anthropic" when baseUrl is the real Anthropic endpoint,
	 * "anthropic-compatible" otherwise. The auto-default keeps third-party
	 * proxies / Bedrock-style passthroughs from being mistakenly tagged
	 * as the real API — their signatures are not interchangeable, and
	 * replaying one to the real Anthropic endpoint would 400.
	 *
	 * Hosts that KNOW their proxy passes through real Anthropic
	 * signatures (e.g. an authenticated reverse proxy that forwards to
	 * api.anthropic.com unchanged) can opt back into "anthropic" by
	 * setting this explicitly. Codex Tier-3 pass-4 finding.
	 */
	providerName?: string;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_ENV_KEY = "ANTHROPIC_API_KEY";
const DEFAULT_API_VERSION = "2023-06-01";

function thinkingBudget(level: ThinkingLevel | undefined): number | null {
	switch (level) {
		case "minimal":
			return 1024;
		case "low":
			return 4096;
		case "medium":
			return 8192;
		case "high":
			return 16384;
		case "xhigh":
			return 32768;
		default:
			return null;
	}
}

interface AnthropicContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	signature?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
	is_error?: boolean;
	source?: { type: string; media_type: string; data: string };
	cache_control?: { type: "ephemeral" };
}

interface AnthropicMessage {
	role: "user" | "assistant";
	content: AnthropicContentBlock[];
}

/**
 * Anthropic tool_use IDs are typically `toolu_<24-char-base64ish>` and
 * the API rejects IDs that are too long or contain shell-style chars.
 * Other providers can emit IDs that violate those constraints (OpenAI
 * Responses uses long IDs with `|`). When we replay history through
 * Anthropic, normalize any ID outside the safe shape AND remap the
 * matching toolResult.toolCallId so the pair still wires up.
 *
 * Codex Tier-3 pass-3 finding.
 */
const ANTHROPIC_TOOL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isAnthropicSafeToolId(id: string): boolean {
	return ANTHROPIC_TOOL_ID_RE.test(id);
}

function convertMessages(context: Context, enableCaching: boolean): AnthropicMessage[] {
	const out: AnthropicMessage[] = [];
	// First pass: build a remap of foreign tool IDs to anthropic-safe
	// IDs by walking assistant tool_call blocks. The remap is then
	// applied to the matching toolResult below.
	const toolIdRemap = new Map<string, string>();
	let toolIdCounter = 0;
	const safeId = (orig: string): string => {
		if (isAnthropicSafeToolId(orig)) return orig;
		const cached = toolIdRemap.get(orig);
		if (cached) return cached;
		const fresh = `toolu_compat_${toolIdCounter++}`;
		toolIdRemap.set(orig, fresh);
		return fresh;
	};

	// Anthropic groups consecutive tool_results into the *next* user
	// message. We rebuild the flat my-agent message list as Anthropic's
	// alternating user/assistant turns, where a "user" turn may be a
	// mix of plain user text/images and tool_result blocks following an
	// assistant tool-use.
	let pendingUser: AnthropicContentBlock[] = [];
	const flushUser = () => {
		if (pendingUser.length > 0) {
			out.push({ role: "user", content: pendingUser });
			pendingUser = [];
		}
	};

	for (const msg of context.messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				pendingUser.push({ type: "text", text: msg.content });
			} else {
				for (const block of msg.content) {
					if (block.type === "text") {
						pendingUser.push({ type: "text", text: block.text });
					} else if (block.type === "image") {
						pendingUser.push({
							type: "image",
							source: {
								type: "base64",
								media_type: block.mimeType,
								data: block.data,
							},
						});
					}
				}
			}
		} else if (msg.role === "toolResult") {
			const content: Array<{ type: string; text?: string; source?: AnthropicContentBlock["source"] }> = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					content.push({ type: "text", text: block.text });
				} else if (block.type === "image") {
					content.push({
						type: "image",
						source: {
							type: "base64",
							media_type: block.mimeType,
							data: block.data,
						},
					});
				}
			}
			pendingUser.push({
				type: "tool_result",
				tool_use_id: safeId(msg.toolCallId),
				content,
				...(msg.isError ? { is_error: true } : {}),
			});
		} else if (msg.role === "assistant") {
			flushUser();
			// Signed thinking is provider/model-specific continuation
			// state, not portable transcript content. A thinking block
			// produced by a non-Anthropic assistant (or by us before
			// the provider tag was set) carries a signature that
			// Anthropic will reject — even if it's well-formed,
			// because it isn't ITS signature. Only replay signed
			// thinking when the assistant message came from this
			// provider. Otherwise drop the block (we already drop
			// thinking with no signature for the same reason).
			// Codex Tier-3 pass-3 finding.
			// Only "anthropic" provenance qualifies — undefined means
			// we don't know, so don't trust the signature.
			const sameProvider = msg.provider === "anthropic";
			const blocks: AnthropicContentBlock[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					if (block.signature && sameProvider) {
						blocks.push({
							type: "thinking",
							thinking: block.text,
							signature: block.signature,
						});
					}
					// Otherwise drop — see comment above.
				} else if (block.type === "tool_call") {
					let parsedInput: Record<string, unknown> = {};
					if (block.arguments) {
						try {
							const parsed = JSON.parse(block.arguments);
							// Anthropic requires `input` to be a JSON OBJECT.
							// Reject arrays, null, scalars — replaying any of
							// those would 400 the next request and durably
							// break the conversation. Fall back to {} so the
							// follow-up tool_result still wires up correctly.
							// (Codex Tier-3 pass-2 finding.)
							if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
								parsedInput = parsed as Record<string, unknown>;
							}
						} catch {
							// Malformed JSON — leave parsedInput as {}.
						}
					}
					blocks.push({
						type: "tool_use",
						id: safeId(block.id),
						name: block.name,
						input: parsedInput,
					});
				}
			}
			out.push({ role: "assistant", content: blocks });
		}
	}
	flushUser();

	// Apply ephemeral cache_control to the LAST content block of the
	// LAST user message — Anthropic caches the prefix up through that
	// marker so subsequent turns reuse the system + tools + chat prefix.
	if (enableCaching && out.length > 0) {
		const last = out[out.length - 1];
		if (last.role === "user" && last.content.length > 0) {
			last.content[last.content.length - 1].cache_control = { type: "ephemeral" };
		}
	}

	return out;
}

function convertTools(context: Context, enableCaching: boolean): Record<string, unknown>[] | undefined {
	if (!context.tools?.length) return undefined;
	const tools: Record<string, unknown>[] = context.tools.map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.parameters,
	}));
	// Cache the tools block (schemas are large and stable across turns).
	if (enableCaching && tools.length > 0) {
		tools[tools.length - 1].cache_control = { type: "ephemeral" };
	}
	return tools;
}

function convertSystem(systemPrompt: string | undefined, enableCaching: boolean): unknown {
	if (!systemPrompt) return undefined;
	if (!enableCaching) return systemPrompt;
	// Send as a content-block array so we can attach cache_control —
	// Anthropic accepts string OR array, but cache_control requires array.
	return [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
}

function mapStopReason(reason: string | null | undefined): "stop" | "length" | "toolUse" | "error" {
	switch (reason) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		case "end_turn":
		case "stop_sequence":
			return "stop";
		default:
			return "stop";
	}
}

export function createAnthropicStream(config: AnthropicConfig = {}) {
	const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
	const envKey = config.envKey ?? DEFAULT_ENV_KEY;
	const apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
	const enableCaching = config.enableCaching ?? true;
	// Safe default: mark non-default endpoints as "anthropic-compatible"
	// so the replay-trust gate in convertMessages doesn't forward their
	// signed thinking back to the real Anthropic API. Hosts that KNOW
	// their proxy passes signatures through unchanged can opt back into
	// "anthropic" explicitly via providerName.
	const providerName =
		config.providerName ?? (baseUrl === DEFAULT_BASE_URL ? "anthropic" : "anthropic-compatible");

	return function anthropicStream(
		model: Model,
		context: Context,
		options: StreamOptions = {},
	): EventStream<AssistantMessageEvent, AssistantMessage> {
		const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				throw new Error((event as { error?: string }).error || "Stream error");
			},
		);

		(async () => {
			try {
				const apiKey = options.apiKey || process.env[envKey];
				if (!apiKey) {
					stream.push({ type: "error", error: `${envKey} not set` });
					return;
				}

				const body: Record<string, unknown> = {
					model: model.id,
					messages: convertMessages(context, enableCaching),
					max_tokens: options.maxTokens || model.maxOutputTokens || 4096,
					stream: true,
				};
				const system = convertSystem(context.systemPrompt, enableCaching);
				if (system !== undefined) body.system = system;
				const tools = convertTools(context, enableCaching);
				if (tools) body.tools = tools;
				if (options.temperature !== undefined) body.temperature = options.temperature;

				const budget = thinkingBudget(options.thinkingLevel);
				if (budget !== null && model.supportsThinking) {
					body.thinking = { type: "enabled", budget_tokens: budget };
					// Anthropic requires max_tokens > budget_tokens.
					const requestedMax = body.max_tokens as number;
					if (requestedMax <= budget) {
						body.max_tokens = budget + 4096;
					}
				}

				const response = await fetch(baseUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-api-key": apiKey,
						"anthropic-version": apiVersion,
					},
					body: JSON.stringify(body),
					signal: options.signal,
				});

				if (!response.ok) {
					const error = await response.text();
					const isRateLimit = response.status === 429;
					const retryAfter = response.headers.get("retry-after");
					const errorMsg = isRateLimit && retryAfter
						? `anthropic API ${response.status}: ${error} (retry after ${retryAfter}s)`
						: `anthropic API ${response.status}: ${error}`;
					stream.push({ type: "error", error: errorMsg });
					return;
				}

				await parseSSEStream(response, stream, model.id, providerName, options.signal);
			} catch (err) {
				if (options.signal?.aborted) {
					stream.end();
				} else {
					stream.push({
						type: "error",
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		})();

		return stream;
	};
}

interface BlockState {
	type: "text" | "thinking" | "tool_use";
	text: string;
	thinkingSignature?: string;
	toolId?: string;
	toolName?: string;
	toolJson?: string;
	/**
	 * Tool-use `input` value from content_block_start. Some Anthropic-
	 * compatible proxies populate input eagerly in the start event and
	 * never send any `input_json_delta` chunks. We keep this as a
	 * fallback for content_block_stop when toolJson stayed empty
	 * (Codex Tier-3 pass-1 finding).
	 */
	seededInput?: unknown;
}

async function parseSSEStream(
	response: Response,
	stream: EventStream<AssistantMessageEvent, AssistantMessage>,
	modelId: string,
	providerName: string,
	signal?: AbortSignal,
): Promise<void> {
	if (!response.body) {
		stream.push({ type: "error", error: "anthropic API returned empty body" });
		return;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let usage: Usage = { inputTokens: 0, outputTokens: 0 };
	let stopReason: "stop" | "length" | "toolUse" | "error" = "stop";
	let errored = false;
	const blocks = new Map<number, BlockState>();
	const finalContent: AssistantMessage["content"] = [];

	stream.push({ type: "start", message: { role: "assistant", content: [] } });

	// Split buffer into complete events (separated by blank line),
	// returning the leftover trailing buffer. Tolerates both LF
	// (`\n\n`) and CRLF (`\r\n\r\n`) framing — the SSE spec allows
	// either, and CRLF appears in real Anthropic-compatible proxies.
	// Codex Tier-3 pass-1 finding.
	const splitEvents = (buf: string, drain: boolean): { events: string[]; rest: string } => {
		const normalized = buf.replace(/\r\n/g, "\n");
		const parts = normalized.split("\n\n");
		if (drain) return { events: parts, rest: "" };
		const rest = parts.pop() || "";
		return { events: parts, rest };
	};

	const processData = (data: Record<string, unknown>): void => {
		const eventType = data.type as string | undefined;
		if (eventType === "message_start") {
			const msg = data.message as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined;
			if (msg?.usage) {
				usage = {
					inputTokens: msg.usage.input_tokens || 0,
					outputTokens: msg.usage.output_tokens || 0,
					cacheReadTokens: msg.usage.cache_read_input_tokens,
					cacheWriteTokens: msg.usage.cache_creation_input_tokens,
				};
			}
		} else if (eventType === "content_block_start") {
			const idx = data.index as number;
			const cb = data.content_block as { type: string; id?: string; name?: string; text?: string; thinking?: string; input?: unknown };
			if (cb.type === "text") {
				blocks.set(idx, { type: "text", text: cb.text || "" });
			} else if (cb.type === "thinking") {
				blocks.set(idx, { type: "thinking", text: cb.thinking || "" });
			} else if (cb.type === "tool_use") {
				blocks.set(idx, {
					type: "tool_use",
					text: "",
					toolId: cb.id || "",
					toolName: cb.name || "",
					toolJson: "",
					seededInput: cb.input,
				});
				stream.push({ type: "tool_call_start", id: cb.id || "", name: cb.name || "" });
			}
		} else if (eventType === "content_block_delta") {
			const idx = data.index as number;
			const delta = data.delta as {
				type: string;
				text?: string;
				thinking?: string;
				signature?: string;
				partial_json?: string;
			};
			const block = blocks.get(idx);
			if (!block) return;
			if (delta.type === "text_delta" && delta.text) {
				block.text += delta.text;
				stream.push({ type: "text_delta", text: delta.text });
			} else if (delta.type === "thinking_delta" && delta.thinking) {
				block.text += delta.thinking;
				stream.push({ type: "thinking_delta", text: delta.thinking });
			} else if (delta.type === "signature_delta" && delta.signature) {
				block.thinkingSignature = (block.thinkingSignature || "") + delta.signature;
			} else if (delta.type === "input_json_delta" && delta.partial_json !== undefined) {
				block.toolJson = (block.toolJson || "") + delta.partial_json;
				stream.push({ type: "tool_call_delta", id: block.toolId || "", arguments: delta.partial_json });
			}
		} else if (eventType === "content_block_stop") {
			const idx = data.index as number;
			const block = blocks.get(idx);
			if (!block) return;
			if (block.type === "text") {
				finalContent.push({ type: "text", text: block.text });
			} else if (block.type === "thinking") {
				const thinkingBlock: { type: "thinking"; text: string; signature?: string } = {
					type: "thinking",
					text: block.text,
				};
				if (block.thinkingSignature) {
					thinkingBlock.signature = block.thinkingSignature;
				}
				finalContent.push(thinkingBlock);
			} else if (block.type === "tool_use") {
				// Prefer streamed partial_json, fall back to the seeded
				// input from content_block_start when no deltas arrived
				// (compatible-proxy quirk).
				let args = block.toolJson || "";
				if (!args && block.seededInput !== undefined) {
					try {
						args = JSON.stringify(block.seededInput);
					} catch {
						args = "";
					}
				}
				finalContent.push({
					type: "tool_call",
					id: block.toolId || "",
					name: block.toolName || "",
					arguments: args,
				});
				stream.push({ type: "tool_call_end", id: block.toolId || "" });
			}
		} else if (eventType === "message_delta") {
			const delta = data.delta as { stop_reason?: string };
			if (delta?.stop_reason) {
				stopReason = mapStopReason(delta.stop_reason);
			}
			const usageDelta = data.usage as
				| { output_tokens?: number; input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
				| undefined;
			if (usageDelta) {
				usage = {
					inputTokens: usageDelta.input_tokens ?? usage.inputTokens,
					outputTokens: usageDelta.output_tokens ?? usage.outputTokens,
					cacheReadTokens: usageDelta.cache_read_input_tokens ?? usage.cacheReadTokens,
					cacheWriteTokens: usageDelta.cache_creation_input_tokens ?? usage.cacheWriteTokens,
				};
			}
		} else if (eventType === "error") {
			const err = data.error as { message?: string } | undefined;
			stream.push({ type: "error", error: err?.message || "anthropic stream error" });
			errored = true;
		}
	};

	const handleEvent = (evt: string): void => {
		for (const line of evt.split("\n")) {
			if (!line.startsWith("data: ")) continue;
			const raw = line.slice(6).trim();
			if (!raw || raw === "[DONE]") continue;
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(raw);
			} catch {
				continue;
			}
			processData(data);
			if (errored) return;
		}
	};

	try {
		while (true) {
			if (signal?.aborted) {
				stream.end();
				return;
			}
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const { events, rest } = splitEvents(buffer, false);
			buffer = rest;
			for (const evt of events) {
				handleEvent(evt);
				if (errored) return;
			}
		}

		// Drain any final buffered event the server didn't terminate
		// with a trailing blank line. Without this, the last
		// message_delta / message_stop could be silently dropped if it
		// arrived in the same chunk as EOF (Codex Tier-3 pass-1).
		if (buffer.length > 0) {
			const { events } = splitEvents(buffer, true);
			for (const evt of events) {
				handleEvent(evt);
				if (errored) return;
			}
			buffer = "";
		}
	} catch (err) {
		if (signal?.aborted) {
			stream.end();
		} else {
			stream.push({
				type: "error",
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return;
	}

	stream.push({ type: "usage", usage });
	stream.push({
		type: "done",
		message: {
			role: "assistant",
			content: finalContent,
			model: modelId,
			provider: providerName,
			usage,
			stopReason,
		},
	});
}
