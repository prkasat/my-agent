// @my-agent/ai - Multi-provider LLM abstraction

export { calculateCost, getModel, getModelsByProvider, models, normalizeModelKey } from "./models.js";
// Anthropic provider factory (for custom registration / configuration)
export { createAnthropicStream } from "./providers/anthropic.js";
export type { MockProviderConfig } from "./providers/mock.js";
// Mock provider (for testing)
export { createMockStream } from "./providers/mock.js";
export type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthProvider,
} from "./providers/oauth.js";
// OAuth providers
export {
	createAnthropicOAuthProvider,
	createGitHubCopilotOAuthProvider,
	createOpenAICodexOAuthProvider,
	getOAuthApiKey,
	getOAuthProvider,
	getOAuthProviders,
	registerBuiltinOAuthProviders,
	registerOAuthProvider,
} from "./providers/oauth.js";
// OpenAI-compatible provider factories (for custom registration)
export { createOpenAICodexStream } from "./providers/openai-codex.js";
export { createOpenAICompatibleStream } from "./providers/openai-compatible.js";
export { complete, getProvider, registerProvider, stream } from "./providers/registry.js";
// Types
export type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	AsyncStreamFunction,
	ContentBlock,
	Context,
	ImageContent,
	Message,
	Model,
	StopReason,
	StreamFunction,
	StreamFunctionLike,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCallContent,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "./types.js";
// Core
export { EventStream } from "./utils/event-stream.js";
export type { RetryConfig } from "./utils/retry.js";
// Retry utilities
export { isRetryable, withRetry } from "./utils/retry.js";

// Register built-in providers on import
import "./providers/index.js";
