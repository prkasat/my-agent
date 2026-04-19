/**
 * Theme system for agent TUI components
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";
import { Chalk } from "chalk";

const chalk = new Chalk({ level: 3 });

/**
 * Theme for tool execution display
 */
export interface ToolExecutionTheme {
	/** Style for pending status icon */
	pendingIcon: (text: string) => string;
	/** Style for running status icon */
	runningIcon: (text: string) => string;
	/** Style for success status icon */
	successIcon: (text: string) => string;
	/** Style for error status icon */
	errorIcon: (text: string) => string;
	/** Style for tool name */
	toolName: (text: string) => string;
	/** Style for duration display */
	duration: (text: string) => string;
	/** Style for output content */
	output: (text: string) => string;
	/** Style for error content */
	error: (text: string) => string;
	/** Style for collapsed indicator */
	collapsed: (text: string) => string;
}

/**
 * Theme for footer/status bar
 */
export interface FooterTheme {
	/** Background color for the footer */
	background: (text: string) => string;
	/** Style for model name */
	model: (text: string) => string;
	/** Style for mode indicator */
	mode: (text: string) => string;
	/** Style for cost display */
	cost: (text: string) => string;
	/** Style for token counts */
	tokens: (text: string) => string;
	/** Style for thinking indicator */
	thinking: (text: string) => string;
	/** Style for separator characters */
	separator: (text: string) => string;
}

/**
 * Theme for user messages
 */
export interface UserMessageTheme {
	/** Style for the user label/prefix */
	label: (text: string) => string;
	/** Style for user message text */
	text: (text: string) => string;
	/** Background color for user message */
	background?: (text: string) => string;
}

/**
 * Theme for assistant messages
 */
export interface AssistantMessageTheme {
	/** Style for the assistant label/prefix */
	label: (text: string) => string;
	/** Default text style */
	text: (text: string) => string;
	/** Background color for assistant message */
	background?: (text: string) => string;
}

/**
 * Theme for diff viewer
 */
export interface DiffViewerTheme {
	/** Style for added lines */
	added: (text: string) => string;
	/** Style for removed lines */
	removed: (text: string) => string;
	/** Style for context lines */
	context: (text: string) => string;
	/** Style for file header */
	header: (text: string) => string;
	/** Style for line numbers */
	lineNumber: (text: string) => string;
	/** Style for hunk headers (@@ ... @@) */
	hunkHeader: (text: string) => string;
}

/**
 * Complete theme for all agent TUI components
 */
export interface AgentTheme {
	toolExecution: ToolExecutionTheme;
	footer: FooterTheme;
	userMessage: UserMessageTheme;
	assistantMessage: AssistantMessageTheme;
	diffViewer: DiffViewerTheme;
	markdown: MarkdownTheme;
	editor: EditorTheme;
	selectList: SelectListTheme;
}

/**
 * Default select list theme (frozen to prevent mutation)
 */
export const defaultSelectListTheme: SelectListTheme = Object.freeze({
	selectedPrefix: (text: string) => chalk.cyan(text),
	selectedText: (text: string) => chalk.bold(text),
	description: (text: string) => chalk.dim(text),
	scrollInfo: (text: string) => chalk.dim(text),
	noMatch: (text: string) => chalk.dim(text),
});

/**
 * Default markdown theme (frozen to prevent mutation)
 */
export const defaultMarkdownTheme: MarkdownTheme = Object.freeze({
	heading: (text: string) => chalk.bold.cyan(text),
	link: (text: string) => chalk.blue(text),
	linkUrl: (text: string) => chalk.dim(text),
	code: (text: string) => chalk.yellow(text),
	codeBlock: (text: string) => chalk.green(text),
	codeBlockBorder: (text: string) => chalk.dim(text),
	quote: (text: string) => chalk.italic(text),
	quoteBorder: (text: string) => chalk.dim(text),
	hr: (text: string) => chalk.dim(text),
	listBullet: (text: string) => chalk.cyan(text),
	bold: (text: string) => chalk.bold(text),
	italic: (text: string) => chalk.italic(text),
	strikethrough: (text: string) => chalk.strikethrough(text),
	underline: (text: string) => chalk.underline(text),
});

/**
 * Default editor theme (frozen to prevent mutation)
 */
