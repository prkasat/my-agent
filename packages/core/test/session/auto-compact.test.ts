import { describe, expect, it, vi } from "vitest";
import { EventStream } from "@my-agent/ai";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@my-agent/ai";
import {
	createAutoCompactor,
	createAutoCompactorWithPersistence,
} from "../../src/session/auto-compact.js";
import type { AgentContext, AgentMessage } from "../../src/agent/types.js";

const fakeModel: Model = {
	id: "test",
	name: "Test",
	provider: "test",
	contextWindow: 1000,
} as unknown as Model;

/**
 * Build a long conversation that overflows a tiny context window so
 * compaction is forced to trigger.
 */
function buildOversizedMessages(count: number, charsPerMessage = 800): AgentMessage[] {
	const text = "x".repeat(charsPerMessage);
	const out: AgentMessage[] = [];
	for (let i = 0; i < count; i++) {
		if (i % 2 === 0) {
			out.push({ role: "user", content: `u${i}: ${text}`, timestamp: Date.now() });
		} else {
			out.push({
				role: "assistant",
				content: [{ type: "text", text: `a${i}: ${text}` }],
				stopReason: "stop",
				timestamp: Date.now(),
			});
		}
	}
	return out;
}

/**
 * A streaming function that returns a fake summary instantly.
 */
function fakeStreamFn(summaryText: string) {
	return function fauxStream() {
		const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
			(e) => e.type === "done",
			(e) => {
				if (e.type === "done") return e.message;
				throw new Error("unexpected");
			},
		);
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: summaryText }],
			stopReason: "stop",
			timestamp: Date.now(),
		};
		queueMicrotask(() => {
			stream.push({ type: "start", message });
			stream.push({ type: "done", message });
		});
		return stream;
	};
}

describe("createAutoCompactor", () => {
	it("compacts when context exceeds the limit", async () => {
		const compactor = createAutoCompactor({
			streamFn: fakeStreamFn("compacted summary") as any,
			settings: { reserveTokens: 100, keepRecentTokens: 50 },
		});

		const messages = buildOversizedMessages(20);
		const context: AgentContext = {
			messages,
			model: fakeModel,
			systemPrompt: "",
			tools: [],
		};

		const result = await compactor(context);
		expect(result.messages.length).toBeLessThan(20);
		// First message should be the synthetic compaction summary
		const first = result.messages[0];
		expect("role" in first && first.role === "custom").toBe(true);
	});

	it("uses the call-time signal in preference to the construction-time signal", async () => {
		const constructionAc = new AbortController();
		const callAc = new AbortController();
		callAc.abort();

		const seenSignals: (AbortSignal | undefined)[] = [];
		const compactor = createAutoCompactor({
			streamFn: ((_model: Model, _ctx: any, opts: { signal?: AbortSignal }) => {
				seenSignals.push(opts.signal);
				return fakeStreamFn("ignored")();
			}) as any,
			settings: { reserveTokens: 100, keepRecentTokens: 50 },
			signal: constructionAc.signal,
		});

		const context: AgentContext = {
			messages: buildOversizedMessages(20),
			model: fakeModel,
			systemPrompt: "",
			tools: [],
		};

		await compactor(context, callAc.signal);
		expect(seenSignals.length).toBeGreaterThan(0);
		expect(seenSignals[0]).toBe(callAc.signal);
		expect(seenSignals[0]).not.toBe(constructionAc.signal);
	});
});

