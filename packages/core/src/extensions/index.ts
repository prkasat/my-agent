// Public API for the extension system.

export { ExtensionRunner } from "./runner.js";
export type { ExtensionRunnerOptions, LogSink } from "./runner.js";

export { ExtensionLoader } from "./loader.js";
export type { LoaderOptions } from "./loader.js";

export { FileExtensionStorage, MemoryExtensionStorage } from "./storage.js";
export type { StorageOptions } from "./storage.js";

export { MetricsTracker } from "./metrics.js";

export { noopUI, noopActions } from "./context.js";

export {
	createMockContext,
	createMockUI,
	createMockActions,
	activateForTest,
} from "./testing.js";
export type { MockContext, MockUI, MockActions, MockContextOptions } from "./testing.js";

export type {
	ExtensionEvent,
	ExtensionEventType,
	ExtensionEventBase,
	ExtensionEventByType,
	ExtensionEventHandler,
	ExtensionDefinition,
	ExtensionMetadata,
	ExtensionManifest,
	ExtensionContext,
	ExtensionConfigSchema,
	ExtensionCommand,
	ExtensionUI,
	ExtensionActions,
	ExtensionStorage,
	ExtensionMetrics,
	ExtensionFailureMode,
	StorageScope,
	UISelectItem,
	ToolInterceptResult,
	ToolResultModification,
	ToolMiddleware,
	ToolMiddlewareContext,
	MetricsRecorder,
} from "./types.js";
