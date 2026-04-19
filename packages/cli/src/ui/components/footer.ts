/**
 * Footer - Status bar displaying model, mode, tokens, and cost
 */

import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { FooterTheme } from "../theme.js";

export type AgentMode = "normal" | "plan" | "auto";

export interface FooterData {
	/** Current model name */
	model: string;
	/** Current agent mode */
	mode: AgentMode;
	/** Input tokens used */
	inputTokens: number;
	/** Output tokens generated */
	outputTokens: number;
	/** Total cost in dollars */
	cost: number;
	/** Whether agent is currently thinking */
	thinking: boolean;
	/** Optional custom status text */
	statusText?: string;
}

export interface FooterOptions {
	/** Theme for styling */
	theme: FooterTheme;
	/** Callback when content changes */
	onInvalidate?: () => void;
}

/**
 * Status bar component showing model, mode, token counts, and cost.
 */
export class Footer implements Component {
	private data: FooterData;
	private theme: FooterTheme;
	private onInvalidate?: () => void;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];
	private dirty = true;

	constructor(initialData: FooterData, options: FooterOptions) {
		this.data = { ...initialData };
		this.theme = options.theme;
		this.onInvalidate = options.onInvalidate;
	}

	/**
	 * Update footer data (partial updates supported)
	 */
	update(data: Partial<FooterData>): void {
		Object.assign(this.data, data);
		this.markDirty();
	}

	/**
	 * Get the current footer data (returns a copy to prevent external mutation)
	 */
	getData(): Readonly<FooterData> {
		return { ...this.data };
	}

	/**
	 * Set the model name
	 */
	setModel(model: string): void {
		if (this.data.model !== model) {
			this.data.model = model;
			this.markDirty();
		}
	}

	/**
	 * Set the agent mode
	 */
	setMode(mode: AgentMode): void {
		if (this.data.mode !== mode) {
			this.data.mode = mode;
			this.markDirty();
		}
	}

	/**
	 * Update token counts
	 */
	setTokens(inputTokens: number, outputTokens: number): void {
		if (this.data.inputTokens !== inputTokens || this.data.outputTokens !== outputTokens) {
			this.data.inputTokens = inputTokens;
			this.data.outputTokens = outputTokens;
			this.markDirty();
		}
	}

	/**
	 * Set the cost
	 */
	setCost(cost: number): void {
		if (this.data.cost !== cost) {
			this.data.cost = cost;
			this.markDirty();
		}
	}

	/**
	 * Set thinking state
	 */
	setThinking(thinking: boolean): void {
		if (this.data.thinking !== thinking) {
			this.data.thinking = thinking;
			this.markDirty();
		}
	}

	/**
	 * Set custom status text
	 */
	setStatusText(statusText: string | undefined): void {
		if (this.data.statusText !== statusText) {
			this.data.statusText = statusText;
			this.markDirty();
		}
	}

	render(width: number): string[] {
		if (!this.dirty && this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}

		const theme = this.theme;
		const separator = theme.separator(" | ");

		// Build left side: model | mode [| status]
		const modelText = theme.model(this.data.model);
		const modeText = theme.mode(this.data.mode);

		const leftParts = [modelText, separator, modeText];

		if (this.data.thinking) {
			leftParts.push(separator, theme.thinking("thinking..."));
		} else if (this.data.statusText) {
			leftParts.push(separator, this.data.statusText);
		}

		const left = ` ${leftParts.join("")}`;
		const leftWidth = visibleWidth(left);

		// Build right side with progressive compaction for narrow terminals
		const right = this.buildRightSide(width, leftWidth, theme, separator);
		const rightWidth = visibleWidth(right);

		// Compose the final line
		let line: string;
		const totalContentWidth = leftWidth + rightWidth;

		if (totalContentWidth <= width) {
			// Everything fits
			const padding = width - totalContentWidth;
			line = left + " ".repeat(padding) + right;
		} else if (rightWidth < width) {
			// Right fits, truncate left
			const availableForLeft = Math.max(1, width - rightWidth);
			const truncatedLeft = truncateToWidth(left, availableForLeft, "...");
			const truncLeftWidth = visibleWidth(truncatedLeft);
			const padding = Math.max(0, width - truncLeftWidth - rightWidth);
			line = truncatedLeft + " ".repeat(padding) + right;
		} else {
			// Even right doesn't fit - truncate everything to width
			line = truncateToWidth(left + right, width, "...", true);
		}

		// Apply background to entire line (line is already padded to width by truncateToWidth with pad=true, or manually)
		const styledLine = theme.background(line);

		// Update cache
		this.cachedWidth = width;
		this.cachedLines = [styledLine];
		this.dirty = false;

		return [styledLine];
	}

	/**
	 * Build the right side of the footer with progressive compaction for narrow terminals.
	 * Returns the most compact format that fits.
	 */
	private buildRightSide(totalWidth: number, leftWidth: number, theme: FooterTheme, separator: string): string {
		const minLeftWidth = 10; // Minimum space for left side
		const availableForRight = Math.max(1, totalWidth - minLeftWidth);

		// Full format: $0.0012 | ↑1.2k ↓345
		const costText = theme.cost(this.formatCost());
		const tokensText = theme.tokens(this.formatTokens());
		const fullRight = `${costText + separator + tokensText} `;

		if (visibleWidth(fullRight) <= availableForRight) {
			return fullRight;
		}

		// Compact format: $0.00 | 1k/345
		const compactCost = theme.cost(this.formatCostCompact());
		const compactTokens = theme.tokens(this.formatTokensCompact());
		const compactRight = `${compactCost + separator + compactTokens} `;

		if (visibleWidth(compactRight) <= availableForRight) {
			return compactRight;
		}

		// Minimal format: just tokens
		const minimalRight = `${theme.tokens(this.formatTokensCompact())} `;

		if (visibleWidth(minimalRight) <= availableForRight) {
			return minimalRight;
		}

		// Ultra-minimal: truncate to fit
		return truncateToWidth(minimalRight, availableForRight, "");
	}

	private formatCost(): string {
		if (this.data.cost < 0.01) {
			return `$${this.data.cost.toFixed(4)}`;
		}
		if (this.data.cost < 1) {
			return `$${this.data.cost.toFixed(3)}`;
		}
		return `$${this.data.cost.toFixed(2)}`;
	}

	private formatCostCompact(): string {
		if (this.data.cost < 1) {
			return `$${this.data.cost.toFixed(2)}`;
		}
		return `$${Math.round(this.data.cost)}`;
	}

	private formatTokens(): string {
		const input = this.formatTokenCount(this.data.inputTokens);
		const output = this.formatTokenCount(this.data.outputTokens);
		return `\u2191${input} \u2193${output}`;
	}

	private formatTokensCompact(): string {
		const input = this.formatTokenCountCompact(this.data.inputTokens);
		const output = this.formatTokenCountCompact(this.data.outputTokens);
		return `${input}/${output}`;
	}

	private formatTokenCount(count: number): string {
		if (count < 1000) {
			return String(count);
		}
		// Use M for values that would display as 1000k or higher
		if (count >= 999950) {
			return `${(count / 1000000).toFixed(1)}M`;
		}
		return `${(count / 1000).toFixed(1)}k`;
	}

	private formatTokenCountCompact(count: number): string {
		if (count < 1000) {
			return String(count);
		}
		// Use M for values that would round to 1000k or higher
		if (count >= 999500) {
			return `${Math.round(count / 1000000)}M`;
		}
		return `${Math.round(count / 1000)}k`;
	}

	private markDirty(): void {
		this.dirty = true;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.onInvalidate?.();
	}

	invalidate(): void {
		this.markDirty();
	}
}
