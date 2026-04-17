import type {
	Model,
	Context,
	StreamOptions,
	AssistantMessageEvent,
	AssistantMessage,
	Message,
	Usage,
} from "../types.js";
import { EventStream } from "../utils/event-stream.js";

/**
 * OpenAI-compatible provider.
 *
 * Works with OpenAI, OpenRouter, and any API that follows the
 * OpenAI chat completions format. Configurable base URL and headers.
 *
 * Uses raw fetch + SSE parsing — no SDK dependency.
 */

interface OpenAICompatibleConfig {
	baseUrl: string;
	defaultHeaders?: Record<string, string>;
	envKey: string;
	providerName: string;
	/**
	 * Whether to send `stream_options: { include_usage: true }` with
	 * streaming requests. OpenAI, OpenRouter, DeepSeek, and most
	 * compatible shims accept this and emit a terminal usage chunk that
	 * downstream context-window accounting depends on. Strict shims that
	 * reject unknown request fields can opt out by setting this to false.
	 * Default: true.
	 */
	includeUsage?: boolean;
	/**
	 * Whether to ask the upstream for an authoritative per-call cost
	 * (in USD) in the terminal usage chunk. OpenRouter populates
	 * `chunk.usage.cost` when the request body sets
	 * `usage: { include: true }`. Sending this field is a no-op for
	 * shims that ignore unknown request fields, but strict shims may
	 * 400 on it — those should leave this false.
	 *
	 * When the upstream returns a real cost, downstream accounting
	 * uses that USD figure instead of the per-million estimate
	 * derived from the static model price table, which keeps cost
	 * tracking accurate across BYO-key, surge pricing, and routing
	 * changes inside OpenRouter.
	 *
	 * Default: false (only enable for providers known to support it).
	 */
	includeRealCost?: boolean;
}

function convertMessages(context: Context): Record<string, unknown>[] {
	const messages: Record<string, unknown>[] = [];

	if (context.systemPrompt) {
		messages.push({ role: "system", content: context.systemPrompt });
	}

	for (const msg of context.messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content.map((c) =>
							c.type === "text"
								? { type: "text", text: c.text }
								: { type: "image_url", image_url: { url: `data:${c.mimeType};base64,${c.data}` } },
						);
			messages.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const textContent = msg.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			const toolCalls = msg.content
				.filter((c) => c.type === "tool_call")
				.map((c) => ({
					id: c.id,
					type: "function",
					function: { name: c.name, arguments: c.arguments },
				}));

			messages.push({
				role: "assistant",
				content: textContent || null,
				...(toolCalls.length ? { tool_calls: toolCalls } : {}),
			});
		} else if (msg.role === "toolResult") {
			messages.push({
				role: "tool",
				tool_call_id: msg.toolCallId,
				content: msg.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
			});
		}
	}

	return messages;
}

