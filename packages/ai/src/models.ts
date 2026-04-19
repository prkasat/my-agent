import type { Model } from "./types.js";

/**
 * Model definitions.
 *
 * Explicit model registry — easy to audit, customize, and reason about.
 * OpenRouter entries below are the free-tier bootstrap options.
 */

const MODEL_KEY_ALIASES: Record<string, string> = {
	"gpt-5.1-codex": "gpt-5.1",
};

export const models: Record<string, Model> = {
	// OpenRouter free models
	"qwen3.6-plus": {
		id: "qwen/qwen3.6-plus:free",
		name: "Qwen 3.6 Plus",
		provider: "openrouter",
		contextWindow: 1_000_000,
		maxOutputTokens: 16_384,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: true,
		cost: { inputPerMillion: 0, outputPerMillion: 0 },
	},
	"trinity-large": {
		id: "arcee-ai/trinity-large-preview:free",
		name: "Arcee Trinity Large",
		provider: "openrouter",
		contextWindow: 131_000,
		maxOutputTokens: 16_384,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: false,
		cost: { inputPerMillion: 0, outputPerMillion: 0 },
	},
	"openrouter-auto": {
		id: "openrouter/free",
		name: "OpenRouter Auto (Free)",
		provider: "openrouter",
		contextWindow: 200_000,
		maxOutputTokens: 16_384,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: true,
		cost: { inputPerMillion: 0, outputPerMillion: 0 },
	},

	// Anthropic subscription models
	"claude-sonnet-4": {
		id: "claude-sonnet-4-20250514",
		name: "Claude Sonnet 4",
		provider: "anthropic",
		contextWindow: 200_000,
		maxOutputTokens: 16_384,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: true,
		cost: { inputPerMillion: 3, outputPerMillion: 15 },
	},
	"claude-opus-4": {
		id: "claude-opus-4-20250514",
		name: "Claude Opus 4",
		provider: "anthropic",
		contextWindow: 200_000,
		maxOutputTokens: 16_384,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: true,
		cost: { inputPerMillion: 15, outputPerMillion: 75 },
	},
	"claude-haiku-3.5": {
		id: "claude-haiku-3-5-20241022",
		name: "Claude Haiku 3.5",
		provider: "anthropic",
		contextWindow: 200_000,
		maxOutputTokens: 8_192,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: false,
		cost: { inputPerMillion: 0.8, outputPerMillion: 4 },
	},

	// ChatGPT subscription (Codex) models
	"gpt-5.1": {
		id: "gpt-5.1",
		name: "GPT-5.1",
		provider: "openai-codex",
		contextWindow: 272_000,
		maxOutputTokens: 128_000,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: true,
		cost: { inputPerMillion: 1.25, outputPerMillion: 10 },
	},
	"gpt-5.1-codex-max": {
		id: "gpt-5.1-codex-max",
		name: "GPT-5.1 Codex Max",
		provider: "openai-codex",
		contextWindow: 272_000,
		maxOutputTokens: 128_000,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: true,
		cost: { inputPerMillion: 1.25, outputPerMillion: 10 },
	},
	"gpt-5.1-codex-mini": {
		id: "gpt-5.1-codex-mini",
		name: "GPT-5.1 Codex Mini",
		provider: "openai-codex",
		contextWindow: 272_000,
		maxOutputTokens: 128_000,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: true,
		cost: { inputPerMillion: 0.25, outputPerMillion: 2 },
	},
	"gpt-5.2": {
		id: "gpt-5.2",
		name: "GPT-5.2",
		provider: "openai-codex",
		contextWindow: 272_000,
		maxOutputTokens: 128_000,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: true,
		cost: { inputPerMillion: 1.75, outputPerMillion: 14 },
	},
	"gpt-5.2-codex": {
		id: "gpt-5.2-codex",
		name: "GPT-5.2 Codex",
		provider: "openai-codex",
		contextWindow: 272_000,
		maxOutputTokens: 128_000,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: true,
		cost: { inputPerMillion: 1.75, outputPerMillion: 14 },
	},
	"gpt-5.3-codex": {
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		provider: "openai-codex",
		contextWindow: 272_000,
		maxOutputTokens: 128_000,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: true,
		cost: { inputPerMillion: 1.75, outputPerMillion: 14 },
	},
	"gpt-5.3-codex-spark": {
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		provider: "openai-codex",
		contextWindow: 128_000,
		maxOutputTokens: 128_000,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: true,
		cost: { inputPerMillion: 0, outputPerMillion: 0 },
	},
	"gpt-5.4": {
		id: "gpt-5.4",
		name: "GPT-5.4",
		provider: "openai-codex",
		contextWindow: 272_000,
		maxOutputTokens: 128_000,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: true,
		cost: { inputPerMillion: 2.5, outputPerMillion: 15 },
	},
	"gpt-5.4-mini": {
		id: "gpt-5.4-mini",
		name: "GPT-5.4 Mini",
		provider: "openai-codex",
		contextWindow: 272_000,
		maxOutputTokens: 128_000,
		supportsTools: true,
		supportsStreaming: true,
		supportsThinking: true,
		cost: { inputPerMillion: 0.75, outputPerMillion: 4.5 },
	},
};

export function normalizeModelKey(id: string): string {
	return MODEL_KEY_ALIASES[id] ?? id;
}

export function getModel(id: string): Model {
	const normalizedId = normalizeModelKey(id);
	const model = models[normalizedId];
	if (!model) {
		throw new Error(`Unknown model: "${id}". Available: ${Object.keys(models).join(", ")}`);
	}
	return model;
}

export function getModelsByProvider(provider: string): Model[] {
	return Object.values(models).filter((m) => m.provider === provider);
}

/**
 * Calculate the cost of a usage record for a given model.
 */
export function calculateCost(model: Model, usage: { inputTokens: number; outputTokens: number }): number {
	return (
		(usage.inputTokens / 1_000_000) * model.cost.inputPerMillion +
		(usage.outputTokens / 1_000_000) * model.cost.outputPerMillion
	);
}
