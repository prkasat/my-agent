import { describe, it, expect } from "vitest";
import { EventStream } from "@my-agent/ai";
import type { AssistantMessage, AssistantMessageEvent } from "@my-agent/ai";
import {
  estimateTokens,
  estimateContextTokens,
  findCutPoint,
  extractFileOperations,
  generateCompactionSummary,
  shouldCompact,
} from "../../src/session/compaction.js";
import type { AgentMessage } from "../../src/agent/types.js";

describe("estimateTokens", () => {
  it("should estimate user message tokens", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "Hello world", // 11 chars
      timestamp: Date.now(),
    };

    const tokens = estimateTokens(msg);
    expect(tokens).toBeCloseTo(11 / 4, 1);
  });

  it("should estimate user message with content array", () => {
    const msg: AgentMessage = {
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: "World" },
      ],
      timestamp: Date.now(),
    };

    const tokens = estimateTokens(msg);
    expect(tokens).toBeCloseTo(10 / 4, 1);
  });

  it("should estimate images as ~1200 tokens", () => {
    const msg: AgentMessage = {
      role: "user",
      content: [
        { type: "text", text: "Look at this" },
        { type: "image", source: { type: "base64", data: "...", mediaType: "image/png" } },
      ],
      timestamp: Date.now(),
    };

    const tokens = estimateTokens(msg);
    expect(tokens).toBeGreaterThan(1200);
  });

  it("should estimate assistant message tokens", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello there!" },
        { type: "tool_call", id: "tc1", name: "read", arguments: '{"path":"/file.txt"}' },
      ],
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const tokens = estimateTokens(msg);
    // text: 12 chars + tool: "read" (4) + args (20) = ~36 chars / 4 = ~9 tokens
    expect(tokens).toBeGreaterThan(5);
  });

  it("should estimate tool result tokens", () => {
    const msg: AgentMessage = {
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "read",
      content: [{ type: "text", text: "file content here" }],
      timestamp: Date.now(),
    };

    const tokens = estimateTokens(msg);
    expect(tokens).toBeCloseTo(17 / 4, 1);
  });

  it("should handle custom messages", () => {
    const msg: AgentMessage = {
      role: "custom",
      type: "test",
      content: "Custom content here",
      timestamp: Date.now(),
    };

    const tokens = estimateTokens(msg);
    expect(tokens).toBeCloseTo(19 / 4, 1);
  });
});

describe("estimateContextTokens", () => {
  it("should sum tokens for all messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello", timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi!" }],
        stopReason: "stop",
        timestamp: Date.now(),
      },
      { role: "user", content: "World", timestamp: Date.now() },
    ];

    const tokens = estimateContextTokens(messages);
    // "Hello" (5) + "Hi!" (3) + "World" (5) = 13 chars / 4 = ~3.25 tokens
    expect(tokens).toBeGreaterThan(2);
    expect(tokens).toBeLessThan(5);
  });
});

describe("findCutPoint", () => {
  it("should find cut point based on token budget", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "A".repeat(100), timestamp: Date.now() }, // ~25 tokens
      { role: "assistant", content: [{ type: "text", text: "B".repeat(100) }], stopReason: "stop", timestamp: Date.now() }, // ~25 tokens
      { role: "user", content: "C".repeat(100), timestamp: Date.now() }, // ~25 tokens
      { role: "assistant", content: [{ type: "text", text: "D".repeat(100) }], stopReason: "stop", timestamp: Date.now() }, // ~25 tokens
    ];

    // Keep ~50 tokens (2 messages worth)
    const cutPoint = findCutPoint(messages, 50);
    expect(cutPoint).toBe(2); // Cut at index 2, keep messages 2 and 3
  });

  it("should not cut at toolResult", () => {
    // Construct messages so that the token budget lands exactly on the toolResult
    //
    // Token estimates (chars/4):
    // msg 0: user "A" * 400 = 100 tokens
    // msg 1: toolResult with "X" * 400 = 100 tokens
    // msg 2: toolResult with "Y" * 40 = 10 tokens
    // msg 3: user "Z" * 40 = 10 tokens
    //
    // Walking back with budget 15:
    // - i=3: tokens = 10, continue
    // - i=2: tokens = 10 + 10 = 20 >= 15, cutIndex = 2
    // - msg[2] is toolResult, skip to 3
    // - msg[3] is user, stop
    // Final cutIndex = 3
    const messages: AgentMessage[] = [
      { role: "user", content: "A".repeat(400), timestamp: Date.now() },
      { role: "toolResult", toolCallId: "tc1", toolName: "test", content: [{ type: "text", text: "X".repeat(400) }], timestamp: Date.now() },
      { role: "toolResult", toolCallId: "tc2", toolName: "test", content: [{ type: "text", text: "Y".repeat(40) }], timestamp: Date.now() },
      { role: "user", content: "Z".repeat(40), timestamp: Date.now() },
    ];

    const cutPoint = findCutPoint(messages, 15);
    expect(cutPoint).toBe(3); // Skip past consecutive toolResults
  });

  it("should return 0 for empty messages", () => {
    const cutPoint = findCutPoint([], 1000);
    expect(cutPoint).toBe(0);
  });
});

