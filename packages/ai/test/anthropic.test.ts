import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnthropicStream } from "../src/providers/anthropic.js";
import type { Context, Model } from "../src/types.js";

const MODEL: Model = {
	id: "claude-test",
	name: "Claude Test",
	provider: "anthropic",
	contextWindow: 200_000,
	maxOutputTokens: 8_192,
	supportsTools: true,
	supportsStreaming: true,
	supportsThinking: true,
	cost: { inputPerMillion: 3, outputPerMillion: 15 },
};

function sse(chunks: Array<{ event: string; data: Record<string, unknown> }>): string {
	return (
		chunks
			.map((c) => `event: ${c.event}\ndata: ${JSON.stringify(c.data)}\n`)
			.join("\n") + "\n"
	);
}

function mockResponse(body: string, status = 200): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(ctrl) {
			ctrl.enqueue(new TextEncoder().encode(body));
			ctrl.close();
		},
	});
	return new Response(stream, {
		status,
		headers: { "content-type": "text/event-stream" },
	});
}

let realFetch: typeof fetch;
beforeEach(() => {
	realFetch = globalThis.fetch;
	process.env.ANTHROPIC_API_KEY = "sk-ant-test";
});
afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.ANTHROPIC_API_KEY;
});

describe("anthropic provider", () => {
	it("streams a basic text response and reports usage", async () => {
		const body = sse([
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: {
						id: "msg_1",
						type: "message",
						role: "assistant",
						model: "claude-test",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				},
			},
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello, " } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world!" } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{
				event: "message_delta",
				data: {
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 7 },
				},
			},
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

		const ctx: Context = { systemPrompt: "you are helpful", messages: [{ role: "user", content: "hi" }] };
		const stream = createAnthropicStream()(MODEL, ctx);
		const msg = await stream.result();

		expect(msg.role).toBe("assistant");
		expect(msg.content).toEqual([{ type: "text", text: "Hello, world!" }]);
		expect(msg.stopReason).toBe("stop");
		expect(msg.usage?.inputTokens).toBe(10);
		expect(msg.usage?.outputTokens).toBe(7);
		expect(msg.provider).toBe("anthropic");
	});

	it("streams a thinking block and preserves the text", async () => {
		const body = sse([
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 5, output_tokens: 0 } },
				},
			},
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me think " } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "about it" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
			{
				event: "message_delta",
				data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
			},
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

		const stream = createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "hi" }] });
		const msg = await stream.result();

		expect(msg.content).toHaveLength(2);
		expect(msg.content[0]).toEqual({
			type: "thinking",
			text: "let me think about it",
			signature: "sig123",
		});
		expect(msg.content[1]).toEqual({ type: "text", text: "Done." });
	});

	it("streams a tool_use block with incremental input_json_delta", async () => {
		const body = sse([
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 12, output_tokens: 0 } },
				},
			},
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
				},
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"/tmp/x"}' } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{
				event: "message_delta",
				data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
			},
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

		const stream = createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "read it" }] });
		const events: string[] = [];
		for await (const e of stream) {
			events.push(e.type);
		}
		const msg = await stream.result();

		expect(msg.stopReason).toBe("toolUse");
		expect(msg.content).toEqual([
			{ type: "tool_call", id: "toolu_1", name: "read", arguments: '{"path":"/tmp/x"}' },
		]);
		expect(events).toContain("tool_call_start");
		expect(events).toContain("tool_call_delta");
		expect(events).toContain("tool_call_end");
	});

	it("converts toolResult messages into a user-role tool_result block", async () => {
		const body = sse([
			{
				event: "message_start",
				data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } },
			},
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy;

		const ctx: Context = {
			messages: [
				{ role: "user", content: "do it" },
				{
					role: "assistant",
					content: [{ type: "tool_call", id: "toolu_1", name: "read", arguments: '{"path":"/tmp/x"}' }],
				},
				{
					role: "toolResult",
					toolCallId: "toolu_1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
				},
			],
		};
		await createAnthropicStream()(MODEL, ctx).result();

		const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
		// Last message is the synthesized "user" turn carrying the tool_result.
		const lastMsg = sentBody.messages[sentBody.messages.length - 1];
		expect(lastMsg.role).toBe("user");
		expect(lastMsg.content[0].type).toBe("tool_result");
		expect(lastMsg.content[0].tool_use_id).toBe("toolu_1");
	});

	it("emits cache_control on system, tools, and last user block when caching enabled", async () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy;

		const ctx: Context = {
			systemPrompt: "you are helpful",
			messages: [{ role: "user", content: "hi" }],
			tools: [{ name: "noop", description: "", parameters: { type: "object" } as never }],
		};
		await createAnthropicStream()(MODEL, ctx).result();

		const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
		expect(sentBody.system).toEqual([
			{ type: "text", text: "you are helpful", cache_control: { type: "ephemeral" } },
		]);
		expect(sentBody.tools[0].cache_control).toEqual({ type: "ephemeral" });
		const lastUser = sentBody.messages[sentBody.messages.length - 1];
		expect(lastUser.content[lastUser.content.length - 1].cache_control).toEqual({ type: "ephemeral" });
	});

	it("omits cache_control when caching is disabled", async () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy;

		await createAnthropicStream({ enableCaching: false })(MODEL, {
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi" }],
		}).result();

		const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
		expect(sentBody.system).toBe("sys");
		const lastUser = sentBody.messages[0];
		expect(lastUser.content[0].cache_control).toBeUndefined();
	});

	it("propagates thinking budget when caller maxTokens already exceeds it", async () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy;

		await createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "hi" }] }, { thinkingLevel: "high", maxTokens: 32000 }).result();

		const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
		expect(sentBody.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
		// Caller cap already > budget: pass through unchanged.
		expect(sentBody.max_tokens).toBe(32000);
	});

	it("maps tool_use stop_reason to toolUse", async () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 0 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

		const msg = await createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] }).result();
		expect(msg.stopReason).toBe("toolUse");
	});

	it("emits an error event on non-OK HTTP response", async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response("Bad Request", { status: 400 }),
		);
		globalThis.fetch = fetchSpy;

		const stream = createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] });
		await expect(stream.result()).rejects.toThrow(/anthropic API 400/);
	});

	it("propagates abort signal cleanly", async () => {
		// Hang the response until aborted.
		globalThis.fetch = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
			return new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					const err = new Error("aborted");
					err.name = "AbortError";
					reject(err);
				});
			});
		});

		const ctrl = new AbortController();
		const stream = createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] }, { signal: ctrl.signal });
		// Pre-attach a catcher to result() — when the stream ends via
		// abort there's no terminal event, so result() rejects with
		// "Stream ended without result". That's expected behavior; the
		// test just wants to confirm we don't surface a stream `error`
		// event for the abort.
		const resultPromise = stream.result().catch(() => undefined);
		ctrl.abort();
		const events: string[] = [];
		for await (const e of stream) {
			events.push(e.type);
		}
		await resultPromise;
		expect(events).not.toContain("error");
	});

	it("returns an error when ANTHROPIC_API_KEY is unset and no apiKey override", async () => {
		delete process.env.ANTHROPIC_API_KEY;
		const stream = createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] });
		await expect(stream.result()).rejects.toThrow(/ANTHROPIC_API_KEY/);
	});

	it("converts assistant tool_call blocks back to tool_use input", async () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy;

		await createAnthropicStream()(MODEL, {
			messages: [
				{ role: "user", content: "do it" },
				{
					role: "assistant",
					content: [{ type: "tool_call", id: "toolu_1", name: "read", arguments: '{"path":"/tmp/x"}' }],
				},
				{
					role: "toolResult",
					toolCallId: "toolu_1",
					toolName: "read",
					content: [{ type: "text", text: "data" }],
				},
			],
		}).result();

		const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
		const assistantMsg = sentBody.messages.find((m: { role: string }) => m.role === "assistant");
		expect(assistantMsg.content[0]).toEqual({
			type: "tool_use",
			id: "toolu_1",
			name: "read",
			input: { path: "/tmp/x" },
		});
	});

	it("falls back to {} input when assistant tool_call arguments are malformed JSON", async () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy;

		await createAnthropicStream()(MODEL, {
			messages: [
				{ role: "user", content: "x" },
				{
					role: "assistant",
					content: [{ type: "tool_call", id: "t1", name: "x", arguments: "not-valid-json" }],
				},
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "x",
					content: [{ type: "text", text: "" }],
				},
			],
		}).result();

		const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
		const assistantMsg = sentBody.messages.find((m: { role: string }) => m.role === "assistant");
		expect(assistantMsg.content[0].input).toEqual({});
	});

	it("Tier-3 pass-4 regression: custom baseUrl auto-tags messages as anthropic-compatible (not anthropic)", async () => {
		// Pre-pass-4 bug: createAnthropicStream stamped every emitted
		// AssistantMessage with provider: "anthropic" regardless of
		// baseUrl. A user pointing at a proxy got messages mislabeled
		// as the real provider, and pass-3's signed-thinking trust gate
		// would forward the proxy's foreign signature back to Anthropic
		// on replay — reopening the exact bug pass-3 closed.
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

		const msg = await createAnthropicStream({
			baseUrl: "https://custom-proxy.example.com/v1/messages",
		})(MODEL, { messages: [{ role: "user", content: "x" }] }).result();

		expect(msg.provider).toBe("anthropic-compatible");
	});

	it("Tier-3 pass-4 regression: default baseUrl tags as anthropic", async () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

		const msg = await createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] }).result();
		expect(msg.provider).toBe("anthropic");
	});

	it("Tier-3 pass-4 regression: explicit providerName overrides the auto-default", async () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

		const msg = await createAnthropicStream({
			baseUrl: "https://my-proxy.example.com/v1/messages",
			providerName: "anthropic-bedrock",
		})(MODEL, { messages: [{ role: "user", content: "x" }] }).result();

		expect(msg.provider).toBe("anthropic-bedrock");
	});

	it("Tier-3 pass-4 regression: anthropic-compatible signed thinking is dropped when replayed through real Anthropic endpoint", async () => {
		// End-to-end coverage of the bug class: a proxy stream emits
		// message tagged "anthropic-compatible". Replaying through the
		// real default endpoint must NOT forward the signature.
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy;

		await createAnthropicStream()(MODEL, {
			messages: [
				{ role: "user", content: "x" },
				{
					role: "assistant",
					provider: "anthropic-compatible", // came from a proxy
					content: [
						{ type: "thinking", text: "proxy thought", signature: "proxy-sig" },
						{ type: "text", text: "answered" },
					],
				},
				{ role: "user", content: "again" },
			],
		}).result();

		const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
		const assistantMsg = sentBody.messages.find((m: { role: string }) => m.role === "assistant");
		expect(assistantMsg.content).toEqual([{ type: "text", text: "answered" }]);
	});

	it("Tier-3 pass-3 regression: thinking with foreign provider provenance is dropped on replay", async () => {
		// Pre-pass-3 bug: convertMessages replayed any signed thinking
		// block as long as `signature` was present, even if the source
		// assistant message came from a different provider. Anthropic
		// would reject the foreign signature with a 400.
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy;

		await createAnthropicStream()(MODEL, {
			messages: [
				{ role: "user", content: "x" },
				{
					role: "assistant",
					provider: "openrouter", // foreign provider
					content: [
						{ type: "thinking", text: "openrouter thought", signature: "openrouter-sig-bytes" },
						{ type: "text", text: "answered" },
					],
				},
				{ role: "user", content: "again" },
			],
		}).result();

		const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
		const assistantMsg = sentBody.messages.find((m: { role: string }) => m.role === "assistant");
		// Foreign signed thinking must be dropped — only text remains.
		expect(assistantMsg.content).toEqual([{ type: "text", text: "answered" }]);
	});

	it("Tier-3 pass-3 regression: thinking with no provider tag is dropped on replay", async () => {
		// Defensive: undefined provider means we don't know — don't trust.
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy;

		await createAnthropicStream()(MODEL, {
			messages: [
				{ role: "user", content: "x" },
				{
					role: "assistant",
					// no provider tag
					content: [
						{ type: "thinking", text: "untagged", signature: "sig-bytes" },
						{ type: "text", text: "answered" },
					],
				},
				{ role: "user", content: "again" },
			],
		}).result();

		const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
		const assistantMsg = sentBody.messages.find((m: { role: string }) => m.role === "assistant");
		expect(assistantMsg.content).toEqual([{ type: "text", text: "answered" }]);
	});

	it("Tier-3 pass-3 regression: foreign tool_use IDs are normalized and tool_result IDs remapped", async () => {
		// Pre-pass-3 bug: tool_use.id and tool_result.tool_use_id were
		// replayed verbatim. OpenAI Responses can emit IDs longer than
		// 64 chars and containing `|`, which Anthropic rejects. The pair
		// must be normalized AND remapped so they still match.
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy;

		const foreignId = "fc_resp_01abcdef|stream_chunk_xyz_12345_long_id_pretending_to_exceed_64_chars";

		await createAnthropicStream()(MODEL, {
			messages: [
				{ role: "user", content: "do it" },
				{
					role: "assistant",
					provider: "openai",
					content: [{ type: "tool_call", id: foreignId, name: "read", arguments: '{"path":"/tmp/x"}' }],
				},
				{
					role: "toolResult",
					toolCallId: foreignId,
					toolName: "read",
					content: [{ type: "text", text: "data" }],
				},
			],
		}).result();

		const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
		const assistantMsg = sentBody.messages.find((m: { role: string }) => m.role === "assistant");
		const userMsg = sentBody.messages.find((m: { role: string; content: Array<{ type: string }> }) => m.role === "user" && m.content.some((c) => c.type === "tool_result"));

		const usedId = assistantMsg.content[0].id;
		expect(usedId).not.toBe(foreignId);
		expect(usedId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
		// The matching tool_result MUST use the same normalized id.
		expect(userMsg.content[0].tool_use_id).toBe(usedId);
	});

	it("Tier-3 pass-3 regression: anthropic-safe tool IDs are passed through unchanged", async () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy;

		await createAnthropicStream()(MODEL, {
			messages: [
				{ role: "user", content: "x" },
				{
					role: "assistant",
					provider: "anthropic",
					content: [{ type: "tool_call", id: "toolu_01ABC", name: "read", arguments: '{}' }],
				},
				{
					role: "toolResult",
					toolCallId: "toolu_01ABC",
					toolName: "read",
					content: [{ type: "text", text: "" }],
				},
			],
		}).result();

		const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
		const assistantMsg = sentBody.messages.find((m: { role: string }) => m.role === "assistant");
		expect(assistantMsg.content[0].id).toBe("toolu_01ABC");
	});

	it("Tier-3 pass-2 regression: thinking signature round-trips on replay", async () => {
		// Pre-pass-2 bug: convertMessages hardcoded `signature: ""` for
		// any prior thinking block. Anthropic requires the original
		// signature to be replayed verbatim — sending an empty one
		// breaks the conversation on the next request.
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy;

		await createAnthropicStream()(MODEL, {
			messages: [
				{ role: "user", content: "think" },
				{
					role: "assistant",
					provider: "anthropic",
					content: [
						{ type: "thinking", text: "the model thought", signature: "real-sig-bytes" },
						{ type: "text", text: "answered" },
					],
				},
				{ role: "user", content: "again" },
			],
		}).result();

		const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
		const assistantMsg = sentBody.messages.find((m: { role: string }) => m.role === "assistant");
		expect(assistantMsg.content[0]).toEqual({
			type: "thinking",
			thinking: "the model thought",
			signature: "real-sig-bytes",
		});
	});

	it("Tier-3 pass-2 regression: thinking blocks WITHOUT signatures are dropped from replay (not sent with empty signature)", async () => {
		// Defensive: a message produced by another provider, or by us
		// before signature persistence existed, won't have a signature.
		// Sending `signature: ""` makes the API 400 — drop the block
		// instead so the conversation continues.
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy;

		await createAnthropicStream()(MODEL, {
			messages: [
				{ role: "user", content: "x" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", text: "no signature here" },
						{ type: "text", text: "answered" },
					],
				},
				{ role: "user", content: "again" },
			],
		}).result();

		const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
		const assistantMsg = sentBody.messages.find((m: { role: string }) => m.role === "assistant");
		// Only the text block should remain; thinking is dropped.
		expect(assistantMsg.content).toEqual([{ type: "text", text: "answered" }]);
	});

	it("Tier-3 pass-2 regression: non-object tool_call arguments fall back to {} on replay", async () => {
		// Anthropic requires `tool_use.input` to be a JSON OBJECT.
		// Pre-pass-2 we passed through any parseable JSON, so a model
		// emitting `[]`, `null`, or a scalar would 400 the next request
		// when the assistant message + tool_result was replayed.
		const events = [
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		];
		// Fresh Response per call — ReadableStream can only be consumed once.
		const fetchSpy = vi.fn().mockImplementation(async () => mockResponse(sse(events)));
		globalThis.fetch = fetchSpy;

		const cases = ["[]", "null", "123", '"a string"', "true"];
		for (const args of cases) {
			fetchSpy.mockClear();
			await createAnthropicStream()(MODEL, {
				messages: [
					{ role: "user", content: "x" },
					{
						role: "assistant",
						content: [{ type: "tool_call", id: "t1", name: "x", arguments: args }],
					},
					{
						role: "toolResult",
						toolCallId: "t1",
						toolName: "x",
						content: [{ type: "text", text: "" }],
					},
				],
			}).result();

			const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
			const assistantMsg = sentBody.messages.find((m: { role: string }) => m.role === "assistant");
			expect(assistantMsg.content[0].input).toEqual({});
		}
	});

	it("Tier-3 pass-1 regression: tool_use input from content_block_start when no input_json_delta arrives", async () => {
		// Some Anthropic-compatible proxies populate input eagerly in
		// the start event and never send partial_json deltas. The
		// parser must not silently drop the args.
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_x", name: "read", input: { path: "/tmp/seeded" } },
				},
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

		const msg = await createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] }).result();
		expect(msg.content).toEqual([
			{ type: "tool_call", id: "toolu_x", name: "read", arguments: '{"path":"/tmp/seeded"}' },
		]);
	});

	it("Tier-3 pass-1 regression: streaming partial_json overrides seededInput when both present", async () => {
		// Defensive: if a server sends BOTH a seeded input AND
		// partial_json deltas, we should use the streamed deltas (which
		// is what the spec actually does).
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_y", name: "read", input: { path: "/tmp/SEEDED" } },
				},
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"/tmp/streamed"}' } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

		const msg = await createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] }).result();
		expect(msg.content).toEqual([
			{ type: "tool_call", id: "toolu_y", name: "read", arguments: '{"path":"/tmp/streamed"}' },
		]);
	});

	it("Tier-3 pass-1 regression: parses CRLF-framed SSE the same as LF-framed", async () => {
		// Build the same event stream but with CRLF line endings (the
		// SSE spec allows either; some intermediaries normalize to CRLF).
		const events = [
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello CRLF" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		];
		const crlfBody = events
			.map((e) => `event: ${e.event}\r\ndata: ${JSON.stringify(e.data)}\r\n`)
			.join("\r\n") + "\r\n";
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(crlfBody));

		const msg = await createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] }).result();
		expect(msg.content).toEqual([{ type: "text", text: "Hello CRLF" }]);
		expect(msg.stopReason).toBe("stop");
		expect(msg.usage?.outputTokens).toBe(3);
	});

	it("Tier-3 pass-1 regression: drains the final buffered event when EOF arrives without a trailing blank line", async () => {
		// Build a body that DOES NOT end with the canonical \n\n
		// terminator on the final event. The parser must drain the
		// trailing buffer or it would silently drop message_stop /
		// message_delta and emit empty content.
		const events = [
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "tail-buffered" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		];
		// Use single \n separators (instead of \n\n) so the LAST event
		// gets stuck in the trailing buffer when EOF hits.
		const drainBody = events
			.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}`)
			.join("\n\n");
		// Note: NO trailing "\n\n" — final event has no blank line
		// after it, so it must come from the EOF drain path.
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(drainBody));

		const msg = await createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] }).result();
		expect(msg.content).toEqual([{ type: "text", text: "tail-buffered" }]);
		expect(msg.stopReason).toBe("stop");
		expect(msg.usage?.outputTokens).toBe(2);
	});

	it("captures cache_read_input_tokens and cache_creation_input_tokens in usage", async () => {
		const body = sse([
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: {
						id: "m",
						role: "assistant",
						model: "claude-test",
						usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 },
					},
				},
			},
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

		const msg = await createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] }).result();
		expect(msg.usage?.cacheReadTokens).toBe(50);
		expect(msg.usage?.cacheWriteTokens).toBe(25);
	});

	// Pass-5 fail-closed regressions. A 200 OK with no parseable
	// Anthropic events used to fall through to a "blank assistant
	// turn" — silently corrupting history and confusing retry logic.
	// All three flavors (empty body, HTML, malformed JSON) must
	// surface as errors instead.
	it("rejects 200 OK with empty body (fail closed, not blank turn)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(""));
		const stream = createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] });
		await expect(stream.result()).rejects.toThrow(/no events|no message_start/i);
	});

	it("rejects 200 OK with non-SSE HTML body", async () => {
		const html = "<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>";
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(html));
		const stream = createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] });
		await expect(stream.result()).rejects.toThrow(/no events|no message_start/i);
	});

	it("rejects 200 OK with all-malformed JSON data lines", async () => {
		// Real SSE framing (event:/data: lines, blank-line separated)
		// but every data payload is broken JSON, so every JSON.parse
		// throws and is silently skipped — leaving zero processed
		// events.
		const body =
			"event: message_start\ndata: {not valid json\n\n" +
			"event: content_block_delta\ndata: {also broken,\n\n" +
			"event: message_stop\ndata: {still not json\n\n";
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));
		const stream = createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] });
		await expect(stream.result()).rejects.toThrow(/no events|no message_start/i);
	});

	// Pass-6 cap-honor regressions. Silent max_tokens inflation when
	// thinking is enabled would let a caller's explicit cost cap get
	// bypassed (e.g. `maxTokens: 1000` becoming 20480). We now fail
	// fast on caller-set caps and only bump silently when the value
	// came from the model/default fallback (no caller intent to honor).
	it("rejects explicit maxTokens lower than thinking budget", async () => {
		// fetch should never even be called.
		const fetchSpy = vi.fn();
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const stream = createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] }, {
			maxTokens: 1000,
			thinkingLevel: "high", // budget 16384
		});
		await expect(stream.result()).rejects.toThrow(/maxTokens.*must exceed thinking budget|exceed.*budget/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("still inflates default maxTokens when no explicit cap was set", async () => {
		// Caller did not pass maxTokens; model.maxOutputTokens is 8192,
		// thinkingLevel high requires 16384. With no explicit cap to
		// honor, the provider may safely bump to budget + 4096.
		const body = sse([
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } },
				},
			},
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		await createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] }, {
			thinkingLevel: "high",
		}).result();

		expect(fetchSpy).toHaveBeenCalledOnce();
		const sentBody = JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body);
		expect(sentBody.max_tokens).toBe(16384 + 4096);
		expect(sentBody.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
	});

	it("rejects stream that opens with message_start but never terminates", async () => {
		// message_start arrives, content streams, but the upstream
		// connection drops before any message_stop or message_delta
		// with stop_reason. We must not silently treat this as a
		// successful turn.
		const body = sse([
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } },
				},
			},
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			// No message_delta with stop_reason. No message_stop.
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));
		const stream = createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] });
		await expect(stream.result()).rejects.toThrow(/terminal event|stop_reason/i);
	});

	// Pass-7 regressions. Two HIGHs: redacted_thinking blocks were
	// silently dropped (returned empty assistant turns), and unknown
	// stop reasons (refusal / sensitive) were downgraded to "stop"
	// instead of surfacing as failures.

	it("preserves redacted_thinking blocks and replays them on the next turn", async () => {
		const body = sse([
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } },
				},
			},
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "redacted_thinking", data: "ENCRYPTED_PAYLOAD_xyz" },
				},
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

		const msg = await createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] }).result();
		expect(msg.content).toEqual([
			{ type: "thinking", text: "", redactedData: "ENCRYPTED_PAYLOAD_xyz" },
			{ type: "text", text: "answer" },
		]);
		expect(msg.provider).toBe("anthropic");

		// Round-trip: send the same assistant message back as history
		// and verify the provider replays redacted_thinking on the wire.
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m2", role: "assistant", model: "claude-test", usage: { input_tokens: 5, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		])));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		await createAnthropicStream()(MODEL, {
			messages: [
				{ role: "user", content: "first" },
				msg,
				{ role: "user", content: "second" },
			],
		}).result();
		const sent = JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body);
		const assistantTurn = sent.messages.find((m: { role: string }) => m.role === "assistant");
		expect(assistantTurn.content).toContainEqual({
			type: "redacted_thinking",
			data: "ENCRYPTED_PAYLOAD_xyz",
		});
	});

	it("drops redacted_thinking on replay when source provider is foreign", async () => {
		// A redacted_thinking payload from a non-Anthropic provider
		// (or one with no provenance tag) is opaque-to-us and would
		// 400 if forwarded to api.anthropic.com — same trust gate as
		// signed thinking.
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		])));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		await createAnthropicStream()(MODEL, {
			messages: [
				{ role: "user", content: "x" },
				{
					role: "assistant",
					provider: "openai",
					content: [
						{ type: "thinking", text: "", redactedData: "FOREIGN_BYTES" },
						{ type: "text", text: "hi" },
					],
				},
				{ role: "user", content: "y" },
			],
		}).result();

		const sent = JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body);
		const assistantTurn = sent.messages.find((m: { role: string }) => m.role === "assistant");
		// Only the text block survives — redacted_thinking from
		// foreign provider must be dropped.
		expect(assistantTurn.content).toEqual([{ type: "text", text: "hi" }]);
	});

	it("surfaces refusal stop_reason as a stream error, not a blank turn", async () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 0 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

		const stream = createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] });
		await expect(stream.result()).rejects.toThrow(/refusal|unrecoverable/i);
	});

	it("surfaces unknown stop_reason as an error rather than silent stop", async () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "some_future_failure_mode" }, usage: { output_tokens: 0 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

		const stream = createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] });
		await expect(stream.result()).rejects.toThrow(/some_future_failure_mode|unrecoverable/i);
	});

	// Pass-8 regressions. pause_turn previously mapped to plain
	// "stop", which made the agent loop terminate with a partial
	// answer instead of recognizing the model wanted to continue.
	// Until auto-continue is wired in, surface it as an error so the
	// caller sees the truncation rather than a fake successful end.
	it("surfaces pause_turn as an error with continuation hint", async () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

		const stream = createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] });
		await expect(stream.result()).rejects.toThrow(/paused|continuation/i);
	});

	// Anthropic rejects `temperature` when extended thinking is
	// enabled. Drop it transparently rather than letting the request
	// 400 deterministically.
	it("drops temperature when thinking is enabled", async () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		await createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] }, {
			temperature: 0.7,
			thinkingLevel: "low",
		}).result();

		const sent = JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body);
		expect(sent.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
		expect(sent).not.toHaveProperty("temperature");
	});

	it("forwards temperature when thinking is disabled", async () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", role: "assistant", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const fetchSpy = vi.fn().mockResolvedValue(mockResponse(body));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		await createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "x" }] }, {
			temperature: 0.42,
		}).result();

		const sent = JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body);
		expect(sent.temperature).toBe(0.42);
		expect(sent).not.toHaveProperty("thinking");
	});
});
