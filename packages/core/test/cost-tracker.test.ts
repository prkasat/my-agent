import type { Model, Usage } from "@my-agent/ai";
import { describe, expect, it } from "vitest";
import { CostTracker } from "../src/agent/cost-tracker.js";

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

	it("loadFromMessages seeds cumulative spend from a compaction_summary snapshot", async () => {
		// Codex budget-fix pass-4 HIGH: a session that compacted its
		// earlier spend would otherwise lose those costs on resume
		// because the compacted turns don't appear in context.messages
		// anymore. The compaction_summary custom message carries a
		// priorCumulativeCost snapshot; loadFromMessages must treat it
		// as authoritative prior spend.
		const tracker = new CostTracker(0.01);
		const messages = [
			{
				role: "custom" as const,
				type: "compaction_summary" as const,
				summary: "earlier work",
				tokensBefore: 1000,
				tokensAfter: 200,
				timestamp: Date.now(),
				priorCumulativeCost: 0.008,
			},
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "post-compaction turn" }],
				stopReason: "stop" as const,
				timestamp: Date.now(),
				usage: { inputTokens: 50, outputTokens: 25, cost: 0.001 },
			},
		];
		const loaded = tracker.loadFromMessages(messages, PRICED_MODEL);
		expect(loaded).toBe(2);
		expect(tracker.getSummary().totalCost).toBeCloseTo(0.009, 6);

		// One more small turn pushes past the $0.01 cap.
		tracker.recordTurn(PRICED_MODEL, { inputTokens: 10, outputTokens: 5, cost: 0.002 }, loaded);
		expect(tracker.isBudgetExceeded()).toBe(true);
	});

	it("loadFromMessages ignores compaction_summary with no priorCumulativeCost (backward compat)", () => {
		const tracker = new CostTracker();
		const messages = [
			{
				role: "custom" as const,
				type: "compaction_summary" as const,
				summary: "older summary",
				tokensBefore: 500,
				tokensAfter: 100,
				timestamp: Date.now(),
				// priorCumulativeCost omitted
			},
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "x" }],
				stopReason: "stop" as const,
				timestamp: Date.now(),
				usage: { inputTokens: 10, outputTokens: 5, cost: 0.001 },
			},
		];
		const loaded = tracker.loadFromMessages(messages, PRICED_MODEL);
		expect(loaded).toBe(1);
		expect(tracker.getSummary().totalCost).toBeCloseTo(0.001, 6);
	});

	it("loadFromMessages rejects a malformed priorCumulativeCost snapshot (Infinity locks session)", () => {
		// Codex budget-fix pass-5 MEDIUM: a corrupted/edited session file
		// that writes `priorCumulativeCost: Infinity` would permanently
		// lock the session under any cap on resume. The loader MUST
		// treat malformed values as "unknown prior spend" and skip the
		// seed rather than honor it.
		const tracker = new CostTracker(0.01);
		const messages = [
			{
				role: "custom" as const,
				type: "compaction_summary" as const,
				summary: "rogue",
				tokensBefore: 100,
				tokensAfter: 10,
				timestamp: Date.now(),
				priorCumulativeCost: Number.POSITIVE_INFINITY,
			},
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "ok" }],
				stopReason: "stop" as const,
				timestamp: Date.now(),
				usage: { inputTokens: 100, outputTokens: 50, cost: 0.001 },
			},
		];
		const loaded = tracker.loadFromMessages(messages, PRICED_MODEL);
		// Only the real assistant turn should be counted; the malformed
		// snapshot is dropped entirely.
		expect(loaded).toBe(1);
		expect(tracker.getSummary().totalCost).toBeCloseTo(0.001, 6);
		expect(tracker.isBudgetExceeded()).toBe(false);
	});

	it("loadFromMessages rejects a negative priorCumulativeCost snapshot", () => {
		// Negative values would let an attacker or buggy writer GIFT the
		// session free headroom under the cap. Skip instead.
		const tracker = new CostTracker(0.01);
		const messages = [
			{
				role: "custom" as const,
				type: "compaction_summary" as const,
				summary: "rogue",
				tokensBefore: 100,
				tokensAfter: 10,
				timestamp: Date.now(),
				priorCumulativeCost: -100,
			},
		];
		const loaded = tracker.loadFromMessages(messages, PRICED_MODEL);
		expect(loaded).toBe(0);
		expect(tracker.getSummary().totalCost).toBe(0);
	});

	it("recordTurn keeps totalCost finite when usage.cost is NaN (falls back to per-million estimate)", () => {
		// Codex budget-fix pass-5 MEDIUM: a single NaN added straight
		// into totalCost would make `totalCost >= cap` return false
		// forever (>= NaN === false) and silently disable enforcement.
		// The calculator rejects the NaN and falls back to the token-
		// based estimate, so totalCost stays finite and the cap still
		// works.
		const tracker = new CostTracker(0.01);
		tracker.recordTurn(PRICED_MODEL, { inputTokens: 100, outputTokens: 50, cost: Number.NaN }, 0);
		expect(Number.isFinite(tracker.getSummary().totalCost)).toBe(true);
		// 100/1M * 3 + 50/1M * 15 = $0.001050 — positive, so a follow-up
		// that blows past the cap still gets stopped.
		expect(tracker.getSummary().totalCost).toBeCloseTo(0.00105, 6);
		expect(tracker.isBudgetExceeded()).toBe(false);
	});

	it("recordTurn keeps totalCost finite when usage.cost is Infinity", () => {
		// Without the isValidCost gate, Infinity would add into
		// totalCost and permanently lock the session under its cap.
		// The calculator rejects it and uses the token-based fallback.
		const tracker = new CostTracker(0.01);
		tracker.recordTurn(PRICED_MODEL, { inputTokens: 100, outputTokens: 50, cost: Number.POSITIVE_INFINITY }, 0);
		expect(Number.isFinite(tracker.getSummary().totalCost)).toBe(true);
		expect(tracker.getSummary().totalCost).toBeCloseTo(0.00105, 6);
		expect(tracker.isBudgetExceeded()).toBe(false);
	});

	it("recordTurn also sanitizes NaN in token counters", () => {
		// A NaN `inputTokens` would poison totalInputTokens the same way.
		// The cost calculator treats NaN tokens as 0 and the token
		// counters do too.
		const tracker = new CostTracker(0.01);
		tracker.recordTurn(PRICED_MODEL, { inputTokens: Number.NaN, outputTokens: 50, cost: 0.001 }, 0);
		// Token counter stays finite (NaN rejected, counted as 0).
		expect(Number.isFinite(tracker.getSummary().totalInputTokens)).toBe(true);
		expect(tracker.getSummary().totalInputTokens).toBe(0);
		expect(tracker.getSummary().totalOutputTokens).toBe(50);
		expect(tracker.getSummary().totalCost).toBeCloseTo(0.001, 6);
	});

	it("recordTurn rejects negative usage.cost and falls back to the per-million estimate", () => {
		// Malformed `cost: -5` must not be honored (negative cost would
		// let providers buy budget back). The calculator falls back to
		// the token-based estimate from model.cost, which is strictly
		// non-negative.
		const tracker = new CostTracker(0.01);
		tracker.recordTurn(PRICED_MODEL, { inputTokens: 100, outputTokens: 50, cost: -5 }, 0);
		// 100/1M * 3 + 50/1M * 15 = $0.001050
		expect(tracker.getSummary().totalCost).toBeCloseTo(0.00105, 6);
		expect(tracker.getSummary().totalCost).toBeGreaterThan(0);
	});

	it("recordTurn stamps computed cost back onto usage so resume survives a model switch", () => {
		// Codex budget-fix pass-6 HIGH: a token-only assistant turn
		// produced under model A must replay at model A's price even if
		// the session later switched to a cheaper or free model B. The
		// only way to guarantee that across a process restart is to
		// persist the computed cost on the assistant message itself.
		// recordTurn should mutate `usage.cost` in place when it isn't
		// already populated.
		const tracker = new CostTracker();
		const usage: { inputTokens: number; outputTokens: number; cost?: number } = {
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			// no cost field — token-only provider
		};
		tracker.recordTurn(PRICED_MODEL, usage as Usage, 0);
		// 1M * $3 + 0.1M * $15 = $3 + $1.5 = $4.50
		expect(usage.cost).toBeCloseTo(4.5, 6);
	});

	it("recordTurn does not overwrite an existing valid usage.cost", () => {
		// If the upstream already supplied an authoritative cost (e.g.
		// OpenRouter's per-call dollar amount), the mutation must not
		// clobber it with the per-million estimate.
		const tracker = new CostTracker();
		const usage: { inputTokens: number; outputTokens: number; cost: number } = {
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cost: 0.0042, // upstream-authoritative
		};
		tracker.recordTurn(PRICED_MODEL, usage as Usage, 0);
		expect(usage.cost).toBe(0.0042);
	});

	it("recordTurn replaces a malformed usage.cost (NaN) with the valid per-million estimate", () => {
		// Defense-in-depth: a corrupted/forged `cost: NaN` must not
		// survive through to disk where it would poison future replays.
		// The mutation overwrites it with the validated computed value.
		const tracker = new CostTracker();
		const usage: { inputTokens: number; outputTokens: number; cost: number } = {
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cost: Number.NaN,
		};
		tracker.recordTurn(PRICED_MODEL, usage as Usage, 0);
		expect(Number.isFinite(usage.cost)).toBe(true);
		expect(usage.cost).toBeCloseTo(4.5, 6);
	});

	it("loadFromMessages replays error AND aborted turns when usage is present (consistent with live policy)", () => {
		// Codex budget-fix pass-8 HIGH: live recordTurn counts both
		// error and aborted turns (their usage may reflect real
		// provider billing). loadFromMessages MUST also replay both;
		// any asymmetry creates a "billed live, lost on restart" hole
		// where the cap re-opens after a process restart. The
		// isValidCost gate inside recordTurn still filters NaN/
		// Infinity/negative inputs, so genuinely garbage usage is
		// rejected at the calculator layer.
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
				usage: { inputTokens: 200, outputTokens: 0, cost: 0.003 },
			},
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "errored" }],
				stopReason: "error" as const,
				timestamp: Date.now(),
				usage: { inputTokens: 300, outputTokens: 0, cost: 0.005 },
			},
		];
		const loaded = tracker.loadFromMessages(messages, PRICED_MODEL);
		// All three count.
		expect(loaded).toBe(3);
		expect(tracker.getSummary().totalCost).toBeCloseTo(0.001 + 0.003 + 0.005, 6);
	});

	it("loadFromMessages prices token-only history with the resolver, not the session model (model-switch defense)", () => {
		// Codex budget-fix pass-9 HIGH: a session that switched from an
		// expensive model to a cheaper/free one would otherwise re-bill
		// historical token-only turns at the new model's price on
		// restart. With the resolver, each historical message is priced
		// at the model that actually produced it.
		const expensive: Model = {
			id: "expensive",
			name: "Expensive",
			provider: "openrouter",
			contextWindow: 100_000,
			maxOutputTokens: 4096,
			supportsTools: true,
			supportsStreaming: true,
			supportsThinking: false,
			cost: { inputPerMillion: 30, outputPerMillion: 150 },
		};
		const free: Model = {
			id: "free",
			name: "Free",
			provider: "openrouter",
			contextWindow: 100_000,
			maxOutputTokens: 4096,
			supportsTools: true,
			supportsStreaming: true,
			supportsThinking: false,
			cost: { inputPerMillion: 0, outputPerMillion: 0 },
		};

		// Build a fresh message list per call — recordTurn stamps the
		// computed cost back onto usage.cost as a side effect, so the
		// SAME message array can't be passed to a second load
		// expecting an unstamped state.
		const buildMessages = () => [
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "ran on the expensive model" }],
				stopReason: "stop" as const,
				timestamp: Date.now(),
				model: "expensive",
				provider: "openrouter",
				// Token-only — NO usage.cost.
				usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
			},
		];

		// Without resolver: re-billed at the current (free) model = $0.
		const trackerNoResolver = new CostTracker();
		trackerNoResolver.loadFromMessages(buildMessages(), free);
		expect(trackerNoResolver.getSummary().totalCost).toBe(0);

		// With resolver: billed at the expensive model =
		// 1M*$30/1M + 0.1M*$150/1M = $30 + $15 = $45.
		const tracker = new CostTracker();
		tracker.loadFromMessages(buildMessages(), free, {
			resolveModel: (id) => (id === "expensive" ? expensive : undefined),
		});
		expect(tracker.getSummary().totalCost).toBeCloseTo(45, 4);
	});

	it("recordTurn live-records error turns so failure spend counts toward the cap", () => {
		// Codex budget-fix pass-7 HIGH: live counterpart to the
		// loadFromMessages test above. Even when the loop stops on
		// stopReason === "error", recordTurn must have already been
		// called so the spend hits totalCost.
		const tracker = new CostTracker(0.01);
		// Recording an error-stop turn directly (recordTurn is
		// stop-reason agnostic) — it just charges the usage.
		tracker.recordTurn(PRICED_MODEL, { inputTokens: 100, outputTokens: 50, cost: 0.011 }, 0);
		expect(tracker.isBudgetExceeded()).toBe(true);
	});
});
