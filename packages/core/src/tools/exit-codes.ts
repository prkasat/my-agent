/**
 * Exit code interpretation utilities.
 *
 * Provides human-readable explanations for common exit codes,
 * helping LLMs and users understand why a command failed.
 */

/**
 * Common exit codes and their meanings.
 */
const EXIT_CODE_MEANINGS: Record<number, string> = {
	0: "success",
	1: "general error",
	2: "misuse of shell command or invalid arguments",
	126: "command found but not executable (permission denied)",
	127: "command not found",
	128: "invalid exit argument",
	130: "terminated by Ctrl+C (SIGINT)",
	137: "killed (SIGKILL) — likely OOM, timeout, or external termination",
	139: "segmentation fault (SIGSEGV)",
	143: "terminated (SIGTERM)",
};

/**
 * Signal number to name mapping (Unix signals).
 */
const SIGNAL_NAMES: Record<number, string> = {
	1: "SIGHUP",
	2: "SIGINT",
	3: "SIGQUIT",
	6: "SIGABRT",
	9: "SIGKILL",
	11: "SIGSEGV",
	13: "SIGPIPE",
	14: "SIGALRM",
	15: "SIGTERM",
};

/**
 * Format an exit code with human-readable explanation.
 *
 * @param code Exit code from process
 * @returns Formatted string explaining the exit code
 *
 * @example
 * formatExitCode(0)   // "success (code 0)"
 * formatExitCode(1)   // "general error (code 1)"
 * formatExitCode(137) // "killed by SIGKILL (code 137) — likely OOM, timeout, or external termination"
 * formatExitCode(42)  // "code 42"
 */
export function formatExitCode(code: number): string {
	// Check for signal-based exit codes (128 + signal number)
	if (code >= 128 && code < 165) {
		const signalNum = code - 128;
		const signalName = SIGNAL_NAMES[signalNum] ?? `signal ${signalNum}`;
		const meaning = EXIT_CODE_MEANINGS[code];

		if (meaning) {
			return `${meaning.replace(/\([^)]+\)/, `(${signalName})`)} (code ${code})`;
		}
		return `killed by ${signalName} (code ${code})`;
	}

	// Check for known exit codes
	const meaning = EXIT_CODE_MEANINGS[code];
	if (meaning) {
		return `${meaning} (code ${code})`;
	}

	// Unknown exit code
	return `code ${code}`;
}

/**
 * Determine if an exit code indicates a transient/retriable failure.
 *
 * @param code Exit code from process
 * @returns true if the failure might be transient
 */
export function isTransientFailure(code: number): boolean {
	// OOM kills, resource exhaustion
	if (code === 137) return true;

	// SIGPIPE (broken pipe - network issues)
	if (code === 141) return true;

	return false;
}

/**
 * Determine if an exit code indicates the command was not found.
 *
 * @param code Exit code from process
 * @returns true if command was not found
 */
export function isCommandNotFound(code: number): boolean {
	return code === 127;
}

/**
 * Determine if an exit code indicates permission issues.
 *
 * @param code Exit code from process
 * @returns true if permission denied
 */
export function isPermissionDenied(code: number): boolean {
	return code === 126;
}
