/**
 * Auto-Compaction
 *
 * Provides a transformContext hook that automatically compacts
 * when the context approaches the model's context window limit.
 */

import type { AgentContext, AgentMessage } from "../agent/types.js";
import type { StreamFunction } from "@my-agent/ai";
import type { CompactionDetails, CompactionSettings } from "./types.js";
import { DEFAULT_COMPACTION_SETTINGS } from "./types.js";
import {
  compact,
  effectiveReserveTokens,
  measureContextTokens,
  type CompactionCostHook,
  type CompactionResult,
} from "./compaction.js";

/**
 * State maintained across compaction calls.
 */
interface CompactionState {
  lastSummary?: string;
  lastDetails?: CompactionDetails;
}

/**
 * Full compaction result passed to callbacks.
 */
export interface CompactionCallbackResult {
  tokensBefore: number;
  tokensAfter: number;
  summary: string;
  cutIndex: number;
  details: CompactionDetails;
  /**
   * The summary LLM call's reported usage, so the persistence wrapper
   * can charge a live cost tracker AFTER appendCompaction succeeds.
   * Codex budget-fix pass-9 finding.
   */
  summaryUsage?: import("@my-agent/ai").Usage;
}

/**
 * Callback when compaction occurs.
 */
export interface CompactionCallback {
  (result: CompactionCallbackResult): void;
}

/**
 * Options for creating an auto-compactor.
 */
export interface AutoCompactorOptions {
  /** Compaction settings */
  settings?: Partial<CompactionSettings>;
  /** Stream function for LLM summarization */
  streamFn: StreamFunction;
  /** API key resolver */
  getApiKey?: (provider: string) => Promise<string | undefined>;
  /** Callback when compaction occurs */
  onCompaction?: CompactionCallback;
  /** Abort signal */
  signal?: AbortSignal;
  /**
   * Error handling policy for compaction failures.
   * - "skip": Return context unchanged (fail-open, default)
   * - "throw": Re-throw the error to the caller
   */
  onError?: "skip" | "throw";
  /**
   * Cost tracker that the compaction summarization LLM call should be
   * charged against. When omitted, the auto-compactor's summary call
   * is unmetered and a near-budget session can silently overdraw via
   * auto-compaction. Codex budget-fix pass-6 finding.
   */
  costTracker?: CompactionCostHook;
}

/**
 * Auto-compactor transform function with reset capability.
 *
 * Accepts an optional AbortSignal at call time so the agent loop can
 * cancel an in-flight compaction (which makes its own LLM call). When
 * called without a signal, falls back to options.signal supplied at
 * compactor construction.
 */
export interface AutoCompactorTransform {
  (context: AgentContext, signal?: AbortSignal): Promise<AgentContext>;
  /**
   * Reset compaction state. Call this when starting a new, independent conversation
   * to avoid leaking summary/file metadata from previous sessions.
   */
  reset: () => void;
}

/**
 * Create a transformContext function that auto-compacts.
 *
 * This plugs into AgentLoopConfig.transformContext and runs
 * before each LLM call. If context exceeds the limit, it compacts.
 *
 * IMPORTANT: The compactor maintains state (previous summary, file metadata).
 * Either create a new compactor per session, or call `compactor.reset()`
 * between independent conversations to avoid state leakage.
 *
 * @example
 * ```typescript
 * const autoCompact = createAutoCompactor({
 *   streamFn: provider.stream,
 *   onCompaction: (result) => console.log(`Compacted to ${result.tokensAfter} tokens`),
 * });
 *
 * const config: AgentLoopConfig = {
 *   transformContext: autoCompact,
 *   // ...
 * };
 *
 * // Between sessions:
 * autoCompact.reset();
 * ```
 */
