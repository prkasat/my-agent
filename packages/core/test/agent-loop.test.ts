import { describe, it, expect } from "vitest";
import { EventStream } from "@my-agent/ai";
import type { AssistantMessage, AssistantMessageEvent } from "@my-agent/ai";
import { Type } from "@sinclair/typebox";
import { agentLoop } from "../src/agent/agent-loop.js";
import { defaultConvertToLlm } from "../src/agent/convert.js";
import type { AgentEvent } from "../src/agent/types.js";

/**
 * Create a fake LLM that returns predetermined responses.
 * Deterministic testing without API calls.
 */
function createFauxLLM(responses: AssistantMessage[]) {
	let callIndex = 0;

	return function fauxStream() {
		const response = responses[callIndex++];
		if (!response) throw new Error("Faux LLM: no more responses");

		const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
			(e) => e.type === "done",
			(e) => {
				if (e.type === "done") return e.message;
				throw new Error("unexpected");
			},
		);

		queueMicrotask(() => {
			stream.push({ type: "start", message: { role: "assistant", content: [] } });
			for (const block of response.content) {
				if (block.type === "text") {
					stream.push({ type: "text_delta", text: block.text });
				}
			}
			stream.push({ type: "done", message: response });
		});

		return stream;
	};
}

describe("Agent Loop", () => {
	it("should complete a simple text response", async () => {
		const llm = createFauxLLM([
			{
				role: "assistant",
				content: [{ type: "text", text: "Hello! How can I help?" }],
				stopReason: "stop",
				timestamp: Date.now(),
			},
		]);

		const events: AgentEvent["type"][] = [];
		const loop = agentLoop(
			[{ role: "user", content: "Hi" }],
			{
				systemPrompt: "You are helpful.",
				messages: [],
				tools: [],
				model: { id: "test", name: "Test", provider: "test" } as any,
			},
			{
				streamFn: llm,
				convertToLlm: defaultConvertToLlm,
			},
		);

		for await (const event of loop) {
			events.push(event.type);
		}

		expect(events).toContain("agent_start");
		expect(events).toContain("turn_start");
		expect(events).toContain("message_start");
		expect(events).toContain("message_end");
		expect(events).toContain("turn_end");
		expect(events).toContain("agent_end");

		const messages = await loop.result();
		expect(messages).toHaveLength(2); // user + assistant
	});

	it("should execute tool calls and loop back for final response", async () => {
		const llm = createFauxLLM([
			// First: LLM requests a tool call
			{
				role: "assistant",
				content: [
					{
						type: "tool_call",
						id: "tc1",
						name: "greet",
						arguments: JSON.stringify({ name: "World" }),
					},
				],
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			// Second: LLM responds with text after seeing tool result
			{
				role: "assistant",
				content: [{ type: "text", text: "I greeted World for you!" }],
				stopReason: "stop",
				timestamp: Date.now(),
			},
		]);

		const greetTool = {
			name: "greet",
			description: "Greet someone",
			parameters: Type.Object({ name: Type.String() }),
			execute: async (_id: string, params: { name: string }) => ({
				content: [{ type: "text" as const, text: `Hello, ${params.name}!` }],
			}),
		};

		const toolExecutions: string[] = [];
		const loop = agentLoop(
			[{ role: "user", content: "Greet World" }],
			{
				systemPrompt: "",
				messages: [],
				tools: [greetTool],
				model: { id: "test", name: "Test", provider: "test" } as any,
			},
			{
				streamFn: llm,
				convertToLlm: defaultConvertToLlm,
			},
		);

		for await (const event of loop) {
			if (event.type === "tool_execution_start") {
				toolExecutions.push(event.toolName);
			}
		}

		expect(toolExecutions).toEqual(["greet"]);

		const messages = await loop.result();
		// user + assistant(tool_call) + toolResult + assistant(text)
		expect(messages).toHaveLength(4);
	});

	it("should handle unknown tool gracefully", async () => {
		const llm = createFauxLLM([
			{
				role: "assistant",
				content: [
					{
						type: "tool_call",
						id: "tc1",
						name: "nonexistent",
						arguments: "{}",
					},
				],
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Sorry, that tool failed." }],
				stopReason: "stop",
				timestamp: Date.now(),
			},
		]);

		const loop = agentLoop(
			[{ role: "user", content: "Do something" }],
			{
				systemPrompt: "",
				messages: [],
				tools: [],
				model: { id: "test", name: "Test", provider: "test" } as any,
			},
			{
				streamFn: llm,
				convertToLlm: defaultConvertToLlm,
			},
		);

		const errorResults: AgentEvent[] = [];
		for await (const event of loop) {
			if (event.type === "tool_execution_end" && event.isError) {
				errorResults.push(event);
			}
		}

		// Unknown tool returns error result to LLM, doesn't crash
		expect(errorResults).toHaveLength(0); // unknown tool skips execution events
		const messages = await loop.result();
		// user + assistant(tool_call) + toolResult(error) + assistant(text)
		expect(messages).toHaveLength(4);
		const toolResult = messages[2];
		expect("isError" in toolResult && toolResult.isError).toBe(true);
	});

	it("should respect maxTurns limit", async () => {
		// LLM always requests tools — would loop forever without maxTurns
		const infiniteToolLLM = createFauxLLM(
			Array.from({ length: 10 }, () => ({
				role: "assistant" as const,
				content: [
					{
						type: "tool_call" as const,
						id: `tc_${Math.random()}`,
						name: "ping",
						arguments: "{}",
					},
				],
				stopReason: "toolUse" as const,
				timestamp: Date.now(),
			})),
		);

		const pingTool = {
			name: "ping",
			description: "Ping",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text" as const, text: "pong" }],
			}),
		};

		let endReason = "";
		const loop = agentLoop(
			[{ role: "user", content: "Loop forever" }],
			{
				systemPrompt: "",
				messages: [],
				tools: [pingTool],
				model: { id: "test", name: "Test", provider: "test" } as any,
			},
			{
				streamFn: infiniteToolLLM,
				convertToLlm: defaultConvertToLlm,
				maxTurns: 3,
			},
		);

		for await (const event of loop) {
			if (event.type === "agent_end") {
				endReason = event.reason;
			}
		}

		expect(endReason).toBe("max_turns");
	});

	it("should respect a pre-aborted caller signal", async () => {
		const llm = createFauxLLM([
			{
				role: "assistant",
				content: [{ type: "text", text: "should not run" }],
				stopReason: "stop",
				timestamp: Date.now(),
			},
		]);

		const ac = new AbortController();
		ac.abort();

		let endReason = "";
		const loop = agentLoop(
			[{ role: "user", content: "Hi" }],
			{
				systemPrompt: "",
				messages: [],
				tools: [],
				model: { id: "test", name: "Test", provider: "test" } as any,
			},
			{ streamFn: llm, convertToLlm: defaultConvertToLlm },
			{ signal: ac.signal },
		);

		for await (const event of loop) {
			if (event.type === "agent_end") endReason = event.reason;
		}

		expect(endReason).toBe("aborted");
	});

	it("should pass the caller signal into transformContext", async () => {
		const llm = createFauxLLM([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
				timestamp: Date.now(),
			},
		]);

		const ac = new AbortController();
		let receivedSignal: AbortSignal | undefined;

		const loop = agentLoop(
			[{ role: "user", content: "Hi" }],
			{
				systemPrompt: "",
				messages: [],
				tools: [],
				model: { id: "test", name: "Test", provider: "test" } as any,
			},
			{
				streamFn: llm,
				convertToLlm: defaultConvertToLlm,
				transformContext: (ctx, signal) => {
					receivedSignal = signal;
					return ctx;
				},
			},
			{ signal: ac.signal },
		);

		await loop.result();
		expect(receivedSignal).toBe(ac.signal);
	});

	it("should pass a defined signal to transformContext even when caller omits one", async () => {
		const llm = createFauxLLM([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
				timestamp: Date.now(),
			},
		]);

		let receivedSignal: AbortSignal | undefined;

		const loop = agentLoop(
			[{ role: "user", content: "Hi" }],
			{
				systemPrompt: "",
				messages: [],
				tools: [],
				model: { id: "test", name: "Test", provider: "test" } as any,
			},
			{
				streamFn: llm,
				convertToLlm: defaultConvertToLlm,
				transformContext: (ctx, signal) => {
					receivedSignal = signal;
					return ctx;
				},
			},
		);

		await loop.result();
		expect(receivedSignal).toBeDefined();
		expect(receivedSignal?.aborted).toBe(false);
	});

	it("regression: aborting during tool execution does not leave a synthetic tool error in the conversation", async () => {
		const llm = createFauxLLM([
			{
				role: "assistant",
				content: [
					{
						type: "tool_call",
						id: "tc1",
						name: "slow",
						arguments: "{}",
					},
				],
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		]);

		const ac = new AbortController();
		const slowTool = {
			name: "slow",
			description: "Slow tool that respects the abort signal",
			parameters: Type.Object({}),
			execute: async (_id: string, _params: any, signal: AbortSignal) => {
				// Trigger abort mid-tool, then throw the way well-behaved
				// signal-aware tools do.
				ac.abort();
				if (signal.aborted) throw new Error("Operation aborted");
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};

		const loop = agentLoop(
			[{ role: "user", content: "Run the slow tool" }],
			{
				systemPrompt: "",
				messages: [],
				tools: [slowTool],
				model: { id: "test", name: "Test", provider: "test" } as any,
			},
			{ streamFn: llm, convertToLlm: defaultConvertToLlm },
			{ signal: ac.signal },
		);

		let endReason = "";
		for await (const event of loop) {
			if (event.type === "agent_end") endReason = event.reason;
		}

		expect(endReason).toBe("aborted");

		const messages = await loop.result();
		// Conversation should NOT contain a synthetic toolResult with isError
		// generated from the abort exception. Before the fix, a fake
		// "Error: Operation aborted" tool result was appended here.
		const fakeAbortErrors = messages.filter((m) => {
			if (!("role" in m) || m.role !== "toolResult") return false;
			if (!m.isError) return false;
			const text = m.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join(" ");
			return text.toLowerCase().includes("aborted");
		});
		expect(fakeAbortErrors).toHaveLength(0);
	});

	it("regression (pass-3): aborting mid multi-tool batch leaves a structurally complete transcript", async () => {
		// The assistant requests TWO tools in one message. The first tool
		// completes; the second triggers abort and throws. Without the
		// padding fix, context.messages would contain assistant{2 tool_calls}
		// followed by only ONE toolResult — invalid for replay/resume and
		// some providers reject the next call outright.
		const llm = createFauxLLM([
			{
				role: "assistant",
				content: [
					{ type: "tool_call", id: "tc1", name: "fast", arguments: "{}" },
					{ type: "tool_call", id: "tc2", name: "abortive", arguments: "{}" },
				],
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		]);

		const ac = new AbortController();
		const fastTool = {
			name: "fast",
			description: "Completes immediately",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "done" }] }),
		};
		const abortiveTool = {
			name: "abortive",
			description: "Aborts the run",
			parameters: Type.Object({}),
			execute: async (_id: string, _params: any, signal: AbortSignal) => {
				ac.abort();
				if (signal.aborted) throw new Error("Operation aborted");
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};

		const loop = agentLoop(
			[{ role: "user", content: "Run two tools" }],
			{
				systemPrompt: "",
				messages: [],
				tools: [fastTool, abortiveTool],
				model: { id: "test", name: "Test", provider: "test" } as any,
			},
			{ streamFn: llm, convertToLlm: defaultConvertToLlm },
			{ signal: ac.signal },
		);

		let endReason = "";
		for await (const event of loop) {
			if (event.type === "agent_end") endReason = event.reason;
		}
		expect(endReason).toBe("aborted");

		const messages = await loop.result();
		// Find the assistant message with two tool_calls
		const assistantWithTools = messages.find(
			(m) =>
				"role" in m &&
				m.role === "assistant" &&
				m.content.some((c) => c.type === "tool_call"),
		);
		expect(assistantWithTools).toBeDefined();

		const toolCalls =
			assistantWithTools && "content" in assistantWithTools
				? assistantWithTools.content.filter((c: any) => c.type === "tool_call")
				: [];
		const toolResults = messages.filter((m) => "role" in m && m.role === "toolResult");

		// Structural invariant: one toolResult per tool_call
		expect(toolResults).toHaveLength(toolCalls.length);
		expect(toolResults).toHaveLength(2);

		// Synthetic cancellation result for the unfinished call (NOT isError)
		const cancelled = toolResults.find((r: any) => r.toolCallId === "tc2");
		expect(cancelled).toBeDefined();
		expect((cancelled as any).isError).not.toBe(true);
		const cancelledText = (cancelled as any).content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join(" ");
		expect(cancelledText.toLowerCase()).toContain("cancel");
	});

	it("regression (pass-4): parallel abort does not wait for non-cooperative siblings", async () => {
		// One tool aborts immediately; a sibling SLEEPS without honoring
		// the signal. With Promise.allSettled, the run would block until
		// the sleeper finished. With the racing implementation, the run
		// must end as soon as the abort fires — well before the sleeper.
		const llm = createFauxLLM([
			{
				role: "assistant",
				content: [
					{ type: "tool_call", id: "tc1", name: "abortive", arguments: "{}" },
					{ type: "tool_call", id: "tc2", name: "non-cooperative", arguments: "{}" },
				],
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		]);

		const ac = new AbortController();
		const abortive = {
			name: "abortive",
			description: "Aborts immediately",
			parameters: Type.Object({}),
			execute: async (_id: string, _params: any, signal: AbortSignal) => {
				ac.abort();
				if (signal.aborted) throw new Error("Operation aborted");
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};

		// Sleeps for a long time WITHOUT checking the signal — simulates a
		// network call or third-party SDK that's not signal-aware. We track
		// whether it was awaited via a side effect so the test can fail
		// fast if the racing logic regresses.
		let sleeperFinished = false;
		const nonCooperative = {
			name: "non-cooperative",
			description: "Long sleep that ignores the signal",
			parameters: Type.Object({}),
			execute: async () => {
				await new Promise((r) => setTimeout(r, 5_000));
				sleeperFinished = true;
				return { content: [{ type: "text" as const, text: "late" }] };
			},
		};

		const loop = agentLoop(
			[{ role: "user", content: "Run them" }],
			{
				systemPrompt: "",
				messages: [],
				tools: [abortive, nonCooperative],
				model: { id: "test", name: "Test", provider: "test" } as any,
				toolExecution: "parallel",
			},
			{ streamFn: llm, convertToLlm: defaultConvertToLlm },
			{ signal: ac.signal },
		);

		const start = Date.now();
		let endReason = "";
		for await (const event of loop) {
			if (event.type === "agent_end") endReason = event.reason;
		}
		const elapsed = Date.now() - start;

		expect(endReason).toBe("aborted");
		// Should return WELL before the 5-second sleeper. Generous bound
		// so this isn't flaky on slow CI; tight enough to detect a hang.
		expect(elapsed).toBeLessThan(2_000);
		// Sleeper was abandoned mid-flight
		expect(sleeperFinished).toBe(false);

		const messages = await loop.result();
		// Structural padding still gives one toolResult per tool_call
		const toolResults = messages.filter((m) => "role" in m && m.role === "toolResult");
		expect(toolResults).toHaveLength(2);
	});

	it("should filter custom messages via convertToLlm", () => {
		const messages = [
			{ role: "user" as const, content: "Hello" },
			{ role: "custom" as const, type: "session_marker", content: "branch-start" },
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "Hi" }],
			},
		];

		const llmMessages = defaultConvertToLlm(messages);
		expect(llmMessages).toHaveLength(2); // custom message filtered out
		expect(llmMessages[0].role).toBe("user");
		expect(llmMessages[1].role).toBe("assistant");
	});

	it("budget enforcement survives a cross-process resume via loadFromMessages", async () => {
		// Codex budget-fix pass-3 HIGH: simulate resuming a session in
		// a fresh process. The new tracker starts at zero, but the
		// agentLoop must replay prior assistant usage from the
		// existing context.messages so the cap still blocks the next
		// tool-using turn.
		const { CostTracker } = await import("../src/agent/cost-tracker.js");
		const tracker = new CostTracker(0.001);

		let toolExecutions = 0;
		const dangerousTool = {
			name: "danger",
			description: "Should not run after a resumed over-budget session",
			parameters: Type.Object({}),
			execute: async () => {
				toolExecutions++;
				return { content: [{ type: "text" as const, text: "executed" }] };
			},
		};

		const llm = createFauxLLM([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "needs a tool" },
					{ type: "tool_call", id: "t-resume", name: "danger", arguments: "{}" },
				],
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage: { inputTokens: 10, outputTokens: 5, cost: 0.0001 },
			},
		]);

		// Prior session history with a near-budget assistant turn.
		const priorAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "earlier work" }],
			stopReason: "stop" as const,
			timestamp: Date.now() - 60_000,
			usage: { inputTokens: 100, outputTokens: 50, cost: 0.0009 },
		};

		const events: AgentEvent[] = [];
		const loop = agentLoop(
			[
				{ role: "user", content: "earlier prompt" },
				priorAssistant,
				{ role: "user", content: "follow-up" },
			],
			{
				systemPrompt: "You are helpful.",
				messages: [],
				tools: [dangerousTool],
				model: {
					id: "test",
					provider: "test",
					cost: { inputPerMillion: 0, outputPerMillion: 0 },
				} as any,
			},
			{
				streamFn: llm,
				convertToLlm: defaultConvertToLlm,
				costTracker: tracker,
			},
		);

		for await (const event of loop) {
			events.push(event);
		}

		// Resume must have replayed prior $0.0009 + new $0.0001 ≥ $0.001.
		expect(tracker.getSummary().totalCost).toBeGreaterThanOrEqual(0.001);
		// Dangerous tool must NOT have executed.
		expect(toolExecutions).toBe(0);
		expect(events.find((e) => e.type === "tool_execution_start")).toBeUndefined();
		const end = events.find((e) => e.type === "agent_end") as
			| { type: "agent_end"; reason: string; error?: string }
			| undefined;
		expect(end?.reason).toBe("error");
		expect(end?.error).toMatch(/budget/i);
	});

	it("budget check fires before tool execution on the over-budget turn", async () => {
		// Codex budget-fix pass-1 HIGH: an assistant message that BOTH
		// exceeds maxCostPerSession AND requests a tool call must not
		// execute that tool — the loop has to stop before any side
		// effect (write/edit/bash) lands. Earlier ordering ran tools
		// first and only checked the budget afterward.
		const { CostTracker } = await import("../src/agent/cost-tracker.js");
		const tracker = new CostTracker(0.001);

		let toolExecutions = 0;
		const dangerousTool = {
			name: "danger",
			description: "Should never run on an over-budget turn",
			parameters: Type.Object({}),
			execute: async () => {
				toolExecutions++;
				return { content: [{ type: "text" as const, text: "executed" }] };
			},
		};

		const llm = createFauxLLM([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "calling danger" },
					{ type: "tool_call", id: "t1", name: "danger", arguments: "{}" },
				],
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage: { inputTokens: 100, outputTokens: 50, cost: 0.999 },
			},
		]);

		const events: AgentEvent[] = [];
		const loop = agentLoop(
			[{ role: "user", content: "Hi" }],
			{
				systemPrompt: "You are helpful.",
				messages: [],
				tools: [dangerousTool],
				model: {
					id: "test",
					provider: "test",
					cost: { inputPerMillion: 0, outputPerMillion: 0 },
				} as any,
			},
			{
				streamFn: llm,
				convertToLlm: defaultConvertToLlm,
				costTracker: tracker,
			},
		);

		for await (const event of loop) {
			events.push(event);
		}

		expect(toolExecutions).toBe(0);
		const end = events.find((e) => e.type === "agent_end") as
			| { type: "agent_end"; reason: string; error?: string }
			| undefined;
		expect(end?.reason).toBe("error");
		expect(end?.error).toMatch(/budget/i);
		// No tool_execution_start was emitted either.
		expect(events.find((e) => e.type === "tool_execution_start")).toBeUndefined();

		// Codex budget-fix pass-2 HIGH: structural completeness on the
		// budget-exit path. The over-budget assistant message had a
		// tool_call, so the loop must emit a synthetic toolResult before
		// returning — otherwise the persisted session ends with a
		// dangling assistant tool_call that resume/replay rejects.
		const messages = await loop.result();
		const last = messages[messages.length - 1];
		expect(last.role).toBe("toolResult");
		expect((last as { toolCallId: string }).toolCallId).toBe("t1");
	});

	it("fails fast on resume when the replayed spend already exceeds the cap (no compaction LLM call)", async () => {
		// Codex budget-fix pass-5 HIGH: an already-over-budget session
		// resumed in a fresh process MUST bail before any LLM call
		// happens. Without this early check, streamAssistantResponse()
		// runs transformContext() first, which (for sessions with
		// auto-compact wired in) can trigger an LLM-backed compaction —
		// unmetered spend on top of an already-exceeded budget.
		const { CostTracker } = await import("../src/agent/cost-tracker.js");
		const tracker = new CostTracker(0.001);

		let llmCalls = 0;
		let transformCalls = 0;
		const llm = () => {
			llmCalls++;
			// If this ever runs we've failed: budget should have fired first.
			throw new Error("LLM should not run on already-over-budget resume");
		};

		const priorAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "earlier spend" }],
			stopReason: "stop" as const,
			timestamp: Date.now() - 60_000,
			usage: { inputTokens: 100, outputTokens: 50, cost: 0.01 }, // WAY over $0.001 cap
		};

		const events: AgentEvent[] = [];
		const loop = agentLoop(
			[{ role: "user", content: "earlier" }, priorAssistant, { role: "user", content: "resume" }],
			{
				systemPrompt: "",
				messages: [],
				tools: [],
				model: {
					id: "test",
					provider: "test",
					cost: { inputPerMillion: 0, outputPerMillion: 0 },
				} as any,
			},
			{
				streamFn: llm as any,
				convertToLlm: defaultConvertToLlm,
				costTracker: tracker,
				transformContext: (ctx) => {
					transformCalls++;
					return ctx;
				},
			},
		);

		for await (const event of loop) {
			events.push(event);
		}

		// Neither the LLM nor the transform should have been invoked.
		expect(llmCalls).toBe(0);
		expect(transformCalls).toBe(0);
		const end = events.find((e) => e.type === "agent_end") as
			| { type: "agent_end"; reason: string; error?: string }
			| undefined;
		expect(end?.reason).toBe("error");
		expect(end?.error).toMatch(/budget/i);
	});

	it("missing usage on a turn does not bypass the budget check", async () => {
		// Codex budget-fix pass-5 HIGH: if the post-turn check was guarded
		// by `if (assistantMessage.usage)`, a provider response with no
		// usage would skip BOTH recordTurn AND the budget check,
		// letting the loop continue even when accumulated spend already
		// exceeds the cap. The check must run independently.
		const { CostTracker } = await import("../src/agent/cost-tracker.js");
		const tracker = new CostTracker(0.001);
		// Pre-seed the tracker so it's already past cap without the
		// current turn contributing (simulates: prior spend replayed,
		// this turn reports no usage at all).
		tracker.recordTurn(
			{ id: "test", provider: "test", cost: { inputPerMillion: 0, outputPerMillion: 0 } } as any,
			{ inputTokens: 100, outputTokens: 50, cost: 0.002 },
			0,
		);

		let secondLlmCall = false;
		const llm = createFauxLLM([
			{
				role: "assistant",
				// Deliberately NO `usage` field on this message.
				content: [{ type: "text", text: "no usage reported" }],
				stopReason: "stop",
				timestamp: Date.now(),
			} as any,
			{
				role: "assistant",
				content: [{ type: "text", text: "should not happen" }],
				stopReason: "stop",
				timestamp: Date.now(),
			},
		]);

		const events: AgentEvent[] = [];
		const loop = agentLoop(
			[{ role: "user", content: "hi" }],
			{
				systemPrompt: "",
				messages: [],
				tools: [],
				model: {
					id: "test",
					provider: "test",
					cost: { inputPerMillion: 0, outputPerMillion: 0 },
				} as any,
			},
			{
				streamFn: llm,
				convertToLlm: defaultConvertToLlm,
				costTracker: tracker,
				getFollowUpMessages: () => {
					secondLlmCall = true;
					return [{ role: "user", content: "follow" }];
				},
			},
		);

		for await (const event of loop) {
			events.push(event);
		}

		// Follow-up loop must NOT kick in — budget stopped things first.
		expect(secondLlmCall).toBe(false);
		const end = events.find((e) => e.type === "agent_end") as
			| { type: "agent_end"; reason: string; error?: string }
			| undefined;
		expect(end?.reason).toBe("error");
		expect(end?.error).toMatch(/budget/i);
	});

	it("ends the loop with reason=error when the cost budget is exceeded", async () => {
		const { CostTracker } = await import("../src/agent/cost-tracker.js");
		const tracker = new CostTracker(0.001); // tiny budget

		// Two assistant turns wired with a tool call so the loop would
		// continue past the first turn if the budget check did not fire.
		const llm = createFauxLLM([
			{
				role: "assistant",
				content: [{ type: "text", text: "first turn" }],
				stopReason: "stop",
				timestamp: Date.now(),
				usage: { inputTokens: 100, outputTokens: 50, cost: 0.999 },
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "should not run" }],
				stopReason: "stop",
				timestamp: Date.now(),
			},
		]);

		const events: AgentEvent[] = [];
		const loop = agentLoop(
			[{ role: "user", content: "Hi" }],
			{
				systemPrompt: "You are helpful.",
				messages: [],
				tools: [],
				model: {
					id: "test",
					provider: "test",
					cost: { inputPerMillion: 0, outputPerMillion: 0 },
				} as any,
			},
			{
				streamFn: llm,
				convertToLlm: defaultConvertToLlm,
				costTracker: tracker,
				getFollowUpMessages: () => [{ role: "user", content: "again" }],
			},
		);

		for await (const event of loop) {
			events.push(event);
		}

		const end = events.find((e) => e.type === "agent_end") as
			| { type: "agent_end"; reason: string; error?: string }
			| undefined;
		expect(end?.reason).toBe("error");
		expect(end?.error).toMatch(/budget/i);
		// The "should not run" second LLM response must not have been consumed.
		expect(tracker.getSummary().turnCosts).toHaveLength(1);
	});
});
