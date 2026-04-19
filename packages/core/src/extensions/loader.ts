/**
 * ExtensionLoader — discovery and hot-reload.
 *
 * Loading strategy:
 *  - Extensions are ES modules that export a default `ExtensionDefinition`
 *    (or a named `extension` export).
 *  - We dynamic-import the file URL with a cache-busting query string on
 *    reload. This creates a new module in the Node ESM registry each time;
 *    memory-wise this is not free, but reloads during development are
 *    bounded, and the old modules are GC-eligible once their activations
 *    are deactivated and references dropped.
 *
 * Hot-reload triggers (either):
 *  - `loader.reload(id)` called manually.
 *  - `loader.watch(paths)` enabled, which uses fs.watch on each entry file.
 *
 * The loader does NOT compile TypeScript — callers should register
 * compiled .js files, or register a module directly via
 * `runner.load(definition)`.
 */

import { type FSWatcher, watch } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionRunner } from "./runner.js";
import type { ExtensionDefinition, ExtensionManifest } from "./types.js";

export interface LoaderOptions {
	runner: ExtensionRunner;
	log?: {
		debug(msg: string, data?: unknown): void;
		info(msg: string, data?: unknown): void;
		warn(msg: string, data?: unknown): void;
		error(msg: string, data?: unknown): void;
	};
}

interface LoadedEntry {
	manifest: ExtensionManifest;
	loadedAt: number;
	/** Token appended to import URLs to bust the ESM module cache. */
	version: number;
}

export class ExtensionLoader {
	private readonly runner: ExtensionRunner;
	private readonly entries = new Map<string, LoadedEntry>();
	private readonly watchers = new Map<string, FSWatcher>();
	private readonly reloadDebounces = new Map<string, NodeJS.Timeout>();
	private readonly log: NonNullable<LoaderOptions["log"]>;
	private hotReloadEnabled = false;
	private hotReloadDebounceMs = 150;

	constructor(options: LoaderOptions) {
		this.runner = options.runner;
		this.log = options.log ?? {
			debug: () => {},
			info: () => {},
			warn: (msg) => console.warn(`[ext-loader] ${msg}`),
			error: (msg, data) => console.error(`[ext-loader] ${msg}`, data ?? ""),
		};
	}

	/** Load one extension from a manifest. */
	async loadFromManifest(manifest: ExtensionManifest): Promise<void> {
		if (manifest.disabled) {
			this.log.info(`[ext-loader] skipping disabled extension ${manifest.metadata.id}`);
			return;
		}
		// Import FIRST so a failed import or id mismatch can't leave stale
		// bookkeeping in this.entries.
		const def = await this.importModule(manifest.entry, 0);
		if (def.metadata.id !== manifest.metadata.id) {
			throw new Error(
				`Manifest id "${manifest.metadata.id}" does not match module id "${def.metadata.id}" for ${manifest.entry}`,
			);
		}
		await this.runner.load(def, manifest.userConfig);

		// Only track the entry after a successful activation.
		this.entries.set(manifest.metadata.id, {
			manifest,
			loadedAt: Date.now(),
			version: 0,
		});

		// If hot-reload is active, auto-watch the newly loaded entry.
		if (this.hotReloadEnabled) this.watchEntry(manifest.metadata.id);
	}

	/** Load many manifests, respecting `requires` ordering. */
	async loadAll(manifests: ExtensionManifest[]): Promise<void> {
		const sorted = topologicalSort(manifests);
		for (const m of sorted) {
			try {
				await this.loadFromManifest(m);
			} catch (err) {
				this.log.error(`failed to load extension ${m.metadata.id}`, err);
			}
		}
	}

