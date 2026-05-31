/**
 * Agent TUI Components
 *
 * Provides agent-specific UI components built on top of @earendil-works/pi-tui.
 */

// Re-export commonly used pi-tui types and utilities
export {
	Box,
	type Component,
	Container,
	CURSOR_MARKER,
	type DefaultTextStyle,
	Editor,
	type EditorOptions,
	type EditorTheme,
	type Focusable,
	isFocusable,
	Markdown,
	type MarkdownTheme,
	type OverlayHandle,
	type OverlayOptions,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	type Terminal,
	Text,
	TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
export {
	type DiffData,
	type DiffHunk,
	DiffViewer,
	type DiffViewerOptions,
	type MultiDiffData,
	MultiDiffViewer,
	parseDiff,
	parseMultiDiff,
} from "./components/diff-viewer.js";
export {
	type AgentMode,
	Footer,
	type FooterData,
	type FooterOptions,
} from "./components/footer.js";
// Selectors
export {
	COMMON_MODELS,
	createModelSelector,
	type ModelInfo,
	type ModelSelectorOptions,
} from "./components/selectors/model-selector.js";
export {
	createSessionSelector,
	type SessionInfo,
	type SessionSelectorOptions,
	type SessionSelectorResult,
} from "./components/selectors/session-selector.js";
export {
	createTreeSelector,
	TreeSelectorComponent,
	type TreeSelectorComponentOptions,
	type TreeSelectorOptions,
} from "./components/selectors/tree-selector.js";
// Agent-specific components
export {
	StreamingMessage,
	type StreamingMessageOptions,
} from "./components/streaming-message.js";
export {
	SystemMessage,
	type SystemMessageOptions,
	type SystemMessageVariant,
} from "./components/system-message.js";
export {
	TimelineMarker,
	type TimelineMarkerOptions,
} from "./components/timeline-marker.js";
export {
	ToolExecution,
	type ToolExecutionOptions,
	type ToolExecutionState,
	type ToolStatus,
} from "./components/tool-execution.js";
export {
	UserMessage,
	type UserMessageOptions,
} from "./components/user-message.js";
// Keybindings
export {
	AGENT_KEYBINDINGS,
	getActionDescription,
	getAgentKeybindingActions,
	getDefaultKeyForAction,
} from "./keybindings.js";
// Theme system
export {
	type AgentTheme,
	type AssistantMessageTheme,
	createTheme,
	type DiffViewerTheme,
	defaultAgentTheme,
	defaultAssistantMessageTheme,
	defaultDiffViewerTheme,
	defaultEditorTheme,
	defaultFooterTheme,
	defaultMarkdownTheme,
	defaultSelectListTheme,
	defaultSystemMessageTheme,
	defaultToolExecutionTheme,
	defaultUserMessageTheme,
	type FooterTheme,
	type SystemMessageTheme,
	type ToolExecutionTheme,
	type UserMessageTheme,
} from "./theme.js";
