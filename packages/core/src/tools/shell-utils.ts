/**
 * Shell configuration and utilities.
 *
 * Provides cross-platform shell detection with fallbacks and helpful error messages.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface ShellConfig {
	shell: string;
	args: string[];
}

/**
 * Shell candidates to try, in order of preference.
 */
const SHELL_CANDIDATES = ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/bin/sh", "/usr/bin/sh"];

/**
 * Cache for shell config to avoid repeated filesystem checks.
 */
let cachedShellConfig: ShellConfig | null = null;

/**
 * Find a shell by checking if it exists on the filesystem.
 */
function findShellOnPath(name: string): string | null {
	try {
		const result = spawnSync("which", [name], {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (result.status === 0 && result.stdout) {
			const path = result.stdout.trim().split("\n")[0];
			if (path && existsSync(path)) {
				return path;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Get shell configuration for command execution.
 *
 * Resolution order:
 * 1. SHELL environment variable (if exists)
 * 2. Known shell locations (/bin/bash, /bin/zsh, /bin/sh)
 * 3. Shell found via `which`
 *
 * @throws Error with helpful message if no shell is found
 */
export function getShellConfig(): ShellConfig {
	if (cachedShellConfig) {
		return cachedShellConfig;
	}

	// 1. Try SHELL environment variable
	const envShell = process.env.SHELL;
	if (envShell && existsSync(envShell)) {
		cachedShellConfig = { shell: envShell, args: ["-c"] };
		return cachedShellConfig;
	}

	// 2. Try known shell locations
	for (const candidate of SHELL_CANDIDATES) {
		if (existsSync(candidate)) {
			cachedShellConfig = { shell: candidate, args: ["-c"] };
			return cachedShellConfig;
		}
	}

	// 3. Try finding bash or sh via which
	const bashPath = findShellOnPath("bash");
	if (bashPath) {
		cachedShellConfig = { shell: bashPath, args: ["-c"] };
		return cachedShellConfig;
	}

	const shPath = findShellOnPath("sh");
	if (shPath) {
		cachedShellConfig = { shell: shPath, args: ["-c"] };
		return cachedShellConfig;
	}

	// No shell found - provide helpful error
	const tried = envShell ? `SHELL=${envShell}, ` : "";
	throw new Error(
		`No shell found.\n` +
			`Tried: ${tried}${SHELL_CANDIDATES.join(", ")}\n` +
			`\n` +
			`Solutions:\n` +
			`  - Set SHELL environment variable to your shell path\n` +
			`  - Ensure /bin/bash or /bin/sh exists\n` +
			`  - On macOS: shells should be available by default\n` +
			`  - On Linux: install bash with your package manager`,
	);
}

/**
 * Get environment variables for shell execution.
 *
 * Sets TERM=dumb to prevent ANSI escape codes from most programs.
 * Note: Some programs ignore TERM, so output sanitization is still needed.
 */
export function getShellEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		TERM: "dumb",
	};
}

/**
 * Validate that a shell exists and is executable.
 *
 * @param shellPath Path to the shell
 * @throws Error if shell doesn't exist or isn't executable
 */
export function validateShell(shellPath: string): void {
	if (!existsSync(shellPath)) {
		throw new Error(`Shell not found: ${shellPath}`);
	}

	// Try to execute a simple command to verify it's a working shell
	try {
		const result = spawnSync(shellPath, ["-c", "echo test"], {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error) {
			throw new Error(`Shell not executable: ${shellPath} - ${result.error.message}`);
		}

		if (result.status !== 0) {
			throw new Error(`Shell test failed: ${shellPath} exited with code ${result.status}`);
		}
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("Shell")) {
			throw e;
		}
		throw new Error(`Shell validation failed: ${shellPath} - ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * Clear the cached shell config.
 * Useful for testing or when environment changes.
 */
export function clearShellConfigCache(): void {
	cachedShellConfig = null;
}
