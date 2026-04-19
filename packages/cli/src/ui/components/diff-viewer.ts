/**
 * DiffViewer - Component for displaying unified diffs
 */

import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { DiffViewerTheme } from "../theme.js";

export interface DiffHunk {
	/** Starting line in old file */
	oldStart: number;
	/** Number of lines from old file */
	oldLines: number;
	/** Starting line in new file */
	newStart: number;
	/** Number of lines in new file */
	newLines: number;
	/** Lines in this hunk (with +, -, or space prefix) */
	lines: string[];
}

export interface DiffData {
	/** Old file path */
	oldPath: string;
	/** New file path */
	newPath: string;
	/** Diff hunks */
	hunks: DiffHunk[];
}

/**
 * Multi-file diff data for patches spanning multiple files
 */
export interface MultiDiffData {
	/** Array of file diffs */
	files: DiffData[];
}

export interface DiffViewerOptions {
	/** Theme for styling */
	theme: DiffViewerTheme;
	/** Horizontal padding (default: 1) */
	paddingX?: number;
	/** Whether to show line numbers (default: true) */
	showLineNumbers?: boolean;
	/** Maximum lines to display per hunk (default: unlimited) */
	maxLinesPerHunk?: number;
	/** Whether the diff is collapsed (default: false) */
	collapsed?: boolean;
	/** Callback when content changes */
	onInvalidate?: () => void;
}

/**
 * Component for displaying single-file unified diff output.
 */
