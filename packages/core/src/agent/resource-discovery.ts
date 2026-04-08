import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProjectContextFile } from "./system-prompt.js";

const CONTEXT_FILES = ["CLAUDE.md", "AGENTS.md", ".agent-context.md"];
const SYSTEM_PROMPT_FILES = ["SYSTEM.md"];
const APPEND_SYSTEM_FILES = ["APPEND_SYSTEM.md"];

/** Maximum file size for context files (50KB) */
const MAX_FILE_SIZE = 50 * 1024;

export interface DiscoveryResult {
	/** Project context files (CLAUDE.md, AGENTS.md, etc.) */
	projectContext: ProjectContextFile[];
	/** Custom system prompt override (SYSTEM.md) — replaces base instructions if found */
	systemOverride?: string;
	/** Additional text to append to system prompt (APPEND_SYSTEM.md) */
	systemAppend?: string;
}

/**
 * Discover project context files by walking up from cwd.
 *
 * 1. Start at cwd, check for context files and system overrides
 * 2. Walk to parent directory, repeat
 * 3. Stop at home directory
 * 4. Check global config directory
 * 5. Deduplicate via realpath (handles symlinks)
 * 6. Enforce file size limits (50KB per file)
 *
 * Files closer to cwd are listed first (higher priority).
 * SYSTEM.md closest to cwd wins (only one override).
 */
export async function discoverProjectContext(
	cwd: string,
	globalDir?: string,
): Promise<DiscoveryResult> {
	const found: ProjectContextFile[] = [];
	const seen = new Set<string>();
	let systemOverride: string | undefined;
	const appendParts: string[] = [];

	let current = path.resolve(cwd);
	const root = path.parse(current).root;
	const home = process.env.HOME || process.env.USERPROFILE || root;

	// Walk up from cwd. Stop at home dir if inside home, or at root if outside home.
	// This handles repos in /tmp, mounted volumes, CI workspaces, etc.
	while (current !== root) {
		// Don't walk above home directory (if cwd is inside it)
		if (current.length < home.length && current.startsWith(home.slice(0, current.length))) break;

		// Context files (check both root and .my-agent/ subdirectory)
		for (const filename of CONTEXT_FILES) {
			await tryLoadContext(path.join(current, filename), "project", found, seen);
			await tryLoadContext(path.join(current, ".my-agent", filename), "project", found, seen);
		}

		// SYSTEM.md override — check both root and .my-agent/ (closest to cwd wins)
		if (!systemOverride) {
			for (const filename of SYSTEM_PROMPT_FILES) {
				const content =
					(await tryReadFile(path.join(current, filename))) ||
					(await tryReadFile(path.join(current, ".my-agent", filename)));
				if (content) {
					systemOverride = content;
					break;
				}
			}
		}

		// APPEND_SYSTEM.md — check both root and .my-agent/ (all found are concatenated)
		for (const filename of APPEND_SYSTEM_FILES) {
			const rootContent = await tryReadFile(path.join(current, filename));
			if (rootContent) appendParts.push(rootContent);
			const subContent = await tryReadFile(path.join(current, ".my-agent", filename));
			if (subContent) appendParts.push(subContent);
		}

		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	// Global config directory
	if (globalDir) {
		for (const filename of CONTEXT_FILES) {
			await tryLoadContext(path.join(globalDir, filename), "global", found, seen);
		}

		if (!systemOverride) {
			for (const filename of SYSTEM_PROMPT_FILES) {
				const content = await tryReadFile(path.join(globalDir, filename));
				if (content) systemOverride = content;
			}
		}

		for (const filename of APPEND_SYSTEM_FILES) {
			const content = await tryReadFile(path.join(globalDir, filename));
			if (content) appendParts.push(content);
		}
	}

	return {
		projectContext: found,
		systemOverride,
		systemAppend: appendParts.length > 0 ? appendParts.join("\n\n") : undefined,
	};
}

async function tryLoadContext(
	filePath: string,
	source: "project" | "user" | "global",
	found: ProjectContextFile[],
	seen: Set<string>,
): Promise<void> {
	try {
		const realPath = await fs.realpath(filePath);
		if (seen.has(realPath)) return;

		const stat = await fs.stat(realPath);
		if (stat.size > MAX_FILE_SIZE) {
			// Truncate oversized files
			const content = await fs.readFile(realPath, "utf-8");
			const truncated = content.slice(0, MAX_FILE_SIZE);
			seen.add(realPath);
			found.push({
				path: filePath,
				content: `${truncated.trim()}\n\n[TRUNCATED — file exceeds ${MAX_FILE_SIZE / 1024}KB limit]`,
				source,
			});
			return;
		}

		const content = await fs.readFile(realPath, "utf-8");
		if (content.trim()) {
			seen.add(realPath);
			found.push({ path: filePath, content: content.trim(), source });
		}
	} catch {
		// File doesn't exist or isn't readable — skip
	}
}

async function tryReadFile(filePath: string): Promise<string | undefined> {
	try {
		const stat = await fs.stat(filePath);
		if (stat.size > MAX_FILE_SIZE) return undefined;
		const content = await fs.readFile(filePath, "utf-8");
		return content.trim() || undefined;
	} catch {
		return undefined;
	}
}
