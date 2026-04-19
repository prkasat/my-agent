import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.js";

describe("EventStream", () => {
	it("should yield pushed events and resolve result", async () => {
		const stream = new EventStream<{ type: "data"; value: number } | { type: "done"; total: number }, number>(
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
		const stream = new EventStream<{ type: "chunk"; text: string } | { type: "done"; text: string }, string>(
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
		const stream = new EventStream<{ type: "data"; value: number } | { type: "done"; total: number }, number>(
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

	it("should deliver to all simultaneous waiters when event arrives", async () => {
		// This tests the multi-waiter fix: when multiple consumers are waiting
		// at the exact same moment, they all receive the same event (broadcast to waiters).
		// This prevents the single-waiter bug where only one consumer would receive
		// events while others hung forever.
		const stream = new EventStream<{ type: "data"; value: number } | { type: "done" }, void>(
			(e) => e.type === "done",
			() => undefined,
		);

		// Start 3 async iterators and have them each wait for one event
		const iter1 = stream[Symbol.asyncIterator]();
		const iter2 = stream[Symbol.asyncIterator]();
		const iter3 = stream[Symbol.asyncIterator]();

		// All three iterators wait for next event (they become waiters)
		const p1 = iter1.next();
		const p2 = iter2.next();
		const p3 = iter3.next();

		// Give them time to enter waiting state
		await new Promise((r) => setTimeout(r, 5));

		// Push one event - all three waiters should receive it
		stream.push({ type: "data", value: 42 });

		const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

		// All waiters that were waiting at push time receive the same event
		expect(r1.value).toEqual({ type: "data", value: 42 });
		expect(r2.value).toEqual({ type: "data", value: 42 });
		expect(r3.value).toEqual({ type: "data", value: 42 });

		// Clean up
		stream.push({ type: "done" });
	});

	it("should not hang when multiple consumers iterate", async () => {
		// This tests that multiple consumers can iterate without blocking each other.
		// Events from the queue are distributed (not broadcast) to consumers.
		const stream = new EventStream<{ type: "data"; value: number } | { type: "done"; total: number }, number>(
			(e) => e.type === "done",
			(e) => (e as { type: "done"; total: number }).total,
		);

		// Pre-queue events so they're in the queue before consumers start
		stream.push({ type: "data", value: 1 });
		stream.push({ type: "data", value: 2 });
		stream.push({ type: "data", value: 3 });
		stream.push({ type: "done", total: 6 });

		const allEvents: number[] = [];

		// Two consumers racing to drain the queue
		const consumer1 = (async () => {
			for await (const event of stream) {
				if (event.type === "data") allEvents.push(event.value);
			}
		})();

		const consumer2 = (async () => {
			for await (const event of stream) {
				if (event.type === "data") allEvents.push(event.value);
			}
		})();

		// Both consumers should complete (not hang)
		await Promise.race([
			Promise.all([consumer1, consumer2]),
			new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout - consumers hung")), 1000)),
		]);

		// Events are distributed between consumers (total should be 3 events + done)
		// The exact distribution depends on scheduling
		expect(allEvents.length).toBeGreaterThanOrEqual(1);
		expect(allEvents.length).toBeLessThanOrEqual(3);
	});
});
