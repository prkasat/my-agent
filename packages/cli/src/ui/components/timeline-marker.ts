import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SystemMessageTheme } from "../theme.js";

export interface TimelineMarkerOptions {
	theme: SystemMessageTheme;
	onInvalidate?: () => void;
}

export class TimelineMarker implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private dirty = true;

	constructor(
		private readonly text: string,
		private readonly options: TimelineMarkerOptions,
	) {}

	render(width: number): string[] {
		if (!this.dirty && this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}

		const borderStyle = this.options.theme.border ?? ((text: string) => text);
		const labelStyle = this.options.theme.muted ?? this.options.theme.label ?? ((text: string) => text);
		const maxLabelWidth = Math.max(1, width - 6);
		const rawLabel = ` ${truncateToWidth(this.text, maxLabelWidth, "...")} `;
		const labelWidth = visibleWidth(rawLabel);
		const totalRule = Math.max(0, width - labelWidth);
		const leftWidth = Math.floor(totalRule / 2);
		const rightWidth = Math.max(0, totalRule - leftWidth);
		const line = `${borderStyle("─".repeat(leftWidth))}${labelStyle(rawLabel)}${borderStyle("─".repeat(rightWidth))}`;
		const rendered = truncateToWidth(line, width, "", true);

		this.cachedWidth = width;
		this.cachedLines = [rendered];
		this.dirty = false;
		return [rendered];
	}

	invalidate(): void {
		this.dirty = true;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.options.onInvalidate?.();
	}
}
