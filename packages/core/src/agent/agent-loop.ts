import { EventStream } from "@my-agent/ai";
import { Value } from "@sinclair/typebox/value";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentToolResult,
} from "./types.js";
import type { AssistantMessage, Message, ToolCallContent, ToolResultMessage } from "@my-agent/ai";

/**
 * Start a new agent loop with user prompts.
 *
 * Returns an EventStream that emits AgentEvents as the agent runs,
 * and resolves to the final message list when complete.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
): EventStream<AgentEvent, AgentMessage[]> {
	context.messages.push(...prompts);

	const stream = new EventStream<AgentEvent, AgentMessage[]>(
		(e) => e.type === "agent_end",
		() => [...context.messages],
	);

	runLoop(context, config, stream).catch(() => {
		stream.push({ type: "agent_end", reason: "error" });
	});

	return stream;
}

/**
 * Continue an existing agent loop (e.g., after recovery).
 * Validates that the last message is not an assistant message.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
): EventStream<AgentEvent, AgentMessage[]> {
	const lastMsg = context.messages[context.messages.length - 1];
	if (lastMsg && "role" in lastMsg && lastMsg.role === "assistant") {
		throw new Error("Cannot continue: last message is already an assistant message");
	}

	const stream = new EventStream<AgentEvent, AgentMessage[]>(
		(e) => e.type === "agent_end",
		() => [...context.messages],
	);

	runLoop(context, config, stream).catch(() => {
		stream.push({ type: "agent_end", reason: "error" });
	});

	return stream;
}

/**
 * Main loop implementation.
 *
 * Architecture (from Pi-Mono):
 * - Outer loop: handles follow-up messages after agent would stop
 * - Inner loop: handles LLM call -> tool execution -> steering messages
 */
async function runLoop(
	context: AgentContext,
	config: AgentLoopConfig,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<void> {
	const abortController = new AbortController();
	const signal = abortController.signal;

	stream.push({ type: "agent_start" });

	let turnIndex = 0;
	const maxTurns = config.maxTurns ?? 50;

	// === Outer Loop: Follow-up messages ===
	outerLoop: while (true) {
		// === Inner Loop: LLM call + tools + steering ===
		while (true) {
			stream.push({ type: "turn_start", turnIndex });

			// Check for steering messages before the LLM call
			const steeringMessages = config.getSteeringMessages?.();
			if (steeringMessages?.length) {
				context.messages.push(...steeringMessages);
			}

			// --- Stream LLM Response (with retry for transient errors) ---
			const maxRetries = config.maxRetries ?? 1;
			let assistantMessage: AssistantMessage | null = null;
			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				assistantMessage = await streamAssistantResponse(context, config, stream, signal);
				if (assistantMessage) break;
				// Only retry if not aborted and we have retries left
				if (signal.aborted || attempt === maxRetries) break;
				// Exponential backoff: 1s, 2s
				await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
			}

			if (!assistantMessage) {
				stream.push({ type: "agent_end", reason: "error" });
				return;
			}

			// Add assistant message to context
			context.messages.push(assistantMessage);

			// Check stop reason
			if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
				stream.push({ type: "turn_end", turnIndex, usage: assistantMessage.usage });
				stream.push({
					type: "agent_end",
					reason: assistantMessage.stopReason === "aborted" ? "aborted" : "error",
				});
				return;
			}

			// --- Execute Tool Calls ---
			const toolCalls = assistantMessage.content.filter(
				(c): c is ToolCallContent => c.type === "tool_call",
			);

			if (toolCalls.length > 0) {
				const toolResults =
					config.toolExecution === "parallel"
						? await executeToolsParallel(toolCalls, context, config, stream, signal)
						: await executeToolsSequential(toolCalls, context, config, stream, signal);

				context.messages.push(...toolResults);
			}

			stream.push({ type: "turn_end", turnIndex, usage: assistantMessage.usage });

			// Auto-wire cost tracking (budget enforcement disabled — free models only)
			if (config.costTracker && assistantMessage.usage) {
				config.costTracker.recordTurn(context.model, assistantMessage.usage, turnIndex);
			}

			turnIndex++;

			// Safety limit
			if (turnIndex >= maxTurns) {
				stream.push({ type: "agent_end", reason: "max_turns" });
				return;
			}

			// If no tool calls, the inner loop is done (unless steering says otherwise)
			if (toolCalls.length === 0) {
				const moreSteeringMessages = config.getSteeringMessages?.();
				if (!moreSteeringMessages?.length) {
					break; // Exit inner loop
				}
				context.messages.push(...moreSteeringMessages);
			}
		}

		// === Check for follow-up messages ===
		const followUpMessages = config.getFollowUpMessages?.();
		if (!followUpMessages?.length) {
			break outerLoop;
		}

		context.messages.push(...followUpMessages);
	}

	stream.push({ type: "agent_end", reason: "complete" });
}

