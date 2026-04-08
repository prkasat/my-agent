import type {
	Model,
	Context,
	StreamOptions,
	AssistantMessageEvent,
	AssistantMessage,
} from "../types.js";
import { EventStream } from "../utils/event-stream.js";

/**
 * Mock provider for testing.
 *
 * Returns predetermined responses without making any API calls.
 * Register as "mock" in the provider registry.
 */

export interface MockProviderConfig {
	/** Responses to return in order. Loops back to start when exhausted. */
	responses: AssistantMessage[];
}

export function createMockStream(config: MockProviderConfig) {
	let callIndex = 0;

	return function mockStream(
		model: Model,
		_context: Context,
		_options: StreamOptions = {},
	): EventStream<AssistantMessageEvent, AssistantMessage> {
		const response = config.responses[callIndex % config.responses.length];
		callIndex++;

		const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
			(e) => e.type === "done" || e.type === "error",
			(e) => {
				if (e.type === "done") return e.message;
				throw new Error((e as { error?: string }).error || "Stream error");
			},
		);

		// Simulate async delivery via microtask
		queueMicrotask(() => {
			stream.push({ type: "start", message: { role: "assistant", content: [] } });

			for (const block of response.content) {
				if (block.type === "text") {
					stream.push({ type: "text_delta", text: block.text });
				} else if (block.type === "tool_call") {
					stream.push({ type: "tool_call_start", id: block.id, name: block.name });
					stream.push({ type: "tool_call_delta", id: block.id, arguments: block.arguments });
					stream.push({ type: "tool_call_end", id: block.id });
				}
			}

			const message: AssistantMessage = {
				...response,
				model: model.id,
				provider: "mock",
				timestamp: response.timestamp || Date.now(),
			};

			stream.push({ type: "done", message });
		});

		return stream;
	};
}
