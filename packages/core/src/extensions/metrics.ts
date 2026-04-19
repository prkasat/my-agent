/**
 * Per-extension metrics recorder.
 *
 * The runner wraps every handler call in recordExecution() and catches
 * errors via recordError(). Extensions can opt-in to finer-grained
 * tracking (token attribution, API call counts) via the recorder passed
 * to them in ExtensionContext.
 */

import type { ExtensionMetrics, MetricsRecorder } from "./types.js";

export class MetricsTracker implements MetricsRecorder {
	private _tokensUsed = 0;
	private _apiCalls = 0;
	private _executionTimeMs = 0;
	private _errors = 0;
	private _firstActiveAt?: number;
	private _lastActiveAt?: number;

	recordTokens(n: number): void {
		if (n <= 0) return;
		this._tokensUsed += n;
		this.touch();
	}

	recordApiCall(): void {
		this._apiCalls += 1;
		this.touch();
	}

	recordExecution(ms: number): void {
		if (ms < 0) return;
		this._executionTimeMs += ms;
		this.touch();
	}

	recordError(): void {
		this._errors += 1;
		this.touch();
	}

	snapshot(): ExtensionMetrics {
		return {
			tokensUsed: this._tokensUsed,
			apiCalls: this._apiCalls,
			executionTimeMs: this._executionTimeMs,
			errors: this._errors,
			firstActiveAt: this._firstActiveAt,
			lastActiveAt: this._lastActiveAt,
		};
	}

	reset(): void {
		this._tokensUsed = 0;
		this._apiCalls = 0;
		this._executionTimeMs = 0;
		this._errors = 0;
		this._firstActiveAt = undefined;
		this._lastActiveAt = undefined;
	}

	private touch(): void {
		const now = Date.now();
		if (this._firstActiveAt === undefined) this._firstActiveAt = now;
		this._lastActiveAt = now;
	}
}
