import { describe, expect, it } from "vitest";
import { redactSecrets, redactValue } from "../../src/tools/redact.js";

const openAiKey = (value: string) => ["sk", value].join("-");
const githubToken = (prefix: string, value: string) => [prefix, value].join("_");

describe("redactSecrets", () => {
	it("redacts GitHub personal access tokens (pat + legacy)", () => {
		const pat = ["github", "pat", "A".repeat(20), "B".repeat(20)].join("_");
		const legacy = githubToken("gho", "A".repeat(36));
		const input = `GITHUB_TOKEN=${pat} and ${legacy}`;
		const out = redactSecrets(input);
		expect(out).not.toContain(pat);
		expect(out).not.toContain(legacy);
		expect(out).toContain("[REDACTED]");
	});

	it("redacts Anthropic and OpenAI API keys distinctly", () => {
		const anthropicKey = ["sk", "ant", "api03", "A".repeat(24)].join("-");
		const projectKey = ["sk", "proj", "B".repeat(24)].join("-");
		const standardKey = openAiKey("C".repeat(20));
		const input = `${anthropicKey} and ${projectKey} and ${standardKey}`;
		const out = redactSecrets(input);
		expect(out).not.toContain(anthropicKey);
		expect(out).not.toContain(projectKey);
		expect(out).not.toContain(standardKey);
		// Should NOT collapse to "everything's redacted" — still readable text
		expect(out).toContain("and");
	});

	it("redacts AWS access keys, Google API keys, Stripe, Slack", () => {
		const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
		const googleKey = ["AIza", "SyAbCdEfGhIjKlMnOpQrStUvWxYz0123456"].join("");
		const stripeKey = ["sk", "live", "AAAAAAAAAAAAAAAAAAAAAAAA"].join("_");
		const slackToken = ["xoxb", "1234567890", "AAAAAAAAAAAAAAAAAAAA"].join("-");
		const input = `${awsKey} ${googleKey} ${stripeKey} ${slackToken}`;
		const out = redactSecrets(input);
		expect(out).not.toMatch(/AKIA[0-9A-Z]{16}/);
		expect(out).not.toMatch(/AIza[A-Za-z0-9_-]{35}/);
		expect(out).not.toMatch(/sk_live_[A-Za-z0-9]{20,}/);
		expect(out).not.toContain(slackToken);
	});

	it("redacts JWTs without false-positiving on non-JWT base64", () => {
		const jwt =
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
		const input = `Bearer ${jwt} and a non-jwt base64 like aGVsbG8gd29ybGQ=`;
		const out = redactSecrets(input);
		expect(out).not.toContain(jwt);
		expect(out).toContain("aGVsbG8gd29ybGQ="); // not redacted — not JWT-shaped
	});

	it("redacts Authorization headers (Bearer / Basic / Token) preserving header name", () => {
		const bearerValue = openAiKey("secret-token-abc123");
		const basicValue = ["dXNlcjpw", "YXNzd29yZA=="].join("");
		const tokenValue = githubToken("ghp", "A".repeat(24));
		const cases = [
			`curl -H 'Authorization: Bearer ${bearerValue}'`,
			`-H "Authorization: Basic ${basicValue}"`,
			`Authorization: Token ${tokenValue}`,
		];
		for (const c of cases) {
			const out = redactSecrets(c);
			expect(out).toMatch(/Authorization:\s*(?:Bearer|Basic|Token)\s+\[REDACTED\]/i);
		}
	});

	it("redacts KEY=value env exports for sensitive-named keys", () => {
		const openAiEnvValue = openAiKey("very-secret-XYZAAAAAAAAA");
		const githubEnvValue = githubToken("ghp", "A".repeat(36));
		const awsSecret = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/");
		const cases: { input: string; key: string; value: string }[] = [
			{
				input: `OPENAI_API_KEY=${openAiEnvValue}`,
				key: "OPENAI_API_KEY",
				value: openAiEnvValue,
			},
			{
				input: `GITHUB_TOKEN="${githubEnvValue}"`,
				key: "GITHUB_TOKEN",
				value: githubEnvValue,
			},
			{ input: "DB_PASSWORD='hunter2'", key: "DB_PASSWORD", value: "hunter2" },
			{ input: "MY_PRIVATE_KEY=-----BEGIN", key: "MY_PRIVATE_KEY", value: "-----BEGIN" },
			{
				input: `AWS_SECRET_ACCESS_KEY=${awsSecret}`,
				key: "AWS_SECRET_ACCESS_KEY",
				value: awsSecret,
			},
		];
		for (const c of cases) {
			const out = redactSecrets(c.input);
			expect(out).not.toContain(c.value);
			expect(out).toContain(c.key);
			expect(out).toContain("[REDACTED]");
		}
	});

	it("does NOT redact innocuous KEY=value pairs", () => {
		const innocuous = "PORT=3000 NODE_ENV=development DEBUG=app:* PATH=/usr/local/bin";
		expect(redactSecrets(innocuous)).toBe(innocuous);
	});

	it("does NOT touch a string with no secrets (reference equality is fine)", () => {
		const input = "ls -la /tmp && echo done";
		expect(redactSecrets(input)).toBe(input);
	});

	it("redacts multiple secrets in a single string independently", () => {
		const envValue = openAiKey("A".repeat(20));
		const headerValue = githubToken("ghp", "B".repeat(36));
		const input = `export OPENAI_API_KEY=${envValue} && curl -H 'Authorization: Bearer ${headerValue}' https://api`;
		const out = redactSecrets(input);
		expect(out).not.toContain(envValue);
		expect(out).not.toContain(headerValue);
		expect((out.match(/\[REDACTED\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
	});
});

describe("redactValue", () => {
	it("redacts strings inside nested objects and arrays", () => {
		const bearerValue = openAiKey("secret-AAAAAAAAAAAAAAAAAAAA");
		const argValue = githubToken("ghp", "A".repeat(36));
		const input = {
			outer: {
				cmd: `curl -H 'Authorization: Bearer ${bearerValue}'`,
				args: ["--key", argValue],
			},
			count: 7,
			ok: true,
		};
		const out = redactValue(input) as typeof input;
		expect(out.outer.cmd).not.toContain(bearerValue);
		expect(out.outer.args[1]).not.toContain(argValue);
		expect(out.count).toBe(7);
		expect(out.ok).toBe(true);
	});

	it("preserves non-string primitives untouched", () => {
		expect(redactValue(42)).toBe(42);
		expect(redactValue(null)).toBe(null);
		expect(redactValue(undefined)).toBe(undefined);
		expect(redactValue(true)).toBe(true);
	});
});
