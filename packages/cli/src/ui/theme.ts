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
	/** Optional border style for framed tool cards */
	border?: (text: string) => string;
	/** Optional section-header style for Input / Output / Error blocks */
	sectionTitle?: (text: string) => string;
	/** Optional background for pending tool cards */
	pendingBackground?: (text: string) => string;
	/** Optional background for running tool cards */
	runningBackground?: (text: string) => string;
	/** Optional background for successful tool cards */
	successBackground?: (text: string) => string;
	/** Optional background for failed tool cards */
	errorBackground?: (text: string) => string;
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
	/** Optional framed-title style */
	title?: (text: string) => string;
	/** Optional border style for the message card */
	border?: (text: string) => string;
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
	/** Optional framed-title style */
	title?: (text: string) => string;
	/** Optional border style for the message card */
	border?: (text: string) => string;
	/** Background color for assistant message */
	background?: (text: string) => string;
}

/**
 * Theme for compact system/status messages
 */
export interface SystemMessageTheme {
	/** Generic label style */
	label?: (text: string) => string;
	/** Generic body-text style */
	text?: (text: string) => string;
	/** Generic border/accent style */
	border?: (text: string) => string;
	/** Optional full-line background */
	background?: (text: string) => string;
	/** Variant styles */
	info?: (text: string) => string;
	success?: (text: string) => string;
	warning?: (text: string) => string;
	error?: (text: string) => string;
	muted?: (text: string) => string;
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
	systemMessage: SystemMessageTheme;
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
	runningIcon: (text: string) => chalk.yellowBright(text),
	successIcon: (text: string) => chalk.greenBright(text),
	errorIcon: (text: string) => chalk.redBright(text),
	toolName: (text: string) => chalk.bold.cyanBright(text),
	duration: (text: string) => chalk.dim(text),
	output: (text: string) => chalk.whiteBright(text),
	error: (text: string) => chalk.redBright(text),
	collapsed: (text: string) => chalk.gray(text),
	border: (text: string) => chalk.hex("#3b82f6")(text),
	sectionTitle: (text: string) => chalk.bold.white(text),
	pendingBackground: (text: string) => chalk.bgHex("#08131b")(text),
	runningBackground: (text: string) => chalk.bgHex("#1a1408")(text),
	successBackground: (text: string) => chalk.bgHex("#0c1710")(text),
	errorBackground: (text: string) => chalk.bgHex("#1b0a0a")(text),
});

/**
 * Default footer theme (frozen to prevent mutation)
 */
export const defaultFooterTheme: FooterTheme = Object.freeze({
	background: (text: string) => chalk.bgBlackBright.white(text),
	model: (text: string) => chalk.bold.white(text),
	mode: (text: string) => chalk.cyanBright(text),
	cost: (text: string) => chalk.yellowBright(text),
	tokens: (text: string) => chalk.gray(text),
	thinking: (text: string) => chalk.magentaBright(text),
	separator: (text: string) => chalk.gray(text),
});

/**
 * Default system-message theme (frozen to prevent mutation)
 */
export const defaultSystemMessageTheme: SystemMessageTheme = Object.freeze({
	label: (text: string) => chalk.bold(text),
	text: (text: string) => text,
	border: (text: string) => chalk.hex("#4b5563")(text),
	info: (text: string) => chalk.cyanBright(text),
	success: (text: string) => chalk.greenBright(text),
	warning: (text: string) => chalk.yellowBright(text),
	error: (text: string) => chalk.redBright(text),
	muted: (text: string) => chalk.gray(text),
});

/**
 * Default user message theme (frozen to prevent mutation)
 */
export const defaultUserMessageTheme: UserMessageTheme = Object.freeze({
	label: (text: string) => chalk.bold.blueBright(text),
	title: (text: string) => chalk.bold.blueBright(text),
	border: (text: string) => chalk.blueBright(text),
	text: (text: string) => text,
	background: (text: string) => chalk.bgHex("#081321")(text),
});

/**
 * Default assistant message theme (frozen to prevent mutation)
 */
export const defaultAssistantMessageTheme: AssistantMessageTheme = Object.freeze({
	label: (text: string) => chalk.bold.greenBright(text),
	title: (text: string) => chalk.bold.greenBright(text),
	border: (text: string) => chalk.greenBright(text),
	text: (text: string) => text,
	background: (text: string) => chalk.bgHex("#0a160f")(text),
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
	systemMessage: defaultSystemMessageTheme,
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
		systemMessage: { ...defaultSystemMessageTheme, ...overrides.systemMessage },
		userMessage: { ...defaultUserMessageTheme, ...overrides.userMessage },
		assistantMessage: { ...defaultAssistantMessageTheme, ...overrides.assistantMessage },
		diffViewer: { ...defaultDiffViewerTheme, ...overrides.diffViewer },
		markdown: { ...defaultMarkdownTheme, ...overrides.markdown },
		editor: mergedEditor,
		selectList: mergedSelectList,
	};
}
