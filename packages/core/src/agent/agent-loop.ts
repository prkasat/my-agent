import { EventStream } from "@my-agent/ai";
import type { AssistantMessage, Message, ToolCallContent, ToolResultMessage } from "@my-agent/ai";
import { Value } from "@sinclair/typebox/value";
import { calculateUsageCost } from "./cost-tracker.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentToolResult } from "./types.js";

/**
 * Per-invocation options for the agent loop.
 */
export interface AgentLoopRunOptions {
	/**
	 * Caller-controlled abort signal. When aborted, the in-flight LLM call,
	 * compaction transform, tool execution, and retry backoff all stop.
	 *
	 * Without a signal, the loop runs to completion with no external way to
	 * cancel it — useful for tests but unsafe for interactive callers.
	 */
	signal?: AbortSignal;
}

/**
 * Start a new agent loop with user prompts.
 *
 * Returns an EventStream that emits AgentEvents as the agent runs,
 * and resolves to the final message list when complete.
 *
 * Pass an AbortSignal in options.signal to cancel the loop. The signal
 * is threaded through transformContext, the provider stream, tool
 * execution, and the retry backoff.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	options?: AgentLoopRunOptions,
): EventStream<AgentEvent, AgentMessage[]> {
	context.messages.push(...prompts);

	const stream = new EventStream<AgentEvent, AgentMessage[]>(
		(e) => e.type === "agent_end",
		() => [...context.messages],
	);

	runLoop(context, config, stream, options?.signal).catch((err) => {
		stream.push({
			type: "agent_end",
			reason: "error",
			error: err instanceof Error ? err.message : String(err),
		});
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
	options?: AgentLoopRunOptions,
): EventStream<AgentEvent, AgentMessage[]> {
	const lastMsg = context.messages[context.messages.length - 1];
	if (lastMsg && "role" in lastMsg && lastMsg.role === "assistant") {
		throw new Error("Cannot continue: last message is already an assistant message");
	}

	const stream = new EventStream<AgentEvent, AgentMessage[]>(
		(e) => e.type === "agent_end",
		() => [...context.messages],
	);

	runLoop(context, config, stream, options?.signal).catch((err) => {
		stream.push({
			type: "agent_end",
			reason: "error",
			error: err instanceof Error ? err.message : String(err),
		});
	});

	return stream;
}

/**
 * Stamp a computed cost onto `message.usage.cost` if missing. Done
 * BEFORE the assistant message is emitted as `message_end` so any host
 * that persists on that event captures an authoritative dollar value.
 * Without this, restart-after-model-switch would re-price historical
 * token-only turns at the new (possibly cheaper) model and bypass
 * `maxCostPerSession`. Codex budget-fix pass-7 finding.
 *
 * Idempotent and safe to call multiple times — `recordTurn` runs the
 * same gate later as belt-and-braces.
 */
function stampUsageCost(
	model: { cost?: { inputPerMillion: number; outputPerMillion: number } },
	message: AssistantMessage,
): void {
	if (!message.usage) return;
	const existing = message.usage.cost;
	if (typeof existing === "number" && Number.isFinite(existing) && existing >= 0) return;
	const computed = calculateUsageCost(model as any, message.usage);
	if (Number.isFinite(computed) && computed >= 0) {
		(message.usage as { cost?: number }).cost = computed;
	}
}

/**
 * Sleep that respects an AbortSignal. Resolves after `ms`, or rejects
 * with a DOMException-style "AbortError" the moment the signal fires.
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Main loop implementation.
 *
 * Architecture (from Pi-Mono):
 * - Outer loop: handles follow-up messages after agent would stop
 * - Inner loop: handles LLM call -> tool execution -> steering messages
 *
 * The signal is the caller-supplied AbortSignal. If the caller didn't
 * provide one, we still create a never-aborting controller so downstream
 * code can rely on signal being defined. This preserves backward
 * compatibility with code paths that didn't accept a signal before.
 */
