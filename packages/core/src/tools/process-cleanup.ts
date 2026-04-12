import { execSync } from "node:child_process";

/**
 * Kill a process and all its children immediately.
 *
 * Uses SIGKILL for immediate termination - prioritizes responsiveness
 * over graceful shutdown. Without this, aborting a bash command only
 * kills the parent shell, leaving child processes as orphans.
 */
export function killProcessTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
		} else {
			// Send SIGKILL to process group for immediate termination
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// Fallback to killing just the process if group kill fails
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Process already dead
				}
			}
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
