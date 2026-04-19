/**
 * Session Types
 *
 * Type definitions for session persistence using JSONL event sourcing.
 * Sessions are stored as append-only logs where each entry has an id and parentId
 * forming a tree structure that supports branching and navigation.
 */

import type { Model } from "@my-agent/ai";
import type { AgentMessage } from "../agent/types.js";

// ============================================================================
// Session Header
// ============================================================================

/**
 * Session file header - first line of every JSONL session file.
 */
export interface SessionHeader {
	type: "session";
	/** Schema version for migrations */
	version: number;
	/** Unique session identifier (UUIDv7 for time-ordering) */
	id: string;
	/** Working directory where session was started */
	cwd: string;
	/** ISO timestamp of session creation */
	timestamp: string;
	/** Path to parent session if this was forked */
	parentSession?: string;
	/** Entry ID in parent session where fork occurred */
	forkPoint?: string;
}

// ============================================================================
// Entry Base
// ============================================================================

/**
 * Base interface for all session entries.
 * Every entry has an id and parentId forming a tree structure.
 */
export interface SessionEntryBase {
	/** Unique identifier within session (8 hex chars) */
	id: string;
	/** Parent entry ID (null for first entry) */
	parentId: string | null;
	/** ISO timestamp */
	timestamp: string;
}

// ============================================================================
// Entry Types
// ============================================================================

/**
 * Message entry - wraps an AgentMessage (user, assistant, toolResult).
 */
export interface MessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

/**
 * Settings change entry - tracks model and/or thinking level changes.
 * Unified entry type (improvement over Pi-Mono's separate types).
 */
export interface SettingsChangeEntry extends SessionEntryBase {
	type: "settings_change";
	/** Model change (if changed) */
	model?: {
		provider: string;
		modelId: string;
		name?: string;
	};
	/** Thinking level change (if changed) */
	thinkingLevel?: string;
}

/**
 * Compaction entry - records when context was compacted.
 * The summary replaces earlier messages in LLM context.
 */
export interface CompactionEntry extends SessionEntryBase {
	type: "compaction";
	/** LLM-generated summary of compacted messages */
	summary: string;
	/** First entry ID to keep (entries before this are summarized) */
	firstKeptEntryId: string;
	/** Token count before compaction */
	tokensBefore: number;
	/** Compaction metadata */
	details: CompactionDetails;
}

/**
 * Branch summary entry - captures context when navigating away from a branch.
 */
export interface BranchSummaryEntry extends SessionEntryBase {
	type: "branch_summary";
	/** Entry ID where we branched from */
	fromId: string;
	/** LLM-generated summary of abandoned branch */
	summary: string;
	/** Branch summary metadata */
	details?: BranchSummaryDetails;
}

/**
 * Session info entry - stores session metadata like display name.
 */
export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	/** User-defined session name (undefined clears the name) */
	name?: string;
}

/**
 * Label entry - attaches a user-defined label to any other entry.
 *
 * Labels act as named bookmarks for navigation: rather than scanning
 * a session for "the turn where I asked about X", the user labels
 * that turn and references it by name. Labels are append-only history
 * (a new LabelEntry with `label: undefined` clears the label) so the
 * full provenance is recoverable on replay; only the latest label per
 * targetId is exposed via the getLabel/getLabels API.
 *
 * Single-owner semantics: a label string is owned by at most one
 * entry at a time. Reassigning a label that another target already
 * holds atomically displaces it; the displacement is recorded in
 * the same LabelEntry via the `displaces` field so the change is one
 * append (no two-write race that could lose the label on crash).
 */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	/** Entry being labeled. */
	targetId: string;
	/** New label value. `undefined` (or empty after trim) clears the label. */
	label?: string;
	/**
	 * Other target IDs whose labels this entry atomically clears.
	 * Used to displace a previous owner when this entry takes a label
	 * that was attached elsewhere. Replaying this entry processes the
	 * assign for `targetId` and the clear for each entry in `displaces`
	 * as a single unit.
	 */
	displaces?: string[];
}

/**
 * Extension entry — namespaced plugin payload that core does not interpret.
 *
 * Lets plugins persist arbitrary state inside the session file without
 * widening the core entry union or risking key collisions. Core only
 * promises to:
 *   * preserve unknown extension namespaces verbatim through reads,
 *     writes, and migrations,
 *   * skip extensions when reconstructing LLM context, building branch
 *     summaries, or computing compaction inputs,
 *   * surface them through `getEntries()` and the namespace-filtered
 *     accessor on SessionManager so plugins can recover their own
 *     payloads on session reload.
 *
 * Plugins MUST namespace their entries (reverse-DNS, short slug, or
 * package name) so two unrelated plugins cannot collide. `subtype` is
 * an optional secondary discriminator inside one namespace.
 */
