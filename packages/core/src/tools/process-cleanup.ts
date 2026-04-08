import { execSync } from "node:child_process";

/**
 * Kill a process and all its children.
 *
 * Without this, aborting a bash command only kills the parent shell,
 * leaving child processes (servers, watchers) as orphans.
 */
export function killProcessTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
		} else {
			// Send SIGTERM to process group
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				process.kill(pid, "SIGTERM");
			}

			// Give 3s for graceful shutdown, then SIGKILL
			setTimeout(() => {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					// Already dead
				}
			}, 3000);
		}
	} catch {
		// Process already exited
	}
}

/**
 * Create an AbortController with timeout.
 * Chains to an optional parent signal.
 */
export function createTimeoutController(
	timeoutMs: number,
	parent?: AbortSignal,
): { controller: AbortController; cleanup: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	if (parent) {
		parent.addEventListener("abort", () => controller.abort(), { once: true });
	}

	return {
		controller,
		cleanup: () => clearTimeout(timer),
	};
}
