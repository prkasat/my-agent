import type { Context, Model, StreamFunction, StreamOptions } from "../types.js";
import type { AssistantMessage, AssistantMessageEvent } from "../types.js";
import type { EventStream } from "../utils/event-stream.js";

type ProviderFactory = () => Promise<StreamFunction>;

/**
 * Registry of LLM providers.
 *
 * Providers are lazy-loaded via factory functions — only initialized
 * when first used. This means registering 10 providers costs nothing
 * until you actually call one.
 */
const providers = new Map<string, ProviderFactory>();
const loadedProviders = new Map<string, StreamFunction>();

export function registerProvider(name: string, factory: ProviderFactory): void {
	providers.set(name, factory);
}

export async function getProvider(name: string): Promise<StreamFunction> {
	const cached = loadedProviders.get(name);
	if (cached) return cached;

	const factory = providers.get(name);
	if (!factory) {
		throw new Error(`Unknown provider: "${name}". Available: ${[...providers.keys()].join(", ")}`);
	}

	const streamFn = await factory();
	loadedProviders.set(name, streamFn);
	return streamFn;
}

/**
 * Main entry point: stream an LLM response.
 * Looks up the provider from the model, delegates to provider's stream function.
 */
export async function stream(
	model: Model,
	context: Context,
	options: StreamOptions = {},
): Promise<EventStream<AssistantMessageEvent, AssistantMessage>> {
	const streamFn = await getProvider(model.provider);
	return streamFn(model, context, options);
}

/**
 * Convenience: get complete response without streaming.
 */
export async function complete(model: Model, context: Context, options: StreamOptions = {}): Promise<AssistantMessage> {
	const eventStream = await stream(model, context, options);
	return eventStream.result();
}
