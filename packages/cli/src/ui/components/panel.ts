import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const identity = (text: string): string => text;

export interface PanelRenderOptions {
	width: number;
	title?: string;
	titleStyle?: (text: string) => string;
	borderStyle?: (text: string) => string;
	backgroundStyle?: (text: string) => string;
	lines: string[];
	paddingX?: number;
	paddingY?: number;
}

export function getPanelContentWidth(width: number, paddingX = 1): number {
	return Math.max(1, width - 4 - Math.max(0, paddingX) * 2);
}

export function wrapStyledText(text: string, width: number, style: (text: string) => string = identity): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph.length === 0) {
			lines.push("");
			continue;
		}
		lines.push(...wrapTextWithAnsi(style(paragraph), width));
	}
	return lines.length > 0 ? lines : [""];
}

export function renderPanel(options: PanelRenderOptions): string[] {
	const width = Math.max(6, options.width);
	const paddingX = Math.max(0, options.paddingX ?? 1);
	const paddingY = Math.max(0, options.paddingY ?? 0);
	const borderStyle = options.borderStyle ?? identity;
	const titleStyle = options.titleStyle ?? identity;
	const backgroundStyle = options.backgroundStyle;
	const contentWidth = getPanelContentWidth(width, paddingX);
	const outerContentWidth = width - 4;
	const pad = " ".repeat(paddingX);
	const lines = options.lines.length > 0 ? options.lines : [""];
	const rendered: string[] = [renderTopBorder(width, options.title, borderStyle, titleStyle)];

	for (let i = 0; i < paddingY; i++) {
		rendered.push(renderContentLine("", contentWidth, outerContentWidth, pad, borderStyle, backgroundStyle));
	}

	for (const line of lines) {
		rendered.push(renderContentLine(line, contentWidth, outerContentWidth, pad, borderStyle, backgroundStyle));
	}

	for (let i = 0; i < paddingY; i++) {
		rendered.push(renderContentLine("", contentWidth, outerContentWidth, pad, borderStyle, backgroundStyle));
	}

	rendered.push(borderStyle(`╰${"─".repeat(width - 2)}╯`));
	return rendered;
}

function renderTopBorder(
	width: number,
	title: string | undefined,
	borderStyle: (text: string) => string,
	titleStyle: (text: string) => string,
): string {
	if (!title) {
		return borderStyle(`╭${"─".repeat(width - 2)}╮`);
	}

	const availableTitleWidth = Math.max(1, width - 6);
	const truncatedTitle = truncateToWidth(title, availableTitleWidth, "...");
	const titleWidth = visibleWidth(truncatedTitle);
	const fillWidth = Math.max(0, width - titleWidth - 5);

	return `${borderStyle("╭─ ")}${titleStyle(truncatedTitle)}${borderStyle(` ${"─".repeat(fillWidth)}╮`)}`;
}

function renderContentLine(
	line: string,
	contentWidth: number,
	outerContentWidth: number,
	pad: string,
	borderStyle: (text: string) => string,
	backgroundStyle?: (text: string) => string,
): string {
	const paddedContent = `${pad}${truncateToWidth(line, contentWidth, "...", true)}${pad}`;
	const content = truncateToWidth(paddedContent, outerContentWidth, "", true);
	const styledContent = backgroundStyle ? backgroundStyle(content) : content;
	return `${borderStyle("│ ")}${styledContent}${borderStyle(" │")}`;
}
