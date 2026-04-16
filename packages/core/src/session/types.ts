/**
 * Session Types
 *
 * Type definitions for session persistence using JSONL event sourcing.
 * Sessions are stored as append-only logs where each entry has an id and parentId
 * forming a tree structure that supports branching and navigation.
 */

import type { AgentMessage } from "../agent/types.js";
import type { Model } from "@my-agent/ai";

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
  | SessionInfoEntry;

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
 */
export const CURRENT_SESSION_VERSION = 1;