describe("Tier-1: usage-based trigger", () => {
	it("invokes the summarization LLM when last assistant Usage exceeds the limit even though chars/4 would not", async () => {
		// Threat model: thinking-heavy models (e.g., o1, claude with extended
		// thinking) and prompt-cached calls return tokens that exceed the
		// chars/4 estimate by 5-10x. The OLD chars/4-only trigger would let
		// the conversation silently grow past the model's actual context
		// window before compaction kicks in. The Usage-based trigger MUST
		// notice the real consumption immediately.
		let summaryCalls = 0;
		const trackingStreamFn = ((_m: Model, _ctx: any, _opts: any) => {
			summaryCalls++;
			return fakeStreamFn("compacted")();
		}) as any;

		const compactor = createAutoCompactor({
			streamFn: trackingStreamFn,
			settings: { reserveTokens: 100, keepRecentTokens: 50 },
		});

		// A few short text messages — chars/4 says ~tens of tokens. But
		// the last clean assistant turn reports 1400 inputTokens + 100
		// outputTokens, way over the 1000-token window minus 100 reserve
		// = 900 limit. The Usage-based trigger MUST kick in.
		const filler = "x".repeat(300); // ~75 tokens each
		const messages: AgentMessage[] = [
			{ role: "user", content: `u0: ${filler}`, timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: `a1: ${filler}` }],
				usage: { inputTokens: 1400, outputTokens: 100 },
				stopReason: "stop",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
			{ role: "user", content: `u2: ${filler}`, timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: `a3: ${filler}` }],
				stopReason: "stop",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		];

		const context: AgentContext = {
			messages,
			model: fakeModel,
			systemPrompt: "",
			tools: [],
		};

		await compactor(context);
		expect(summaryCalls).toBe(1);
	});

	it("does NOT call the summarization LLM when reported Usage is well within the limit", async () => {
		let summaryCalls = 0;
		const trackingStreamFn = ((_m: Model, _ctx: any, _opts: any) => {
			summaryCalls++;
			return fakeStreamFn("compacted")();
		}) as any;

		const compactor = createAutoCompactor({
			streamFn: trackingStreamFn,
			settings: { reserveTokens: 100, keepRecentTokens: 50 },
		});

		// Long-ish text but the model says "I only used 150 tokens" via
		// Usage. Trust the model — don't compact.
		const filler = "x".repeat(300);
		const messages: AgentMessage[] = [
			{ role: "user", content: `u0: ${filler}`, timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: `a1: ${filler}` }],
				usage: { inputTokens: 100, outputTokens: 50 },
				stopReason: "stop",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		];

		const context: AgentContext = {
			messages,
			model: fakeModel,
			systemPrompt: "",
			tools: [],
		};

		await compactor(context);
		expect(summaryCalls).toBe(0);
	});
});

describe("Codex-fix: forceProgress breaks usage>limit livelock", () => {
	it("makes a real cut when measureContextTokens overflows but chars/4 fits", async () => {
		// Setup: chars/4 of all messages is small (well inside
		// keepRecentTokens), but the last assistant turn reports usage
		// far past the model window. WITHOUT forceProgress, findCutPoint
		// returns 0 and the auto-compactor silently no-ops every time.
		// WITH forceProgress, the compactor must drop oldest content.
		let cutsAttempted = 0;
		const trackingStreamFn = ((_m: Model, _ctx: any, _opts: any) => {
			cutsAttempted++;
			return fakeStreamFn("forced summary")();
		}) as any;

		const compactor = createAutoCompactor({
			streamFn: trackingStreamFn,
			settings: { reserveTokens: 100, keepRecentTokens: 100_000 },
		});

		// Four short messages; last assistant turn reports 5000 tokens
		// (well past the 1000-token model window).
		const messages: AgentMessage[] = [
			{ role: "user", content: "hi", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: { inputTokens: 4500, outputTokens: 500 },
				stopReason: "stop",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
			{ role: "user", content: "more", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "yep" }],
				stopReason: "stop",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		];

		const context: AgentContext = {
			messages,
			model: fakeModel,
			systemPrompt: "",
			tools: [],
		};

		const before = context.messages.length;
		await compactor(context);
		// Summarization MUST have been called (no silent skip).
		expect(cutsAttempted).toBe(1);
		// And the in-memory context MUST be smaller than what we started with.
		expect(context.messages.length).toBeLessThan(before);
	});
});

