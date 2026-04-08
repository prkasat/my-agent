import { describe, it, expect } from "vitest";
import { EventStream } from "../src/utils/event-stream.js";

describe("EventStream", () => {
	it("should yield pushed events and resolve result", async () => {
		const stream = new EventStream<
			{ type: "data"; value: number } | { type: "done"; total: number },
			number
		>(
			(e) => e.type === "done",
			(e) => (e as { type: "done"; total: number }).total,
		);

		// Push events synchronously before consuming
		stream.push({ type: "data", value: 1 });
		stream.push({ type: "data", value: 2 });
		stream.push({ type: "done", total: 3 });

		// Collect events
		const events = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(events).toHaveLength(3);
		expect(await stream.result()).toBe(3);
	});

	it("should handle async push/consume pattern", async () => {
		const stream = new EventStream<
			{ type: "chunk"; text: string } | { type: "done"; text: string },
			string
		>(
			(e) => e.type === "done",
			(e) => (e as { type: "done"; text: string }).text,
		);

		// Simulate async producer (like an LLM streaming response)
		setTimeout(() => {
			stream.push({ type: "chunk", text: "hello " });
			stream.push({ type: "chunk", text: "world" });
			stream.push({ type: "done", text: "hello world" });
		}, 10);

		const chunks: string[] = [];
		for await (const event of stream) {
			if (event.type === "chunk") chunks.push(event.text);
		}

		expect(chunks).toEqual(["hello ", "world"]);
		expect(await stream.result()).toBe("hello world");
	});

	it("should handle end() with explicit result", async () => {
		const stream = new EventStream<{ type: "data" } | { type: "done" }, string>(
			(e) => e.type === "done",
			() => "ok",
		);

		stream.push({ type: "data" });
		stream.end("forced");

		expect(await stream.result()).toBe("forced");
	});

	it("should reject result when end() called without result", async () => {
		const stream = new EventStream<{ type: "data" } | { type: "done" }, string>(
			(e) => e.type === "done",
			() => "ok",
		);

		stream.push({ type: "data" });
		stream.end();

		await expect(stream.result()).rejects.toThrow("Stream ended without result");
	});

	it("should ignore pushes after done", async () => {
		const stream = new EventStream<
			{ type: "data"; value: number } | { type: "done"; total: number },
			number
		>(
			(e) => e.type === "done",
			(e) => (e as { type: "done"; total: number }).total,
		);

		stream.push({ type: "data", value: 1 });
		stream.push({ type: "done", total: 1 });
		stream.push({ type: "data", value: 2 }); // should be ignored

		const events = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(events).toHaveLength(2); // data + done, not the post-done push
	});
});
