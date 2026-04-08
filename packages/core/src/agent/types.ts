import type { TSchema, Static } from "@sinclair/typebox";
import type {
	Message,
	AssistantMessage,
	Model,
	StreamFunction,
	StreamOptions,
	AssistantMessageEvent,
	TextContent,
	ImageContent,
	Usage,
} from "@my-agent/ai";

// === Agent Messages ===
// Extends the base Message type with custom message types.
// Custom messages are internal — convertToLlm filters them out before LLM calls.

export type AgentMessage = Message | CustomAgentMessage;

export interface CustomAgentMessage {
	role: "custom";
	type: string;
	content: string;
	timestamp?: number;
}

// === Agent Context ===

export interface AgentContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools: AgentTool[];
	model: Model;
}

// === Tool Types ===

export interface AgentTool<TParams extends TSchema = TSchema, TDetails = unknown> {
	name: string;
	description: string;
	parameters: TParams;
	/** Transform raw args before validation */
	prepareArguments?: (raw: unknown) => Static<TParams>;
	/** Execute the tool and return a result for the LLM */
	execute: (
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal,
		onUpdate?: (update: Partial<AgentToolResult<TDetails>>) => void,
	) => Promise<AgentToolResult<TDetails>>;
}

export interface AgentToolResult<TDetails = unknown> {
	/** Content sent back to the LLM */
	content: (TextContent | ImageContent)[];
	/** Metadata for UI/logging — not sent to the LLM */
	details?: TDetails;
	/** If true, the LLM sees this as an error result */
	isError?: boolean;
}

// === Configuration ===

export interface AgentLoopConfig {
	/** LLM stream function (from @my-agent/ai provider registry) */
	streamFn: StreamFunction;
	/** Stream options (temperature, maxTokens, etc.) */
	streamOptions?: StreamOptions;
	/**
	 * Convert AgentMessage[] to Message[] for the LLM.
	 * MUST filter out custom messages. MUST NOT throw.
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[];
	/** Optional: transform context before each LLM call (token pruning, caching) */
	transformContext?: (context: AgentContext) => AgentContext;
	/** Dynamic API key resolution. Called before each LLM call. */
	getApiKey?: (provider: string) => Promise<string | undefined>;
	/** Get steering messages to inject between turns (inner loop driver) */
	getSteeringMessages?: () => AgentMessage[] | undefined;
	/** Get follow-up messages after agent would stop (outer loop driver) */
	getFollowUpMessages?: () => AgentMessage[] | undefined;
	/** Tool execution mode: sequential (safe default) or parallel (faster) */
	toolExecution?: "sequential" | "parallel";
	/** Maximum turns before force-stopping (prevents runaway loops) */
	maxTurns?: number;
	/** Maximum retries for transient LLM errors (default: 1) */
	maxRetries?: number;
	/** Hook: called before a tool executes. Return "block" to prevent. */
	beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult>;
	/** Hook: called after a tool executes. Can modify the result. */
	afterToolCall?: (ctx: AfterToolCallContext) => Promise<AfterToolCallResult | undefined>;
	/** Optional cost tracker — auto-wired to record usage after each turn */
	costTracker?: { recordTurn: (model: Model, usage: Usage, turnIndex: number) => void; isBudgetExceeded: () => boolean };
}

// === Hook Types ===

export interface BeforeToolCallContext {
	toolCall: { id: string; name: string; arguments: string };
	args: unknown;
	context: AgentContext;
}

export type BeforeToolCallResult = { action: "allow" } | { action: "block"; reason: string };

export interface AfterToolCallContext extends BeforeToolCallContext {
	result: AgentToolResult;
	isError: boolean;
}

export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
}

// === Events ===
// Everything the UI needs to render the agent's activity

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "turn_start"; turnIndex: number }
	| { type: "message_start"; message: Partial<AssistantMessage> }
	| { type: "message_update"; event: AssistantMessageEvent }
	| { type: "message_end"; message: AssistantMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; update: Partial<AgentToolResult> }
	| { type: "tool_execution_end"; toolCallId: string; result: AgentToolResult; isError: boolean }
	| { type: "turn_end"; turnIndex: number; usage?: Usage }
	| { type: "agent_end"; reason: "complete" | "error" | "aborted" | "max_turns" };
