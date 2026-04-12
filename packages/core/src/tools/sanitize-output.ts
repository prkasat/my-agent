/**
 * Output sanitization utilities for tool outputs.
 *
 * Handles:
 * - ANSI escape code removal (for programs that ignore TERM=dumb)
 * - Control character filtering (binary garbage)
 * - Carriage return normalization
 * - Environment variable redaction in error messages
 */

import stripAnsi from "strip-ansi";

/**
 * Patterns that indicate sensitive environment variables.
 * Used to redact values in error messages.
 */
const SENSITIVE_VAR_PATTERNS = [
	/password/i,
	/secret/i,
	/key/i,
	/token/i,
	/auth/i,
	/credential/i,
	/api_key/i,
	/apikey/i,
	/private/i,
	/bearer/i,
	/jwt/i,
	/session/i,
	/cookie/i,
];

/**
 * Sanitize command output for safe consumption.
 *
 * 1. Strip ANSI escape codes (colors, cursor movement)
 * 2. Normalize line endings (\r\n -> \n, lone \r -> \n)
 * 3. Remove control characters (except tab, newline)
 * 4. Filter Unicode format characters that crash string-width
 *
 * @param input Raw command output
 * @returns Sanitized output safe for LLM consumption
 */
export function sanitizeOutput(input: string): string {
	// 1. Strip ANSI escape codes
	let output = stripAnsi(input);

	// 2. Normalize line endings
	output = output.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

	// 3. Remove control characters and problematic Unicode
	// Use Array.from to properly iterate over code points (handles surrogate pairs)
	output = Array.from(output)
		.filter((char) => {
			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab (\t = 0x09) and newline (\n = 0x0A)
			if (code === 0x09 || code === 0x0a) return true;

			// Filter out control characters (0x00-0x1F)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters (crash string-width library)
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			// Filter out Unicode replacement character for binary garbage
			if (code === 0xfffd) return false;

			return true;
		})
		.join("");

	return output;
}

/**
 * Sanitize a Buffer containing command output.
 * Handles binary detection and UTF-8 conversion.
 *
 * @param buffer Raw output buffer
 * @returns Sanitized string, or placeholder if binary
 */
export function sanitizeBuffer(buffer: Buffer): string {
	// Check for binary content (null bytes in first 512 bytes)
	const checkLength = Math.min(buffer.length, 512);
	for (let i = 0; i < checkLength; i++) {
		if (buffer[i] === 0) {
			return `[Binary output detected, ${formatBytes(buffer.length)}]`;
		}
	}

	return sanitizeOutput(buffer.toString("utf-8"));
}

/**
 * Redact sensitive environment variable values from an error message.
 *
 * @param error Error message that may contain env var values
 * @param env Environment variables to check
 * @returns Error message with sensitive values redacted
 */
export function redactSensitiveEnv(error: string, env: NodeJS.ProcessEnv = process.env): string {
	let redacted = error;

	for (const [key, value] of Object.entries(env)) {
		// Skip empty values or very short values (avoid false positives)
		if (!value || value.length < 8) continue;

		// Check if this looks like a sensitive variable
		const isSensitive = SENSITIVE_VAR_PATTERNS.some((pattern) => pattern.test(key));
		if (!isSensitive) continue;

		// Redact all occurrences of the value
		redacted = redacted.split(value).join("[REDACTED]");
	}

	return redacted;
}

/**
 * Format byte count for display.
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
