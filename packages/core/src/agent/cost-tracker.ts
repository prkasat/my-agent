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

		this.costs.totalInputTokens += usage.inputTokens;
		this.costs.totalOutputTokens += usage.outputTokens;
		this.costs.totalCacheReadTokens += usage.cacheReadTokens || 0;
		this.costs.totalCacheWriteTokens += usage.cacheWriteTokens || 0;
		this.costs.totalCost += cost;

		this.costs.turnCosts.push({
			turnIndex,
			model: model.id,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
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
				msg.type === "compaction_summary" &&
				typeof (msg as { priorCumulativeCost?: number }).priorCumulativeCost === "number"
			) {
				const priorCost = (msg as { priorCumulativeCost: number }).priorCumulativeCost;
				if (priorCost > 0) {
					this.costs.totalCost += priorCost;
					this.costs.turnCosts.push({
						turnIndex: loaded,
						model: "compaction-snapshot",
						inputTokens: 0,
						outputTokens: 0,
						cost: priorCost,
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

	private calculateCost(model: Model, usage: Usage): number {
		// Prefer the upstream's authoritative per-call cost (OpenRouter
		// reports this in `chunk.usage.cost` when `includeRealCost` is
		// enabled on the provider). The static per-million estimate
		// drifts from reality whenever the model's price changes mid-
		// session, when caching/discount tiers apply, or when the
		// upstream router fans out across providers with different
		// pricing — `usage.cost` captures all of those exactly.
		if (typeof usage.cost === "number") {
			return usage.cost;
		}
		const inputCost = (usage.inputTokens / 1_000_000) * model.cost.inputPerMillion;
		const outputCost = (usage.outputTokens / 1_000_000) * model.cost.outputPerMillion;
		const cacheReadCost = ((usage.cacheReadTokens || 0) / 1_000_000) * model.cost.inputPerMillion * 0.1;
		return inputCost + outputCost + cacheReadCost;
	}
}