describe("regression A5 — small context window", () => {
	it("does not collapse history when contextWindow < default reserveTokens", async () => {
		// 4K context window with default 16K reserve — the original code computed
		// limit = 4K - 16K = -12K, which made the check always trigger and the
		// downstream cut-point math collapse to the last message.
		const tinyModel: Model = {
			id: "tiny",
			name: "Tiny",
			provider: "test",
			contextWindow: 4_000,
		} as unknown as Model;

		const compactor = createAutoCompactor({
			streamFn: fakeStreamFn("compacted") as any,
			// Use defaults — reserveTokens=16384, keepRecentTokens=20000
		});

		// Build a moderate context that's well under 4K tokens
		const messages = buildOversizedMessages(4, 200);
		const beforeLength = messages.length;
		const context: AgentContext = {
			messages,
			model: tinyModel,
			systemPrompt: "",
			tools: [],
		};

		await compactor(context);

		// Context is small — should not have been compacted.
		// Before A5: this would collapse to ~1 message.
		expect(context.messages.length).toBe(beforeLength);
	});

	it("compacts gracefully when small-context truly overflows", async () => {
		const tinyModel: Model = {
			id: "tiny",
			name: "Tiny",
			provider: "test",
			contextWindow: 4_000,
		} as unknown as Model;

		const compactor = createAutoCompactor({
			streamFn: fakeStreamFn("compacted") as any,
			// Defaults
		});

		// Build a context that genuinely exceeds the clamped limit (2K)
		const messages = buildOversizedMessages(20, 800);
		const context: AgentContext = {
			messages,
			model: tinyModel,
			systemPrompt: "",
			tools: [],
		};

		const before = context.messages.length;
		await compactor(context);

		// Should have compacted but kept SOME messages (not just the last one).
		expect(context.messages.length).toBeLessThan(before);
		expect(context.messages.length).toBeGreaterThan(1);
	});
});

