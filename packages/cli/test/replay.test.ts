import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replayFile } from "../src/commands/replay.js";

describe("replayFile", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "my-agent-replay-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("renders trace timelines", async () => {
		const file = path.join(tmpDir, "trace.jsonl");
		await fs.writeFile(
			file,
			[
				JSON.stringify({
					timestamp: "2026-01-01T00:00:00.000Z",
					scope: "runtime",
					type: "agent.start",
					data: { sessionId: "abc" },
				}),
				JSON.stringify({
					timestamp: "2026-01-01T00:00:01.000Z",
					scope: "runtime",
					type: "agent.end",
					data: { sessionId: "abc" },
				}),
			].join("\n"),
			"utf-8",
		);

		const replay = await replayFile(file);
		expect(replay).toMatch(/Trace replay/);
		expect(replay).toMatch(/runtime\.agent.start/);
	});

	it("renders session timelines", async () => {
		const file = path.join(tmpDir, "session.jsonl");
		await fs.writeFile(
			file,
			[
				JSON.stringify({ type: "session", id: "session-1", cwd: "/tmp/project" }),
				JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
			].join("\n"),
			"utf-8",
		);

		const replay = await replayFile(file);
		expect(replay).toMatch(/Session replay/);
		expect(replay).toMatch(/user: hello/);
		expect(replay).toMatch(/assistant: hi/);
	});
});
