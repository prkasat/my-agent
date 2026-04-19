/**
 * UserMessage - Styled display of user input messages
 */

import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { UserMessageTheme } from "../theme.js";

export interface UserMessageOptions {
	/** Theme for styling */
	theme: UserMessageTheme;
	/** Horizontal padding (default: 1) */
	paddingX?: number;
	/** Vertical padding (default: 0) */
	paddingY?: number;
	/** Label to display before the message (default: "You") */
	label?: string;
	/** Callback when content changes */
	onInvalidate?: () => void;
}

/**
 * Component for displaying user messages with a label prefix.
 */
export class UserMessage implements Component {
	private text: string;
	private options: Required<Omit<UserMessageOptions, "onInvalidate">> & Pick<UserMessageOptions, "onInvalidate">;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];
	private dirty = true;

	constructor(text: string, options: UserMessageOptions) {
		this.text = text;
		this.options = {
			theme: options.theme,
			paddingX: options.paddingX ?? 1,
			paddingY: options.paddingY ?? 0,
			label: options.label ?? "You",
			onInvalidate: options.onInvalidate,
		};
	}

	/**
	 * Set the message text
	 */
	setText(text: string): void {
		if (this.text !== text) {
			this.text = text;
			this.markDirty();
		}
	}

	/**
	 * Get the message text
	 */
	getText(): string {
		return this.text;
	}

	/**
	 * Set the label
	 */
	setLabel(label: string): void {
		if (this.options.label !== label) {
			this.options.label = label;
			this.markDirty();
		}
	}

	render(width: number): string[] {
		if (!this.dirty && this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}

		const theme = this.options.theme;
		const padding = " ".repeat(this.options.paddingX);
		const contentWidth = Math.max(1, width - this.options.paddingX * 2);

		const lines: string[] = [];

		// Add top padding
		for (let i = 0; i < this.options.paddingY; i++) {
			lines.push(this.createEmptyLine(width, theme.background));
		}

		// Calculate label dimensions
		const labelText = `${this.options.label}: `;
		const label = theme.label(labelText);
		const labelWidth = visibleWidth(labelText);

		// First line has less available width due to the label
		const firstLineContentWidth = Math.max(1, contentWidth - labelWidth);

		if (!this.text || this.text.trim() === "") {
			// Empty message - just show label
			const line = this.composeLine(padding, label, "", width, theme.background);
			lines.push(line);
		} else {
			// Wrap all text at the reduced width to account for label/indent
			// This avoids Unicode slicing issues by using all wrapped lines directly
			const wrappedLines = wrapTextWithAnsi(this.text, firstLineContentWidth);

			// First line with label
			const firstLineText = theme.text(wrappedLines[0] || "");
			const firstLine = this.composeLine(padding, label, firstLineText, width, theme.background);
			lines.push(firstLine);

			// Continuation lines with indent to align with content after label
			const indent = " ".repeat(labelWidth);
			for (let i = 1; i < wrappedLines.length; i++) {
				const lineText = theme.text(wrappedLines[i] || "");
				const line = this.composeLine(padding, indent, lineText, width, theme.background);
				lines.push(line);
			}
		}

		// Add bottom padding
		for (let i = 0; i < this.options.paddingY; i++) {
			lines.push(this.createEmptyLine(width, theme.background));
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
		// Truncate to ensure we don't exceed width
		const truncated = truncateToWidth(composed, width, "...", true);
		// Apply background if present
		return bgFn ? bgFn(truncated) : truncated;
	}

	/**
	 * Create an empty line of the given width
	 */
	private createEmptyLine(width: number, bgFn?: (text: string) => string): string {
		const emptyLine = " ".repeat(width);
		return bgFn ? bgFn(emptyLine) : emptyLine;
	}

	private markDirty(): void {
		this.dirty = true;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.options.onInvalidate?.();
	}

	invalidate(): void {
		this.markDirty();
	}
}
