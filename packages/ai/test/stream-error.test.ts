import { describe, it, expect } from "vitest";
import { EventStream } from "../src/utils/event-stream.js";
import type { AssistantMessageEvent, AssistantMessage } from "../src/types.js";

describe("EventStream error handling", () => {
	it("should encode errors as events, not throw", async () => {
		const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
			(e) => e.type === "done" || e.type === "error",
			(e) => {
				if (e.type === "done") return e.message;
				throw new Error((e as { error?: string }).error || "Stream error");
			},
		);

		// Simulate a provider pushing a partial response then erroring
		stream.push({ type: "start", message: { role: "assistant", content: [] } });
		stream.push({ type: "text_delta", text: "partial response..." });
		stream.push({ type: "error", error: "Network connection lost" });

		// Consumer should see all events including the error
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(events).toHaveLength(3);
		expect(events[2].type).toBe("error");
		expect((events[2] as { type: "error"; error: string }).error).toBe("Network connection lost");

		// The result promise should reject since the stream ended with an error
		await expect(stream.result()).rejects.toThrow("Network connection lost");
	});

	it("should handle error after tool call start", async () => {
		const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
			(e) => e.type === "done" || e.type === "error",
			(e) => {
				if (e.type === "done") return e.message;
				throw new Error((e as { error?: string }).error || "Stream error");
			},
		);

		stream.push({ type: "start", message: { role: "assistant", content: [] } });
		stream.push({ type: "tool_call_start", id: "tc_1", name: "read_file" });
		stream.push({ type: "tool_call_delta", id: "tc_1", arguments: '{"path":' });
		stream.push({ type: "error", error: "Connection reset" });

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(events).toHaveLength(4);
		await expect(stream.result()).rejects.toThrow("Connection reset");
	});
});
