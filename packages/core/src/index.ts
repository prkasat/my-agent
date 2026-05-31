// @my-agent/core - Agent runtime engine

// Agent loop
export { agentLoop, agentLoopContinue } from "./agent/agent-loop.js";
export { defaultConvertToLlm } from "./agent/convert.js";
export type { SessionCosts, TurnCost } from "./agent/cost-tracker.js";
// Cost tracking
export { CostTracker } from "./agent/cost-tracker.js";
export type {
	BashExecutionMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	CustomMessage,
	ExtensionMessage,
} from "./agent/custom-messages.js";
// Custom messages
export { customMessageToLlm } from "./agent/custom-messages.js";
export type {
	AskDecision,
	PermissionAskContext,
	PermissionCheckerOptions,
	PermissionMode,
} from "./agent/permissions.js";
// Permissions
export { BUILTIN_READ_TOOL_NAMES, createPermissionChecker } from "./agent/permissions.js";
export type { DiscoveryResult } from "./agent/resource-discovery.js";
// Resource discovery
export { discoverProjectContext } from "./agent/resource-discovery.js";
export type { ProjectContextFile, SystemPromptConfig } from "./agent/system-prompt.js";
// System prompt
export { BASE_INSTRUCTIONS, buildSystemPrompt, SAFETY_RULES } from "./agent/system-prompt.js";
// Types
export type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	BeforeToolCallContext,
	BeforeToolCallResult,
	CustomAgentMessage,
} from "./agent/types.js";
export type {
	ExtensionActions,
	ExtensionCommand,
	ExtensionConfigSchema,
	ExtensionContext,
	ExtensionDefinition,
	ExtensionEvent,
	ExtensionEventBase,
	ExtensionEventByType,
	ExtensionEventHandler,
	ExtensionEventType,
	ExtensionFailureMode,
	ExtensionManifest,
	ExtensionMetadata,
	ExtensionMetrics,
	ExtensionRunnerOptions,
	ExtensionStorage,
	ExtensionUI,
	LoaderOptions,
	LogSink,
	MetricsRecorder,
	MockActions,
	MockContext,
	MockContextOptions,
	MockUI,
	StorageOptions,
	StorageScope,
	ToolInterceptResult,
	ToolMiddleware,
	ToolMiddlewareContext,
	ToolResultModification,
	UISelectItem,
} from "./extensions/index.js";
// Extension system
export {
	activateForTest,
	createMockActions,
	createMockContext,
	createMockUI,
	ExtensionLoader,
	ExtensionRunner,
	FileExtensionStorage,
	MemoryExtensionStorage,
	MetricsTracker,
	noopActions,
	noopUI,
} from "./extensions/index.js";
export { EXTENSION_API_VERSION, isExtensionApiCompatible } from "./extensions/version.js";
export type {
	LoadResourcePackagesConfig,
	LoadResourcePackagesResult,
	ResourcePackage,
	ResourcePackageManifest,
} from "./resources/packages.js";
// Resource packages
export { loadResourcePackages } from "./resources/packages.js";
export type { LoadSkillsConfig, LoadSkillsResult, SkillDefinition } from "./resources/skills.js";
// Skills
export { expandSkill, findSkillByCommand, getSkillHelp, loadSkills } from "./resources/skills.js";
export type {
	AutoCompactorOptions,
	BranchSummaryDetails,
	BranchSummaryEntry,
	BranchSummaryResult,
	CompactionCallback,
	CompactionDetails,
	CompactionEntry,
	CompactionEvaluation,
	CompactionResult,
	CompactionSettings,
	CompactOptions,
	ExtensionEntry,
	FileEntry,
	GenerateBranchSummaryOptions,
	MessageEntry,
	SessionContext,
	SessionEntry,
	SessionEntryBase,
	SessionHeader,
	SessionInfo,
	SessionInfoEntry,
	SessionTreeNode,
	SettingsChangeEntry,
} from "./session/index.js";
// Session persistence
export {
	buildSessionContext,
	CURRENT_SESSION_VERSION,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	// Auto-compaction
	createAutoCompactor,
	createAutoCompactorWithPersistence,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	// Compaction
	estimateTokens,
	evaluateCompaction,
	extractFileOperations,
	findCutPoint,
	// Branch summarization
	generateBranchSummary,
	generateCompactionSummary,
	measureContextTokens,
	SessionManager,
	shouldCompact,
	shouldGenerateBranchSummary,
} from "./session/index.js";
export type { PromptTemplate, TemplateLoadConfig } from "./templates/prompt-templates.js";
// Prompt templates
export {
	expandTemplate,
	getTemplateHelp,
	loadPromptTemplates,
	matchTemplate,
} from "./templates/prompt-templates.js";
export type { AuditLogEntry, AuditLoggerConfig } from "./tools/audit.js";
// Audit logging
export {
	AuditLogger,
	configureAuditLogger,
	disableAuditLogging,
	ExecutionLogger,
	getAuditLogger,
} from "./tools/audit.js";
export type {
	BashOperations,
	BashSpawnContext,
	BashSpawnHook,
	BashToolDetails,
	BashToolInput,
	BashToolOptions,
} from "./tools/bash.js";
export { createBashTool, createBashToolDefinition, createLocalBashOperations } from "./tools/bash.js";
export type { BashExecutorOptions, BashResult } from "./tools/bash-executor.js";
// Standalone bash executor
export { exec, executeBash, executeBashWithOperations } from "./tools/bash-executor.js";
export type { DiffResult } from "./tools/diff.js";
export { computeDiff } from "./tools/diff.js";
export type { EditOperations, EditToolDetails, EditToolInput, EditToolOptions } from "./tools/edit.js";
export { createEditTool, createEditToolDefinition } from "./tools/edit.js";
export type { AppliedEditsResult, Edit, FuzzyMatchResult } from "./tools/edit-diff.js";
// Edit diff utilities
export {
	applyEditsToNormalizedContent,
	detectLineEnding,
	fuzzyFindText,
	generateDiffString,
	normalizeForFuzzyMatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./tools/edit-diff.js";
export { acquireFileLock, withCrossProcessLock, withFileLock } from "./tools/file-mutation-queue.js";
export type { FindOperations, FindToolDetails, FindToolInput, FindToolOptions } from "./tools/find.js";
export { createFindTool, createFindToolDefinition } from "./tools/find.js";
export type { GrepOperations, GrepToolDetails, GrepToolInput, GrepToolOptions } from "./tools/grep.js";
export { createGrepTool, createGrepToolDefinition } from "./tools/grep.js";
export type { ImageResizeOptions, ResizedImage } from "./tools/image-resize.js";
// Image resize utilities
export { formatDimensionNote, resizeImage } from "./tools/image-resize.js";
export type { LsOperations, LsToolDetails, LsToolInput, LsToolOptions } from "./tools/ls.js";
export { createLsTool, createLsToolDefinition } from "./tools/ls.js";
// Path utilities
export {
	expandPath,
	isPathWithinBoundary,
	resolveAndValidatePath,
	resolveReadPath,
	resolveToCwd,
} from "./tools/path-utils.js";
// Infrastructure utilities
export { createTimeoutController, killProcessTree } from "./tools/process-cleanup.js";
export type { ReadOperations, ReadToolDetails, ReadToolInput, ReadToolOptions } from "./tools/read.js";
// Tools
export { createReadTool, createReadToolDefinition } from "./tools/read.js";
// Secret redaction (also reused by audit logger)
export { redactSecrets, redactValue } from "./tools/redact.js";
export type { ToolName, ToolsOptions } from "./tools/registry.js";
// Tool registry
export {
	createAllToolDefinitions,
	createAllTools,
	createCodingToolDefinitions,
	createCodingTools,
	createReadOnlyToolDefinitions,
	createReadOnlyTools,
	getToolVersions,
} from "./tools/registry.js";
// Output sanitization
export { redactSensitiveEnv, sanitizeBuffer, sanitizeOutput } from "./tools/sanitize-output.js";
export type { ShellConfig } from "./tools/shell-utils.js";
// Shell utilities
export { clearShellConfigCache, getShellConfig, getShellEnv, validateShell } from "./tools/shell-utils.js";
// Temp file management
export {
	cleanupOldTempFiles,
	cleanupSessionTempFiles,
	cleanupTempFile,
	getTempFilePath,
	getTempFileStats,
	markForCleanup,
	preserveTempFile,
} from "./tools/temp-file-manager.js";
export type { ToolDefinition } from "./tools/tool-definition.js";
// Tool definition layer
export { createToolDefinitionFromAgentTool, wrapToolDefinition, wrapToolDefinitions } from "./tools/tool-definition.js";
export type { EnsureToolOptions, EnsureToolResult } from "./tools/tools-manager.js";
// Tools manager (auto-download external tools)
export { ensureTool, getToolPath, getToolsDir } from "./tools/tools-manager.js";
export type { TruncationOptions, TruncationResult } from "./tools/truncate.js";
// Truncation utilities
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./tools/truncate.js";
export type { WriteOperations, WriteToolInput, WriteToolOptions } from "./tools/write.js";
export { createWriteTool, createWriteToolDefinition } from "./tools/write.js";
