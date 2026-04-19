import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ExtensionRunner,
  noopActions,
  noopUI,
  type AgentContext,
  type ExtensionDefinition,
} from "@my-agent/core";
import type { Settings } from "../config/settings.js";

export interface LoadedExtensions {
  runner: ExtensionRunner;
  loadedIds: string[];
  entries: string[];
  dispose: () => Promise<void>;
}

export async function loadExtensionsForRun(options: {
  cwd: string;
  globalDir: string;
  settings: Settings;
  sessionId: string;
  getAgentContext: () => AgentContext | null;
}): Promise<LoadedExtensions | undefined> {
  const entries = await discoverExtensionEntries(options.cwd, options.globalDir, options.settings.extensions);
  if (entries.length === 0) return undefined;

  const runner = new ExtensionRunner({
    sessionId: options.sessionId,
    storageRoot: path.join(options.globalDir, "extension-storage"),
    ui: noopUI,
    actions: noopActions,
    getAgentContext: options.getAgentContext,
    log: {
      debug: () => {},
      info: () => {},
      warn: (msg, data) => console.warn(msg, data ?? ""),
      error: (msg, data) => console.error(msg, data ?? ""),
    },
  });

  const loadedIds: string[] = [];
  for (const entry of entries) {
    const definition = await importExtensionDefinition(entry);
    await runner.load(definition);
    loadedIds.push(definition.metadata.id);
  }

  return {
    runner,
    loadedIds,
    entries,
    dispose: async () => {
      for (const id of [...loadedIds].reverse()) {
        await runner.unload(id);
      }
    },
  };
}

async function discoverExtensionEntries(
  cwd: string,
  globalDir: string,
  configuredEntries: string[],
): Promise<string[]> {
  const candidates = [
    ...configuredEntries,
    path.join(cwd, ".my-agent", "extensions"),
    path.join(globalDir, "extensions"),
  ];
  const resolved = new Set<string>();

  for (const candidate of candidates) {
    for (const abs of resolveEntryPaths(candidate, cwd, globalDir)) {
      const stat = await safeStat(abs);
      if (!stat) continue;

      if (stat.isDirectory()) {
        const children = await fs.readdir(abs);
        for (const child of children) {
          if (!isSupportedExtensionFile(child)) continue;
          resolved.add(path.join(abs, child));
        }
      } else if (stat.isFile() && isSupportedExtensionFile(abs)) {
        resolved.add(abs);
      }
    }
  }

  return [...resolved].sort();
}

function resolveEntryPaths(entry: string, cwd: string, globalDir: string): string[] {
  if (!entry) return [];
  if (path.isAbsolute(entry)) return [entry];
  if (entry.startsWith("~/")) return [path.join(process.env.HOME || ".", entry.slice(2))];

  const paths = [path.resolve(cwd, entry)];
  const globalPath = path.resolve(globalDir, entry);
  if (!paths.includes(globalPath)) {
    paths.push(globalPath);
  }
  return paths;
}

async function safeStat(target: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

function isSupportedExtensionFile(filePath: string): boolean {
  return /\.(mjs|js|cjs)$/i.test(filePath);
}

async function importExtensionDefinition(entry: string): Promise<ExtensionDefinition> {
  const mod = (await import(pathToFileURL(path.resolve(entry)).href)) as Record<string, unknown>;
  const definition = (mod.default ?? mod.extension) as ExtensionDefinition | undefined;
  if (!definition || !definition.metadata || typeof definition.activate !== "function") {
    throw new Error(`Extension module ${entry} does not export a valid ExtensionDefinition`);
  }
  return definition;
}