export class DiffViewer implements Component {
	private diff: DiffData;
	private options: Required<Omit<DiffViewerOptions, "onInvalidate" | "maxLinesPerHunk">> &
		Pick<DiffViewerOptions, "onInvalidate" | "maxLinesPerHunk">;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];
	private dirty = true;

	constructor(diff: DiffData, options: DiffViewerOptions) {
		this.diff = diff;
		this.options = {
			theme: options.theme,
			paddingX: Math.max(0, options.paddingX ?? 1),
			showLineNumbers: options.showLineNumbers ?? true,
			maxLinesPerHunk: options.maxLinesPerHunk !== undefined ? Math.max(0, options.maxLinesPerHunk) : undefined,
			collapsed: options.collapsed ?? false,
			onInvalidate: options.onInvalidate,
		};
	}

	/**
	 * Set the diff data
	 */
	setDiff(diff: DiffData): void {
		this.diff = diff;
		this.markDirty();
	}

	/**
	 * Get the diff data
	 */
	getDiff(): Readonly<DiffData> {
		return this.diff;
	}

	/**
	 * Toggle collapsed state
	 */
	toggleCollapsed(): void {
		this.options.collapsed = !this.options.collapsed;
		this.markDirty();
	}

	/**
	 * Set collapsed state
	 */
	setCollapsed(collapsed: boolean): void {
		if (this.options.collapsed !== collapsed) {
			this.options.collapsed = collapsed;
			this.markDirty();
		}
	}

	/**
	 * Check if collapsed
	 */
	isCollapsed(): boolean {
		return this.options.collapsed;
	}

	render(width: number): string[] {
		if (!this.dirty && this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}

		const lines = this.renderDiff(this.diff, width);

		// Update cache
		this.cachedWidth = width;
		this.cachedLines = lines;
		this.dirty = false;

		return lines;
	}

	private renderDiff(diff: DiffData, width: number): string[] {
		const theme = this.options.theme;
		const padding = " ".repeat(this.options.paddingX);
		const contentWidth = Math.max(1, width - this.options.paddingX * 2);
		const lines: string[] = [];

		// Header showing file path
		const headerText = diff.oldPath === diff.newPath ? diff.newPath : `${diff.oldPath} -> ${diff.newPath}`;

		const header = theme.header(truncateToWidth(headerText, contentWidth, "..."));
		lines.push(this.composeLine(padding, header, width));

		// If collapsed, just show the header with indicator
		if (this.options.collapsed) {
			const collapsedIndicator = theme.context(`  [${this.getTotalChanges(diff)}]`);
			lines.push(this.composeLine(padding, collapsedIndicator, width));
			return lines;
		}

		// Calculate line number column width (minimum 4, or enough for largest line number)
		const maxLineNum = this.getMaxLineNumber(diff);
		const numWidth = Math.max(4, String(maxLineNum).length);

		// Render each hunk
		for (const hunk of diff.hunks) {
			// Hunk header
			const hunkHeader = theme.hunkHeader(
				`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
			);
			lines.push(this.composeLine(padding, hunkHeader, width));

			// Hunk lines
			let oldLineNum = hunk.oldStart;
			let newLineNum = hunk.newStart;
			let renderedLines = 0;
			const maxLines = this.options.maxLinesPerHunk;

			for (const line of hunk.lines) {
				if (maxLines !== undefined && renderedLines >= maxLines) {
					const remaining = hunk.lines.length - renderedLines;
					const moreText = theme.context(`  ... ${remaining} more lines`);
					lines.push(this.composeLine(padding, moreText, width));
					break;
				}

				const lineContent = line.slice(1); // Remove the prefix character
				const prefix = line[0] || " ";

				let lineNumDisplay = "";
				if (this.options.showLineNumbers) {
					const rawLineNums = this.formatLineNumbers(prefix, oldLineNum, newLineNum, numWidth);
					lineNumDisplay = theme.lineNumber(rawLineNums);
				}

				let styledLine: string;
				switch (prefix) {
					case "+":
						styledLine = `${lineNumDisplay}${theme.added(`+${lineContent}`)}`;
						newLineNum++;
						break;
					case "-":
						styledLine = `${lineNumDisplay}${theme.removed(`-${lineContent}`)}`;
						oldLineNum++;
						break;
					default:
						styledLine = `${lineNumDisplay}${theme.context(` ${lineContent}`)}`;
						oldLineNum++;
						newLineNum++;
						break;
				}

				const truncatedLine = truncateToWidth(styledLine, contentWidth, "...");
				lines.push(this.composeLine(padding, truncatedLine, width));
				renderedLines++;
			}
		}

		return lines;
	}

	private formatLineNumbers(prefix: string, oldLine: number, newLine: number, numWidth: number): string {
		const oldStr = prefix === "+" ? " ".repeat(numWidth) : String(oldLine).padStart(numWidth);
		const newStr = prefix === "-" ? " ".repeat(numWidth) : String(newLine).padStart(numWidth);
		return `${oldStr} ${newStr} `;
	}

	/**
	 * Calculate the maximum line number in the diff for dynamic column width
	 */
	private getMaxLineNumber(diff: DiffData): number {
		let max = 0;
		for (const hunk of diff.hunks) {
			// Use the last displayed line number (start + lines - 1), handling zero-line hunks
			const oldEnd = hunk.oldLines > 0 ? hunk.oldStart + hunk.oldLines - 1 : hunk.oldStart;
			const newEnd = hunk.newLines > 0 ? hunk.newStart + hunk.newLines - 1 : hunk.newStart;
			max = Math.max(max, oldEnd, newEnd);
		}
		return max;
	}

	private getTotalChanges(diff: DiffData): string {
		let additions = 0;
		let deletions = 0;

		for (const hunk of diff.hunks) {
			for (const line of hunk.lines) {
				if (line.startsWith("+")) additions++;
				else if (line.startsWith("-")) deletions++;
			}
		}

		const parts: string[] = [];
		if (additions > 0) parts.push(`+${additions}`);
		if (deletions > 0) parts.push(`-${deletions}`);

		return parts.join(", ") || "no changes";
	}

	private composeLine(padding: string, content: string, width: number): string {
		const composed = `${padding}${content}`;
		return truncateToWidth(composed, width, "...", true);
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

/**
 * Component for displaying multi-file diffs
 */
export class MultiDiffViewer implements Component {
	private diffs: DiffData[];
	private options: Required<Omit<DiffViewerOptions, "onInvalidate" | "maxLinesPerHunk">> &
		Pick<DiffViewerOptions, "onInvalidate" | "maxLinesPerHunk">;
	private viewers: DiffViewer[] = [];

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];
	private dirty = true;

	constructor(diffs: DiffData[] | MultiDiffData, options: DiffViewerOptions) {
		this.diffs = Array.isArray(diffs) ? diffs : diffs.files;
		this.options = {
			theme: options.theme,
			paddingX: options.paddingX ?? 1,
			showLineNumbers: options.showLineNumbers ?? true,
			maxLinesPerHunk: options.maxLinesPerHunk,
			collapsed: options.collapsed ?? false,
			onInvalidate: options.onInvalidate,
		};

		// Create a viewer for each file
		this.viewers = this.diffs.map(
			(diff) =>
				new DiffViewer(diff, {
					...options,
					onInvalidate: () => this.markDirty(),
				}),
		);
	}

	/**
	 * Set all diffs
	 */
	setDiffs(diffs: DiffData[] | MultiDiffData): void {
		this.diffs = Array.isArray(diffs) ? diffs : diffs.files;
		this.viewers = this.diffs.map(
			(diff) =>
				new DiffViewer(diff, {
					theme: this.options.theme,
					paddingX: this.options.paddingX,
					showLineNumbers: this.options.showLineNumbers,
					maxLinesPerHunk: this.options.maxLinesPerHunk,
					collapsed: this.options.collapsed,
					onInvalidate: () => this.markDirty(),
				}),
		);
		this.markDirty();
	}

	/**
	 * Get all diffs
	 */
	getDiffs(): readonly DiffData[] {
		return this.diffs;
	}

	/**
	 * Collapse/expand all file diffs
	 */
	setAllCollapsed(collapsed: boolean): void {
		this.options.collapsed = collapsed;
		for (const viewer of this.viewers) {
			viewer.setCollapsed(collapsed);
		}
		this.markDirty();
	}

	render(width: number): string[] {
		if (!this.dirty && this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}

		const lines: string[] = [];

		for (let i = 0; i < this.viewers.length; i++) {
			if (i > 0) {
				// Add separator between files
				lines.push("");
			}
			lines.push(...this.viewers[i].render(width));
		}

		// Update cache
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
		for (const viewer of this.viewers) {
			viewer.invalidate();
		}
	}
}

/**
 * Parse a unified diff string into DiffData (single file)
 * @deprecated Use parseMultiDiff for multi-file support
 */
export function parseDiff(diffText: string, defaultPath = "file"): DiffData {
	const diffs = parseMultiDiff(diffText, defaultPath);
	if (diffs.length === 0) {
		return { oldPath: defaultPath, newPath: defaultPath, hunks: [] };
	}
	return diffs[0];
}

/**
 * Parse a unified diff string into an array of DiffData (supports multiple files)
 */
export function parseMultiDiff(diffText: string, defaultPath = "file"): DiffData[] {
	const lines = diffText.split("\n");
	const diffs: DiffData[] = [];

	let currentDiff: DiffData | null = null;
	let currentHunk: DiffHunk | null = null;
	let pendingOldPath: string | null = null;

	for (const line of lines) {
		// Check for file headers first - they take precedence over hunk content
		// because "--- " could look like a removed line but is actually a header
		if (line.startsWith("--- ")) {
			// End current hunk if any
			if (currentHunk && currentDiff) {
				currentDiff.hunks.push(currentHunk);
				currentHunk = null;
			}
			// Save previous diff if any
			if (currentDiff) {
				diffs.push(currentDiff);
			}

			// Strip a/ prefix and any tab-delimited timestamp suffix (e.g., "file.txt\t2026-04-14")
			pendingOldPath = line.slice(4).replace(/^a\//, "").split("\t")[0].trim();
			currentDiff = null;
			continue;
		}

		if (line.startsWith("+++ ")) {
			// End current hunk if any (shouldn't happen in well-formed diffs)
			if (currentHunk && currentDiff) {
				currentDiff.hunks.push(currentHunk);
				currentHunk = null;
			}

			// Strip b/ prefix and any tab-delimited timestamp suffix
			const newPath = line.slice(4).replace(/^b\//, "").split("\t")[0].trim();
			currentDiff = {
				oldPath: pendingOldPath || newPath,
				newPath: newPath,
				hunks: [],
			};
			pendingOldPath = null;
			continue;
		}

		// Parse hunk headers
		const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
		if (hunkMatch) {
			// End previous hunk if any
			if (currentHunk && currentDiff) {
				currentDiff.hunks.push(currentHunk);
			}

			// If we don't have a current diff, create one with default path
			if (!currentDiff) {
				currentDiff = {
					oldPath: defaultPath,
					newPath: defaultPath,
					hunks: [],
				};
			}

			currentHunk = {
				oldStart: Number.parseInt(hunkMatch[1], 10),
				oldLines: Number.parseInt(hunkMatch[2] ?? "1", 10),
				newStart: Number.parseInt(hunkMatch[3], 10),
				newLines: Number.parseInt(hunkMatch[4] ?? "1", 10),
				lines: [],
			};
			continue;
		}

		// Inside a hunk, collect diff content lines
		if (currentHunk) {
			// Diff content lines start with +, -, or space (context)
			if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
				currentHunk.lines.push(line);
				continue;
			}
			// Empty lines within hunks are skipped (not treated as context)
			if (line === "") {
				continue;
			}
			// Other lines end the hunk (but we already handled headers above)
		}

		// Handle binary file markers (e.g., "Binary files a/img.png and b/img.png differ")
		const binaryMatch = line.match(/^Binary files (.+?) and (.+?) differ$/);
		if (binaryMatch) {
			// End current hunk/diff if any
			if (currentHunk && currentDiff) {
				currentDiff.hunks.push(currentHunk);
				currentHunk = null;
			}
			if (currentDiff) {
				diffs.push(currentDiff);
			}

			// Extract paths, stripping a/ and b/ prefixes
			const oldPath = binaryMatch[1].replace(/^a\//, "").trim();
			const newPath = binaryMatch[2].replace(/^b\//, "").trim();

			// Create a placeholder diff for the binary file
			diffs.push({
				oldPath: oldPath === "/dev/null" ? newPath : oldPath,
				newPath: newPath === "/dev/null" ? oldPath : newPath,
				hunks: [
					{
						oldStart: 0,
						oldLines: 0,
						newStart: 0,
						newLines: 0,
						lines: [" [Binary file]"],
					},
				],
			});

			currentDiff = null;
			pendingOldPath = null;
		}

		// Skip other lines (git headers like "diff --git", "index ...", etc.)
	}

	// Save final hunk and diff
	if (currentDiff) {
		if (currentHunk) {
			currentDiff.hunks.push(currentHunk);
		}
		diffs.push(currentDiff);
	}

	return diffs;
}