describe("regression A4 — repeated-compaction double-count", () => {
	it("does not feed prior compaction_summary into the next summarization input", async () => {
		// Track every message the summarization LLM sees on each round.
		const summarizationInputs: string[][] = [];
		let summaryRound = 0;

		const trackingStreamFn: any = (
			_model: Model,
			ctx: { messages: AgentMessage[] },
			_opts: any,
		) => {
			// The compactor wraps the conversation in a single user message
			// (see formatMessagesForSummary); capture its text so we can assert
			// the prior summary doesn't appear inside.
			const userMsg = ctx.messages[0];
			let text = "";
			if (userMsg && "role" in userMsg && userMsg.role === "user") {
				text =
					typeof userMsg.content === "string"
						? userMsg.content
						: Array.isArray(userMsg.content)
							? userMsg.content
									.filter(
										(c: any): c is { type: "text"; text: string } =>
											c.type === "text",
									)
									.map((c: any) => c.text)
									.join("\n")
							: "";
			}
			summarizationInputs.push([text]);

			summaryRound++;
			return fakeStreamFn(`SUMMARY-ROUND-${summaryRound}`)();
		};

		const compactor = createAutoCompactor({
			streamFn: trackingStreamFn,
			settings: { reserveTokens: 100, keepRecentTokens: 50 },
		});

		// Round 1
		const ctx1: AgentContext = {
			messages: buildOversizedMessages(20),
			model: fakeModel,
			systemPrompt: "",
			tools: [],
		};
		await compactor(ctx1);
		// First message is now the SUMMARY-ROUND-1 custom message
		expect(ctx1.messages[0]).toMatchObject({ role: "custom", type: "compaction_summary" });

		// Round 2: append more messages and compact again on the SAME context
		ctx1.messages.push(...buildOversizedMessages(20, 800));
		await compactor(ctx1);

		// THE FIX: round-2's prompt has the prior summary in EXACTLY ONE
		// place (the `<previous-summary>` slot), not also in the
		// `<new-conversation>` slot. Before A4, it appeared in both and
		// the summarizer would re-summarize it, double-counting and
		// causing the summary to drift/grow each round.
		expect(summarizationInputs.length).toBeGreaterThanOrEqual(2);
		const round2Prompt = summarizationInputs[1].join("\n");

		// Prior summary content appears exactly once
		const summaryOccurrences = round2Prompt.split("SUMMARY-ROUND-1").length - 1;
		expect(summaryOccurrences).toBe(1);

		// And specifically not inside the conversation block. The structured
		// prompt now uses one <conversation> tag for the transcript and a
		// separate <previous-summary> tag for the prior summary, so the
		// prior summary must appear in the latter, never inside the former.
		const conversationMatch = round2Prompt.match(/<conversation>([\s\S]*?)<\/conversation>/);
		expect(conversationMatch).not.toBeNull();
		expect(conversationMatch![1]).not.toContain("SUMMARY-ROUND-1");
		expect(conversationMatch![1]).not.toContain("[Previous conversation summary]");
	});

	it("does not promote a real user message starting with the legacy summary prefix", async () => {
		// A user can legitimately type or paste content that begins with
		// "[Previous conversation summary]" or "[Conversation summary".
		// An older heuristic dropped any such message from the conversation
		// and routed its text into the privileged <previous-summary> slot.
		// That is durable data corruption: the message disappears from the
		// transcript and attacker-supplied text gains elevated trust. The
		// only legitimate provenance for a prior summary is a typed
		// custom-role compaction_summary entry, never raw user text.
		const summarizationInputs: string[] = [];
		const trackingStreamFn: any = (
			_model: Model,
			ctx: { messages: AgentMessage[] },
			_opts: any,
		) => {
			const userMsg = ctx.messages[0];
			let text = "";
			if (userMsg && "role" in userMsg && userMsg.role === "user") {
				text =
					typeof userMsg.content === "string"
						? userMsg.content
						: Array.isArray(userMsg.content)
							? userMsg.content
									.filter(
										(c: any): c is { type: "text"; text: string } =>
											c.type === "text",
									)
									.map((c: any) => c.text)
									.join("\n")
							: "";
			}
			summarizationInputs.push(text);
			return fakeStreamFn("REAL-SUMMARY")();
		};

		const compactor = createAutoCompactor({
			streamFn: trackingStreamFn,
			settings: { reserveTokens: 100, keepRecentTokens: 50 },
		});

		const padding = buildOversizedMessages(18, 800);
		const sentinel = "USER_PASTED_SENTINEL_TEXT_42";
		const offendingUser: AgentMessage = {
			role: "user",
			content: `[Previous conversation summary] ${sentinel}`,
			timestamp: Date.now(),
		};
		const messages: AgentMessage[] = [offendingUser, ...padding];

		const ctx: AgentContext = {
			messages,
			model: fakeModel,
			systemPrompt: "",
			tools: [],
		};
		await compactor(ctx);

		expect(summarizationInputs.length).toBe(1);
		const prompt = summarizationInputs[0];
		const conversationMatch = prompt.match(/<conversation>([\s\S]*?)<\/conversation>/);
		expect(conversationMatch).not.toBeNull();
		// The user's text MUST be inside the <conversation> block, not promoted.
		expect(conversationMatch![1]).toContain(sentinel);
		// And the <previous-summary> block, if present, MUST NOT contain it.
		const prevMatch = prompt.match(/<previous-summary>([\s\S]*?)<\/previous-summary>/);
		if (prevMatch) {
			expect(prevMatch[1]).not.toContain(sentinel);
		}
	});
});

