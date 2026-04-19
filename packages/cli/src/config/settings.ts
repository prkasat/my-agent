import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getModel } from "@my-agent/ai";

/**
 * User settings.
 *
 * Priority (highest to lowest):
 * 1. CLI flags
 * 2. Project-level .my-agent/settings.json
 * 3. User-level ~/.my-agent/settings.json
 * 4. Defaults
 */

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface RetrySettings {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface Settings {
  model: string;
  provider: string;
  thinkingLevel: string;
  compaction: CompactionSettings;
  retry: RetrySettings;
  extensions: string[];
  packages: string[];
  enabledModels: string[];
  maxTurns: number;
  permissionMode: "ask" | "auto" | "strict";
}

const DEFAULTS: Settings = {
  model: "openrouter-auto",
  provider: "openrouter",
  thinkingLevel: "medium",
  compaction: {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
  },
  retry: {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2000,
    maxDelayMs: 60000,
  },
  extensions: [],
  packages: [],
  enabledModels: ["*"],
  maxTurns: 50,
  permissionMode: "ask",
};

export async function loadSettings(cwd: string): Promise<Settings> {
  const userDir = path.join(process.env.HOME || ".", ".my-agent");
  const projectDir = path.join(cwd, ".my-agent");

  const userSettings = await loadJsonFile(path.join(userDir, "settings.json"));
  const projectSettings = await loadJsonFile(path.join(projectDir, "settings.json"));

  return normalizeSettings(
    deepMerge(
      DEFAULTS as unknown as Record<string, unknown>,
      userSettings,
      projectSettings,
    ) as unknown as Settings,
  );
}

async function loadJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function deepMerge(...objects: Record<string, unknown>[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        result[key] = deepMerge((result[key] as Record<string, unknown>) || {}, value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

export async function saveSettings(
  settings: Partial<Settings>,
  scope: "user" | "project",
  cwd?: string,
): Promise<void> {
  const dir = scope === "user"
    ? path.join(process.env.HOME || ".", ".my-agent")
    : path.join(cwd || process.cwd(), ".my-agent");

  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "settings.json");

  let existing: Record<string, unknown> = {};
  try {
    const content = await fs.readFile(filePath, "utf-8");
    existing = JSON.parse(content);
  } catch {
    // New file
  }

  const merged = normalizeSettings(
    deepMerge(existing, settings as Record<string, unknown>) as unknown as Settings,
  );
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2), "utf-8");
}

function normalizeSettings(settings: Settings): Settings {
  try {
    const model = getModel(settings.model);
    return {
      ...settings,
      provider: model.provider,
    };
  } catch {
    return settings;
  }
}

export function getDefaultSettings(): Settings {
  return { ...DEFAULTS };
}