function convertTools(context: Context): Record<string, unknown>[] | undefined {
	if (!context.tools?.length) return undefined;
	return context.tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

function mapFinishReason(reason: string): "stop" | "length" | "toolUse" | "error" {
	switch (reason) {
		case "tool_calls":
			return "toolUse";
		case "length":
			return "length";
		default:
			return "stop";
	}
}

export function createOpenAICompatibleStream(config: OpenAICompatibleConfig) {
	return function openaiCompatibleStream(
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
				const apiKey = options.apiKey || process.env[config.envKey];
				if (!apiKey) {
					stream.push({ type: "error", error: `${config.envKey} not set` });
					return;
				}

				const body: Record<string, unknown> = {
					model: model.id,
					messages: convertMessages(context),
					max_tokens: options.maxTokens || model.maxOutputTokens || 4096,
					stream: true,
				};
				// Required for the API to emit the terminal usage chunk
				// the parser reads to fill `usage`. Without this flag
				// downstream measureContextTokens has no provider-side
				// signal and falls back to the chars/4 estimate, which
				// silently disables Tier-1 usage-aware compaction.
				// Capability-gated so strict shims that reject unknown
				// fields can opt out via OpenAICompatibleConfig.
				if (config.includeUsage !== false) {
					body.stream_options = { include_usage: true };
				}
				// Ask the upstream for an authoritative per-call cost
				// (USD). OpenRouter populates `chunk.usage.cost` when
				// the request body sets `usage: { include: true }`. Off
				// by default since strict shims may reject the unknown
				// field; opt in per provider via includeRealCost.
				if (config.includeRealCost) {
					body.usage = { include: true };
				}

				const tools = convertTools(context);
				if (tools) body.tools = tools;
				if (options.temperature !== undefined) body.temperature = options.temperature;

				const response = await fetch(config.baseUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
						...config.defaultHeaders,
					},
					body: JSON.stringify(body),
					signal: options.signal,
				});

				if (!response.ok) {
					const error = await response.text();
					// Include retry hint for rate limits
					const isRateLimit = response.status === 429;
					const retryAfter = response.headers.get("retry-after");
					const errorMsg = isRateLimit && retryAfter
						? `${config.providerName} API ${response.status}: ${error} (retry after ${retryAfter}s)`
						: `${config.providerName} API ${response.status}: ${error}`;
					stream.push({ type: "error", error: errorMsg });
					return;
				}

				await parseSSEStream(response, stream, model.id, config.providerName, options.signal);
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

async function parseSSEStream(
	response: Response,
	stream: EventStream<AssistantMessageEvent, AssistantMessage>,
	modelId: string,
	providerName: string,
	signal?: AbortSignal,
): Promise<void> {
	if (!response.body) {
		stream.push({ type: "error", error: `${providerName} API returned empty body` });
		return;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let textContent = "";
	let thinkingContent = "";
	const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
	let usage: Usage = { inputTokens: 0, outputTokens: 0 };
	// Start as empty so the usage gate below can distinguish "stream
	// hasn't reported finish yet" from "stream said stop". mapFinishReason
	// defaults to "stop" for unknown values, so leaving this empty until
	// a chunk actually carries a finish_reason is safe for the persisted
	// stopReason but lets us tell apart provisional and final usage.
	let finishReason = "";

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
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				// Skip OpenRouter processing keepalives
				if (line.startsWith(": ")) continue;
				if (!line.startsWith("data: ")) continue;
				const data = line.slice(6).trim();
				if (data === "[DONE]") continue;

				let chunk: Record<string, unknown>;
				try {
					chunk = JSON.parse(data);
				} catch {
					continue;
				}

				const choices = chunk.choices as { delta?: Record<string, unknown>; finish_reason?: string }[];

				// Capture finish_reason and usage BEFORE the delta-skip
				// below: OpenAI's terminal usage chunk has empty `choices`
				// (so no delta), but it carries the final usage totals
				// we need. Skipping it here would silently drop them.
				if (choices?.[0]?.finish_reason) {
					finishReason = choices[0].finish_reason as string;
				}
				const earlyChunkUsage = chunk.usage as
					| { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number } }
					| undefined;
				if (earlyChunkUsage) {
					// Trust this usage when EITHER:
					//  - choices is empty (the spec's terminal usage chunk
					//    has `choices: []`), OR
					//  - finish_reason has been observed (this chunk or a
					//    prior one — the stream is wrapping up).
					// Otherwise the chunk is provisional and we ignore it
					// to avoid pinning the persisted message to an early
					// underestimate.
					const hasNoChoices = !choices || choices.length === 0;
					const isFinalUsage = hasNoChoices || finishReason !== "";
					if (isFinalUsage) {
						usage = {
							inputTokens: earlyChunkUsage.prompt_tokens || 0,
							outputTokens: earlyChunkUsage.completion_tokens || 0,
							...(earlyChunkUsage.prompt_tokens_details?.cached_tokens
								? { cacheReadTokens: earlyChunkUsage.prompt_tokens_details.cached_tokens }
								: {}),
							// Authoritative per-call cost from the
							// upstream (OpenRouter when includeRealCost
							// is on). Downstream prefers this over the
							// per-million estimate.
							...(typeof earlyChunkUsage.cost === "number" ? { cost: earlyChunkUsage.cost } : {}),
						};
					}
				}

				const delta = choices?.[0]?.delta;
				if (!delta) continue;

				// Reasoning content (provider-specific field name normalization).
				// DeepSeek R1 and several OpenRouter routes emit `reasoning_content`;
				// other shims (Together, Groq with reasoning models, some
				// OpenRouter routes) emit `reasoning`. Both shapes mean the same
				// thing — the model's chain-of-thought before it commits to its
				// final answer — so we collapse them to a single `thinking` block
				// in the AssistantMessage so downstream code (compaction, branch
				// summary, persistence) doesn't need provider-specific knowledge.
				const reasoningDelta =
					(delta.reasoning_content as string | undefined) ??
					(delta.reasoning as string | undefined);
				if (reasoningDelta) {
					thinkingContent += reasoningDelta;
					stream.push({ type: "thinking_delta", text: reasoningDelta });
				}

				// Text content
				if (delta.content) {
					textContent += delta.content;
					stream.push({ type: "text_delta", text: delta.content as string });
				}

				// Tool calls
				const deltaToolCalls = delta.tool_calls as
					| { index: number; id?: string; function?: { name?: string; arguments?: string } }[]
					| undefined;
				if (deltaToolCalls) {
					for (const tc of deltaToolCalls) {
						if (!toolCalls.has(tc.index)) {
							toolCalls.set(tc.index, {
								id: tc.id || "",
								name: tc.function?.name || "",
								arguments: "",
							});
							if (tc.id) {
								stream.push({ type: "tool_call_start", id: tc.id, name: tc.function?.name || "" });
							}
						}
						const existing = toolCalls.get(tc.index)!;
						if (tc.id) existing.id = tc.id;
						if (tc.function?.name) existing.name = tc.function.name;
						if (tc.function?.arguments) {
							existing.arguments += tc.function.arguments;
							stream.push({ type: "tool_call_delta", id: existing.id, arguments: tc.function.arguments });
						}
					}
				}

				// finish_reason / usage handled above the delta-skip — see
				// the early capture block at the top of the per-chunk loop.
			}
		}

		// Build final message — order matches Anthropic's convention so
		// downstream code that walks content blocks behaves uniformly across
		// providers: thinking first, then text, then tool_calls.
		const content: AssistantMessage["content"] = [];
		if (thinkingContent) content.push({ type: "thinking", text: thinkingContent });
		if (textContent) content.push({ type: "text", text: textContent });
		for (const tc of toolCalls.values()) {
			// Pass arguments as-is. If the LLM returned malformed JSON, the tool execution
			// layer will return a validation error, giving the LLM a chance to retry.
			// Silently rewriting to "{}" would cause unpredictable behavior.
			content.push({ type: "tool_call", id: tc.id, name: tc.name, arguments: tc.arguments });
			stream.push({ type: "tool_call_end", id: tc.id });
		}

		const message: AssistantMessage = {
			role: "assistant",
			content,
			model: modelId,
			provider: providerName,
			usage,
			stopReason: mapFinishReason(finishReason),
			timestamp: Date.now(),
		};

		stream.push({ type: "done", message });
	} catch (err) {
		stream.push({
			type: "error",
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
