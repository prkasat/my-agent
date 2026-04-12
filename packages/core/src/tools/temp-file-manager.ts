/**
 * Temporary file management utilities.
 *
 * Handles creation, tracking, and cleanup of temp files created during
 * command execution. Keeps files on failure for debugging, cleans up on success.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Prefix for all temp files created by the agent.
 */
const TEMP_FILE_PREFIX = "my-agent-";

/**
 * Maximum age of temp files before cleanup (24 hours).
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum total size of temp files before cleanup (100MB).
 */
const MAX_TOTAL_SIZE = 100 * 1024 * 1024;

/**
 * Track temp files created in the current session.
 */
const sessionTempFiles = new Set<string>();

/**
 * Generate a unique temp file path.
 *
 * @param suffix File suffix (e.g., ".log")
 * @returns Unique temp file path
 */
export function getTempFilePath(suffix = ".log"): string {
	const id = randomBytes(8).toString("hex");
	const path = join(tmpdir(), `${TEMP_FILE_PREFIX}${id}${suffix}`);
	sessionTempFiles.add(path);
	return path;
}

/**
 * Mark a temp file for cleanup on success.
 * File will be deleted when cleanupOnSuccess() is called.
 *
 * @param path Path to temp file
 */
export function markForCleanup(path: string): void {
	sessionTempFiles.add(path);
}

/**
 * Remove a temp file from cleanup tracking.
 * Use when you want to preserve a file (e.g., on failure).
 *
 * @param path Path to temp file
 */
export function preserveTempFile(path: string): void {
	sessionTempFiles.delete(path);
}

/**
 * Clean up a specific temp file.
 *
 * @param path Path to temp file
 * @returns true if file was deleted, false if it didn't exist
 */
export function cleanupTempFile(path: string): boolean {
	sessionTempFiles.delete(path);

	if (!existsSync(path)) {
		return false;
	}

	try {
		rmSync(path, { force: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * Clean up all temp files created in this session.
 * Call this after successful operations.
 */
export function cleanupSessionTempFiles(): void {
	for (const path of sessionTempFiles) {
		cleanupTempFile(path);
	}
	sessionTempFiles.clear();
}

/**
 * Clean up old temp files created by the agent.
 * Removes files older than MAX_AGE_MS or when total size exceeds MAX_TOTAL_SIZE.
 *
 * @returns Number of files cleaned up
 */
export function cleanupOldTempFiles(): number {
	const tempDir = tmpdir();
	let cleanedCount = 0;

	try {
		const files = readdirSync(tempDir) as string[];
		const agentFiles: Array<{ path: string; mtime: number; size: number }> = [];

		// Collect agent temp files
		for (const file of files) {
			if (!file.startsWith(TEMP_FILE_PREFIX)) continue;

			const fullPath = join(tempDir, file);
			try {
				const stats = statSync(fullPath);
				agentFiles.push({
					path: fullPath,
					mtime: stats.mtimeMs,
					size: stats.size,
				});
			} catch {
				// Skip files we can't stat
			}
		}

		// Sort by age (oldest first)
		agentFiles.sort((a, b) => a.mtime - b.mtime);

		const now = Date.now();
		let totalSize = agentFiles.reduce((sum, f) => sum + f.size, 0);

		// Clean up old or excess files
		for (const file of agentFiles) {
			const age = now - file.mtime;
			const shouldDelete = age > MAX_AGE_MS || totalSize > MAX_TOTAL_SIZE;

			if (shouldDelete) {
				try {
					rmSync(file.path, { force: true });
					totalSize -= file.size;
					cleanedCount++;
				} catch {
					// Ignore cleanup errors
				}
			}
		}
	} catch {
		// Ignore errors reading temp directory
	}

	return cleanedCount;
}

/**
 * Get information about agent temp files.
 *
 * @returns Object with count and total size of temp files
 */
export function getTempFileStats(): { count: number; totalSize: number } {
	const tempDir = tmpdir();
	let count = 0;
	let totalSize = 0;

	try {
		const files = readdirSync(tempDir) as string[];

		for (const file of files) {
			if (!file.startsWith(TEMP_FILE_PREFIX)) continue;

			const fullPath = join(tempDir, file);
			try {
				const stats = statSync(fullPath);
				count++;
				totalSize += stats.size;
			} catch {
				// Skip files we can't stat
			}
		}
	} catch {
		// Ignore errors
	}

	return { count, totalSize };
}