export function createAutoCompactor(
  options: AutoCompactorOptions
): AutoCompactorTransform {
  const settings: CompactionSettings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    ...options.settings,
  };

  const state: CompactionState = {};
  const errorPolicy = options.onError ?? "skip";

  const transformContext = async function (
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<AgentContext> {
    if (!settings.enabled) return context;
    // Prefer the call-time signal (from agent loop) over the construction-time
    // signal (from options). The agent loop's signal reflects the current
    // user-cancellation state, while options.signal was bound at setup time.
    const effectiveSignal = signal ?? options.signal;

    const measurement = measureContextTokens(context.messages);
    const currentTokens = measurement.tokens;
    const contextWindow = context.model.contextWindow ?? 128_000;

    // Clamp reserveTokens against the model's actual context window.
    // See `effectiveReserveTokens` for the why; the same clamp is applied
    // by `shouldCompact` so the two cannot disagree.
    const effectiveReserve = effectiveReserveTokens(contextWindow, settings.reserveTokens);
    const limit = contextWindow - effectiveReserve;

    if (currentTokens <= limit) {
      return context;
    }

    // Need to compact
    let result: CompactionResult;
    try {
      const apiKey = options.getApiKey
        ? await options.getApiKey(context.model.provider)
        : undefined;

      // Adjust keepRecentTokens for smaller context windows.
      // If the default keepRecentTokens is larger than available space,
      // reduce it to fit within the limit (keeping at least 25% for new content).
      // After the reserve clamp above, this is guaranteed >= 0.
      const availableForKept = Math.max(
        0,
        Math.floor((contextWindow - effectiveReserve) * 0.75),
      );
      const effectiveKeepRecent = Math.min(settings.keepRecentTokens, availableForKept);

      // forceProgress: when provider Usage tells us we're over the
      // limit, findCutPoint MUST drop something even if the chars/4
      // budget would have kept everything (otherwise next turn we
      // re-trigger and skip again — livelock).
      //
      // Only force when the USAGE side specifically caused the overflow
      // (`usageTokens > limit`). When the trailing chars/4 tail is what
      // pushes us over, findCutPoint already sees mass to cut and the
      // regular path is correct. Forcing in that case would over-shrink
      // the kept tail unnecessarily.
      const forceProgress =
        measurement.lastUsageIndex !== null &&
        measurement.usageTokens > limit;
      result = await compact(context.messages, {
        keepRecentTokens: effectiveKeepRecent,
        model: context.model,
        streamFn: options.streamFn,
        previousCompaction: state.lastDetails,
        previousSummary: state.lastSummary,
        apiKey,
        signal: effectiveSignal,
        forceProgress,
        costTracker: options.costTracker,
      });
    } catch (err) {
      if (errorPolicy === "throw") {
        throw err;
      }
      // Skip: return context unchanged (fail-open)
      return context;
    }

    // If no valid cut point (cutIndex === 0), compaction couldn't drop anything.
    // This can happen with very short contexts. Skip to avoid adding empty summary.
    if (result.cutIndex === 0) {
      return context;
    }

    // Update state
    state.lastSummary = result.summary;
    state.lastDetails = result.details;

    // Notify callback with full result info
    options.onCompaction?.({
      tokensBefore: currentTokens,
      tokensAfter: result.details.tokensAfter,
      summary: result.summary,
      cutIndex: result.cutIndex,
      details: result.details,
      summaryUsage: result.summaryUsage,
    });

    // Build new message list with summary as a custom message.
    // Using role: "custom" keeps it internal (filtered by convertToLlm)
    // but customMessageToLlm converts it to user format for the LLM call.
    const summaryMessage: AgentMessage = {
      role: "custom",
      type: "compaction_summary",
      summary: result.summary,
      tokensBefore: currentTokens,
      tokensAfter: result.details.tokensAfter,
      timestamp: Date.now(),
      ...(result.details.priorCumulativeCost !== undefined
        ? { priorCumulativeCost: result.details.priorCumulativeCost }
        : {}),
    };

    const newMessages = [summaryMessage, ...result.keptMessages];

    // Mutate context.messages in-place so subsequent appends go to the compacted array.
    // This is critical: returning a new context object doesn't help because
    // the agent-loop keeps appending to the original context.messages reference.
    context.messages.length = 0;
    context.messages.push(...newMessages);

    return context;
  } as AutoCompactorTransform;

  // Attach reset method to clear state between independent sessions
  transformContext.reset = () => {
    state.lastSummary = undefined;
    state.lastDetails = undefined;
  };

  return transformContext;
}

