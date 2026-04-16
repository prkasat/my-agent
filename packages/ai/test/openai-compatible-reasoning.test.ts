/**
 * Offline replay tests for openai-compatible reasoning normalization.
 *
 * Drives the SSE parser through `createOpenAICompatibleStream` with
 * captured-shape fixtures so reasoning shape drift is caught here
 * instead of at runtime against a live provider.
 *
 * Two reasoning field names exist in the wild:
 *   - `delta.reasoning_content` (DeepSeek R1, several OpenRouter routes)
 *   - `delta.reasoning`         (Together, Groq with reasoning models,
 *                                other OpenRouter routes)
 *
 * Both must collapse to a single `ThinkingContent` block in the final
 * AssistantMessage, prepended before text/tool_call blocks so downstream
 * compaction / branch-summary / persistence code can read reasoning
 * uniformly across providers.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenAICompatibleStream } from "../src/providers/openai-compatible.js";
import type { AssistantMessageEvent, Model } from "../src/types.js";

function ssePayload(chunks: object[]): Uint8Array {
	const encoder = new TextEncoder();
	const body =
		chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
		"data: [DONE]\n\n";
	return encoder.encode(body);
}

function makeMockFetch(chunks: object[]): typeof fetch {
	return (async () => {
		const data = ssePayload(chunks);
		let pushed = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!pushed) {
					controller.enqueue(data);
					pushed = true;
				} else {
					controller.close();
				}
			},
		});
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}) as typeof fetch;
}

const fakeModel: Model = {
	id: "test-reasoning-model",
	name: "Test Reasoning",
	provider: "openai",
	contextWindow: 1000,
	maxOutputTokens: 100,
	supportsTools: true,
	supportsStreaming: true,
	supportsThinking: true,
	cost: { inputPerMillion: 0, outputPerMillion: 0 },
};

describe("openai-compatible reasoning normalization", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		process.env.TEST_KEY = "test-key";
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.TEST_KEY;
	});

	function runWith(chunks: object[]) {
		globalThis.fetch = makeMockFetch(chunks);
		const stream = createOpenAICompatibleStream({
			providerName: "test",
			baseUrl: "http://example.test",
			envKey: "TEST_KEY",
		})(fakeModel, { messages: [] }, {});
		return stream;
	}

	function collectEvents(
		stream: ReturnType<typeof runWith>,
	): Promise<{ message: Awaited<ReturnType<typeof stream.result>>; events: AssistantMessageEvent[] }> {
		const events: AssistantMessageEvent[] = [];
		const collector = (async () => {
			for await (const ev of stream) events.push(ev);
		})();
		return stream.result().then(async (message) => {
			await collector;
			return { message, events };
		});
	}

	it("DeepSeek-style: reasoning_content delta is collected as a leading thinking block", async () => {
		// Captured shape from a typical DeepSeek R1 SSE response.
		const { message, events } = await collectEvents(
			runWith([
				{ choices: [{ delta: { role: "assistant" } }] },
				{ choices: [{ delta: { reasoning_content: "Let me think " } }] },
				{ choices: [{ delta: { reasoning_content: "step by step." } }] },
				{ choices: [{ delta: { content: "Answer: 42" } }] },
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
				{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
			]),
		);

		expect(message.content[0]).toEqual({
			type: "thinking",
			text: "Let me think step by step.",
		});
		expect(message.content[1]).toEqual({ type: "text", text: "Answer: 42" });

		const thinkingDeltas = events.filter((e) => e.type === "thinking_delta") as {
			type: "thinking_delta";
			text: string;
		}[];
		expect(thinkingDeltas.map((e) => e.text)).toEqual([
			"Let me think ",
			"step by step.",
		]);
	});

	it("OpenRouter-style: bare `reasoning` field collapses to the same thinking block", async () => {
		const { message } = await collectEvents(
			runWith([
				{ choices: [{ delta: { reasoning: "Considering options... " } }] },
				{ choices: [{ delta: { reasoning: "decided." } }] },
				{ choices: [{ delta: { content: "Final answer" } }] },
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
				{ choices: [], usage: { prompt_tokens: 8, completion_tokens: 3 } },
			]),
		);

		expect(message.content[0]).toEqual({
			type: "thinking",
			text: "Considering options... decided.",
		});
		expect(message.content[1]).toEqual({ type: "text", text: "Final answer" });
	});

	it("reasoning + tool_call: thinking block precedes the tool_call in final content", async () => {
		const { message } = await collectEvents(
			runWith([
				{ choices: [{ delta: { reasoning_content: "I should call a tool." } }] },
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_1",
										function: { name: "search", arguments: '{"q":' },
									},
								],
							},
						},
					],
				},
				{
					choices: [
						{
							delta: {
								tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }],
							},
						},
					],
				},
				{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
				{ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } },
			]),
		);

		expect(message.stopReason).toBe("toolUse");
		expect(message.content[0]).toEqual({
			type: "thinking",
			text: "I should call a tool.",
		});
		expect(message.content[1]).toMatchObject({
			type: "tool_call",
			id: "call_1",
			name: "search",
			arguments: '{"q":"hello"}',
		});
	});

	it("a stream with no reasoning at all does NOT emit any thinking block", async () => {
		const { message, events } = await collectEvents(
			runWith([
				{ choices: [{ delta: { content: "plain text" } }] },
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
				{ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
			]),
		);
		expect(message.content.find((c) => c.type === "thinking")).toBeUndefined();
		expect(events.filter((e) => e.type === "thinking_delta").length).toBe(0);
	});

	it("when both `reasoning_content` and `reasoning` appear in one delta, prefers reasoning_content", async () => {
		// Conservative tie-breaker: reasoning_content is the more
		// explicit field name and appears first in the field order our
		// normalizer checks. Asserting it pins the precedence so a future
		// refactor that swaps the order surfaces in tests.
		const { message } = await collectEvents(
			runWith([
				{
					choices: [
						{
							delta: {
								reasoning_content: "EXPLICIT",
								reasoning: "BARE",
							},
						},
					],
				},
				{ choices: [{ delta: { content: "x" } }] },
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
				{ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
			]),
		);
		expect((message.content[0] as { text: string }).text).toBe("EXPLICIT");
	});
});
