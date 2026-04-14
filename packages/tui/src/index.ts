/**
 * Agent TUI Components
 *
 * Provides agent-specific UI components built on top of @mariozechner/pi-tui.
 */

// Re-export commonly used pi-tui types and utilities
export {
	type Component,
	Container,
	type Focusable,
	isFocusable,
	TUI,
	type OverlayHandle,
	type OverlayOptions,
	CURSOR_MARKER,
	visibleWidth,
} from "@mariozechner/pi-tui";

export {
	Text,
	Markdown,
	type MarkdownTheme,
	type DefaultTextStyle,
	Editor,
	type EditorOptions,
	type EditorTheme,
	SelectList,
	type SelectItem,
	type SelectListTheme,
	Spacer,
	Box,
	ProcessTerminal,
	type Terminal,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

// Theme system
export {
	type AgentTheme,
	type ToolExecutionTheme,
	type FooterTheme,
	type UserMessageTheme,
	type AssistantMessageTheme,
	type DiffViewerTheme,
	defaultAgentTheme,
	defaultToolExecutionTheme,
	defaultFooterTheme,
	defaultUserMessageTheme,
	defaultAssistantMessageTheme,
	defaultDiffViewerTheme,
	defaultMarkdownTheme,
	defaultEditorTheme,
	defaultSelectListTheme,
	createTheme,
} from "./theme.js";

// Agent-specific components
export {
	StreamingMessage,
	type StreamingMessageOptions,
} from "./components/streaming-message.js";

export {
	ToolExecution,
	type ToolExecutionState,
	type ToolExecutionOptions,
	type ToolStatus,
} from "./components/tool-execution.js";

export {
	Footer,
	type FooterData,
	type FooterOptions,
	type AgentMode,
} from "./components/footer.js";

export {
	UserMessage,
	type UserMessageOptions,
} from "./components/user-message.js";

export {
	DiffViewer,
	MultiDiffViewer,
	type DiffViewerOptions,
	type DiffData,
	type DiffHunk,
	type MultiDiffData,
	parseDiff,
	parseMultiDiff,
} from "./components/diff-viewer.js";

// Selectors
export {
	createModelSelector,
	type ModelInfo,
	type ModelSelectorOptions,
	COMMON_MODELS,
} from "./components/selectors/model-selector.js";

export {
	createSessionSelector,
	type SessionInfo,
	type SessionSelectorOptions,
	type SessionSelectorResult,
} from "./components/selectors/session-selector.js";

// Keybindings
export {
	AGENT_KEYBINDINGS,
	getAgentKeybindingActions,
	getDefaultKeyForAction,
	getActionDescription,
} from "./keybindings.js";
