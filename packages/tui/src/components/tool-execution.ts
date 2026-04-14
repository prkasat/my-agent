/**
 * ToolExecution - Shows tool execution progress with collapsible output
 */

import { type Component, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { ToolExecutionTheme } from "../theme.js";

export type ToolStatus = "pending" | "running" | "success" | "error";

/**
 * Tool execution state - uses discriminated union for type-safe state transitions
 */
export type ToolExecutionState =
	| { status: "pending"; name: string; input: Record<string, unknown>; expanded: boolean }
	| { status: "running"; name: string; input: Record<string, unknown>; expanded: boolean; startTime: number }
	| { status: "success"; name: string; input: Record<string, unknown>; expanded: boolean; output: string; durationMs: number }
	| { status: "error"; name: string; input: Record<string, unknown>; expanded: boolean; error: string; durationMs?: number };

export interface ToolExecutionOptions {
	/** Theme for styling */
	theme: ToolExecutionTheme;
	/** Maximum lines to show when expanded (default: 20) */
	maxExpandedLines?: number;
	/** Horizontal padding (default: 1) */
	paddingX?: number;
	/** Whether to auto-expand on error (default: true) */
	autoExpandOnError?: boolean;
	/** Whether to show input parameters when expanded (default: true) */
	showInput?: boolean;
	/** Maximum lines for input display (default: 5) */
	maxInputLines?: number;
	/** Callback when content changes */
	onInvalidate?: () => void;
}

const STATUS_ICONS: Record<ToolStatus, string> = {
	pending: "\u25CB", // ○
	running: "\u25D0", // ◐
	success: "\u25CF", // ●
	error: "\u2717", // ✗
};

/**
 * Component for displaying tool execution state with collapsible output.
 */
export class ToolExecution implements Component {
	private state: ToolExecutionState;
	private options: Required<Omit<ToolExecutionOptions, "onInvalidate">> & Pick<ToolExecutionOptions, "onInvalidate">;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];
	private cachedInputJson?: string;
	private dirty: boolean = true;

	constructor(name: string, input: Record<string, unknown>, options: ToolExecutionOptions) {
		// Deep clone input to prevent external mutation from desyncing rendered state
		let clonedInput: Record<string, unknown>;
		try {
			clonedInput = JSON.parse(JSON.stringify(input));
		} catch {
			// Fallback for non-JSON-serializable input
			clonedInput = { ...input };
		}

		this.state = {
			status: "pending",
			name,
			input: clonedInput,
			expanded: false,
		};

		this.options = {
			theme: options.theme,
			maxExpandedLines: Math.max(0, options.maxExpandedLines ?? 20),
			paddingX: Math.max(0, options.paddingX ?? 1),
			autoExpandOnError: options.autoExpandOnError ?? true,
			showInput: options.showInput ?? true,
			maxInputLines: Math.max(0, options.maxInputLines ?? 5),
			onInvalidate: options.onInvalidate,
		};
	}

	/**
	 * Mark the tool as running (ignored if already in terminal state)
	 */
	setRunning(): void {
		// Ignore if already in terminal state (success/error)
		if (this.state.status === "success" || this.state.status === "error") {
			return;
		}
		this.state = {
			status: "running",
			name: this.state.name,
			input: this.state.input,
			expanded: this.state.expanded,
			startTime: Date.now(),
		};
		this.markDirty();
	}

	/**
	 * Mark the tool as successfully completed
	 */
	setSuccess(output: string, durationMs: number): void {
		this.state = {
			status: "success",
			name: this.state.name,
			input: this.state.input,
			expanded: this.state.expanded,
			output,
			durationMs,
		};
		this.markDirty();
	}

	/**
	 * Mark the tool as failed
	 */
	setError(error: string, durationMs?: number): void {
		this.state = {
			status: "error",
			name: this.state.name,
			input: this.state.input,
			expanded: this.options.autoExpandOnError ? true : this.state.expanded,
			error,
			durationMs,
		};
		this.markDirty();
	}

	/**
	 * Toggle expanded/collapsed state
	 */
	toggleExpanded(): void {
		this.state = { ...this.state, expanded: !this.state.expanded };
		this.markDirty();
	}

	/**
	 * Set expanded state explicitly
	 */
	setExpanded(expanded: boolean): void {
		if (this.state.expanded !== expanded) {
			this.state = { ...this.state, expanded };
			this.markDirty();
		}
	}

	/**
	 * Get the current state
	 */
	getState(): Readonly<ToolExecutionState> {
		return this.state;
	}

	/**
	 * Get the tool name
	 */
	getName(): string {
		return this.state.name;
	}

	/**
	 * Get the current status
	 */
	getStatus(): ToolStatus {
		return this.state.status;
	}

	render(width: number): string[] {
		if (!this.dirty && this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const theme = this.options.theme;
		const padding = " ".repeat(this.options.paddingX);
		const contentWidth = Math.max(1, width - this.options.paddingX * 2);

		// Header line: [status icon] tool_name (duration) [+/-]
		const headerLine = this.renderHeader(contentWidth, theme);
		lines.push(this.composeLine(padding, headerLine, width));

		// Expanded content
		if (this.state.expanded) {
			const expandedLines = this.renderExpandedContent(contentWidth, theme);
			for (const line of expandedLines) {
				lines.push(this.composeLine(padding, line, width));
			}
		}

		// Update cache
		this.cachedWidth = width;
		this.cachedLines = lines;
		this.dirty = false;

		return lines;
	}

	private renderHeader(contentWidth: number, theme: ToolExecutionTheme): string {
		const icon = this.getStyledIcon(theme);
		const name = theme.toolName(this.state.name);
		const duration = this.getDurationText(theme);
		const expandIndicator = this.hasExpandableContent()
			? theme.collapsed(this.state.expanded ? " [-]" : " [+]")
			: "";

		// Compose header without truncation first to measure
		const headerContent = `${icon} ${name}${duration}${expandIndicator}`;

		// Truncate to fit content width
		return truncateToWidth(headerContent, contentWidth, "...");
	}

	private getDurationText(theme: ToolExecutionTheme): string {
		if (this.state.status === "success" || this.state.status === "error") {
			const ms = this.state.durationMs;
			if (ms !== undefined) {
				return theme.duration(` (${this.formatDuration(ms)})`);
			}
		}
		return "";
	}

	private getStyledIcon(theme: ToolExecutionTheme): string {
		const icon = STATUS_ICONS[this.state.status];

		switch (this.state.status) {
			case "pending":
				return theme.pendingIcon(icon);
			case "running":
				return theme.runningIcon(icon);
			case "success":
				return theme.successIcon(icon);
			case "error":
				return theme.errorIcon(icon);
		}
	}

	private hasExpandableContent(): boolean {
		if (this.state.status === "success") return Boolean(this.state.output);
		if (this.state.status === "error") return Boolean(this.state.error);
		// Input can be shown for any state if showInput is enabled
		return this.options.showInput && Object.keys(this.state.input).length > 0;
	}

	private renderExpandedContent(contentWidth: number, theme: ToolExecutionTheme): string[] {
		const lines: string[] = [];
		const indentWidth = 2;
		const indent = "  ";
		const availableWidth = Math.max(1, contentWidth - indentWidth);

		// Show input parameters if enabled
		if (this.options.showInput && Object.keys(this.state.input).length > 0) {
			lines.push(theme.collapsed(`${indent}Input:`));
			const inputLines = this.renderInput(availableWidth, theme);
			for (const line of inputLines) {
				lines.push(`${indent}  ${line}`);
			}
		}

		// Show output or error based on status
		if (this.state.status === "success" && this.state.output) {
			if (lines.length > 0) lines.push(""); // separator
			lines.push(theme.collapsed(`${indent}Output:`));
			const outputLines = this.renderContent(this.state.output, availableWidth - 2, theme.output);
			for (const line of outputLines) {
				lines.push(`${indent}  ${line}`);
			}
		} else if (this.state.status === "error" && this.state.error) {
			if (lines.length > 0) lines.push(""); // separator
			lines.push(theme.collapsed(`${indent}Error:`));
			const errorLines = this.renderContent(this.state.error, availableWidth - 2, theme.error);
			for (const line of errorLines) {
				lines.push(`${indent}  ${line}`);
			}
		}

		return lines;
	}

	private renderInput(availableWidth: number, theme: ToolExecutionTheme): string[] {
		const lines: string[] = [];
		const maxLines = this.options.maxInputLines;

		try {
			// Cache the JSON string since input doesn't change after construction
			if (this.cachedInputJson === undefined) {
				this.cachedInputJson = JSON.stringify(this.state.input, null, 2);
			}
			const inputLines = this.cachedInputJson.split("\n");
			const truncatedLines = inputLines.slice(0, maxLines);

			for (const line of truncatedLines) {
				const styledLine = theme.output(line);
				const truncated = truncateToWidth(styledLine, availableWidth, "...");
				lines.push(truncated);
			}

			if (inputLines.length > maxLines) {
				const remaining = inputLines.length - maxLines;
				lines.push(theme.collapsed(`... ${remaining} more lines`));
			}
		} catch {
			// Fallback for non-JSON-serializable input
			lines.push(theme.output("[complex input]"));
		}

		return lines;
	}

	private renderContent(
		content: string,
		availableWidth: number,
		styleFn: (text: string) => string
	): string[] {
		const lines: string[] = [];
		const maxLines = this.options.maxExpandedLines;
		const contentLines = content.split("\n");
		const truncatedLines = contentLines.slice(0, maxLines);

		for (const line of truncatedLines) {
			const styledLine = styleFn(line);
			const truncated = truncateToWidth(styledLine, availableWidth, "...");
			lines.push(truncated);
		}

		if (contentLines.length > maxLines) {
			const remaining = contentLines.length - maxLines;
			const theme = this.options.theme;
			lines.push(theme.collapsed(`... ${remaining} more lines`));
		}

		return lines;
	}

	private formatDuration(ms: number): string {
		if (ms < 1000) {
			return `${ms}ms`;
		}
		const seconds = ms / 1000;
		if (seconds < 60) {
			return `${seconds.toFixed(1)}s`;
		}
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = Math.floor(seconds % 60);
		return `${minutes}m ${remainingSeconds}s`;
	}

	/**
	 * Compose a line, truncating and padding to exact width
	 */
	private composeLine(padding: string, content: string, width: number): string {
		const composed = `${padding}${content}`;
		// Truncate to ensure we don't exceed width, then pad
		const truncated = truncateToWidth(composed, width, "...", true);
		return truncated;
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
