// Core types for the LLM layer
// These types are provider-agnostic — they work with any LLM API

import type { TSchema } from "@sinclair/typebox";

// === Messages ===

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

export interface ThinkingContent {
	type: "thinking";
	text: string;
}

export interface ToolCallContent {
	type: "tool_call";
	id: string;
	name: string;
	arguments: string; // JSON string
}

export type ContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent;

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp?: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCallContent)[];
	model?: string;
	provider?: string;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	timestamp?: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	isError?: boolean;
	timestamp?: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// === Models & Providers ===

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cost?: number;
}

export interface Model {
	id: string;
	name: string;
	provider: string;
	contextWindow: number;
	maxOutputTokens: number;
	supportsTools: boolean;
	supportsStreaming: boolean;
	supportsThinking: boolean;
	cost: {
		inputPerMillion: number;
		outputPerMillion: number;
	};
}

// === Tools ===

export interface Tool {
	name: string;
	description: string;
	parameters: TSchema;
}

// === Context ===

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

// === Streaming ===

export interface StreamOptions {
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	thinkingLevel?: ThinkingLevel;
}

export type AssistantMessageEvent =
	| { type: "start"; message: Partial<AssistantMessage> }
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; text: string }
	| { type: "tool_call_start"; id: string; name: string }
	| { type: "tool_call_delta"; id: string; arguments: string }
	| { type: "tool_call_end"; id: string }
	| { type: "usage"; usage: Usage }
	| { type: "done"; message: AssistantMessage }
	| { type: "error"; error: string; message?: AssistantMessage };

export type StreamFunction = (model: Model, context: Context, options: StreamOptions) => AssistantMessageEventStream;

// Forward reference — implemented in event-stream.ts
import type { EventStream } from "./utils/event-stream.js";
export type AssistantMessageEventStream = EventStream<AssistantMessageEvent, AssistantMessage>;