describe("extractFileOperations", () => {
  it("should extract read operations", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "tc1", name: "read", arguments: '{"path":"/src/file.ts"}' },
        ],
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    ];

    const details = extractFileOperations(messages);
    expect(details.readFiles).toContain("/src/file.ts");
    expect(details.modifiedFiles).toHaveLength(0);
  });

  it("should extract write and edit operations", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "tc1", name: "write", arguments: '{"path":"/src/new.ts"}' },
          { type: "tool_call", id: "tc2", name: "edit", arguments: '{"path":"/src/existing.ts"}' },
        ],
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    ];

    const details = extractFileOperations(messages);
    expect(details.modifiedFiles).toContain("/src/new.ts");
    expect(details.modifiedFiles).toContain("/src/existing.ts");
  });

  it("should merge with existing details", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "tc1", name: "read", arguments: '{"path":"/new-file.ts"}' },
        ],
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    ];

    const existing = {
      readFiles: ["/old-file.ts"],
      modifiedFiles: ["/modified.ts"],
      tokensAfter: 100,
    };

    const details = extractFileOperations(messages, existing);
    expect(details.readFiles).toContain("/old-file.ts");
    expect(details.readFiles).toContain("/new-file.ts");
    expect(details.modifiedFiles).toContain("/modified.ts");
  });

  it("should handle capitalized tool names", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "tc1", name: "Read", arguments: '{"path":"/file.ts"}' },
          { type: "tool_call", id: "tc2", name: "Edit", arguments: '{"path":"/edit.ts"}' },
        ],
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    ];

    const details = extractFileOperations(messages);
    expect(details.readFiles).toContain("/file.ts");
    expect(details.modifiedFiles).toContain("/edit.ts");
  });
});

describe("shouldCompact", () => {
  it("should return true when tokens exceed limit", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "A".repeat(10000), timestamp: Date.now() }, // ~2500 tokens
    ];

    // Context window 4000, reserve 1000 = limit 3000
    // 2500 < 3000 = false
    expect(shouldCompact(messages, 4000, 1000)).toBe(false);

    // Context window 3000, reserve 1000 = limit 2000
    // 2500 > 2000 = true
    expect(shouldCompact(messages, 3000, 1000)).toBe(true);
  });

  it("should return false for empty messages", () => {
    expect(shouldCompact([], 128000, 16000)).toBe(false);
  });

  it("Tier-1: tool results in summary input are truncated past TOOL_RESULT_MAX_CHARS", () => {
    // Threat model: a single grep result returning megabytes of text
    // would otherwise blow the summarization-LLM context budget. The
    // formatMessagesForSummary path must keep tool results below
    // TOOL_RESULT_MAX_CHARS and signal that truncation happened so the
    // summarizer doesn't pretend it saw the full content.
    //
    // Verified end-to-end through the structured prompt that the
    // summarization stream sees (captured here via a tracking streamFn).
    const huge = "X".repeat(50_000);
    const trackingStreamFn: any = (_m: any, ctx: any) => {
      capturedPrompt = (ctx.messages[0] as any).content;
      const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
        (e) => e.type === "done",
        (e) => {
          if (e.type === "done") return e.message;
          throw new Error("unexpected");
        },
      );
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", message });
        stream.push({ type: "done", message });
      });
      return stream;
    };

    let capturedPrompt = "";

    return (async () => {
      const messages: AgentMessage[] = [
        { role: "user", content: "search please", timestamp: Date.now() },
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "tc1", name: "grep", arguments: '{"pattern":"x"}' },
          ],
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "grep",
          content: [{ type: "text", text: huge }],
          timestamp: Date.now(),
        },
        { role: "user", content: "thanks", timestamp: Date.now() },
      ];

      const fakeModel = {
        id: "test",
        name: "Test",
        provider: "test",
        contextWindow: 1000,
      } as any;
      await generateCompactionSummary(messages, fakeModel, trackingStreamFn, {});

      // The huge string MUST be truncated; the marker must be present.
      expect(capturedPrompt).toContain("more characters truncated]");
      // And the captured prompt must be much smaller than the raw input
      expect(capturedPrompt.length).toBeLessThan(huge.length / 5);
    })();
  });

  it("Tier-1: structured prompt uses a system message scoping the model to summarize-only", () => {
    let capturedSystemPrompt: string | undefined;
    const trackingStreamFn: any = (_m: any, ctx: any) => {
      capturedSystemPrompt = ctx.systemPrompt;
      const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
        (e) => e.type === "done",
        (e) => {
          if (e.type === "done") return e.message;
          throw new Error("unexpected");
        },
      );
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", message });
        stream.push({ type: "done", message });
      });
      return stream;
    };

    return (async () => {
      const messages: AgentMessage[] = [
        { role: "user", content: "Hi", timestamp: Date.now() },
      ];
      const fakeModel = {
        id: "test",
        name: "Test",
        provider: "test",
        contextWindow: 1000,
      } as any;
      await generateCompactionSummary(messages, fakeModel, trackingStreamFn, {});
      expect(capturedSystemPrompt).toBeDefined();
      expect(capturedSystemPrompt!.toLowerCase()).toContain("summariz");
      // Critical: must instruct NOT to continue the conversation
      expect(capturedSystemPrompt!.toLowerCase()).toContain("not continue");
    })();
  });

  it("regression: clamps reserveTokens for small context windows", () => {
    // Without the clamp, contextWindow=4K, reserveTokens=16K gives
    // limit = 4000 - 16000 = -12000. Then ANY non-empty context returns
    // true, even a single short message — and the auto-compactor would
    // immediately collapse the conversation to the last message.
    //
    // After the clamp (reserveTokens capped at half the window):
    // effectiveReserve = min(16000, 2000) = 2000
    // limit = 4000 - 2000 = 2000
    // A 4-char user message (~1 token) is well under 2000.
    const tiny: AgentMessage[] = [
      { role: "user", content: "hi", timestamp: Date.now() },
    ];
    expect(shouldCompact(tiny, 4000, 16000)).toBe(false);

    // And it correctly returns true when the context genuinely overflows
    // the (clamped) limit.
    const big: AgentMessage[] = [
      { role: "user", content: "A".repeat(10_000), timestamp: Date.now() }, // ~2500 tokens
    ];
    expect(shouldCompact(big, 4000, 16000)).toBe(true);
  });
});