async function runLoop(
	context: AgentContext,
	config: AgentLoopConfig,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	callerSignal: AbortSignal | undefined,
): Promise<void> {
	const signal = callerSignal ?? new AbortController().signal;

	stream.push({ type: "agent_start" });

	// Replay prior turn usage into the cost tracker before the first
	// new turn. Without this, resuming a session in a fresh process
	// would reset cumulative spend to zero and let the next turn
	// exceed `maxCostPerSession`. The tracker's loadFromMessages is a
	// no-op when it already has recorded turns (same-process loop
	// continuation), so this is safe to call unconditionally.
	// Codex budget-fix pass-3 finding.
	let turnIndex = 0;
	if (config.costTracker?.loadFromMessages && context.messages.length > 0) {
		turnIndex = config.costTracker.loadFromMessages(
			context.messages,
			context.model,
			config.resolveModel ? { resolveModel: config.resolveModel } : undefined,
		);
	}

	// Fail fast if the restored/accumulated spend is already past the
	// cap. Without this, a resumed over-budget session would still
	// enter streamAssistantResponse() — which runs transformContext
	// first and can trigger an LLM-backed auto-compaction BEFORE the
	// cap fires at the post-turn check. That compaction call is
	// unmetered spend on top of an already-exceeded budget.
	// Codex budget-fix pass-5 finding.
	if (config.costTracker?.isBudgetExceeded?.()) {
		stream.push({
			type: "agent_end",
			reason: "error",
			error: "Cost budget exceeded for this session",
		});
		return;
	}
	const maxTurns = config.maxTurns ?? 50;

	// === Outer Loop: Follow-up messages ===
	while (true) {
		// === Inner Loop: LLM call + tools + steering ===
		while (true) {
			if (signal.aborted) {
				stream.push({ type: "agent_end", reason: "aborted" });
				return;
			}
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
				// Exponential backoff: 1s, 2s — abortable so cancellation isn't delayed
				try {
					await abortableSleep(1000 * (attempt + 1), signal);
				} catch {
					break;
				}
			}

			if (!assistantMessage) {
				stream.push({
					type: "agent_end",
					reason: signal.aborted ? "aborted" : "error",
				});
				return;
			}

			// Add assistant message to context
			context.messages.push(assistantMessage);

			// Record THIS turn's cost FIRST — even error and aborted turns
			// can carry real provider-billed usage (Anthropic emits a
			// terminal `error` message with populated usage on paid
			// non-recoverable stops like pause_turn; aborted streams may
			// have completed billing on the provider side before we
			// stopped reading). Putting recordTurn before the stopReason
			// early return prevents that spend from escaping the cap.
			// Codex budget-fix pass-7 finding.
			if (config.costTracker && assistantMessage.usage) {
				config.costTracker.recordTurn(context.model, assistantMessage.usage, turnIndex);
			}

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
			const toolCalls = assistantMessage.content.filter((c): c is ToolCallContent => c.type === "tool_call");

			// Auto-wire cost tracking. The recordTurn happened above (so
			// even error/aborted turns count); this branch only handles
			// the post-record budget enforcement: an over-budget turn
			// must not be allowed to mutate state (write/edit/bash) just
			// because it crossed the cap on the same response that
			// requested the tool calls. For free-tier sessions (no
			// maxCostPerSession configured) `isBudgetExceeded()` returns
			// false, so this is a no-op. Codex budget-fix pass-1 finding.
			//
			// Structural completeness on early exit: if the over-budget
			// assistant message had tool_calls, pad them with synthetic
			// "cancelled" toolResults BEFORE returning. Otherwise the
			// session ends with a dangling assistant tool_call turn that
			// agentLoopContinue refuses to resume and providers reject
			// on replay. Codex budget-fix pass-2 finding.
			//
			// The budget check fires REGARDLESS of whether the provider
			// emitted usage on this turn. isBudgetExceeded reads the
			// accumulated total and would otherwise stay silent on
			// missing-usage streams, letting the loop keep running while
			// the caller has no way to know spend crossed the cap.
			// Codex budget-fix pass-5 finding.
			if (config.costTracker) {
				if (config.costTracker.isBudgetExceeded()) {
					if (toolCalls.length > 0) {
						context.messages.push(...padCancelledToolResults(toolCalls, []));
					}
					stream.push({ type: "turn_end", turnIndex, usage: assistantMessage.usage });
					stream.push({
						type: "agent_end",
						reason: "error",
						error: "Cost budget exceeded for this session",
					});
					return;
				}
			}

			if (toolCalls.length > 0) {
				const toolResults =
					config.toolExecution === "parallel"
						? await executeToolsParallel(toolCalls, context, config, stream, signal)
						: await executeToolsSequential(toolCalls, context, config, stream, signal);

				// Structural completeness: every assistant message that contains
				// N tool_calls must be followed by exactly N toolResults in the
				// transcript. If we got fewer (because abort interrupted the
				// batch), pad with synthetic "cancelled" results so the
				// conversation can be safely persisted, replayed, and resumed.
				//
				// We use a plain non-error toolResult (NOT isError=true) to
				// avoid surfacing "fake" tool-execution failures — the abort
				// is a control-flow signal, not a tool malfunction.
				const completeResults =
					toolResults.length < toolCalls.length ? padCancelledToolResults(toolCalls, toolResults) : toolResults;

				context.messages.push(...completeResults);
			}

			stream.push({ type: "turn_end", turnIndex, usage: assistantMessage.usage });

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
			break;
		}

		context.messages.push(...followUpMessages);
	}

	stream.push({ type: "agent_end", reason: "complete" });
}