/**
 * Stream an LLM response and emit events.
 *
 * Pipeline: transformContext -> convertToLlm -> streamFn -> forward events
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	agentStream: EventStream<AgentEvent, AgentMessage[]>,
	signal: AbortSignal,
): Promise<AssistantMessage | null> {
	// Apply context transform (token pruning, etc.)
	let effectiveContext = context;
	if (config.transformContext) {
		effectiveContext = config.transformContext(context);
	}

	// Convert to LLM-compatible messages (filters out custom messages)
	// Fail closed: if conversion throws, we must NOT continue with empty history
	// because the LLM would run with tools enabled but no user constraints.
	let llmMessages: Message[];
	try {
		llmMessages = config.convertToLlm(effectiveContext.messages);
	} catch (err) {
		agentStream.push({ type: "agent_end", reason: "error" });
		return null;
	}

	// Resolve API key
	const apiKey = config.getApiKey ? await config.getApiKey(context.model.provider) : undefined;

	// Build LLM context
	const llmContext = {
		systemPrompt: effectiveContext.systemPrompt,
		messages: llmMessages,
		tools: effectiveContext.tools.map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		})),
	};

	// Stream the response
	// Handle both sync StreamFunction and async registry stream() return types
	const llmStreamOrPromise = config.streamFn(context.model, llmContext, {
		...config.streamOptions,
		signal,
		apiKey,
	});
	const llmStream =
		llmStreamOrPromise instanceof Promise ? await llmStreamOrPromise : llmStreamOrPromise;

	// Forward LLM events to the agent stream
	for await (const event of llmStream) {
		switch (event.type) {
			case "start":
				agentStream.push({ type: "message_start", message: event.message });
				break;
			case "text_delta":
			case "thinking_delta":
			case "tool_call_start":
			case "tool_call_delta":
			case "tool_call_end":
			case "usage":
				agentStream.push({ type: "message_update", event });
				break;
			case "done":
				agentStream.push({ type: "message_end", message: event.message });
				break;
			case "error":
				if (event.message) {
					agentStream.push({ type: "message_end", message: event.message });
				}
				return event.message || null;
		}
	}

	// Get the final message
	try {
		return await llmStream.result();
	} catch {
		return null;
	}
}

/**
 * Execute tool calls sequentially (safe default — tools may depend on each other).
 */
async function executeToolsSequential(
	toolCalls: ToolCallContent[],
	context: AgentContext,
	config: AgentLoopConfig,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	signal: AbortSignal,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		const result = await executeSingleTool(toolCall, context, config, stream, signal);
		results.push(result);
	}
	return results;
}

/**
 * Execute tool calls in parallel (faster for independent tools).
 */
async function executeToolsParallel(
	toolCalls: ToolCallContent[],
	context: AgentContext,
	config: AgentLoopConfig,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	signal: AbortSignal,
): Promise<ToolResultMessage[]> {
	const promises = toolCalls.map((tc) => executeSingleTool(tc, context, config, stream, signal));
	return Promise.all(promises);
}

/**
 * Execute a single tool call with full lifecycle:
 * find -> validate -> beforeToolCall hook -> execute -> afterToolCall hook
 */
async function executeSingleTool(
	toolCall: ToolCallContent,
	context: AgentContext,
	config: AgentLoopConfig,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	signal: AbortSignal,
): Promise<ToolResultMessage> {
	const tool = context.tools.find((t) => t.name === toolCall.name);

	if (!tool) {
		return createErrorResult(toolCall, `Unknown tool: ${toolCall.name}`);
	}

	// Parse and validate arguments
	let args: unknown;
	try {
		args = JSON.parse(toolCall.arguments || "{}");
		if (tool.prepareArguments) {
			args = tool.prepareArguments(args);
		}
		if (!Value.Check(tool.parameters, args)) {
			const errors = [...Value.Errors(tool.parameters, args)];
			const details = errors.map((e) => `${e.path}: ${e.message}`).join(", ");
			return createErrorResult(toolCall, `Invalid arguments: ${details}`);
		}
	} catch (err) {
		return createErrorResult(toolCall, `Failed to parse arguments: ${err}`);
	}

	// Before hook
	if (config.beforeToolCall) {
		const hookResult = await config.beforeToolCall({
			toolCall: { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments },
			args,
			context,
		});
		if (hookResult.action === "block") {
			return createErrorResult(toolCall, `Blocked: ${hookResult.reason}`);
		}
	}

	// Execute
	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args,
	});

	let result: AgentToolResult;
	let isError = false;

	try {
		result = await tool.execute(toolCall.id, args, signal, (update) => {
			stream.push({ type: "tool_execution_update", toolCallId: toolCall.id, update });
		});
	} catch (err) {
		result = {
			content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : err}` }],
			isError: true,
		};
		isError = true;
	}

	// After hook
	if (config.afterToolCall) {
		const hookResult = await config.afterToolCall({
			toolCall: { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments },
			args,
			context,
			result,
			isError,
		});
		if (hookResult) {
			if (hookResult.content) result.content = hookResult.content;
			if (hookResult.details !== undefined) result.details = hookResult.details;
			if (hookResult.isError !== undefined) isError = hookResult.isError;
		}
	}

	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		result,
		isError,
	});

	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		isError,
		timestamp: Date.now(),
	};
}

function createErrorResult(toolCall: ToolCallContent, error: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: error }],
		isError: true,
		timestamp: Date.now(),
	};
}
