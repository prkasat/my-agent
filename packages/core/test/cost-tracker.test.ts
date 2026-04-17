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
});
