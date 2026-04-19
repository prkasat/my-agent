import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@my-agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportFromSessionManager } from "../src/commands/export.js";

describe("export session", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "export-session-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("writes a standalone HTML export for the current session", async () => {
		const session = SessionManager.continueRecent(tmpDir);
		session.appendMessage({ role: "user", content: "hello export", timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "exported response" }],
			stopReason: "stop",
			timestamp: Date.now(),
		});
		session.flush();

		const outputPath = path.join(tmpDir, "session.html");
		await exportFromSessionManager(session, outputPath);

		const html = await fs.readFile(outputPath, "utf-8");
		expect(html).toContain("Agent Session");
		expect(html).toContain("hello export");
		expect(html).toContain("exported response");
	});
});
