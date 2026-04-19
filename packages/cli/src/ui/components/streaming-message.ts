/**
 * StreamingMessage - Optimized component for token-by-token LLM output
 *
 * During streaming, uses simple text rendering for performance.
 * After finalization, switches to full markdown parsing.
 */

import {
	type Component,
	type DefaultTextStyle,
	Markdown,
	type MarkdownTheme,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import type { AssistantMessageTheme } from "../theme.js";

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
			onInvalidate: options.onInvalidate,
		};

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
		this.markdown = new Markdown(
			"",
			this.options.paddingX,
			this.options.paddingY,
			this.options.markdownTheme,
			defaultTextStyle,
		);
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
		this.markdown.setText("");
		this.dirty = true;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.invalidate();
	}

	render(width: number): string[] {
		// Check cache validity
		if (!this.dirty && this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const theme = this.options.messageTheme;
		const padding = " ".repeat(this.options.paddingX);
		const contentWidth = Math.max(1, width - this.options.paddingX * 2);

		// Add label if present (only on first render line)
		const hasLabel = Boolean(this.options.label);
		const labelText = hasLabel ? `${this.options.label}: ` : "";
		const label = hasLabel ? theme.label(labelText) : "";
		const labelWidth = hasLabel ? visibleWidth(labelText) : 0;

		// Add label on its own line if present (consistent between streaming and finalized)
		if (hasLabel) {
			lines.push(this.composeLine(padding, label, "", width, theme.background));
		}

		if (this.isStreaming) {
			// During streaming, use simple text wrapping for correctness
			if (this.rawText && this.rawText.trim() !== "") {
				const styledText = theme.text(this.rawText);
				const wrappedLines = wrapTextWithAnsi(styledText, contentWidth);

				for (const wrappedLine of wrappedLines) {
					lines.push(this.composeLine(padding, "", wrappedLine || "", width, theme.background));
				}
			}
		} else {
			// After finalization, use full markdown rendering
			const markdownLines = this.markdown.render(width);
			lines.push(...markdownLines);
		}

		// Update cache
		this.cachedWidth = width;
		this.cachedLines = lines;
		this.dirty = false;

		return lines;
	}

	/**
	 * Compose a line with prefix and content, then truncate and pad to width
	 */
	private composeLine(
		padding: string,
		prefix: string,
		content: string,
		width: number,
		bgFn?: (text: string) => string,
	): string {
		const composed = `${padding}${prefix}${content}`;
		// Truncate to ensure we don't exceed width, pad to fill
		const truncated = truncateToWidth(composed, width, "...", true);
		return bgFn ? bgFn(truncated) : truncated;
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