export interface ExtensionEntry extends SessionEntryBase {
	type: "extension";
	/** Plugin-specific namespace; must be unique across all installed plugins. */
	namespace: string;
	/** Optional sub-discriminator inside the namespace. */
	subtype?: string;
	/** Plugin-defined opaque payload. Core never reads its shape. */
	payload: unknown;
}

// ============================================================================
// Entry Union
// ============================================================================

/**
 * All possible session entry types.
 */
export type SessionEntry =
	| MessageEntry
	| SettingsChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| SessionInfoEntry
	| LabelEntry
	| ExtensionEntry;

/**
 * Raw file entry (header or entry).
 */
export type FileEntry = SessionHeader | SessionEntry;

// ============================================================================
// Details Types
// ============================================================================

/**
 * Metadata stored with compaction entries.
 */
export interface CompactionDetails {
	/** Files that were read in compacted messages */
	readFiles: string[];
	/** Files that were modified in compacted messages */
	modifiedFiles: string[];
	/** Token count after compaction */
	tokensAfter: number;
	/** Self-evaluation of compaction quality. Optional for backward compat
	 * with sessions written before self-eval shipped — readers MUST treat
	 * `undefined` as "not evaluated" and not as "no warnings". */
	evaluation?: CompactionEvaluation;
	/**
	 * Sum of `usage.cost` across every non-aborted/non-error assistant
	 * message that was folded into this compaction. Used by the cost
	 * tracker's `loadFromMessages` replay on resume. Optional for backward
	 * compat with compactions written before this field; readers MUST
	 * treat `undefined` as "unknown prior spend, don't seed".
	 */
	priorCumulativeCost?: number;
}

/**
 * Post-compaction sanity checks. Recorded with the entry; not thrown.
 * Surfaces concrete failure modes so callers can decide whether to
 * trust the summary, retry, or escalate. Estimates use the same
 * chars/4 heuristic as the rest of the codebase so the numbers are
 * comparable to other token measurements.
 */
export interface CompactionEvaluation {
	/** Estimated tokens in the input transcript that was summarized */
	tokensBefore: number;
	/** Estimated tokens in the produced summary */
	tokensAfterSummary: number;
	/** tokensAfterSummary / tokensBefore. 1.0 = no shrink; <1.0 = shrunk. */
	savingsRatio: number;
	/** Tracked file paths that did not appear anywhere in the summary text */
	missingFiles: string[];
	/** Human-readable warnings: empty summary, summary larger than input,
	 * tracked files dropped, etc. Empty array means the summary passed all
	 * checks. */
	warnings: string[];
}

/**
 * Metadata stored with branch summary entries.
 */
export interface BranchSummaryDetails {
	/** Files that were read in abandoned branch */
	readFiles: string[];
	/** Files that were modified in abandoned branch */
	modifiedFiles: string[];
	/** Number of messages in abandoned branch */
	messageCount: number;
}

// ============================================================================
// Tree Types
// ============================================================================

/**
 * Tree node for session visualization.
 */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
}

// ============================================================================
// Context Types
// ============================================================================

/**
 * Reconstructed session context for LLM.
 */
export interface SessionContext {
	/** Messages to send to LLM */
	messages: AgentMessage[];
	/** Current model settings (null if not set) */
	model: { provider: string; modelId: string; name?: string } | null;
	/** Current thinking level */
	thinkingLevel: string;
}

// ============================================================================
// Session Info (for listing)
// ============================================================================

/**
 * Summary info about a session (for listing without loading full content).
 */
export interface SessionInfo {
	/** Full path to session file */
	path: string;
	/** Session ID */
	id: string;
	/** Working directory */
	cwd: string;
	/** User-defined display name */
	name?: string;
	/** Parent session path (if forked) */
	parentSessionPath?: string;
	/** Creation timestamp */
	created: Date;
	/** Last activity timestamp */
	modified: Date;
	/** Number of message entries */
	messageCount: number;
	/** Preview text (first user message) */
	firstMessage: string;
}

// ============================================================================
// Compaction Settings
// ============================================================================

/**
 * Configuration for auto-compaction.
 */
export interface CompactionSettings {
	/** Whether auto-compaction is enabled */
	enabled: boolean;
	/** Tokens to reserve for LLM output */
	reserveTokens: number;
	/** Minimum tokens of recent context to keep */
	keepRecentTokens: number;
}

/**
 * Default compaction settings.
 */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16_384,
	keepRecentTokens: 20_000,
};

// ============================================================================
// Constants
// ============================================================================

/**
 * Current session schema version.
 * Increment when making breaking changes to session format.
 *
 * Version history:
 *   v1 — initial schema
 *   v2 — adds LabelEntry (`type: "label"`) with optional
 *        `displaces?: string[]` for atomic single-owner moves.
 *        Older readers don't know how to remap label.targetId on
 *        fork (their forkSession would copy the targetId verbatim
 *        and corrupt navigation), so we bump the version and the
 *        loader rejects newer files.
 */
export const CURRENT_SESSION_VERSION = 2;
