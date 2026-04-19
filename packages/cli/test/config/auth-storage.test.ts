import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type OAuthCredentials, type OAuthProvider, registerOAuthProvider } from "@my-agent/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/config/auth-storage.js";

describe("AuthStorage", () => {
	let tmpDir: string;
	let originalOpenRouterKey: string | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-storage-test-"));
		originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_API_KEY = undefined;
	});

	afterEach(async () => {
		if (originalOpenRouterKey === undefined) {
			process.env.OPENROUTER_API_KEY = undefined;
		} else {
			process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("resolves an auth-file API key before the environment", async () => {
		process.env.OPENROUTER_API_KEY = "env-openrouter-key";
		const storage = new AuthStorage(path.join(tmpDir, "auth.json"));
		await storage.setApiKey("openrouter", "stored-openrouter-key");

		await expect(storage.resolveApiKey("openrouter")).resolves.toBe("stored-openrouter-key");
	});

	it("falls back to OPENROUTER_API_KEY when no stored credential exists", async () => {
		process.env.OPENROUTER_API_KEY = "env-openrouter-key";
		const storage = new AuthStorage(path.join(tmpDir, "auth.json"));

		await expect(storage.resolveApiKey("openrouter")).resolves.toBe("env-openrouter-key");
	});

	it("stores OAuth credentials from provider login and resolves the provider api key", async () => {
		const providerId = `test-oauth-${Date.now()}`;
		const provider: OAuthProvider = {
			id: providerId,
			name: "Test OAuth",
			async login() {
				return {
					accessToken: "oauth-access-token",
					refreshToken: "oauth-refresh-token",
					expiresAt: Date.now() + 60_000,
				} satisfies OAuthCredentials;
			},
			async refreshToken(credentials) {
				return credentials;
			},
			getApiKey(credentials) {
				return credentials.accessToken;
			},
		};
		registerOAuthProvider(provider);

		const storage = new AuthStorage(path.join(tmpDir, "auth.json"));
		await storage.login(providerId, {
			onAuth: () => {},
			onPrompt: async () => "",
		});

		const credential = await storage.get(providerId);
		expect(credential?.type).toBe("oauth");
		await expect(storage.resolveApiKey(providerId)).resolves.toBe("oauth-access-token");
	});

	it("backs up a corrupted auth file and recovers with an empty store", async () => {
		const authFile = path.join(tmpDir, "auth.json");
		await fs.writeFile(authFile, "{not valid json", "utf-8");

		const storage = new AuthStorage(authFile);
		await storage.load();

		expect(await storage.listProviders()).toEqual([]);
		const files = await fs.readdir(tmpDir);
		expect(files.some((file) => file.startsWith("auth.json.corrupt-"))).toBe(true);
	});

	it("refreshes expired OAuth credentials when resolving an api key", async () => {
		const providerId = `test-oauth-refresh-${Date.now()}`;
		const provider: OAuthProvider = {
			id: providerId,
			name: "Refresh OAuth",
			async login() {
				throw new Error("not used");
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					accessToken: "refreshed-access-token",
					refreshToken: "refreshed-refresh-token",
					expiresAt: Date.now() + 60_000,
				} satisfies OAuthCredentials;
			},
			getApiKey(credentials) {
				return credentials.accessToken;
			},
		};
		registerOAuthProvider(provider);

		const storage = new AuthStorage(path.join(tmpDir, "auth.json"));
		await storage.set(providerId, {
			type: "oauth",
			accessToken: "expired-access-token",
			refreshToken: "expired-refresh-token",
			expiresAt: Date.now() - 1_000,
		});

		await expect(storage.resolveApiKey(providerId)).resolves.toBe("refreshed-access-token");
		const credential = await storage.get(providerId);
		expect(credential).toMatchObject({
			type: "oauth",
			accessToken: "refreshed-access-token",
			refreshToken: "refreshed-refresh-token",
		});
	});
});
