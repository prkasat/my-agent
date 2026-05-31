import { getModel, type Model, models, normalizeModelKey } from "@my-agent/ai";
import type { AuthStorage } from "../config/auth-storage.js";
import type { Settings } from "../config/settings.js";

export type ProviderAuthMode = "api_key" | "oauth" | "unknown";

export interface ModelAvailability {
	key: string;
	model: Model;
	authMode: ProviderAuthMode;
	available: boolean;
	reason?: string;
}

const PROVIDER_AUTH_MODE: Record<string, ProviderAuthMode> = {
	openrouter: "api_key",
	anthropic: "oauth",
	"openai-codex": "oauth",
};

const FALLBACK_MODEL_ORDER = [
	"openrouter-auto",
	"qwen3.6-plus",
	"claude-sonnet-4",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.1",
	"trinity-large",
];

export function getProviderAuthMode(provider: string): ProviderAuthMode {
	return PROVIDER_AUTH_MODE[provider] ?? "unknown";
}

export async function listModelAvailability(authStorage: AuthStorage): Promise<ModelAvailability[]> {
	const entries = Object.entries(models).map(([key, model]) => ({ key, model }));
	const results: ModelAvailability[] = [];

	for (const entry of entries) {
		const authMode = getProviderAuthMode(entry.model.provider);
		const hasAuth = await authStorage.hasAuth(entry.model.provider);

		results.push({
			key: entry.key,
			model: entry.model,
			authMode,
			available: hasAuth,
			reason: hasAuth ? undefined : missingAuthReason(entry.model.provider, authMode),
		});
	}

	return results.sort((a, b) => a.model.name.localeCompare(b.model.name));
}

function missingAuthReason(provider: string, authMode: ProviderAuthMode): string {
	if (provider === "openrouter") {
		return "Set OPENROUTER_API_KEY or store an openrouter API key in auth.json.";
	}
	if (authMode === "oauth") {
		return `Run /login ${provider} to enable this provider.`;
	}
	return `No authentication available for provider ${provider}.`;
}

function pickBestAvailableModel(available: ModelAvailability[]): ModelAvailability | undefined {
	for (const key of FALLBACK_MODEL_ORDER) {
		const match = available.find((entry) => entry.available && entry.key === key);
		if (match) return match;
	}
	return available.find((entry) => entry.available);
}

export async function resolveConfiguredModel(
	settings: Settings,
	authStorage: AuthStorage,
): Promise<{ key: string; model: Model; availableModels: ModelAvailability[] }> {
	const availableModels = await listModelAvailability(authStorage);
	const configuredKey = normalizeModelKey(settings.model);
	const configured = availableModels.find((entry) => entry.key === configuredKey);
	if (configured?.available) {
		return { key: configured.key, model: configured.model, availableModels };
	}

	const fallback = pickBestAvailableModel(availableModels);
	if (fallback) {
		return { key: fallback.key, model: fallback.model, availableModels };
	}

	throw new Error(
		[
			`No authenticated models are available for configured model "${settings.model}".`,
			...availableModels.map((entry) => `- ${entry.key}: ${entry.reason ?? "available"}`),
		].join("\n"),
	);
}

export function formatModelResolutionError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (!message.includes("No authenticated models are available")) {
		return message;
	}
	return [
		`No model is ready yet: ${message}`,
		"Next steps:",
		"  - OpenRouter: export OPENROUTER_API_KEY=...",
		"  - Anthropic: /login anthropic",
		"  - OpenAI Codex: /login openai-codex",
		"  - Choose a model after auth: /model or my-agent --list-models",
	].join("\n");
}

export function getModelProviderForKey(key: string): string | undefined {
	try {
		return getModel(key).provider;
	} catch {
		return undefined;
	}
}
