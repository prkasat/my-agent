import { describe, expect, it, vi } from "vitest";
import { createOpenAICodexStream } from "../src/providers/openai-codex.js";
import type { Context, Model } from "../src/types.js";

const model: Model = {
  id: "gpt-5.1-codex",
  name: "GPT-5.1 Codex",
  provider: "openai-codex",
  contextWindow: 200_000,
  maxOutputTokens: 16_384,
  supportsTools: true,
  supportsStreaming: true,
  supportsThinking: true,
  cost: { inputPerMillion: 0, outputPerMillion: 0 },
};

const context: Context = {
  systemPrompt: "You are helpful.",
  messages: [{ role: "user", content: "Hello" }],
  tools: [
    {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } } as never,
    },
  ],
};

function makeToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

function sse(events: Record<string, unknown>[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

describe("openai-codex provider", () => {
  it("streams text output", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        sse([
          { type: "response.output_item.added", item: { type: "message" } },
          { type: "response.output_text.delta", delta: "Hello" },
          { type: "response.output_text.delta", delta: " world" },
          {
            type: "response.output_item.done",
            item: {
              type: "message",
              content: [{ type: "output_text", text: "Hello world" }],
            },
          },
          {
            type: "response.completed",
            response: {
              status: "completed",
              usage: { input_tokens: 10, output_tokens: 3 },
            },
          },
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    ) as typeof fetch;

    const stream = createOpenAICodexStream()(model, context, { apiKey: makeToken("acct_123") });
    const message = await stream.result();

    expect(message.provider).toBe("openai-codex");
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(message.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
  });

  it("streams tool calls and maps stop reason to toolUse", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        sse([
          {
            type: "response.output_item.added",
            item: { type: "function_call", call_id: "call_1", name: "read" },
          },
          { type: "response.function_call_arguments.delta", delta: '{"path":"' },
          { type: "response.function_call_arguments.delta", delta: 'foo.txt"}' },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call_1",
              name: "read",
              arguments: '{"path":"foo.txt"}',
            },
          },
          {
            type: "response.completed",
            response: {
              status: "completed",
              usage: { input_tokens: 20, output_tokens: 5 },
            },
          },
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    ) as typeof fetch;

    const stream = createOpenAICodexStream()(model, context, { apiKey: makeToken("acct_123") });
    const message = await stream.result();

    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual([
      { type: "tool_call", id: "call_1", name: "read", arguments: '{"path":"foo.txt"}' },
    ]);
  });
});