/**
 * Session manager interface for persistence.
 * Requires ability to get message-to-entry mapping and append compaction entries.
 */
export interface PersistenceSessionManager {
  /** Append a compaction entry to the session */
  appendCompaction: (
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details: CompactionDetails
  ) => string;
  /**
   * Build a mapping from message indices to entry IDs for the current context.
   * Returns an array where result[i] is the entry ID for messages[i].
   *
   * `null` means there is no persisted entry to anchor on (e.g., the
   * synthetic compaction-summary that's prepended in memory). Branch
   * summaries DO have persisted entry ids and are returned as such — they
   * are valid anchors for `firstKeptEntryId`.
   */
  buildMessageToEntryMapping: () => (string | null)[];
  /**
   * Optional cross-process lock. When provided, the persistence wrapper
   * runs `appendCompaction` inside it. The lock activates the
   * session-manager's disk-rollback path (truncateSync to the
   * pre-write size) on persist failure — without it, a failed write
   * leaves a partial trailing line on disk that later parses
   * silently as a malformed entry. Codex budget-fix pass-9 finding.
   */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Create an auto-compactor that also persists to a session manager.
 *
 * This uses the compaction callback to receive full result details including
 * cutIndex, then maps that to the correct entry ID using message-to-entry mapping
 * that properly accounts for synthetic messages.
 */
export function createAutoCompactorWithPersistence(
  options: AutoCompactorOptions & {
    /** Session manager for persistence */
    sessionManager: PersistenceSessionManager;
  }
): AutoCompactorTransform {
  // Track last compaction result for persistence callback
  let capturedCompaction: CompactionCallbackResult | undefined;
  // Capture the mapping before compaction transforms the context
  let preCompactionMapping: (string | null)[] = [];

  // Strip costTracker from the inner options so the summary call is
  // NOT charged via compact()'s onUsage. The wrapper charges the
  // tracker AFTER appendCompaction succeeds — preserving atomicity
  // across persist failures (live tracker and disk stay aligned).
  // Codex budget-fix pass-9 finding.
  const innerOptions: AutoCompactorOptions = { ...options };
  delete (innerOptions as { costTracker?: unknown }).costTracker;

  const compactor = createAutoCompactor({
    ...innerOptions,
    onCompaction: (result) => {
      capturedCompaction = result;
      // Also call the original callback if provided
      options.onCompaction?.(result);
    },
  });

  const wrapped = async function transformContext(
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<AgentContext> {
    capturedCompaction = undefined;
    // Capture mapping BEFORE compaction. The mapping is built from the
    // PERSISTED branch (see SessionManager.buildMessageToEntryMapping)
    // and is prefix-aligned with context.messages by construction —
    // i.e., mapping[i] is the entry id (or null) for context.messages[i]
    // for every i in [0, mapping.length). The TAIL of context.messages
    // beyond mapping.length is ephemeral state (e.g., steering messages
    // injected by the agent loop, freshly compacted summary not yet
    // persisted) that has no corresponding session entry yet.
    //
    // Any cutIndex < mapping.length is safe to look up directly because
    // of that prefix alignment. A cutIndex >= mapping.length means the
    // kept tail consists entirely of unpersisted ephemeral state, in
    // which case we defer persistence to a future round once the agent
    // loop has flushed those messages.
    preCompactionMapping = options.sessionManager.buildMessageToEntryMapping();

    // Snapshot the pre-compaction transcript so we can roll back if
    // appendCompaction throws. Without rollback, a persist failure
    // leaves the in-memory context shrunk and the summary call
    // already charged, but no durable CompactionEntry on disk — so
    // a restart would lose the priorCumulativeCost snapshot for the
    // compacted-away spend. With rollback, on persist failure the
    // process keeps the original messages and the next compaction
    // round can retry. Codex budget-fix pass-8 finding.
    const preCompactionMessages = context.messages.slice();

    // Always run the in-memory compaction. Compaction has two concerns —
    // "shrink the LLM context" and "record what was shrunk in the session
    // file". The first MUST always succeed when the context is over the
    // limit, otherwise context grows until the provider rejects the call.
    // The second can defer to a later turn when the persistence mapping
    // catches up to the in-memory state.
    const result = await compactor(context, signal);

    const compactionResult = capturedCompaction as CompactionCallbackResult | undefined;
    if (compactionResult !== undefined && compactionResult.cutIndex > 0) {
      const { summary, cutIndex, tokensBefore, details } = compactionResult;

      // Find the first kept entry at or after cutIndex. Skip synthetic
      // messages (null entry IDs, e.g., a previous compaction summary or
      // a branch summary). Stops at preCompactionMapping.length, which
      // covers exactly the persisted prefix.
      let firstKeptEntryId: string | null = null;
      for (let i = cutIndex; i < preCompactionMapping.length; i++) {
        if (preCompactionMapping[i] !== null) {
          firstKeptEntryId = preCompactionMapping[i];
          break;
        }
      }

      // Only persist when we can anchor to a real session entry. If the
      // entire kept tail lies past the persisted prefix (all ephemeral
      // tail), skip — the in-memory context is already shrunk so the
      // current LLM call is safe, and the next compaction round will
      // anchor once the agent loop has flushed those messages.
      //
      // NOTE on prefix-alignment safety: an EARLIER attempt used a
      // strict `mapping.length === messages.length` guard. That created
      // permanent persistence divergence: once the in-memory context
      // shrunk via compaction, the session file (still holding the full
      // un-compacted history) had a longer mapping than context.messages
      // ever again, so the strict check failed forever. The
      // prefix-alignment approach used here recovers as soon as cutIndex
      // lands inside the mapping range, and at worst defers persistence
      // by one or two turns.
      if (firstKeptEntryId) {
        try {
          // Wrap in withLock when the session manager exposes one so
          // a failed write triggers the disk-level truncate rollback
          // inside SessionManager.appendEntry. Without the lock, a
          // partial trailing line stays on disk and later parses as
          // malformed silently. Codex budget-fix pass-9 finding.
          const persist = () =>
            options.sessionManager.appendCompaction(
              summary,
              firstKeptEntryId,
              tokensBefore,
              details,
            );
          if (options.sessionManager.withLock) {
            await options.sessionManager.withLock(async () => persist());
          } else {
            persist();
          }
        } catch (persistErr) {
          // Persistence failed (disk full, permission, transient fs
          // error). Roll the in-memory context BACK to its
          // pre-compaction state so disk and memory stay aligned —
          // the next compaction round will retry. Because the
          // costTracker was NOT charged during the inner compaction
          // (we stripped it from inner options), the live tracker
          // is also still aligned with disk: no spend was recorded
          // for the failed-to-persist summary call. On restart, the
          // original messages survive in the session file and
          // replay rebuilds the bulk of the spend.
          context.messages.length = 0;
          context.messages.push(...preCompactionMessages);
          throw persistErr;
        }

        // Persist succeeded. NOW charge the live tracker for the
        // summary call. This is the only path that records the
        // ancillary spend live; all other paths rely on the
        // priorCumulativeCost snapshot for restart replay.
        if (options.costTracker && compactionResult.summaryUsage) {
          options.costTracker.recordTurn(
            context.model,
            compactionResult.summaryUsage,
            -1,
          );
        }
      }
    }

    return result;
  } as AutoCompactorTransform;

  // Forward reset() to the inner compactor so callers reusing the same
  // persistent wrapper across independent sessions can clear lastSummary
  // and lastDetails. Without this forwarding, prior compaction context
  // leaks into the next session.
  wrapped.reset = compactor.reset;
  return wrapped;
}
