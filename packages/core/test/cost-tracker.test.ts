import { describe, expect, it } from "vitest";
import { CostTracker } from "../src/agent/cost-tracker.js";
import type { Model, Usage } from "@my-agent/ai";

const PRICED_MODEL: Model = {
	id: "test-model",
	name: "Test",
	provider: "openrouter",
	contextWindow: 100_000,
	maxOutputTokens: 4096,
	supportsTools: true,
	supportsStreaming: true,
	supportsThinking: false,
	cost: { inputPerMillion: 3, outputPerMillion: 15 },
};

describe("CostTracker", () => {
	it("uses upstream-reported usage.cost when present (overrides per-million estimate)", () => {
		const tracker = new CostTracker();
		const usage: Usage = { inputTokens: 100, outputTokens: 50, cost: 0.0042 };
		tracker.recordTurn(PRICED_MODEL, usage, 0);

		expect(tracker.getSummary().totalCost).toBeCloseTo(0.0042, 6);
	});

	it("falls back to per-million estimate when usage.cost is absent", () => {
		const tracker = new CostTracker();
		const usage: Usage = { inputTokens: 1_000_000, outputTokens: 500_000 };
		tracker.recordTurn(PRICED_MODEL, usage, 0);

		// 1M input * $3 + 0.5M output * $15 = $3 + $7.5 = $10.50
		expect(tracker.getSummary().totalCost).toBeCloseTo(10.5, 4);
	});

	it("mixes real and estimated cost across turns when only some report cost", () => {
		const tracker = new CostTracker();
		tracker.recordTurn(PRICED_MODEL, { inputTokens: 100, outputTokens: 50, cost: 0.001 }, 0);
		tracker.recordTurn(PRICED_MODEL, { inputTokens: 1_000_000, outputTokens: 0 }, 1);

		// Real $0.001 + estimated $3.00 = $3.001
		expect(tracker.getSummary().totalCost).toBeCloseTo(3.001, 4);
	});

	it("treats usage.cost = 0 as authoritative (free tier model)", () => {
		const tracker = new CostTracker();
		tracker.recordTurn(PRICED_MODEL, { inputTokens: 1000, outputTokens: 500, cost: 0 }, 0);

		// Without preferring usage.cost, this would compute a small
		// non-zero value; the upstream said the call was free.
		expect(tracker.getSummary().totalCost).toBe(0);
	});

	it("loadFromMessages replays prior usage so resume preserves cumulative spend", async () => {
		// Codex budget-fix pass-3 HIGH: a hard cap survives process
		// restart only if the resumed tracker rebuilds cumulative spend
		// from the persisted assistant `usage` records. Bare `new
		// CostTracker(maxCostPerSession)` would reset to zero.
		const tracker = new CostTracker(0.001);
		const messages = [
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "prior turn" }],
				stopReason: "stop" as const,
				timestamp: Date.now(),
				usage: { inputTokens: 100, outputTokens: 50, cost: 0.0009 },
			},
		];
		const loaded = tracker.loadFromMessages(messages, PRICED_MODEL);
		expect(loaded).toBe(1);
		expect(tracker.getSummary().totalCost).toBeCloseTo(0.0009, 6);
		expect(tracker.isBudgetExceeded()).toBe(false);

		tracker.recordTurn(PRICED_MODEL, { inputTokens: 50, outputTokens: 25, cost: 0.0002 }, loaded);
		expect(tracker.isBudgetExceeded()).toBe(true);
	});

	it("loadFromMessages is idempotent — re-calling does not double-count", () => {
		const tracker = new CostTracker(0.01);
		const messages = [
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "x" }],
				stopReason: "stop" as const,
				timestamp: Date.now(),
				usage: { inputTokens: 100, outputTokens: 50, cost: 0.005 },
			},
		];
		tracker.loadFromMessages(messages, PRICED_MODEL);
		const second = tracker.loadFromMessages(messages, PRICED_MODEL);
		expect(second).toBe(0);
		expect(tracker.getSummary().totalCost).toBeCloseTo(0.005, 6);
	});

	it("loadFromMessages skips aborted and error assistant messages", () => {
		const tracker = new CostTracker();
		const messages = [
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "ok" }],
				stopReason: "stop" as const,
				timestamp: Date.now(),
				usage: { inputTokens: 100, outputTokens: 50, cost: 0.001 },
			},
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "aborted" }],
				stopReason: "aborted" as const,
				timestamp: Date.now(),
				usage: { inputTokens: 200, outputTokens: 0, cost: 0.999 },
			},
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "errored" }],
				stopReason: "error" as const,
				timestamp: Date.now(),
				usage: { inputTokens: 300, outputTokens: 0, cost: 0.999 },
			},
		];
		const loaded = tracker.loadFromMessages(messages, PRICED_MODEL);
		expect(loaded).toBe(1);
		expect(tracker.getSummary().totalCost).toBeCloseTo(0.001, 6);
	});
});
