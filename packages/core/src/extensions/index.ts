// Public API for the extension system.

export { noopActions, noopUI } from "./context.js";
export type { LoaderOptions } from "./loader.js";

export { ExtensionLoader } from "./loader.js";
export { MetricsTracker } from "./metrics.js";
export type { ExtensionRunnerOptions, LogSink } from "./runner.js";
export { ExtensionRunner } from "./runner.js";
export type { StorageOptions } from "./storage.js";
export { FileExtensionStorage, MemoryExtensionStorage } from "./storage.js";
export type { MockActions, MockContext, MockContextOptions, MockUI } from "./testing.js";
export {
	activateForTest,
	createMockActions,
	createMockContext,
	createMockUI,
} from "./testing.js";

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
	ExtensionStorage,
	ExtensionUI,
	MetricsRecorder,
	StorageScope,
	ToolInterceptResult,
	ToolMiddleware,
	ToolMiddlewareContext,
	ToolResultModification,
	UISelectItem,
} from "./types.js";
