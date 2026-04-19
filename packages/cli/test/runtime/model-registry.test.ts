import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/config/auth-storage.js";
import { getDefaultSettings } from "../../src/config/settings.js";
import { listModelAvailability, resolveConfiguredModel } from "../../src/runtime/model-registry.js";

describe("model registry", () => {
	let tmpDir: string;
	let originalOpenRouterKey: string | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-registry-test-"));
		originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_API_KEY = "";
	});

	afterEach(async () => {
		if (originalOpenRouterKey === undefined) {
			process.env.OPENROUTER_API_KEY = "";
		} else {
			process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("marks OpenRouter models available when OPENROUTER_API_KEY is set", async () => {
		process.env.OPENROUTER_API_KEY = "test-openrouter-key";
		const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
		const availability = await listModelAvailability(authStorage);

		expect(availability.some((entry) => entry.model.provider === "openrouter" && entry.available)).toBe(true);
	});

	it("uses the configured model when auth is available", async () => {
		process.env.OPENROUTER_API_KEY = "test-openrouter-key";
		const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
		const settings = getDefaultSettings();
		settings.model = "qwen3.6-plus";

		const resolved = await resolveConfiguredModel(settings, authStorage);
		expect(resolved.key).toBe("qwen3.6-plus");
		expect(resolved.model.provider).toBe("openrouter");
	});

	it("falls back to the best available authenticated model", async () => {
		const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
		await authStorage.set("anthropic", {
			type: "oauth",
			accessToken: "anthropic-token",
			refreshToken: "anthropic-refresh",
			expiresAt: Date.now() + 60_000,
		});

		const settings = getDefaultSettings();
		settings.model = "openrouter-auto";

		const resolved = await resolveConfiguredModel(settings, authStorage);
		expect(resolved.model.provider).toBe("anthropic");
		expect(resolved.key).toBe("claude-sonnet-4");
	});

	it("lists the newer pi-mono openai-codex catalog after OAuth login", async () => {
		const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
		await authStorage.set("openai-codex", {
			type: "oauth",
			accessToken: "openai-token",
			refreshToken: "openai-refresh",
			expiresAt: Date.now() + 60_000,
		});

		const availability = await listModelAvailability(authStorage);
		const openaiCodexKeys = availability
			.filter((entry) => entry.model.provider === "openai-codex" && entry.available)
			.map((entry) => entry.key);

		expect(openaiCodexKeys).toEqual(
			expect.arrayContaining([
				"gpt-5.1",
				"gpt-5.1-codex-max",
				"gpt-5.1-codex-mini",
				"gpt-5.2",
				"gpt-5.2-codex",
				"gpt-5.3-codex",
				"gpt-5.3-codex-spark",
				"gpt-5.4",
				"gpt-5.4-mini",
			]),
		);
	});

	it("prefers gpt-5.4 as the openai-codex fallback like pi-mono", async () => {
		const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
		await authStorage.set("openai-codex", {
			type: "oauth",
			accessToken: "openai-token",
			refreshToken: "openai-refresh",
			expiresAt: Date.now() + 60_000,
		});

		const settings = getDefaultSettings();
		settings.model = "openrouter-auto";

		const resolved = await resolveConfiguredModel(settings, authStorage);
		expect(resolved.model.provider).toBe("openai-codex");
		expect(resolved.key).toBe("gpt-5.4");
	});

	it("throws a helpful error when no authenticated models are available", async () => {
		const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
		const settings = getDefaultSettings();

		await expect(resolveConfiguredModel(settings, authStorage)).rejects.toThrow(
			/No authenticated models are available/,
		);
	});
});
