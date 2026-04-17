import type { Usage, Model } from "@my-agent/ai";
import type { AgentMessage } from "./types.js";

export interface SessionCosts {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCost: number;
	turnCosts: TurnCost[];
}

export interface TurnCost {
	turnIndex: number;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	timestamp: number;
}

/**
 * Reject inputs that would silently break budget enforcement:
 *   - NaN totals stay forever-not-greater than the cap (>= NaN === false).
 *   - Infinity locks the session permanently below cap.
 *   - Negative values let a malformed provider buy budget back.
 *
 * The same gate guards every cost ingress: live usage.cost from the
 * provider, the per-million estimate fallback, and persisted snapshot
 * fields like priorCumulativeCost. Codex budget-fix pass-5 finding.
 */
function isValidCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Compute the per-turn cost for a (model, usage) pair using the same
 * rules CostTracker uses internally:
 *   - upstream-reported usage.cost wins when present and valid,
 *   - otherwise estimate from model.cost per-million pricing,
 *   - cached input is billed at 10% of the input rate.
 *
 * Exported so other accounting paths (compaction snapshot replay,
 * session-restoration replay) compute cost identically. Drift between
 * "what the live tracker bills" and "what the snapshot persists"
 * would let providers that don't emit usage.cost (e.g. Anthropic
 * native, which is token-only) silently lose spend across restarts.
 * Codex budget-fix pass-5 finding.
 *
 * Returns 0 when inputs are not usable rather than NaN/throw, so a
 * single bad turn cannot poison the cumulative total.
 */
export function calculateUsageCost(model: Model, usage: Usage): number {
	if (isValidCost(usage.cost)) {
		return usage.cost;
	}
	const inputTokens = isValidCost(usage.inputTokens) ? usage.inputTokens : 0;
	const outputTokens = isValidCost(usage.outputTokens) ? usage.outputTokens : 0;
	const cacheReadTokens = isValidCost(usage.cacheReadTokens) ? usage.cacheReadTokens : 0;
	const inputPerMillion = model.cost?.inputPerMillion;
	const outputPerMillion = model.cost?.outputPerMillion;
	if (!isValidCost(inputPerMillion) || !isValidCost(outputPerMillion)) {
		return 0;
	}
	const inputCost = (inputTokens / 1_000_000) * inputPerMillion;
	const outputCost = (outputTokens / 1_000_000) * outputPerMillion;
	const cacheReadCost = (cacheReadTokens / 1_000_000) * inputPerMillion * 0.1;
	const total = inputCost + outputCost + cacheReadCost;
	return isValidCost(total) ? total : 0;
}

export class CostTracker {
	private costs: SessionCosts = {
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
		totalCost: 0,
		turnCosts: [],
	};

	constructor(private maxCostPerSession?: number) {}

