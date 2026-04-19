import { describe, expect, it } from "vitest";
import { redactSecrets, redactValue } from "../../src/tools/redact.js";

describe("redactSecrets", () => {
	it("redacts GitHub personal access tokens (pat + legacy)", () => {
		const input =
			"GITHUB_TOKEN=REDACTED_GITHUB_PAT and REDACTED_GITHUB_TOKEN";
		const out = redactSecrets(input);
		expect(out).not.toContain("REDACTED_GITHUB_PAT");
		expect(out).not.toContain("REDACTED_GITHUB_TOKEN");
		expect(out).toContain("[REDACTED]");
	});

	it("redacts Anthropic and OpenAI API keys distinctly", () => {
		const input =
			"REDACTED_ANTHROPIC_TOKEN and REDACTED_OPENAI_PROJECT_TOKEN and REDACTED_OPENAI_TOKEN";
		const out = redactSecrets(input);
		expect(out).not.toContain("REDACTED_ANTHROPIC_TOKEN");
		expect(out).not.toContain("REDACTED_OPENAI_PROJECT_TOKEN");
		expect(out).not.toContain("REDACTED_OPENAI_TOKEN");
		// Should NOT collapse to "everything's redacted" — still readable text
		expect(out).toContain("and");
	});

	it("redacts AWS access keys, Google API keys, Stripe, Slack", () => {
		const input =
			"REDACTED_AWS_ACCESS_KEY REDACTED_GOOGLE_API_KEY REDACTED_STRIPE_TOKEN REDACTED_SLACK_TOKEN";
		const out = redactSecrets(input);
		expect(out).not.toMatch(/AKIA[0-9A-Z]{16}/);
		expect(out).not.toMatch(/AIza[A-Za-z0-9_-]{35}/);
		expect(out).not.toMatch(/sk_live_[A-Za-z0-9]{20,}/);
		expect(out).not.toMatch(/xoxb-1234567890-AAAA/);
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
		const cases = [
			"curl -H 'Authorization: Bearer REDACTED_OPENAI_TOKEN'",
			'-H "Authorization: Basic BASIC_AUTH_REDACTION_FIXTURE=="',
			"Authorization: Token REDACTED_GITHUB_TOKEN",
		];
		for (const c of cases) {
			const out = redactSecrets(c);
			expect(out).toMatch(/Authorization:\s*(?:Bearer|Basic|Token)\s+\[REDACTED\]/i);
		}
	});

	it("redacts KEY=value env exports for sensitive-named keys", () => {
		const cases: { input: string; key: string; value: string }[] = [
			{
				input: "OPENAI_API_KEY=REDACTED_OPENAI_TOKEN",
				key: "OPENAI_API_KEY",
				value: "REDACTED_OPENAI_TOKEN",
			},
			{
				input: 'GITHUB_TOKEN="REDACTED_GITHUB_TOKEN"',
				key: "GITHUB_TOKEN",
				value: "REDACTED_GITHUB_TOKEN",
			},
			{ input: "DB_PASSWORD='hunter2'", key: "DB_PASSWORD", value: "hunter2" },
			{ input: "MY_PRIVATE_KEY=-----BEGIN", key: "MY_PRIVATE_KEY", value: "-----BEGIN" },
			{
				input: "AWS_SECRET_ACCESS_KEY=AWS_SECRET_REDACTION_FIXTURE",
				key: "AWS_SECRET_ACCESS_KEY",
				value: "AWS_SECRET_REDACTION_FIXTURE",
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
		const input =
			"export OPENAI_API_KEY=REDACTED_OPENAI_TOKEN && curl -H 'Authorization: Bearer REDACTED_GITHUB_TOKEN' https://api";
		const out = redactSecrets(input);
		expect(out).not.toContain("REDACTED_OPENAI_TOKEN");
		expect(out).not.toContain("REDACTED_GITHUB_TOKEN");
		expect((out.match(/\[REDACTED\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
	});
});

describe("redactValue", () => {
	it("redacts strings inside nested objects and arrays", () => {
		const input = {
			outer: {
				cmd: "curl -H 'Authorization: Bearer REDACTED_OPENAI_TOKEN'",
				args: ["--key", "REDACTED_GITHUB_TOKEN"],
			},
			count: 7,
			ok: true,
		};
		const out = redactValue(input) as typeof input;
		expect(out.outer.cmd).not.toContain("sk-secret-AAAA");
		expect(out.outer.args[1]).not.toContain("ghp_AAAA");
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
