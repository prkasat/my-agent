/**
 * Session Module
 *
 * Provides persistent session management with:
 * - JSONL event sourcing (append-only, crash-safe)
 * - Tree structure for branching and navigation
 * - LLM-powered compaction for long conversations
 * - Branch summarization to preserve context
 */

// Types
export type {
  SessionHeader,
  SessionEntryBase,
  MessageEntry,
  SettingsChangeEntry,
  CompactionEntry,
  BranchSummaryEntry,
  SessionInfoEntry,
  SessionEntry,
  FileEntry,
  CompactionDetails,
  BranchSummaryDetails,
  SessionTreeNode,
  SessionContext,
  SessionInfo,
  CompactionSettings,
} from "./types.js";

export { CURRENT_SESSION_VERSION, DEFAULT_COMPACTION_SETTINGS } from "./types.js";

// Session Manager
export { SessionManager, buildSessionContext } from "./session-manager.js";

// Compaction
export {
  estimateTokens,
  estimateContextTokens,
  findCutPoint,
  extractFileOperations,
  generateCompactionSummary,
  compact,
  shouldCompact,
} from "./compaction.js";
export type { CompactionResult, CompactOptions } from "./compaction.js";

// Auto-Compaction
export {
  createAutoCompactor,
  createAutoCompactorWithPersistence,
} from "./auto-compact.js";
export type {
  AutoCompactorOptions,
  AutoCompactorTransform,
  CompactionCallback,
  CompactionCallbackResult,
  PersistenceSessionManager,
} from "./auto-compact.js";

// Branch Summarization
export {
  generateBranchSummary,
  shouldGenerateBranchSummary,
} from "./branch-summary.js";
export type {
  BranchSummaryResult,
  GenerateBranchSummaryOptions,
} from "./branch-summary.js";
