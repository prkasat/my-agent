/**
 * A generic async iterable stream with a final result.
 *
 * Events are pushed by a producer and consumed via async iteration.
 * When a "complete" event arrives, the result promise resolves.
 *
 * This dual-access pattern handles two needs simultaneously:
 * (1) streaming UI updates via for-await and
 * (2) awaiting the final response via result().
 */
export class EventStream<TEvent, TResult> implements AsyncIterable<TEvent> {
	private queue: TEvent[] = [];
	private waiting: ((value: IteratorResult<TEvent>) => void) | null = null;
	private done = false;

	private resultPromise: Promise<TResult>;
	private resolveResult!: (result: TResult) => void;
	private rejectResult!: (error: Error) => void;

	constructor(
		private isComplete: (event: TEvent) => boolean,
		private extractResult: (event: TEvent) => TResult,
	) {
		this.resultPromise = new Promise((resolve, reject) => {
			this.resolveResult = resolve;
			this.rejectResult = reject;
		});
	}

	/**
	 * Push an event into the stream.
	 * If a consumer is waiting, deliver immediately.
	 * If this is a completion event, resolve the result.
	 */
	push(event: TEvent): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			try {
				this.resolveResult(this.extractResult(event));
			} catch (err) {
				this.rejectResult(err instanceof Error ? err : new Error(String(err)));
			}
		}

		// Deliver to waiting consumer or queue
		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = null;
			resolve({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	/**
	 * Terminate the stream without a completion event.
	 * Used for error cases or manual termination.
	 */
	end(result?: TResult): void {
		if (this.done) return;
		this.done = true;

		if (result !== undefined) {
			this.resolveResult(result);
		} else {
			this.rejectResult(new Error("Stream ended without result"));
		}

		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = null;
			resolve({ value: undefined as unknown as TEvent, done: true });
		}
	}

	/**
	 * Get the final result. Resolves when a completion event is pushed.
	 */
	result(): Promise<TResult> {
		return this.resultPromise;
	}

	/**
	 * Async iterator implementation.
	 * Yields events as they arrive, stops when stream is done.
	 */
	async *[Symbol.asyncIterator](): AsyncIterator<TEvent> {
		while (true) {
			// Drain queued events first
			while (this.queue.length > 0) {
				yield this.queue.shift()!;
			}

			// If done and queue empty, stop
			if (this.done) return;

			// Wait for next event
			const result = await new Promise<IteratorResult<TEvent>>((resolve) => {
				this.waiting = resolve;
			});

			if (result.done) return;
			yield result.value;
		}
	}
}