export const defaultEditorTheme: EditorTheme = Object.freeze({
	borderColor: (text: string) => chalk.dim(text),
	selectList: defaultSelectListTheme,
});

/**
 * Default tool execution theme (frozen to prevent mutation)
 */
export const defaultToolExecutionTheme: ToolExecutionTheme = Object.freeze({
	pendingIcon: (text: string) => chalk.dim(text),
	runningIcon: (text: string) => chalk.yellow(text),
	successIcon: (text: string) => chalk.green(text),
	errorIcon: (text: string) => chalk.red(text),
	toolName: (text: string) => chalk.cyan(text),
	duration: (text: string) => chalk.dim(text),
	output: (text: string) => chalk.dim(text),
	error: (text: string) => chalk.red(text),
	collapsed: (text: string) => chalk.dim(text),
});

/**
 * Default footer theme (frozen to prevent mutation)
 */
export const defaultFooterTheme: FooterTheme = Object.freeze({
	background: (text: string) => chalk.bgGray(text),
	model: (text: string) => chalk.bold(text),
	mode: (text: string) => chalk.cyan(text),
	cost: (text: string) => chalk.yellow(text),
	tokens: (text: string) => chalk.dim(text),
	thinking: (text: string) => chalk.magenta(text),
	separator: (text: string) => chalk.dim(text),
});

/**
 * Default user message theme (frozen to prevent mutation)
 */
export const defaultUserMessageTheme: UserMessageTheme = Object.freeze({
	label: (text: string) => chalk.bold.blue(text),
	text: (text: string) => text,
});

/**
 * Default assistant message theme (frozen to prevent mutation)
 */
export const defaultAssistantMessageTheme: AssistantMessageTheme = Object.freeze({
	label: (text: string) => chalk.bold.green(text),
	text: (text: string) => text,
});

/**
 * Default diff viewer theme (frozen to prevent mutation)
 */
export const defaultDiffViewerTheme: DiffViewerTheme = Object.freeze({
	added: (text: string) => chalk.green(text),
	removed: (text: string) => chalk.red(text),
	context: (text: string) => chalk.dim(text),
	header: (text: string) => chalk.bold.cyan(text),
	lineNumber: (text: string) => chalk.dim(text),
	hunkHeader: (text: string) => chalk.cyan(text),
});

/**
 * Default complete theme for agent TUI (frozen to prevent mutation)
 */
export const defaultAgentTheme: AgentTheme = Object.freeze({
	toolExecution: defaultToolExecutionTheme,
	footer: defaultFooterTheme,
	userMessage: defaultUserMessageTheme,
	assistantMessage: defaultAssistantMessageTheme,
	diffViewer: defaultDiffViewerTheme,
	markdown: defaultMarkdownTheme,
	editor: defaultEditorTheme,
	selectList: defaultSelectListTheme,
});

/**
 * Create a custom theme by merging overrides with the default theme.
 *
 * Note: If you override `selectList`, that override will also be used as the
 * default for `editor.selectList` unless you explicitly override `editor.selectList`.
 */
export function createTheme(overrides: Partial<AgentTheme>): AgentTheme {
	// First, merge selectList (used by both standalone selectors and editor autocomplete)
	const mergedSelectList: SelectListTheme = { ...defaultSelectListTheme, ...overrides.selectList };

	// Merge editor, using the merged selectList as the base for editor.selectList
	// Deep-merge editor.selectList to preserve theme functions not explicitly overridden
	const editorOverrides: Partial<EditorTheme> | undefined = overrides.editor;
	const editorSelectList: SelectListTheme = {
		...mergedSelectList,
		...editorOverrides?.selectList,
	};
	const mergedEditor: EditorTheme = {
		...defaultEditorTheme,
		...editorOverrides,
		selectList: editorSelectList,
	};

	return {
		toolExecution: { ...defaultToolExecutionTheme, ...overrides.toolExecution },
		footer: { ...defaultFooterTheme, ...overrides.footer },
		userMessage: { ...defaultUserMessageTheme, ...overrides.userMessage },
		assistantMessage: { ...defaultAssistantMessageTheme, ...overrides.assistantMessage },
		diffViewer: { ...defaultDiffViewerTheme, ...overrides.diffViewer },
		markdown: { ...defaultMarkdownTheme, ...overrides.markdown },
		editor: mergedEditor,
		selectList: mergedSelectList,
	};
}
