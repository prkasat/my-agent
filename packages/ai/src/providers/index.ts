import { registerProvider } from "./registry.js";
import { createOpenAICompatibleStream } from "./openai-compatible.js";
import { createAnthropicStream } from "./anthropic.js";

/**
 * Register built-in providers.
 *
 * Providers are wrapped in factories that only execute when first used.
 * No reason to initialize a provider you never call.
 */
export function registerBuiltinProviders(): void {
	registerProvider(
		"openrouter",
		async () =>
			createOpenAICompatibleStream({
				baseUrl: "https://openrouter.ai/api/v1/chat/completions",
				envKey: "OPENROUTER_API_KEY",
				providerName: "openrouter",
				// OpenRouter populates chunk.usage.cost with the real
				// USD cost of the call when this is on, which we then
				// route into CostTracker instead of the per-million
				// estimate.
				includeRealCost: true,
			}),
	);
	registerProvider("anthropic", async () => createAnthropicStream());
}

// Auto-register on import
registerBuiltinProviders();
