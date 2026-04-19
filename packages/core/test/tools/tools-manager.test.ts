import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureTool } from "../../src/tools/tools-manager.js";

describe("tools-manager", () => {
	let tmpDir: string;
	let originalPath: string | undefined;
	let originalHome: string | undefined;
	let originalOffline: string | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-manager-test-"));
		originalPath = process.env.PATH;
		originalHome = process.env.HOME;
		originalOffline = process.env.MY_AGENT_OFFLINE;
		process.env.PATH = "";
		process.env.HOME = tmpDir;
		process.env.MY_AGENT_OFFLINE = "1";
	});

	afterEach(async () => {
		if (originalPath === undefined) process.env.PATH = undefined;
		else process.env.PATH = originalPath;
		if (originalHome === undefined) process.env.HOME = undefined;
		else process.env.HOME = originalHome;
		if (originalOffline === undefined) process.env.MY_AGENT_OFFLINE = undefined;
		else process.env.MY_AGENT_OFFLINE = originalOffline;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("returns a clear error when a helper is missing in offline mode", async () => {
		const result = await ensureTool("rg", { silent: true });
		expect(result.path).toBeUndefined();
		expect(result.error).toMatch(/Offline mode enabled/);
	});
});