	/** Reload a single extension by id, re-importing its module. */
	async reload(id: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Extension ${id} is not loaded`);

		const nextVersion = entry.version + 1;
		const def = await this.importModule(entry.manifest.entry, nextVersion);
		if (def.metadata.id !== entry.manifest.metadata.id) {
			throw new Error(
				`Reloaded module changed its id ("${entry.manifest.metadata.id}" -> "${def.metadata.id}"); refusing to reload. Unload the extension and load the new one explicitly.`,
			);
		}
		await this.runner.reload(def, entry.manifest.userConfig);
		entry.version = nextVersion;
		entry.loadedAt = Date.now();
		this.log.info(`[ext-loader] reloaded ${id} (v${entry.version})`);
	}

	/** Unload a single extension by id. */
	async unload(id: string): Promise<void> {
		await this.runner.unload(id);
		this.stopWatching(id);
		this.entries.delete(id);
	}

	/**
	 * Start watching entry files for changes. Extensions loaded afterward
	 * are automatically watched too (handled inside loadFromManifest).
	 */
	enableHotReload(options?: { debounceMs?: number }): void {
		this.hotReloadEnabled = true;
		this.hotReloadDebounceMs = options?.debounceMs ?? 150;
		for (const id of this.entries.keys()) this.watchEntry(id);
	}

	/** Stop all watchers. Call on shutdown. */
	disableHotReload(): void {
		this.hotReloadEnabled = false;
		for (const id of Array.from(this.watchers.keys())) {
			this.stopWatching(id);
		}
		for (const t of this.reloadDebounces.values()) clearTimeout(t);
		this.reloadDebounces.clear();
	}

	private watchEntry(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		if (entry.manifest.metadata.hotReloadable === false) return;
		if (this.watchers.has(id)) return;
		const watcher = watch(entry.manifest.entry, { persistent: false }, () => {
			this.scheduleReload(id, this.hotReloadDebounceMs);
		});
		watcher.on("error", (err) => {
			this.log.warn(`watcher error for ${id}: ${err.message}`);
		});
		this.watchers.set(id, watcher);
	}

	// --------------------------------------------------------------------
	// Internals
	// --------------------------------------------------------------------

	private scheduleReload(id: string, debounceMs: number): void {
		const existing = this.reloadDebounces.get(id);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.reloadDebounces.delete(id);
			this.reload(id).catch((err) => {
				this.log.error(`auto-reload failed for ${id}`, err);
			});
		}, debounceMs);
		this.reloadDebounces.set(id, timer);
	}

	private stopWatching(id: string): void {
		const watcher = this.watchers.get(id);
		if (watcher) {
			try {
				watcher.close();
			} catch {
				/* ignore */
			}
			this.watchers.delete(id);
		}
	}

	private async importModule(entry: string, version: number): Promise<ExtensionDefinition> {
		const abs = resolvePath(entry);
		const url = pathToFileURL(abs).href;
		const withBuster = version > 0 ? `${url}?v=${version}` : url;
		const mod = (await import(withBuster)) as Record<string, unknown>;
		const def = (mod.default ?? mod.extension) as ExtensionDefinition | undefined;
		if (!def || !def.metadata || typeof def.activate !== "function") {
			throw new Error(`Module ${entry} does not export a valid ExtensionDefinition (default or "extension")`);
		}
		return def;
	}
}

// =============================================================================
// Dependency sort
// =============================================================================

function topologicalSort(manifests: ExtensionManifest[]): ExtensionManifest[] {
	const byId = new Map<string, ExtensionManifest>();
	for (const m of manifests) byId.set(m.metadata.id, m);

	const visited = new Set<string>();
	const visiting = new Set<string>();
	const out: ExtensionManifest[] = [];

	function visit(id: string, stack: string[]): void {
		if (visited.has(id)) return;
		if (visiting.has(id)) {
			throw new Error(`Extension dependency cycle: ${[...stack, id].join(" -> ")}`);
		}
		const m = byId.get(id);
		if (!m) return; // unknown dep — caller may warn
		visiting.add(id);
		for (const dep of m.metadata.requires ?? []) {
			if (!byId.has(dep)) {
				throw new Error(`Extension "${id}" requires "${dep}" which is not available`);
			}
			visit(dep, [...stack, id]);
		}
		for (const dep of m.metadata.optionalRequires ?? []) {
			if (byId.has(dep)) visit(dep, [...stack, id]);
		}
		visiting.delete(id);
		visited.add(id);
		out.push(m);
	}

	for (const m of manifests) visit(m.metadata.id, []);
	return out;
}
