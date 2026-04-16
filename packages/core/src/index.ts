// @my-agent/core - Agent runtime engine

// Agent loop
export { agentLoop, agentLoopContinue } from "./agent/agent-loop.js";
export { defaultConvertToLlm } from "./agent/convert.js";

// System prompt
export { buildSystemPrompt, BASE_INSTRUCTIONS, SAFETY_RULES } from "./agent/system-prompt.js";
export type { SystemPromptConfig, ProjectContextFile } from "./agent/system-prompt.js";

// Resource discovery
export { discoverProjectContext } from "./agent/resource-discovery.js";
export type { DiscoveryResult } from "./agent/resource-discovery.js";

// Permissions
export { createPermissionChecker } from "./agent/permissions.js";
export type { PermissionMode, PermissionCheckerOptions } from "./agent/permissions.js";

// Cost tracking
export { CostTracker } from "./agent/cost-tracker.js";
export type { SessionCosts, TurnCost } from "./agent/cost-tracker.js";

// Custom messages
export { customMessageToLlm } from "./agent/custom-messages.js";
export type {
	CustomMessage,
	BashExecutionMessage,
	CompactionSummaryMessage,
	BranchSummaryMessage,
	ExtensionMessage,
} from "./agent/custom-messages.js";

// Infrastructure utilities
export { killProcessTree, createTimeoutController } from "./tools/process-cleanup.js";
export { withFileLock, withCrossProcessLock, acquireFileLock } from "./tools/file-mutation-queue.js";
export { computeDiff } from "./tools/diff.js";
export type { DiffResult } from "./tools/diff.js";

// Output sanitization
export { sanitizeOutput, sanitizeBuffer, redactSensitiveEnv } from "./tools/sanitize-output.js";

// Shell utilities
export { getShellConfig, getShellEnv, validateShell, clearShellConfigCache } from "./tools/shell-utils.js";
export type { ShellConfig } from "./tools/shell-utils.js";

// Tools manager (auto-download external tools)
export { ensureTool, getToolPath, getToolsDir } from "./tools/tools-manager.js";
export type { EnsureToolOptions, EnsureToolResult } from "./tools/tools-manager.js";

// Temp file management
export { getTempFilePath, markForCleanup, preserveTempFile, cleanupTempFile, cleanupSessionTempFiles, cleanupOldTempFiles, getTempFileStats } from "./tools/temp-file-manager.js";

// Audit logging
export { AuditLogger, ExecutionLogger, getAuditLogger, configureAuditLogger, disableAuditLogging } from "./tools/audit.js";
export type { AuditLogEntry, AuditLoggerConfig } from "./tools/audit.js";

// Image resize utilities
export { resizeImage, formatDimensionNote } from "./tools/image-resize.js";
export type { ImageResizeOptions, ResizedImage } from "./tools/image-resize.js";

// Standalone bash executor
export { executeBash, executeBashWithOperations, exec } from "./tools/bash-executor.js";
export type { BashExecutorOptions, BashResult } from "./tools/bash-executor.js";

// Tool definition layer
export { wrapToolDefinition, wrapToolDefinitions, createToolDefinitionFromAgentTool } from "./tools/tool-definition.js";
export type { ToolDefinition } from "./tools/tool-definition.js";

// Truncation utilities
export { truncateHead, truncateTail, truncateLine, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, GREP_MAX_LINE_LENGTH } from "./tools/truncate.js";
export type { TruncationResult, TruncationOptions } from "./tools/truncate.js";

// Path utilities
export { expandPath, resolveToCwd, resolveReadPath, isPathWithinBoundary, resolveAndValidatePath } from "./tools/path-utils.js";

// Edit diff utilities
export { fuzzyFindText, normalizeForFuzzyMatch, normalizeToLF, detectLineEnding, restoreLineEndings, stripBom, applyEditsToNormalizedContent, generateDiffString } from "./tools/edit-diff.js";
export type { Edit, FuzzyMatchResult, AppliedEditsResult } from "./tools/edit-diff.js";

// Tools
export { createReadToolDefinition, createReadTool } from "./tools/read.js";
export type { ReadToolInput, ReadToolDetails, ReadOperations, ReadToolOptions } from "./tools/read.js";

export { createWriteToolDefinition, createWriteTool } from "./tools/write.js";
export type { WriteToolInput, WriteOperations, WriteToolOptions } from "./tools/write.js";

export { createEditToolDefinition, createEditTool } from "./tools/edit.js";
export type { EditToolInput, EditToolDetails, EditOperations, EditToolOptions } from "./tools/edit.js";

export { createBashToolDefinition, createBashTool, createLocalBashOperations } from "./tools/bash.js";
export type { BashToolInput, BashToolDetails, BashOperations, BashToolOptions, BashSpawnContext, BashSpawnHook } from "./tools/bash.js";

export { createGrepToolDefinition, createGrepTool } from "./tools/grep.js";
export type { GrepToolInput, GrepToolDetails, GrepOperations, GrepToolOptions } from "./tools/grep.js";

export { createFindToolDefinition, createFindTool } from "./tools/find.js";
export type { FindToolInput, FindToolDetails, FindOperations, FindToolOptions } from "./tools/find.js";

export { createLsToolDefinition, createLsTool } from "./tools/ls.js";
export type { LsToolInput, LsToolDetails, LsOperations, LsToolOptions } from "./tools/ls.js";

// Tool registry
export {
	createAllToolDefinitions,
	createAllTools,
	createCodingToolDefinitions,
	createCodingTools,
	createReadOnlyToolDefinitions,
	createReadOnlyTools,
} from "./tools/registry.js";
export type { ToolName, ToolsOptions } from "./tools/registry.js";

// Types
export type {
	AgentEvent,
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	CustomAgentMessage,
	AgentTool,
	AgentToolResult,
	BeforeToolCallContext,
	BeforeToolCallResult,
	AfterToolCallContext,
	AfterToolCallResult,
} from "./agent/types.js";

// Session persistence
export {
	SessionManager,
	buildSessionContext,
	CURRENT_SESSION_VERSION,
	DEFAULT_COMPACTION_SETTINGS,
	// Compaction
	estimateTokens,
	estimateContextTokens,
	findCutPoint,
	extractFileOperations,
	generateCompactionSummary,
	compact,
	shouldCompact,
	// Auto-compaction
	createAutoCompactor,
	createAutoCompactorWithPersistence,
	// Branch summarization
	generateBranchSummary,
	shouldGenerateBranchSummary,
} from "./session/index.js";

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
	CompactionResult,
	CompactOptions,
	AutoCompactorOptions,
	CompactionCallback,
	BranchSummaryResult,
	GenerateBranchSummaryOptions,
} from "./session/index.js";
