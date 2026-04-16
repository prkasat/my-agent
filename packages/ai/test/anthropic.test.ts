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
		expect(msg.content[0]).toEqual({ type: "thinking", text: "let me think about it" });
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

	it("propagates thinking budget and bumps max_tokens above it", async () => {
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

		await createAnthropicStream()(MODEL, { messages: [{ role: "user", content: "hi" }] }, { thinkingLevel: "high", maxTokens: 1000 }).result();

		const sentBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
		expect(sentBody.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
		// 1000 ≤ 16384, must be bumped.
		expect(sentBody.max_tokens).toBeGreaterThan(16384);
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
});
