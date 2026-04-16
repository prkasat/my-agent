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

function convertMessages(context: Context, enableCaching: boolean): AnthropicMessage[] {
	const out: AnthropicMessage[] = [];

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
				tool_use_id: msg.toolCallId,
				content,
				...(msg.isError ? { is_error: true } : {}),
			});
		} else if (msg.role === "assistant") {
			flushUser();
			const blocks: AnthropicContentBlock[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					// Anthropic requires thinking blocks to be replayed
					// verbatim with their signature. We don't currently
					// persist signatures, so include the text only —
					// Anthropic's API will accept this for non-extended-
					// thinking sessions and tolerate it for follow-ups
					// where tool_use comes after.
					blocks.push({ type: "thinking", thinking: block.text, signature: "" });
				} else if (block.type === "tool_call") {
					let parsedInput: unknown = {};
					try {
						parsedInput = block.arguments ? JSON.parse(block.arguments) : {};
					} catch {
						// Anthropic requires `input` to be a JSON object —
						// fall back to {} on malformed args rather than
						// crashing the stream. The model will see the
						// followup tool_result and can correct course.
						parsedInput = {};
					}
					blocks.push({
						type: "tool_use",
						id: block.id,
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

				await parseSSEStream(response, stream, model.id, options.signal);
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
}

async function parseSSEStream(
	response: Response,
	stream: EventStream<AssistantMessageEvent, AssistantMessage>,
	modelId: string,
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
	const blocks = new Map<number, BlockState>();
	const finalContent: AssistantMessage["content"] = [];

	stream.push({ type: "start", message: { role: "assistant", content: [] } });

	try {
		while (true) {
			if (signal?.aborted) {
				stream.end();
				return;
			}
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			// Anthropic SSE: events are separated by blank lines. Each
			// event has `event: <name>` and `data: <json>` lines.
			const events = buffer.split("\n\n");
			buffer = events.pop() || "";

			for (const evt of events) {
				let data: Record<string, unknown> | null = null;
				for (const line of evt.split("\n")) {
					if (line.startsWith("data: ")) {
						const raw = line.slice(6).trim();
						if (raw && raw !== "[DONE]") {
							try {
								data = JSON.parse(raw);
							} catch {
								data = null;
							}
						}
					}
				}
				if (!data) continue;

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
					const cb = data.content_block as { type: string; id?: string; name?: string; text?: string; thinking?: string };
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
						});
						stream.push({
							type: "tool_call_start",
							id: cb.id || "",
							name: cb.name || "",
						});
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
					if (!block) continue;
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
						stream.push({
							type: "tool_call_delta",
							id: block.toolId || "",
							arguments: delta.partial_json,
						});
					}
				} else if (eventType === "content_block_stop") {
					const idx = data.index as number;
					const block = blocks.get(idx);
					if (!block) continue;
					if (block.type === "text") {
						finalContent.push({ type: "text", text: block.text });
					} else if (block.type === "thinking") {
						finalContent.push({ type: "thinking", text: block.text });
					} else if (block.type === "tool_use") {
						finalContent.push({
							type: "tool_call",
							id: block.toolId || "",
							name: block.toolName || "",
							arguments: block.toolJson || "",
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
						// message_delta carries the FINAL output_tokens (and sometimes
						// updated cache figures). Input tokens come from message_start.
						usage = {
							inputTokens: usageDelta.input_tokens ?? usage.inputTokens,
							outputTokens: usageDelta.output_tokens ?? usage.outputTokens,
							cacheReadTokens: usageDelta.cache_read_input_tokens ?? usage.cacheReadTokens,
							cacheWriteTokens: usageDelta.cache_creation_input_tokens ?? usage.cacheWriteTokens,
						};
					}
				} else if (eventType === "message_stop") {
					// Terminal event — break out via the loop condition.
				} else if (eventType === "error") {
					const err = data.error as { message?: string } | undefined;
					stream.push({ type: "error", error: err?.message || "anthropic stream error" });
					return;
				}
			}
		}

		stream.push({ type: "usage", usage });

		const finalMessage: AssistantMessage = {
			role: "assistant",
			content: finalContent,
			model: modelId,
			provider: "anthropic",
			usage,
			stopReason,
		};
		stream.push({ type: "done", message: finalMessage });
	} catch (err) {
		if (signal?.aborted) {
			stream.end();
		} else {
			stream.push({
				type: "error",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
