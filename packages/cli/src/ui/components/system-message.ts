import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Chalk } from "chalk";
import type { SystemMessageTheme } from "../theme.js";
import { wrapStyledText } from "./panel.js";

const chalk = new Chalk({ level: 3 });

export type SystemMessageVariant = "info" | "success" | "warning" | "error" | "muted";

export interface SystemMessageOptions {
	theme: SystemMessageTheme;
	variant?: SystemMessageVariant;
	onInvalidate?: () => void;
}

const VARIANT_ICONS: Record<SystemMessageVariant, string> = {
	info: "ℹ",
	success: "✓",
	warning: "!",
	error: "✕",
	muted: "·",
};

const VARIANT_LABELS: Record<SystemMessageVariant, string> = {
	info: "info",
	success: "ok",
	warning: "warn",
	error: "error",
	muted: "note",
};

const VARIANT_FALLBACKS: Record<SystemMessageVariant, (text: string) => string> = {
	info: (text: string) => chalk.cyan(text),
	success: (text: string) => chalk.green(text),
	warning: (text: string) => chalk.yellow(text),
	error: (text: string) => chalk.red(text),
	muted: (text: string) => chalk.dim(text),
};

export class SystemMessage implements Component {
	private text: string;
	private options: Required<Omit<SystemMessageOptions, "onInvalidate">> & Pick<SystemMessageOptions, "onInvalidate">;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private dirty = true;

	constructor(text: string, options: SystemMessageOptions) {
		this.text = text;
		this.options = {
			theme: options.theme,
			variant: options.variant ?? "info",
			onInvalidate: options.onInvalidate,
		};
	}

	setText(text: string): void {
		if (this.text !== text) {
			this.text = text;
			this.markDirty();
		}
	}

	render(width: number): string[] {
		if (!this.dirty && this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}

		const variant = this.options.variant;
		const theme = this.options.theme;
		const variantStyle = theme[variant] ?? VARIANT_FALLBACKS[variant];
		const textStyle = theme.text ?? ((text: string) => text);
		const borderStyle = theme.border ?? variantStyle;
		const labelStyle = theme.label ?? variantStyle;
		const backgroundStyle = theme.background;
		const labelText = `${VARIANT_ICONS[variant]} ${VARIANT_LABELS[variant].toUpperCase()}`;
		const labelWidth = visibleWidth(labelText);
		const contentWidth = Math.max(1, width - labelWidth - 3);
		const textLines = wrapStyledText(this.text, contentWidth, textStyle);
		const rendered: string[] = [];

		for (let i = 0; i < textLines.length; i++) {
			const prefix = i === 0 ? `${labelStyle(labelText)} ` : `${" ".repeat(labelWidth)} `;
			const line = `${borderStyle("│")} ${prefix}${textLines[i] ?? ""}`;
			const truncated = truncateToWidth(line, width, "...", true);
			rendered.push(backgroundStyle ? backgroundStyle(truncated) : truncated);
		}

		this.cachedWidth = width;
		this.cachedLines = rendered;
		this.dirty = false;
		return rendered;
	}

	invalidate(): void {
		this.markDirty();
	}

	private markDirty(): void {
		this.dirty = true;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.options.onInvalidate?.();
	}
}
