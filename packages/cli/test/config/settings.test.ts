import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { loadSettings, saveSettings, getDefaultSettings } from "../../src/config/settings.js";

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
      expect(defaults.model).toBe("claude-sonnet-4-20250514");
      expect(defaults.provider).toBe("anthropic");
      expect(defaults.compaction.enabled).toBe(true);
      expect(defaults.retry.maxRetries).toBe(3);
    });
  });

  describe("loadSettings", () => {
    it("returns defaults when no config files exist", async () => {
      const settings = await loadSettings(tmpDir);
      expect(settings.model).toBe("claude-sonnet-4-20250514");
    });

    it("merges user settings over defaults", async () => {
      const userDir = path.join(tmpDir, ".my-agent");
      await fs.mkdir(userDir, { recursive: true });
      await fs.writeFile(
        path.join(userDir, "settings.json"),
        JSON.stringify({ model: "claude-opus-4-20250514" }),
      );

      const settings = await loadSettings(tmpDir);
      expect(settings.model).toBe("claude-opus-4-20250514");
      expect(settings.provider).toBe("anthropic");
    });

    it("project settings override user settings", async () => {
      const userDir = path.join(tmpDir, ".my-agent");
      const projectDir = path.join(tmpDir, "project", ".my-agent");
      await fs.mkdir(userDir, { recursive: true });
      await fs.mkdir(projectDir, { recursive: true });

      await fs.writeFile(
        path.join(userDir, "settings.json"),
        JSON.stringify({ model: "claude-opus-4-20250514" }),
      );
      await fs.writeFile(
        path.join(projectDir, "settings.json"),
        JSON.stringify({ model: "gpt-4o" }),
      );

      const settings = await loadSettings(path.join(tmpDir, "project"));
      expect(settings.model).toBe("gpt-4o");
    });

    it("deep merges nested objects", async () => {
      const userDir = path.join(tmpDir, ".my-agent");
      await fs.mkdir(userDir, { recursive: true });
      await fs.writeFile(
        path.join(userDir, "settings.json"),
        JSON.stringify({ compaction: { reserveTokens: 32768 } }),
      );

      const settings = await loadSettings(tmpDir);
      expect(settings.compaction.reserveTokens).toBe(32768);
      expect(settings.compaction.enabled).toBe(true);
    });
  });

  describe("saveSettings", () => {
    it("saves user settings", async () => {
      await saveSettings({ model: "gpt-4o" }, "user");

      const content = await fs.readFile(
        path.join(tmpDir, ".my-agent", "settings.json"),
        "utf-8",
      );
      expect(JSON.parse(content).model).toBe("gpt-4o");
    });

    it("saves project settings", async () => {
      const projectDir = path.join(tmpDir, "project");
      await fs.mkdir(projectDir, { recursive: true });

      await saveSettings({ model: "gpt-4o" }, "project", projectDir);

      const content = await fs.readFile(
        path.join(projectDir, ".my-agent", "settings.json"),
        "utf-8",
      );
      expect(JSON.parse(content).model).toBe("gpt-4o");
    });

    it("merges with existing settings", async () => {
      const userDir = path.join(tmpDir, ".my-agent");
      await fs.mkdir(userDir, { recursive: true });
      await fs.writeFile(
        path.join(userDir, "settings.json"),
        JSON.stringify({ model: "gpt-4o", provider: "openai" }),
      );

      await saveSettings({ model: "claude-opus-4-20250514" }, "user");

      const content = await fs.readFile(
        path.join(userDir, "settings.json"),
        "utf-8",
      );
      const saved = JSON.parse(content);
      expect(saved.model).toBe("claude-opus-4-20250514");
      expect(saved.provider).toBe("openai");
    });
  });
});
