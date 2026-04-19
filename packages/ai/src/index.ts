// @my-agent/ai - Multi-provider LLM abstraction

// Types
export type {
	Message,
	UserMessage,
	AssistantMessage,
	ToolResultMessage,
	Tool,
	Context,
	Usage,
	Model,
	StopReason,
	ThinkingLevel,
	StreamOptions,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	TextContent,
	ImageContent,
	ThinkingContent,
	ToolCallContent,
	ContentBlock,
	StreamFunction,
	AsyncStreamFunction,
	StreamFunctionLike,
} from "./types.js";

// Core
export { EventStream } from "./utils/event-stream.js";
export { stream, complete, registerProvider, getProvider } from "./providers/registry.js";
export { models, getModel, getModelsByProvider, calculateCost } from "./models.js";

// Mock provider (for testing)
export { createMockStream } from "./providers/mock.js";
export type { MockProviderConfig } from "./providers/mock.js";

// Anthropic provider factory (for custom registration / configuration)
export { createAnthropicStream } from "./providers/anthropic.js";

// OpenAI-compatible provider factory (for custom registration)
export { createOpenAICompatibleStream } from "./providers/openai-compatible.js";

// Retry utilities
export { withRetry, isRetryable } from "./utils/retry.js";
export type { RetryConfig } from "./utils/retry.js";

// OAuth providers
export {
	registerOAuthProvider,
	getOAuthProvider,
	getOAuthProviders,
	getOAuthApiKey,
	createAnthropicOAuthProvider,
	createGitHubCopilotOAuthProvider,
	createOpenAICodexOAuthProvider,
	registerBuiltinOAuthProviders,
} from "./providers/oauth.js";
export type {
	OAuthProvider,
	OAuthCredentials,
	OAuthAuthInfo,
	OAuthPrompt,
	OAuthLoginCallbacks,
} from "./providers/oauth.js";

// Register built-in providers on import
import "./providers/index.js";
