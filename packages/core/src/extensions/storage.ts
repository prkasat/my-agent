/**
 * File-backed storage for extensions.
 *
 * Each extension gets two scopes:
 *   - session: tied to a specific session id (path: <root>/sessions/<sid>/<extId>.json)
 *   - global:  shared across sessions (path: <root>/global/<extId>.json)
 *
 * Writes are synchronous (flushed on every mutation). That is a deliberate
 * simplicity choice — extensions shouldn't be writing megabytes of state.
 * If we later need batching, add a debounce layer on top; do not change
 * the public API.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionStorage, StorageScope } from "./types.js";

export interface StorageOptions {
	/** Root directory for all extension storage. */
	root: string;
	/** Extension id (used to name files). */
	extensionId: string;
	/** Current session id (required for session-scoped storage). */
	sessionId?: string;
}

/**
 * Sanitize an id so it's safe to use as a filename. Drops anything that
 * isn't [A-Za-z0-9_.-] so an extension id can't escape its storage root.
 */
function sanitize(id: string): string {
	const cleaned = id.replace(/[^A-Za-z0-9_.-]/g, "_");
	if (!cleaned || cleaned === "." || cleaned === "..") {
		throw new Error(`Invalid storage id: ${JSON.stringify(id)}`);
	}
	return cleaned;
}

/**
 * Read-then-write strategy (no long-lived cache): every mutation re-reads
 * the file from disk, applies the change, and writes the result via a
 * temp file + renameSync. This protects *serialized* sibling writers on
 * disjoint keys from silently clobbering each other; it does NOT make
 * concurrent overlapping writers (e.g. two processes racing between the
 * read and the rename) safe. If/when we need multi-process sharing, add a
 * lockfile or optimistic version-check retry around the whole mutation.
 *
 * Durability: writes are atomically replaced where the filesystem
 * supports it, but neither the temp file nor the parent directory is
 * fsynced. On power loss the file may contain the previous version.
 * Extension state is considered best-effort; losing a few KB of
 * extension-local state is not catastrophic.
 */
export class FileExtensionStorage implements ExtensionStorage {
	private readonly root: string;
	private readonly extensionId: string;
	private readonly sessionId?: string;

	constructor(options: StorageOptions) {
		this.root = resolve(options.root);
		this.extensionId = sanitize(options.extensionId);
		this.sessionId = options.sessionId ? sanitize(options.sessionId) : undefined;
	}

	private pathFor(scope: StorageScope): string {
		const extFile = `${this.extensionId}.json`;
		if (scope === "global") {
			return join(this.root, "global", extFile);
		}
		if (!this.sessionId) {
			throw new Error(
				`Extension storage: session scope requires a sessionId (extension=${this.extensionId})`,
			);
		}
		return join(this.root, "sessions", this.sessionId, extFile);
	}

	private readFromDisk(scope: StorageScope): Record<string, unknown> {
		const path = this.pathFor(scope);
		if (!existsSync(path)) return {};
		try {
			const raw = readFileSync(path, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Corrupt file — treat as empty rather than crashing the agent.
		}
		return {};
	}

	private writeToDisk(scope: StorageScope, data: Record<string, unknown>): void {
		const path = this.pathFor(scope);
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
		try {
			renameSync(tmp, path);
		} catch {
			writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
			if (existsSync(tmp)) rmSync(tmp, { force: true });
		}
	}

	get<T>(key: string, scope: StorageScope = "session"): T | undefined {
		const data = this.readFromDisk(scope);
		return data[key] as T | undefined;
	}

	set<T>(key: string, value: T, scope: StorageScope = "session"): void {
		const data = this.readFromDisk(scope);
		data[key] = value;
		this.writeToDisk(scope, data);
	}

	delete(key: string, scope: StorageScope = "session"): boolean {
		const data = this.readFromDisk(scope);
		if (!(key in data)) return false;
		delete data[key];
		this.writeToDisk(scope, data);
		return true;
	}

	keys(scope: StorageScope = "session"): string[] {
		return Object.keys(this.readFromDisk(scope));
	}

	clear(scope?: StorageScope): void {
		if (scope) {
			this.writeToDisk(scope, {});
			return;
		}
		this.writeToDisk("global", {});
		if (this.sessionId) this.writeToDisk("session", {});
	}
}

/**
 * In-memory storage — useful for tests and for extensions that don't want
 * to persist anything.
 */
export class MemoryExtensionStorage implements ExtensionStorage {
	private readonly stores: Record<StorageScope, Map<string, unknown>> = {
		session: new Map(),
		global: new Map(),
	};

	get<T>(key: string, scope: StorageScope = "session"): T | undefined {
		return this.stores[scope].get(key) as T | undefined;
	}

	set<T>(key: string, value: T, scope: StorageScope = "session"): void {
		this.stores[scope].set(key, value);
	}

	delete(key: string, scope: StorageScope = "session"): boolean {
		return this.stores[scope].delete(key);
	}

	keys(scope: StorageScope = "session"): string[] {
		return Array.from(this.stores[scope].keys());
	}

	clear(scope?: StorageScope): void {
		if (scope) {
			this.stores[scope].clear();
			return;
		}
		this.stores.session.clear();
		this.stores.global.clear();
	}
}
