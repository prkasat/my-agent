import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AgentContext,
	EXTENSION_API_VERSION,
	type ExtensionActions,
	type ExtensionDefinition,
	ExtensionRunner,
	type ExtensionUI,
	isExtensionApiCompatible,
	noopActions,
	noopUI,
} from "@my-agent/core";
import type { Settings } from "../config/settings.js";

interface ExtensionLog {
	debug(msg: string, data?: unknown): void;
	info(msg: string, data?: unknown): void;
	warn(msg: string, data?: unknown): void;
	error(msg: string, data?: unknown): void;
}

function createSafeExtensionUI(ui: ExtensionUI, log: ExtensionLog): ExtensionUI {
	return {
		async select(items, options) {
			try {
				return await ui.select(items, options);
			} catch (error) {
				log.warn("Extension UI select failed; returning null instead of crashing the host.", error);
				return null;
			}
		},
		async confirm(message, options) {
			try {
				return await ui.confirm(message, options);
			} catch (error) {
				log.warn("Extension UI confirm failed; returning default value instead of crashing the host.", error);
				return options?.defaultValue ?? false;
			}
		},
		async input(message, options) {
			try {
				return await ui.input(message, options);
			} catch (error) {
				log.warn("Extension UI input failed; returning default value instead of crashing the host.", error);
				return options?.defaultValue ?? null;
			}
		},
		notify(message, level) {
			try {
				ui.notify(message, level);
			} catch (error) {
				log.warn("Extension UI notify failed; ignoring instead of crashing the host.", error);
			}
		},
	};
}

export interface LoadedExtensions {
	runner: ExtensionRunner;
	loadedIds: string[];
	entries: string[];
	warnings: string[];
	dispose: () => Promise<void>;
}

export async function loadExtensionsForRun(options: {
	cwd: string;
	globalDir: string;
	settings: Settings;
	sessionId: string;
	getAgentContext: () => AgentContext | null;
	extraEntries?: string[];
	ui?: ExtensionUI;
	actions?: ExtensionActions;
	log?: {
		debug(msg: string, data?: unknown): void;
		info(msg: string, data?: unknown): void;
		warn(msg: string, data?: unknown): void;
		error(msg: string, data?: unknown): void;
	};
}): Promise<LoadedExtensions | undefined> {
	const entries = await discoverExtensionEntries(options.cwd, options.globalDir, [
		...options.settings.extensions,
		...(options.extraEntries ?? []),
	]);
	if (entries.length === 0) return undefined;

	const log: ExtensionLog = options.log ?? {
		debug: () => {},
		info: () => {},
		warn: (msg: string, data?: unknown) => console.warn(msg, data ?? ""),
		error: (msg: string, data?: unknown) => console.error(msg, data ?? ""),
	};

	const runner = new ExtensionRunner({
		sessionId: options.sessionId,
		storageRoot: path.join(options.globalDir, "extension-storage"),
		ui: createSafeExtensionUI(options.ui ?? noopUI, log),
		actions: options.actions ?? noopActions,
		getAgentContext: options.getAgentContext,
		log,
	});

	const loadedIds: string[] = [];
	const warnings: string[] = [];
	for (const entry of entries) {
		try {
			const definition = await importExtensionDefinition(entry);
			const declaredApiVersion = definition.metadata.apiVersion;
			if (declaredApiVersion && !isExtensionApiCompatible(declaredApiVersion, EXTENSION_API_VERSION)) {
				const warning = `Skipping extension ${definition.metadata.id}: apiVersion ${declaredApiVersion} is incompatible with host ${EXTENSION_API_VERSION}`;
				warnings.push(warning);
				log.warn(warning, { entry });
				continue;
			}
			await runner.load(definition);
			loadedIds.push(definition.metadata.id);
		} catch (error) {
			const warning = `Skipping extension ${entry}: ${error instanceof Error ? error.message : String(error)}`;
			warnings.push(warning);
			log.warn(warning);
		}
	}

	return {
		runner,
		loadedIds,
		entries,
		warnings,
		dispose: async () => {
			for (const id of [...loadedIds].reverse()) {
				await runner.unload(id);
			}
		},
	};
}

export async function discoverExtensionEntries(
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

export async function importExtensionDefinition(entry: string): Promise<ExtensionDefinition> {
	const mod = (await import(pathToFileURL(path.resolve(entry)).href)) as Record<string, unknown>;
	const definition = (mod.default ?? mod.extension) as ExtensionDefinition | undefined;
	if (!definition?.metadata || typeof definition.activate !== "function") {
		throw new Error(`Extension module ${entry} does not export a valid ExtensionDefinition`);
	}
	return definition;
}

export async function inspectExtensions(options: {
	cwd: string;
	globalDir: string;
	settings: Settings;
	sessionId: string;
	extraEntries?: string[];
}): Promise<{
	entries: string[];
	loadedIds: string[];
	warnings: string[];
	commands: Array<{ name: string; extensionId: string }>;
	tools: string[];
}> {
	const runtime = await loadExtensionsForRun({
		cwd: options.cwd,
		globalDir: options.globalDir,
		settings: options.settings,
		sessionId: options.sessionId,
		extraEntries: options.extraEntries,
		getAgentContext: () => null,
		ui: noopUI,
		actions: noopActions,
	});

	if (!runtime) {
		return { entries: [], loadedIds: [], warnings: [], commands: [], tools: [] };
	}

	try {
		return {
			entries: runtime.entries,
			loadedIds: runtime.loadedIds,
			warnings: runtime.warnings,
			commands: runtime.runner.getAllCommands().map((command) => ({
				name: command.name,
				extensionId: command.extensionId,
			})),
			tools: runtime.runner.getAllTools().map((tool) => tool.name),
		};
	} finally {
		await runtime.dispose();
	}
}

export async function runExtensionCommand(options: {
	cwd: string;
	globalDir: string;
	settings: Settings;
	sessionId: string;
	command: string;
	args: string;
	extraEntries?: string[];
}): Promise<{ matched: boolean; output: string[]; prompts: string[] }> {
	const output: string[] = [];
	const prompts: string[] = [];
	const runtime = await loadExtensionsForRun({
		cwd: options.cwd,
		globalDir: options.globalDir,
		settings: options.settings,
		sessionId: options.sessionId,
		extraEntries: options.extraEntries,
		getAgentContext: () => null,
		ui: {
			async select() {
				return null;
			},
			async confirm(_message, uiOptions) {
				return uiOptions?.defaultValue ?? false;
			},
			async input(_message, uiOptions) {
				return uiOptions?.defaultValue ?? null;
			},
			notify(message) {
				output.push(message);
			},
		},
		actions: {
			...noopActions,
			sendMessage(content) {
				prompts.push(content);
			},
		},
	});

	if (!runtime) {
		return { matched: false, output, prompts };
	}

	if (runtime.warnings.length > 0) {
		output.push(...runtime.warnings);
	}

	try {
		const matched = await runtime.runner.runCommand(options.command, options.args);
		return { matched, output, prompts };
	} finally {
		await runtime.dispose();
	}
}
