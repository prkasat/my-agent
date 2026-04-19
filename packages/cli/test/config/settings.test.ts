import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultSettings, loadSettings, saveSettings } from "../../src/config/settings.js";

describe("Settings", () => {
	let tmpDir: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-test-"));
		originalHome = process.env.HOME;
		process.env.HOME = tmpDir;
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	describe("getDefaultSettings", () => {
		it("returns default values", () => {
			const defaults = getDefaultSettings();
			expect(defaults.model).toBe("openrouter-auto");
			expect(defaults.provider).toBe("openrouter");
			expect(defaults.compaction.enabled).toBe(true);
			expect(defaults.retry.maxRetries).toBe(3);
		});
	});

	describe("loadSettings", () => {
		it("returns defaults when no config files exist", async () => {
			const settings = await loadSettings(tmpDir);
			expect(settings.model).toBe("openrouter-auto");
			expect(settings.provider).toBe("openrouter");
		});

		it("merges user settings over defaults and normalizes provider from model", async () => {
			const userDir = path.join(tmpDir, ".my-agent");
			await fs.mkdir(userDir, { recursive: true });
			await fs.writeFile(path.join(userDir, "settings.json"), JSON.stringify({ model: "claude-opus-4" }));

			const settings = await loadSettings(tmpDir);
			expect(settings.model).toBe("claude-opus-4");
			expect(settings.provider).toBe("anthropic");
		});

		it("project settings override user settings", async () => {
			const userDir = path.join(tmpDir, ".my-agent");
			const projectDir = path.join(tmpDir, "project", ".my-agent");
			await fs.mkdir(userDir, { recursive: true });
			await fs.mkdir(projectDir, { recursive: true });

			await fs.writeFile(path.join(userDir, "settings.json"), JSON.stringify({ model: "claude-opus-4" }));
			await fs.writeFile(path.join(projectDir, "settings.json"), JSON.stringify({ model: "qwen3.6-plus" }));

			const settings = await loadSettings(path.join(tmpDir, "project"));
			expect(settings.model).toBe("qwen3.6-plus");
			expect(settings.provider).toBe("openrouter");
		});

		it("deep merges nested objects", async () => {
			const userDir = path.join(tmpDir, ".my-agent");
			await fs.mkdir(userDir, { recursive: true });
			await fs.writeFile(path.join(userDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 32768 } }));

			const settings = await loadSettings(tmpDir);
			expect(settings.compaction.reserveTokens).toBe(32768);
			expect(settings.compaction.enabled).toBe(true);
		});

		it("backs up a corrupted settings file and falls back to defaults", async () => {
			const userDir = path.join(tmpDir, ".my-agent");
			await fs.mkdir(userDir, { recursive: true });
			await fs.writeFile(path.join(userDir, "settings.json"), "{not valid json", "utf-8");

			const settings = await loadSettings(tmpDir);
			expect(settings.model).toBe("openrouter-auto");

			const files = await fs.readdir(userDir);
			expect(files.some((file) => file.startsWith("settings.json.corrupt-"))).toBe(true);
		});
	});

	describe("saveSettings", () => {
		it("saves user settings", async () => {
			await saveSettings({ model: "qwen3.6-plus" }, "user");

			const content = await fs.readFile(path.join(tmpDir, ".my-agent", "settings.json"), "utf-8");
			const saved = JSON.parse(content);
			expect(saved.model).toBe("qwen3.6-plus");
			expect(saved.provider).toBe("openrouter");
		});

		it("saves project settings", async () => {
			const projectDir = path.join(tmpDir, "project");
			await fs.mkdir(projectDir, { recursive: true });

			await saveSettings({ model: "claude-sonnet-4" }, "project", projectDir);

			const content = await fs.readFile(path.join(projectDir, ".my-agent", "settings.json"), "utf-8");
			const saved = JSON.parse(content);
			expect(saved.model).toBe("claude-sonnet-4");
			expect(saved.provider).toBe("anthropic");
		});

		it("merges with existing settings and normalizes provider", async () => {
			const userDir = path.join(tmpDir, ".my-agent");
			await fs.mkdir(userDir, { recursive: true });
			await fs.writeFile(
				path.join(userDir, "settings.json"),
				JSON.stringify({ model: "openrouter-auto", provider: "anthropic" }),
			);

			await saveSettings({ model: "claude-opus-4" }, "user");

			const content = await fs.readFile(path.join(userDir, "settings.json"), "utf-8");
			const saved = JSON.parse(content);
			expect(saved.model).toBe("claude-opus-4");
			expect(saved.provider).toBe("anthropic");
		});
	});
});