describe("Codex pass-6: costTracker plumbing", () => {
	it("auto-compactor charges the summarization call against the supplied costTracker", async () => {
		// Codex budget-fix pass-6 CRITICAL: auto-compaction's hidden
		// LLM call must contribute to maxCostPerSession. Verify the
		// option propagates from createAutoCompactor through compact()
		// through generateCompactionSummary and back into the tracker.
		const recorded: { usage: any; turnIndex: number }[] = [];
		const tracker = {
			recordTurn: (_m: any, u: any, t: number) => recorded.push({ usage: u, turnIndex: t }),
			isBudgetExceeded: () => false,
		};

		// Stream that returns a summary AND emits provider usage.
		function summaryStream() {
			const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(e) => e.type === "done",
				(e) => {
					if (e.type === "done") return e.message;
					throw new Error("unexpected");
				},
			);
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "summary" }],
				stopReason: "stop",
				timestamp: Date.now(),
				usage: { inputTokens: 500, outputTokens: 100, cost: 0.0123 },
			};
			queueMicrotask(() => {
				stream.push({ type: "start", message });
				stream.push({ type: "done", message });
			});
			return stream;
		}

		const compactor = createAutoCompactor({
			streamFn: summaryStream as any,
			settings: { reserveTokens: 100, keepRecentTokens: 50 },
			costTracker: tracker,
		});

		const ctx: AgentContext = {
			messages: buildOversizedMessages(20),
			model: fakeModel,
			systemPrompt: "",
			tools: [],
		};

		await compactor(ctx);

		// Tracker recorded the summary call's usage.
		expect(recorded.length).toBe(1);
		expect(recorded[0].usage.cost).toBe(0.0123);
	});
});

