/**
 * Retry wrapper for LLM API calls.
 *
 * Key patterns:
 * - Exponential backoff with jitter (prevents thundering herd)
 * - Only retry retryable errors (429, 500, 502, 503)
 * - Don't retry client errors (400, 401, 403)
 */

export interface RetryConfig {
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

const DEFAULT_RETRY: RetryConfig = {
	maxRetries: 3,
	baseDelayMs: 2000,
	maxDelayMs: 60000,
};

export function isRetryable(status: number): boolean {
	return status === 429 || status === 500 || status === 502 || status === 503;
}

export async function withRetry<T>(
	fn: () => Promise<T>,
	config: Partial<RetryConfig> = {},
	signal?: AbortSignal,
): Promise<T> {
	const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY, ...config };

	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (signal?.aborted) throw new Error("Aborted");

		try {
			return await fn();
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));

			const status = (err as Record<string, unknown>)?.status || (err as Record<string, unknown>)?.statusCode;
			if (typeof status === "number" && !isRetryable(status)) throw lastError;

			if (attempt === maxRetries) break;

			const delay = Math.min(baseDelayMs * 2 ** attempt + Math.random() * 1000, maxDelayMs);

			await sleep(delay, signal);
		}
	}

	throw lastError || new Error("Max retries exceeded");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Aborted"));
			},
			{ once: true },
		);
	});
}
