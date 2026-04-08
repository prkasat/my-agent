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
export { withFileLock } from "./tools/file-mutation-queue.js";
export { computeDiff } from "./tools/diff.js";
export type { DiffResult } from "./tools/diff.js";

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