/**
 * Stream an LLM response and emit events.
 *
 * Pipeline: transformContext -> convertToLlm -> streamFn -> forward events
 *
 * The signal is passed to transformContext (so compaction LLM calls
 * cancel correctly) and to the provider's streamFn.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	agentStream: EventStream<AgentEvent, AgentMessage[]>,
	signal: AbortSignal,
): Promise<AssistantMessage | null> {
	// Apply context transform (token pruning, compaction, etc.)
	let effectiveContext = context;
	if (config.transformContext) {
		try {
			effectiveContext = await Promise.resolve(config.transformContext(context, signal));
		} catch (err) {
			// If the transform threw because the caller aborted (e.g.,
			// `createAutoCompactor(..., { onError: "throw" })` propagating
			// an abort from its summarization LLM call), don't surface
			// that as a generic "error" outcome — return null so the
			// outer loop can detect signal.aborted and end as "aborted".
			if (signal.aborted) return null;
			throw err;
		}
		// transformContext can spend (e.g. an auto-compactor wired to the
		// same cost tracker). Re-check the cap before issuing the next
		// LLM call so the summary's spend can't push us past the cap and
		// then proceed with a follow-up turn that puts us further over.
		// Codex budget-fix pass-6 finding.
		if (config.costTracker?.isBudgetExceeded?.()) {
			agentStream.push({
				type: "agent_end",
				reason: "error",
				error: "Cost budget exceeded for this session",
			});
			return null;
		}
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
	const llmStream = llmStreamOrPromise instanceof Promise ? await llmStreamOrPromise : llmStreamOrPromise;

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
				stampUsageCost(context.model, event.message);
				agentStream.push({ type: "message_end", message: event.message });
				break;
			case "error":
				if (event.message) {
					stampUsageCost(context.model, event.message);
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
		try {
			const result = await executeSingleTool(toolCall, context, config, stream, signal);
			results.push(result);
		} catch (err) {
			// Abort propagation from executeSingleTool: stop running further
			// tools and return whatever genuine successes we already collected.
			if (signal.aborted) break;
			throw err;
		}
	}
	return results;
}

/**
 * Execute tool calls in parallel (faster for independent tools).
 *
 * Abort semantics: when `signal` fires, the function returns immediately
 * with whatever results have already settled. Outstanding tool promises
 * are NOT awaited — a non-cooperative tool that ignores the signal would
 * otherwise hang the agent indefinitely. Each tool's promise is wrapped
 * with a `.catch` so any later rejection from such an outstanding tool
 * is swallowed and does not surface as an unhandled rejection.
 */
