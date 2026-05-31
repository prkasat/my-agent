/**
 * Session Module
 *
 * Provides persistent session management with:
 * - JSONL event sourcing (append-only, crash-safe)
 * - Tree structure for branching and navigation
 * - LLM-powered compaction for long conversations
 * - Branch summarization to preserve context
 */

export type {
	AutoCompactorOptions,
	AutoCompactorTransform,
	CompactionCallback,
	CompactionCallbackResult,
	PersistenceSessionManager,
} from "./auto-compact.js";
// Auto-Compaction
export {
	createAutoCompactor,
	createAutoCompactorWithPersistence,
} from "./auto-compact.js";
export type {
	BranchSummaryResult,
	BranchTreeReader,
	CollectEntriesResult,
	GenerateBranchSummaryOptions,
} from "./branch-summary.js";
// Branch Summarization
export {
	collectEntriesForBranchSummary,
	generateBranchSummary,
	shouldGenerateBranchSummary,
} from "./branch-summary.js";
export type {
	CompactionResult,
	CompactOptions,
	ContextTokenMeasurement,
} from "./compaction.js";
// Compaction
export {
	calculateContextTokens,
	compact,
	estimateContextTokens,
	estimateTokens,
	evaluateCompaction,
	extractFileOperations,
	findCutPoint,
	generateCompactionSummary,
	measureContextTokens,
	shouldCompact,
} from "./compaction.js";
// Session Manager
export { buildSessionContext, SessionManager } from "./session-manager.js";
// Types
export type {
	BranchSummaryDetails,
	BranchSummaryEntry,
	CompactionDetails,
	CompactionEntry,
	CompactionEvaluation,
	CompactionSettings,
	ExtensionEntry,
	FileEntry,
	MessageEntry,
	SessionContext,
	SessionEntry,
	SessionEntryBase,
	SessionHeader,
	SessionInfo,
	SessionInfoEntry,
	SessionTreeNode,
	SettingsChangeEntry,
} from "./types.js";
export { CURRENT_SESSION_VERSION, DEFAULT_COMPACTION_SETTINGS } from "./types.js";
