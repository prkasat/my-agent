import * as fs from "node:fs";

/**
 * Per-file mutation serialization.
 *
 * When tools execute in parallel, two tools might write the same file.
 * This ensures writes to the same file are serialized while writes
 * to different files proceed in parallel.
 *
 * Implementation: Map from resolved file path to a promise chain.
 * Each new operation chains onto the existing promise for that path.
 */

const queues = new Map<string, Promise<void>>();

export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	// Resolve symlinks to get canonical path
	let resolvedPath: string;
	try {
		resolvedPath = fs.realpathSync.native(filePath);
	} catch {
		resolvedPath = filePath; // File doesn't exist yet
	}

	// Chain onto existing queue for this path
	const existing = queues.get(resolvedPath) || Promise.resolve();
	let result: T;

	const newPromise = existing.then(async () => {
		result = await fn();
	});

	// Don't propagate errors to future operations
	queues.set(
		resolvedPath,
		newPromise.catch(() => {}),
	);

	// Cleanup when queue is empty
	newPromise.finally(() => {
		if (queues.get(resolvedPath) === newPromise) {
			queues.delete(resolvedPath);
		}
	});

	await newPromise;
	return result!;
}