async function executeToolsParallel(
	toolCalls: ToolCallContent[],
	context: AgentContext,
	config: AgentLoopConfig,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	signal: AbortSignal,
): Promise<ToolResultMessage[]> {
	const results = new Array<ToolResultMessage | undefined>(toolCalls.length);
	let firstNonAbortError: unknown = null;

	const settled = toolCalls.map((tc, i) =>
		executeSingleTool(tc, context, config, stream, signal)
			.then((r) => {
				results[i] = r;
			})
			.catch((err) => {
				// Capture only NON-abort errors. Abort-induced rejections are
				// expected control flow and are handled by structural padding
				// in runLoop.
				if (!signal.aborted && firstNonAbortError === null) {
					firstNonAbortError = err;
				}
			}),
	);

	const allFinished = Promise.all(settled);
	const abortFired = new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		signal.addEventListener("abort", () => resolve(), { once: true });
	});

	// Race: either all tools finish, or abort fires. If abort wins, we
	// return immediately and let outstanding promises clean up out-of-band
	// (their rejections are already swallowed above).
	await Promise.race([allFinished, abortFired]);

	if (firstNonAbortError !== null && !signal.aborted) {
		throw firstNonAbortError;
	}

	return results.filter((r): r is ToolResultMessage => r !== undefined);
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

	// Before hook (catch exceptions to prevent crashes)
	if (config.beforeToolCall) {
		try {
			const hookResult = await config.beforeToolCall({
				toolCall: { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments },
				args,
				context,
			});
			if (hookResult.action === "block") {
				return createErrorResult(toolCall, `Blocked: ${hookResult.reason}`);
			}
			if ("modifiedArgs" in hookResult) {
				args = hookResult.modifiedArgs;
				if (!Value.Check(tool.parameters, args)) {
					const errors = [...Value.Errors(tool.parameters, args)];
					const details = errors.map((e) => `${e.path}: ${e.message}`).join(", ");
					return createErrorResult(toolCall, `Invalid arguments after beforeToolCall hook: ${details}`);
				}
			}
		} catch (hookErr) {
			return createErrorResult(
				toolCall,
				`beforeToolCall hook failed: ${hookErr instanceof Error ? hookErr.message : hookErr}`,
			);
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
		// If the tool failed because the caller aborted, propagate the
		// error so the loop can end cleanly as "aborted". Without this,
		// an abort-induced "Operation aborted" exception gets converted
		// to a synthetic tool error that pollutes the persisted
		// conversation history with what looks like a real failure.
		if (signal.aborted) {
			throw err;
		}
		result = {
			content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : err}` }],
			isError: true,
		};
		isError = true;
	}

	// After hook (catch exceptions - don't let hook failure discard tool result)
	if (config.afterToolCall) {
		try {
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
		} catch {
			// Hook failure shouldn't discard the tool result - continue with original
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

/**
 * Fill in synthetic "cancelled" tool results for any tool_call in
 * `toolCalls` that does not have a corresponding entry in `actual`.
 *
 * Preserves call order: the returned array contains one toolResult per
 * tool_call, in the same order the assistant message produced them. This
 * matches the shape providers expect when replaying a conversation.
 *
 * Synthetic results are NOT marked isError — the cancellation is a
 * control-flow event from the user, not a tool malfunction. Marking them
 * as errors would cause downstream auto-retry/recovery logic to misread
 * the situation as a tool failure.
 */
function padCancelledToolResults(toolCalls: ToolCallContent[], actual: ToolResultMessage[]): ToolResultMessage[] {
	const byId = new Map(actual.map((r) => [r.toolCallId, r]));
	return toolCalls.map(
		(tc): ToolResultMessage =>
			byId.get(tc.id) ?? {
				role: "toolResult",
				toolCallId: tc.id,
				toolName: tc.name,
				content: [{ type: "text", text: "Tool execution cancelled." }],
				timestamp: Date.now(),
			},
	);
}
