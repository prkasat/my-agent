/**
 * StreamingMessage - Optimized component for token-by-token LLM output
 *
 * During streaming, uses simple text rendering for performance.
 * After finalization, switches to full markdown parsing.
 */

import { type Component, type DefaultTextStyle, Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";
import type { AssistantMessageTheme } from "../theme.js";
import { getPanelContentWidth, renderPanel, wrapStyledText } from "./panel.js";

export interface StreamingMessageOptions {
	/** Markdown theme for rendering finalized content */
	markdownTheme: MarkdownTheme;
	/** Assistant message theme */
	messageTheme: AssistantMessageTheme;
	/** Horizontal padding */
	paddingX?: number;
	/** Vertical padding */
	paddingY?: number;
	/** Label to show before the message (e.g., "Assistant") */
	label?: string;
	/** Whether the panel can be collapsed */
	collapsible?: boolean;
	/** Initial collapsed state */
	collapsed?: boolean;
	/** Number of preview lines to show while collapsed */
	collapsedPreviewLines?: number;
	/** Optional callback when content changes (for TUI invalidation) */
	onInvalidate?: () => void;
}

/**
 * Component optimized for streaming LLM output.
 *
 * Uses a simple Text component during streaming for maximum performance,
 * switching to full Markdown rendering only when the stream is complete.
 */
export class StreamingMessage implements Component {
	private rawText = "";
	private isStreaming = true;
	private markdown: Markdown;
	private collapsed: boolean;
	private options: Required<Omit<StreamingMessageOptions, "onInvalidate" | "label">> &
		Pick<StreamingMessageOptions, "onInvalidate" | "label">;

	// Cache management
	private cachedWidth?: number;
	private cachedLines?: string[];
	private dirty = true;

	// Incremental wrapping optimization removed - the complexity of tracking
	// proper character offsets (not visible widths) with ANSI/CJK/emoji is
	// not worth the performance gain for typical LLM output sizes.
	// The cache is still used to avoid re-rendering when nothing changed.

	constructor(options: StreamingMessageOptions) {
		this.options = {
			markdownTheme: options.markdownTheme,
			messageTheme: options.messageTheme,
			paddingX: options.paddingX ?? 1,
			paddingY: options.paddingY ?? 0,
			label: options.label,
			collapsible: options.collapsible ?? false,
			collapsed: options.collapsed ?? false,
			collapsedPreviewLines: Math.max(1, options.collapsedPreviewLines ?? 2),
			onInvalidate: options.onInvalidate,
		};
		this.collapsed = this.options.collapsible ? this.options.collapsed : false;

		// Build defaultTextStyle from assistant theme
		const defaultTextStyle: DefaultTextStyle = {};
		if (options.messageTheme.text !== undefined) {
			// Use the text function as color (it applies styling)
			defaultTextStyle.color = options.messageTheme.text;
		}
		if (options.messageTheme.background !== undefined) {
			defaultTextStyle.bgColor = options.messageTheme.background;
		}

		// Markdown is used after finalization for full parsing
		// Pass the defaultTextStyle so assistant theme applies
		this.markdown = new Markdown("", 0, 0, this.options.markdownTheme, defaultTextStyle);
	}

	/**
	 * Append a token to the message during streaming.
	 * @returns true if token was appended, false if already finalized
	 */
	appendToken(token: string): boolean {
		if (!this.isStreaming) {
			// Already finalized - token ignored
			return false;
		}

		this.rawText += token;
		this.dirty = true;
		this.invalidate();
		return true;
	}

	/**
	 * Set the complete text (useful for non-streaming scenarios)
	 */
	setText(text: string): void {
		this.rawText = text;
		if (!this.isStreaming) {
			this.markdown.setText(text);
		}
		this.dirty = true;
		this.invalidate();
	}

	/**
	 * Get the current raw text content
	 */
	getText(): string {
		return this.rawText;
	}

	/**
	 * Check if the message is still streaming
	 */
	getIsStreaming(): boolean {
		return this.isStreaming;
	}

	getCollapsed(): boolean {
		return this.collapsed;
	}

	setCollapsed(collapsed: boolean): void {
		if (!this.options.collapsible || this.collapsed === collapsed) return;
		this.collapsed = collapsed;
		this.invalidate();
	}

	toggleCollapsed(): void {
		if (!this.options.collapsible) return;
		this.setCollapsed(!this.collapsed);
	}

	/**
	 * Finalize the message, switching from streaming to markdown mode
	 */
	finalize(): void {
		if (!this.isStreaming) {
			return;
		}

		this.isStreaming = false;
		// Parse the full markdown now that streaming is complete
		this.markdown.setText(this.rawText);
		this.dirty = true;
		this.invalidate();
	}

	/**
	 * Reset to initial state for reuse
	 */
	reset(): void {
		this.rawText = "";
		this.isStreaming = true;
		this.collapsed = this.options.collapsible ? this.options.collapsed : false;
		this.markdown.setText("");
		this.dirty = true;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.invalidate();
	}

	render(width: number): string[] {
		if (!this.dirty && this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}

		const theme = this.options.messageTheme;
		const contentWidth = getPanelContentWidth(width, this.options.paddingX);
		const bodyLines = this.collapsed ? this.renderCollapsedBody(contentWidth) : this.renderExpandedBody(contentWidth);
		const lines = renderPanel({
			width,
			title: this.renderTitle(),
			titleStyle: theme.title ?? theme.label,
			borderStyle: theme.border ?? theme.label,
			backgroundStyle: theme.background,
			paddingX: this.options.paddingX,
			paddingY: this.options.paddingY,
			lines: bodyLines,
		});

		this.cachedWidth = width;
		this.cachedLines = lines;
		this.dirty = false;
		return lines;
	}

	private renderTitle(): string | undefined {
		if (!this.options.label) return undefined;
		if (!this.options.collapsible) return this.options.label;
		return `${this.options.label} ${this.collapsed ? "[+]" : "[-]"}`;
	}

	private renderExpandedBody(contentWidth: number): string[] {
		const theme = this.options.messageTheme;
		return this.isStreaming ? wrapStyledText(this.rawText, contentWidth, theme.text) : this.markdown.render(contentWidth);
	}

	private renderCollapsedBody(contentWidth: number): string[] {
		const theme = this.options.messageTheme;
		const source = this.rawText.trim();
		if (!source) {
			return [theme.text("thinking hidden")];
		}
		const wrappedLines = wrapStyledText(source, contentWidth, theme.text);
		const previewLines = wrappedLines.slice(0, this.options.collapsedPreviewLines);
		const hiddenCount = Math.max(0, wrappedLines.length - previewLines.length);
		if (hiddenCount > 0) {
			previewLines.push(theme.text(`... ${hiddenCount} more line${hiddenCount === 1 ? "" : "s"}`));
		}
		return previewLines;
	}

	invalidate(): void {
		this.dirty = true;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;

		// Also invalidate the markdown component
		this.markdown.invalidate();

		// Notify TUI if callback provided
		this.options.onInvalidate?.();
	}
}