	recordTurn(model: Model, usage: Usage, turnIndex: number): void {
		const cost = this.calculateCost(model, usage);
		// calculateCost never returns a non-finite/negative number by
		// construction, but be defensive: a future regression there would
		// otherwise poison the running total in a way `isBudgetExceeded`
		// can't detect.
		if (!isValidCost(cost)) return;

		const input = isValidCost(usage.inputTokens) ? usage.inputTokens : 0;
		const output = isValidCost(usage.outputTokens) ? usage.outputTokens : 0;
		const cacheRead = isValidCost(usage.cacheReadTokens) ? usage.cacheReadTokens : 0;
		const cacheWrite = isValidCost(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0;

		this.costs.totalInputTokens += input;
		this.costs.totalOutputTokens += output;
		this.costs.totalCacheReadTokens += cacheRead;
		this.costs.totalCacheWriteTokens += cacheWrite;
		this.costs.totalCost += cost;

		// Stamp the computed cost back onto the assistant message's
		// usage so cross-process resume reads an authoritative value.
		// Without this, `loadFromMessages` re-prices historical
		// token-only turns against the current session's model, and a
		// model switch between runs would let prior spend get re-billed
		// at the new (possibly cheaper or zero-cost) model — bypassing
		// the cap. Pi-Mono persists per-turn cost the same way.
		// Codex budget-fix pass-6 finding.
		if (!isValidCost(usage.cost)) {
			(usage as { cost?: number }).cost = cost;
		}

		this.costs.turnCosts.push({
			turnIndex,
			model: model.id,
			inputTokens: input,
			outputTokens: output,
			cost,
			timestamp: Date.now(),
		});
	}

	/** Returns true if the session has exceeded the budget limit */
	isBudgetExceeded(): boolean {
		if (this.maxCostPerSession === undefined) return false;
		return this.costs.totalCost >= this.maxCostPerSession;
	}

	/**
	 * Replay assistant `usage` records from a prior session into this
	 * tracker so a hard `maxCostPerSession` cap survives process
	 * restarts. Without this, resuming a session in a fresh process
	 * would reset cumulative spend to zero and let the next turn
	 * exceed the cap. Codex budget-fix pass-3 finding.
	 *
	 * No-op if the tracker already has any recorded turns — loading
	 * twice would double-count. The caller should invoke this once
	 * per process, before the first new turn runs.
	 *
	 * Returns the number of prior turns loaded so the caller can
	 * continue numbering subsequent turns from there (avoids
	 * `turn_index` collisions in the event stream).
	 *
	 * `model` is used as a fallback when a prior assistant message
	 * has no `usage.cost`. Mixing models across resume is supported
	 * because OpenRouter-reported `usage.cost` (when present) is
	 * authoritative regardless of `model.cost`.
	 */
	loadFromMessages(messages: AgentMessage[], model: Model): number {
		if (this.costs.totalCost > 0 || this.costs.turnCosts.length > 0) {
			return 0;
		}
		let loaded = 0;
		for (const msg of messages) {
			// Compaction summaries carry a snapshot of the cumulative
			// cost of every assistant turn that was folded into them.
			// Seed from that snapshot so a session that compacted its
			// earlier spend still enforces `maxCostPerSession` after
			// resume — without this, the current branch's kept tail
			// would be the only input and the replay would miss the
			// compacted turns' cost. Codex budget-fix pass-4 finding.
			if (
				"role" in msg &&
				msg.role === "custom" &&
				"type" in msg &&
				msg.type === "compaction_summary"
			) {
				const raw = (msg as { priorCumulativeCost?: unknown }).priorCumulativeCost;
				// Treat a malformed (NaN/Infinity/negative) snapshot as
				// "unknown prior spend" rather than seeding a value that
				// would permanently lock the session under its cap or
				// (for a negative value) gift the session free headroom.
				// Codex budget-fix pass-5 finding.
				if (isValidCost(raw) && raw > 0) {
					this.costs.totalCost += raw;
					this.costs.turnCosts.push({
						turnIndex: loaded,
						model: "compaction-snapshot",
						inputTokens: 0,
						outputTokens: 0,
						cost: raw,
						timestamp: (msg as { timestamp?: number }).timestamp ?? Date.now(),
					});
					loaded++;
				}
				continue;
			}
			if (
				"role" in msg &&
				msg.role === "assistant" &&
				msg.usage &&
				msg.stopReason !== "aborted" &&
				msg.stopReason !== "error"
			) {
				this.recordTurn(model, msg.usage, loaded);
				loaded++;
			}
		}
		return loaded;
	}

	getSummary(): SessionCosts {
		return { ...this.costs };
	}

	formatCost(): string {
		const { totalCost, totalInputTokens, totalOutputTokens } = this.costs;
		const budget = this.maxCostPerSession !== undefined ? ` / $${this.maxCostPerSession.toFixed(2)} budget` : "";
		return `$${totalCost.toFixed(4)}${budget} (${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out)`;
	}

	/**
	 * Per-turn cost calculation. Delegates to the shared helper so live
	 * accounting, compaction snapshots, and cross-process resume all
	 * agree on what a turn costs. A provider that emits authoritative
	 * `usage.cost` wins; otherwise we estimate from `model.cost` using
	 * the same 10%-of-input price for cached reads.
	 */
	private calculateCost(model: Model, usage: Usage): number {
		return calculateUsageCost(model, usage);
	}
}
