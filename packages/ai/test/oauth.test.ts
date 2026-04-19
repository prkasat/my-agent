import { describe, expect, it } from "vitest";
import { getOAuthProvider, registerBuiltinOAuthProviders } from "../src/index.js";

describe("registerBuiltinOAuthProviders", () => {
	it("registers anthropic and openai-codex by default", () => {
		registerBuiltinOAuthProviders();
		expect(getOAuthProvider("anthropic")?.id).toBe("anthropic");
		expect(getOAuthProvider("openai-codex")?.id).toBe("openai-codex");
	});
});
