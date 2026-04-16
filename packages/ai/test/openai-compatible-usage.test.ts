/**
 * Regression tests for the openai-compatible streaming parser's usage
 * accounting. Drives the parser through `createOpenAICompatibleStream`
 * with a tiny in-memory fetch mock that emits SSE chunks.
 *
 * The two scenarios under test exist because Codex pass-4 found the
 * pass-3 usage gate was actually broken in two ways:
 *  - terminal usage chunks (with empty `choices`) were being skipped
 *    by an early `if (!delta) continue;`
 *  - `finishReason` was initialized to `"stop"`, so the gate
 *    `finishReason !== ""` was true on the very first chunk and
 *    provisional usage got through immediately.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenAICompatibleStream } from "../src/providers/openai-compatible.js";
import type { Model } from "../src/types.js";

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
  id: "test-model",
  name: "Test",
  provider: "openai",
  contextWindow: 1000,
  maxOutputTokens: 100,
  supportsTools: true,
  supportsStreaming: true,
  supportsThinking: false,
  cost: { inputPerMillion: 0, outputPerMillion: 0 },
};

describe("openai-compatible usage accounting", () => {
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
    return stream.result();
  }

  it("Codex-pass4-fix: captures usage from the spec-compliant terminal chunk (empty choices)", async () => {
    // Real OpenAI streams with `include_usage: true` send:
    //   ...content chunks with delta...
    //   { choices: [{ delta: {}, finish_reason: "stop" }] }   <- final delta + finish
    //   { choices: [], usage: { prompt_tokens, completion_tokens } }   <- terminal usage
    //
    // The PRIOR parser bug: `if (!delta) continue;` ran BEFORE the
    // usage check, so the terminal chunk was skipped and `usage`
    // stayed at the default {0, 0}.
    const message = await runWith([
      { choices: [{ delta: { role: "assistant", content: "" } }] },
      { choices: [{ delta: { content: "hello" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 123, completion_tokens: 7 } },
    ]);
    expect(message.usage?.inputTokens).toBe(123);
    expect(message.usage?.outputTokens).toBe(7);
    expect(message.stopReason).toBe("stop");
  });

  it("Codex-pass4-fix: ignores provisional usage emitted before finish_reason", async () => {
    // Some shims emit usage on EVERY chunk including partial counts.
    // Pinning the persisted message to that early {prompt: 10,
    // completion: 0} would underestimate the prompt cost.
    const message = await runWith([
      {
        choices: [{ delta: { content: "hi" } }],
        usage: { prompt_tokens: 10, completion_tokens: 0 },
      },
      { choices: [{ delta: { content: " there" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 200, completion_tokens: 50 } },
    ]);
    expect(message.usage?.inputTokens).toBe(200);
    expect(message.usage?.outputTokens).toBe(50);
  });

  it("Codex-pass4-fix: accepts intermediate usage once finish_reason has been seen", async () => {
    // If a shim emits usage on the same chunk as finish_reason (no
    // separate terminal chunk), that usage is still final.
    const message = await runWith([
      { choices: [{ delta: { content: "ok" } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      },
    ]);
    expect(message.usage?.inputTokens).toBe(50);
    expect(message.usage?.outputTokens).toBe(5);
  });
});
