import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuditLogEntry, AuditLogger } from "../../src/tools/audit.js";

describe("AuditLogger redaction", () => {
	let logDir: string;
	beforeEach(() => {
		logDir = mkdtempSync(join(tmpdir(), "audit-redact-"));
	});
	afterEach(() => {
		rmSync(logDir, { recursive: true, force: true });
	});

	function readPersistedEntries(): AuditLogEntry[] {
		const files = readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
		const out: AuditLogEntry[] = [];
		for (const f of files) {
			const lines = readFileSync(join(logDir, f), "utf-8").trim().split("\n").filter(Boolean);
			for (const l of lines) out.push(JSON.parse(l));
		}
		return out;
	}

	it("redacts secrets in command, error, and metadata before file write", () => {
		const logger = new AuditLogger({ logDir });
		logger.log({
			timestamp: new Date().toISOString(),
			tool: "bash",
			toolCallId: "t1",
			durationMs: 10,
			status: "success",
			command: "curl -H 'Authorization: Bearer REDACTED_GITHUB_TOKEN' https://api",
			error: "OPENAI_API_KEY=REDACTED_OPENAI_TOKEN was rejected",
			metadata: {
				envSnippet: "AWS_SECRET_ACCESS_KEY=AWS_SECRET_REDACTION_FIXTURE",
				safe: 42,
			},
		});

		const entries = readPersistedEntries();
		expect(entries.length).toBe(1);
		const e = entries[0];
		expect(e.command).not.toContain("ghp_AAAA");
		expect(e.command).toMatch(/Authorization:\s*Bearer\s+\[REDACTED\]/i);
		expect(e.error).not.toContain("sk-FAILEDREQUEST");
		expect((e.metadata as { envSnippet: string }).envSnippet).not.toContain("wJalrXUtnFEMI");
		expect((e.metadata as { safe: number }).safe).toBe(42);
	});

	it("can be disabled via redactSecrets: false (raw secrets persisted)", () => {
		const logger = new AuditLogger({ logDir, redactSecrets: false });
		const secret = "REDACTED_GITHUB_TOKEN";
		logger.log({
			timestamp: new Date().toISOString(),
			tool: "bash",
			toolCallId: "t2",
			durationMs: 1,
			status: "success",
			command: `echo ${secret}`,
		});

		const entries = readPersistedEntries();
		expect(entries[0].command).toContain(secret);
	});

	it("custom handlers also receive the redacted entry", () => {
		const captured: AuditLogEntry[] = [];
		const logger = new AuditLogger({
			logDir,
			handler: (e) => captured.push(e),
		});
		logger.log({
			timestamp: new Date().toISOString(),
			tool: "bash",
			toolCallId: "t3",
			durationMs: 1,
			status: "success",
			command: "export OPENAI_API_KEY=REDACTED_OPENAI_TOKEN",
		});
		expect(captured[0].command).not.toContain("REDACTED_OPENAI_TOKEN");
		expect(captured[0].command).toContain("[REDACTED]");
	});
});
