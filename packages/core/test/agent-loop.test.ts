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
});