describe("createAutoCompactorWithPersistence", () => {
	function fakeSessionManager(mappingLength: number) {
		return {
			appendCompaction: vi.fn(() => "entry-id"),
			buildMessageToEntryMapping: () => {
				const mapping: (string | null)[] = [];
				for (let i = 0; i < mappingLength; i++) {
					mapping.push(`entry-${i}`);
				}
				return mapping;
			},
		};
	}

	it("regression A3: still shrinks in-memory context when steering messages outrun the mapping", async () => {
		// Setup: 22 messages in context, but session mapping covers only 20
		// (2 steering messages are ephemeral and not yet persisted).
		const messages = buildOversizedMessages(22);
		const sm = fakeSessionManager(20); // mapping shorter than messages

		const compactor = createAutoCompactorWithPersistence({
			streamFn: fakeStreamFn("summary") as any,
			settings: { reserveTokens: 100, keepRecentTokens: 50 },
			sessionManager: sm,
		});

		const context: AgentContext = {
			messages,
			model: fakeModel,
			systemPrompt: "",
			tools: [],
		};

		const before = context.messages.length;
		await compactor(context);

		// THE FIX: in-memory context must shrink even though mapping was short.
		// Before A3, this returned context unchanged and compaction effectively
		// disabled itself for the rest of the session.
		expect(context.messages.length).toBeLessThan(before);
	});

	it("regression: persistent wrapper exposes reset() so callers can clear cross-session state", async () => {
		const sm = fakeSessionManager(20);
		const compactor = createAutoCompactorWithPersistence({
			streamFn: fakeStreamFn("summary") as any,
			settings: { reserveTokens: 100, keepRecentTokens: 50 },
			sessionManager: sm,
		});
		// Without this, prior compaction's lastSummary/lastDetails leak across sessions
		expect(typeof compactor.reset).toBe("function");
		// Should be callable without throwing
		compactor.reset();
	});

	it("persists when cut point lands inside the mapped range", async () => {
		const messages = buildOversizedMessages(22);
		// Mapping covers ALL messages — cut point will be inside it
		const sm = fakeSessionManager(22);

		const compactor = createAutoCompactorWithPersistence({
			streamFn: fakeStreamFn("summary") as any,
			settings: { reserveTokens: 100, keepRecentTokens: 50 },
			sessionManager: sm,
		});

		const context: AgentContext = {
			messages,
			model: fakeModel,
			systemPrompt: "",
			tools: [],
		};

		await compactor(context);
		expect(sm.appendCompaction).toHaveBeenCalled();
	});

	it("regression (pass-3): persists with prefix-aligned mapping even when message array is longer than mapping", async () => {
		// 22 in-memory messages, mapping covers the first 20 (last 2 are
		// ephemeral steering). Cut point lands INSIDE the mapped range.
		//
		// An earlier strict-equality guard caused permanent persistence
		// divergence: once compaction shrank context.messages, the session
		// file still carried the full un-compacted history, so the strict
		// `mapping.length === messages.length` check failed forever (Codex
		// pass-3 finding). Prefix-alignment is sufficient — both arrays are
		// built in the same order and the mapping covers exactly the
		// persisted prefix.
		const messages = buildOversizedMessages(22, 1200); // ~6600 tokens
		const sm = fakeSessionManager(20); // 2 trailing messages unmapped

		const midModel: Model = {
			id: "mid",
			name: "Mid",
			provider: "test",
			contextWindow: 6000,
		} as unknown as Model;

		const compactor = createAutoCompactorWithPersistence({
			streamFn: fakeStreamFn("summary") as any,
			settings: { reserveTokens: 500, keepRecentTokens: 3000 },
			sessionManager: sm,
		});

		const context: AgentContext = {
			messages,
			model: midModel,
			systemPrompt: "",
			tools: [],
		};

		const before = context.messages.length;
		await compactor(context);

		// In-memory shrink happened
		expect(context.messages.length).toBeLessThan(before);
		// AND persistence ran — anchored to a real entry inside the
		// persisted prefix. With these settings cutIndex lands ~12, which
		// is well inside the 20-entry mapping.
		expect(sm.appendCompaction).toHaveBeenCalled();
		const firstKeptEntryId = sm.appendCompaction.mock.calls[0][1];
		expect(firstKeptEntryId).toMatch(/^entry-\d+$/);
	});

	it("regression (pass-3): persistence recovers on a later round after a deferred first attempt", async () => {
		// Two-pass scenario:
		// Round 1: kept tail lies entirely past the persisted prefix
		// (cutIndex >= mapping.length). Persistence is deferred.
		// Round 2: with a longer mapping (steering messages have flushed),
		// persistence MUST recover. The earlier strict-equality guard
		// permanently disabled persistence after round 1; prefix-alignment
		// must not have that problem.
		const sm = fakeSessionManager(2); // round 1: tiny mapping
		const compactor = createAutoCompactorWithPersistence({
			streamFn: fakeStreamFn("summary") as any,
			settings: { reserveTokens: 100, keepRecentTokens: 50 },
			sessionManager: sm,
		});

		// Round 1 — mapping shorter than messages, kept tail past mapping
		const ctx1: AgentContext = {
			messages: buildOversizedMessages(22),
			model: fakeModel,
			systemPrompt: "",
			tools: [],
		};
		await compactor(ctx1);
		expect(sm.appendCompaction).not.toHaveBeenCalled(); // deferred

		// Round 2 — simulate the agent loop having flushed enough state
		// that the mapping now covers the entire (compacted) message array.
		// Append more messages to push back over the limit.
		ctx1.messages.push(...buildOversizedMessages(20));
		(sm.buildMessageToEntryMapping as any) = () => {
			const out: (string | null)[] = [];
			for (let i = 0; i < ctx1.messages.length; i++) {
				// First message is the synthetic compaction summary from round 1
				out.push(i === 0 ? null : `entry-${i}`);
			}
			return out;
		};

		await compactor(ctx1);

		// Persistence MUST have recovered on round 2
		expect(sm.appendCompaction).toHaveBeenCalled();
	});

	it("skips persistence (but still compacts) when cut point is past the mapping", async () => {
		// Build a context where the kept tail consists of un-mapped messages.
		const messages = buildOversizedMessages(22);
		const sm = fakeSessionManager(2); // mapping covers only first 2

		const compactor = createAutoCompactorWithPersistence({
			streamFn: fakeStreamFn("summary") as any,
			settings: { reserveTokens: 100, keepRecentTokens: 50 },
			sessionManager: sm,
		});

		const context: AgentContext = {
			messages,
			model: fakeModel,
			systemPrompt: "",
			tools: [],
		};

		const before = context.messages.length;
		await compactor(context);

		// Compaction still ran in memory
		expect(context.messages.length).toBeLessThan(before);
		// But persistence was skipped because no kept-entry could be mapped
		expect(sm.appendCompaction).not.toHaveBeenCalled();
	});
});
