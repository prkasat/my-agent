/**
 * UserMessage - Styled display of user input messages
 */

import type { Component } from "@mariozechner/pi-tui";
import type { UserMessageTheme } from "../theme.js";
import { getPanelContentWidth, renderPanel, wrapStyledText } from "./panel.js";

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
		const contentWidth = getPanelContentWidth(width, this.options.paddingX);
		const bodyLines = wrapStyledText(this.text, contentWidth, theme.text);
		const lines = renderPanel({
			width,
			title: this.options.label,
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
