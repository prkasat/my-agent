import type { Usage, Model } from "@my-agent/ai";

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
