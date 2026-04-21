/**
 * ToolExecution - Shows tool execution progress with collapsible output
 */

import { type Component, truncateToWidth } from "@mariozechner/pi-tui";
import type { ToolExecutionTheme } from "../theme.js";
import { getPanelContentWidth, renderPanel } from "./panel.js";

export type ToolStatus = "pending" | "running" | "success" | "error";

/**
 * Tool execution state - uses discriminated union for type-safe state transitions
 */
export type ToolExecutionState =
	| { status: "pending"; name: string; input: Record<string, unknown>; expanded: boolean }
	| { status: "running"; name: string; input: Record<string, unknown>; expanded: boolean; startTime: number }
	| {
			status: "success";
			name: string;
			input: Record<string, unknown>;
			expanded: boolean;
			output: string;
			durationMs: number;
	  }
	| {
			status: "error";
			name: string;
			input: Record<string, unknown>;
			expanded: boolean;
			error: string;
			durationMs?: number;
	  };

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
	/** Maximum output/error preview lines while collapsed (default: 2) */
	maxCollapsedPreviewLines?: number;
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
	private dirty = true;

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
			maxCollapsedPreviewLines: Math.max(1, options.maxCollapsedPreviewLines ?? 2),
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

		const theme = this.options.theme;
		const contentWidth = getPanelContentWidth(width, this.options.paddingX);
		const lines = renderPanel({
			width,
			title: this.renderHeaderTitle(contentWidth, theme),
			titleStyle: theme.toolName,
			borderStyle: this.getBorderStyle(theme),
			backgroundStyle: this.getBackgroundStyle(theme),
			paddingX: this.options.paddingX,
			paddingY: 0,
			lines: this.renderBody(contentWidth, theme),
		});

		this.cachedWidth = width;
		this.cachedLines = lines;
		this.dirty = false;
		return lines;
	}

	private renderHeaderTitle(contentWidth: number, theme: ToolExecutionTheme): string {
		const target = this.getPrimaryTargetSummary();
		const duration = this.getDurationText(theme);
		const expandIndicator = this.hasExpandableContent() ? theme.collapsed(this.state.expanded ? " [-]" : " [+]") : "";
		const title = target ? `${this.state.name} — ${target}` : this.state.name;
		return truncateToWidth(`${title}${duration}${expandIndicator}`, contentWidth, "...");
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

	private renderBody(contentWidth: number, theme: ToolExecutionTheme): string[] {
		const lines: string[] = [this.getStatusLine(contentWidth, theme)];
		if (!this.state.expanded) {
			const summaryLines = this.renderCollapsedSummary(contentWidth, theme);
			if (summaryLines.length > 0) {
				lines.push(...summaryLines);
			}
			return lines;
		}

		const indent = "  ";
		const availableWidth = Math.max(1, contentWidth - indent.length);
		const sectionTitle = theme.sectionTitle ?? theme.collapsed;

		if (this.options.showInput && Object.keys(this.state.input).length > 0) {
			lines.push("");
			lines.push(sectionTitle("Input"));
			const inputLines = this.renderInput(availableWidth, theme);
			for (const line of inputLines) {
				lines.push(`${indent}${line}`);
			}
		}

		if (this.state.status === "success" && this.state.output) {
			lines.push("");
			lines.push(sectionTitle("Output"));
			const outputLines = this.renderContent(this.state.output, availableWidth, theme.output);
			for (const line of outputLines) {
				lines.push(`${indent}${line}`);
			}
		} else if (this.state.status === "error" && this.state.error) {
			lines.push("");
			lines.push(sectionTitle("Error"));
			const errorLines = this.renderContent(this.state.error, availableWidth, theme.error);
			for (const line of errorLines) {
				lines.push(`${indent}${line}`);
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

	private renderContent(content: string, availableWidth: number, styleFn: (text: string) => string): string[] {
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

	private renderCollapsedSummary(contentWidth: number, theme: ToolExecutionTheme): string[] {
		const lines: string[] = [];
		const inputSummary = this.summarizeInput(contentWidth, theme);
		if (inputSummary) lines.push(inputSummary);

		if (this.state.status === "running") {
			lines.push(theme.collapsed(truncateToWidth("Waiting for result…", contentWidth, "...")));
			return lines;
		}
		if (this.state.status === "success") {
			lines.push(...this.summarizeText(this.state.output, contentWidth, theme.output, "Result", theme));
		}
		if (this.state.status === "error") {
			lines.push(...this.summarizeText(this.state.error, contentWidth, theme.error, "Error", theme));
		}
		return lines;
	}

	private getPrimaryTargetSummary(): string | undefined {
		const preferredKeys = ["path", "command", "pattern", "glob"];
		for (const key of preferredKeys) {
			const value = this.state.input[key];
			if (typeof value === "string" && value.trim().length > 0) {
				const normalized = value.replace(/\s+/g, " ").trim();
				return normalized.length > 36 ? `${normalized.slice(0, 35)}…` : normalized;
			}
		}
		return undefined;
	}

	private summarizeInput(contentWidth: number, theme: ToolExecutionTheme): string | undefined {
		const entries = Object.entries(this.state.input);
		if (entries.length === 0) return undefined;

		const priority = ["path", "command", "pattern", "glob", "limit", "offset", "timeout"];
		entries.sort((a, b) => {
			const ai = priority.indexOf(a[0]);
			const bi = priority.indexOf(b[0]);
			return (ai === -1 ? priority.length : ai) - (bi === -1 ? priority.length : bi) || a[0].localeCompare(b[0]);
		});

		const summary = entries
			.slice(0, 3)
			.map(([key, value]) => `${key}=${this.formatSummaryValue(value)}`)
			.join(" · ");
		const suffix = entries.length > 3 ? ` · +${entries.length - 3} more` : "";
		return theme.collapsed(truncateToWidth(`Args: ${summary}${suffix}`, contentWidth, "..."));
	}

	private summarizeText(
		text: string,
		contentWidth: number,
		styleFn: (text: string) => string,
		label: string,
		theme: ToolExecutionTheme,
	): string[] {
		if (!text) return [];
		const rawLines = text
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 0);
		if (rawLines.length === 0) return [];

		const previewLines = rawLines.slice(0, this.options.maxCollapsedPreviewLines);
		const lines: string[] = [];
		for (const [index, line] of previewLines.entries()) {
			const prefix = index === 0 ? `${label}: ` : "  ";
			lines.push(styleFn(truncateToWidth(`${prefix}${line}`, contentWidth, "...")));
		}

		const remaining = rawLines.length - previewLines.length;
		if (remaining > 0) {
			lines.push(theme.collapsed(truncateToWidth(`... ${remaining} more lines`, contentWidth, "...")));
		}
		return lines;
	}

	private formatSummaryValue(value: unknown): string {
		if (typeof value === "string") {
			const normalized = value.replace(/\s+/g, " ").trim();
			return JSON.stringify(normalized.length > 40 ? `${normalized.slice(0, 39)}…` : normalized);
		}
		if (typeof value === "number" || typeof value === "boolean") {
			return String(value);
		}
		if (Array.isArray(value)) {
			return `[${value.length} items]`;
		}
		if (value && typeof value === "object") {
			return "{…}";
		}
		return String(value);
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
	private getStatusLine(contentWidth: number, theme: ToolExecutionTheme): string {
		const icon = this.getStyledIcon(theme);
		let statusText = "Queued";
		if (this.state.status === "running") statusText = "Running…";
		if (this.state.status === "success") statusText = "Completed";
		if (this.state.status === "error") statusText = "Failed";
		const statusStyle =
			this.state.status === "pending"
				? theme.pendingIcon
				: this.state.status === "running"
					? theme.runningIcon
					: this.state.status === "success"
						? theme.successIcon
						: theme.errorIcon;
		return truncateToWidth(`${icon} ${statusStyle(statusText)}`, contentWidth, "...");
	}

	private getBorderStyle(theme: ToolExecutionTheme): (text: string) => string {
		if (theme.border) return theme.border;
		switch (this.state.status) {
			case "pending":
				return theme.pendingIcon;
			case "running":
				return theme.runningIcon;
			case "success":
				return theme.successIcon;
			case "error":
				return theme.errorIcon;
		}
	}

	private getBackgroundStyle(theme: ToolExecutionTheme): ((text: string) => string) | undefined {
		switch (this.state.status) {
			case "pending":
				return theme.pendingBackground;
			case "running":
				return theme.runningBackground;
			case "success":
				return theme.successBackground;
			case "error":
				return theme.errorBackground;
		}
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
