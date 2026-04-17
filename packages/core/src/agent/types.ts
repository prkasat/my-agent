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

import type { CustomMessage } from "./custom-messages.js";

export type AgentMessage = Message | CustomAgentMessage | CustomMessage;

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
	/**
	 * Schema version for this tool's `parameters`. Bump when changing the
	 * parameter shape in a backwards-incompatible way (renaming a field,
	 * removing a field, changing a field's type/required-ness). Stable
	 * tweaks like description text or new optional fields don't require a
	 * bump. Defaults to 1 when omitted; readers MUST treat undefined as 1.
	 *
	 * Recorded so a future migration step can map old serialized tool-call
	 * arguments in session files onto the current schema. There is no
	 * migration framework yet — this is the scaffolding it would key off.
	 */
	version?: number;
	/** Transform raw args before validation */
	prepareArguments?: (raw: unknown) => Static<TParams>;
	/**
	 * Execute the tool and return a result for the LLM.
	 *
	 * Abort contract: implementations MUST honor `signal`. When the agent
	 * loop aborts a parallel tool batch, it returns immediately rather
	 * than waiting for outstanding executions — but it cannot force-stop
	 * a non-cooperative tool. A tool that ignores `signal` and keeps
	 * running (open timers, sockets, child processes) will keep the Node
	 * event loop alive past `agent_end`.
	 *
	 * Wire any internal `setTimeout`, `fetch`, child-process spawn, or
	 * stream to abort when `signal.aborted` becomes true (`fetch({ signal })`,
	 * `setTimeout(cb, ms, { signal })`, `child_process.spawn({ signal })`,
	 * or `signal.addEventListener("abort", cleanup)`).
	 */
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
	/**
	 * Optional: transform context before each LLM call (token pruning, caching, compaction).
	 * Receives the loop's AbortSignal so long-running transforms (e.g., LLM-powered
	 * compaction) can be cancelled when the caller aborts the agent.
	 */
	transformContext?: (
		context: AgentContext,
		signal?: AbortSignal,
	) => AgentContext | Promise<AgentContext>;
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
	costTracker?: {
		recordTurn: (model: Model, usage: Usage, turnIndex: number) => void;
		isBudgetExceeded: () => boolean;
		/**
		 * Optional: replay prior assistant `usage` records into the
		 * tracker so a hard `maxCostPerSession` cap survives process
		 * restarts. agentLoop calls this once before the first new turn
		 * so resumed sessions keep their cumulative spend. The tracker
		 * is responsible for making this a no-op when already populated.
		 *
		 * The optional third argument lets the caller pass a model
		 * resolver so historical token-only turns are billed at the
		 * model that produced them — not the session's current
		 * (possibly switched-to-cheaper-or-free) model. Codex
		 * budget-fix pass-9 finding.
		 */
		loadFromMessages?: (
			messages: AgentMessage[],
			model: Model,
			options?: { resolveModel?: (id: string, provider?: string) => Model | undefined },
		) => number;
	};
	/**
	 * Optional model resolver passed to costTracker.loadFromMessages
	 * on resume. When set, historical assistant turns that persisted
	 * their `model`/`provider` are re-priced using the resolved
	 * model's per-million pricing rather than the session's current
	 * model — closing the model-switch budget bypass that pre-pass-7
	 * sessions and bypass paths could exhibit.
	 */
	resolveModel?: (id: string, provider?: string) => Model | undefined;
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
	| { type: "agent_end"; reason: "complete" | "error" | "aborted" | "max_turns"; error?: string };
