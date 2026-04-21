import {
	type Focusable,
	Input,
	Key,
	type OverlayHandle,
	type TUI,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import type { SessionEntry, SessionTreeNode } from "@my-agent/core";
import type { AgentTheme } from "../../theme.js";
import { getPanelContentWidth, renderPanel } from "../panel.js";

const identity = (text: string): string => text;
const DEFAULT_MAX_VISIBLE_ROWS = 8;
const DEFAULT_MAX_DETAIL_LINES = 5;

interface FlattenedTreeNode {
	node: SessionTreeNode;
	depth: number;
	isLast: boolean;
	ancestorIsLast: boolean[];
	label?: string;
	defaultVisible: boolean;
	searchable: string;
	preview: string;
}

export interface TreeSelectorComponentOptions {
	theme: AgentTheme;
	currentLeafId: string | null;
	getLabel?: (entryId: string) => string | undefined;
	maxVisibleRows?: number;
	maxDetailLines?: number;
}

export interface TreeSelectorOptions extends TreeSelectorComponentOptions {
	onSelect?: (entryId: string) => void;
	onCancel?: () => void;
	width?: number | `${number}%`;
	maxHeight?: number | `${number}%`;
	minWidth?: number;
}

export class TreeSelectorComponent implements Focusable {
	private readonly theme: AgentTheme;
	private readonly currentLeafId: string | null;
	private readonly maxVisibleRows: number;
	private readonly maxDetailLines: number;
	private readonly searchInput = new Input();
	private readonly flatNodes: FlattenedTreeNode[] = [];
	private readonly parentById = new Map<string, string | null>();
	private readonly activePathIds = new Set<string>();
	private filteredNodes: FlattenedTreeNode[] = [];
	private selectedIndex = 0;
	private lastSelectedId: string | null = null;
	private _focused = false;

	onSelect?: (entryId: string) => void;
	onCancel?: () => void;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(tree: SessionTreeNode[], options: TreeSelectorComponentOptions) {
		this.theme = options.theme;
		this.currentLeafId = options.currentLeafId;
		this.maxVisibleRows = Math.max(4, options.maxVisibleRows ?? DEFAULT_MAX_VISIBLE_ROWS);
		this.maxDetailLines = Math.max(3, options.maxDetailLines ?? DEFAULT_MAX_DETAIL_LINES);

		this.flattenTree(tree, 0, [], options.getLabel);
		this.buildActivePath();
		this.applyFilter(this.currentLeafId);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const panelWidth = Math.max(6, width);
		const contentWidth = getPanelContentWidth(panelWidth, 1);
		const borderStyle = this.theme.systemMessage.border ?? identity;
		const titleStyle = this.theme.systemMessage.label ?? identity;
		const lines: string[] = [];

		lines.push(this.renderSearchLine(contentWidth));
		lines.push(this.renderStatusLine(contentWidth));
		lines.push("");
		lines.push(...this.renderList(contentWidth));
		lines.push("");
		lines.push(...this.renderDetails(contentWidth));
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.selectList.scrollInfo(
					"Enter switch · Esc clear/close · Type to search · ↑/↓ move · PgUp/PgDn faster · Home/End jump",
				),
				contentWidth,
				"...",
				true,
			),
		);

		return renderPanel({
			width: panelWidth,
			title: "Session tree",
			titleStyle,
			borderStyle,
			lines,
			paddingX: 1,
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.moveSelection(-this.maxVisibleRows);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.moveSelection(this.maxVisibleRows);
			return;
		}
		if (matchesKey(data, Key.home)) {
			if (this.filteredNodes.length > 0) {
				this.selectedIndex = 0;
				this.lastSelectedId = this.filteredNodes[0]?.node.entry.id ?? this.lastSelectedId;
			}
			return;
		}
		if (matchesKey(data, Key.end)) {
			if (this.filteredNodes.length > 0) {
				this.selectedIndex = this.filteredNodes.length - 1;
				this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
			}
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const selected = this.getSelectedNode();
			if (selected) this.onSelect?.(selected.node.entry.id);
			return;
		}
		if (matchesKey(data, Key.escape) || data === "\u0003") {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.setValue("");
				this.applyFilter(this.lastSelectedId ?? this.currentLeafId);
			} else {
				this.onCancel?.();
			}
			return;
		}

		const previousQuery = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		const nextQuery = this.searchInput.getValue();
		if (nextQuery !== previousQuery) {
			this.applyFilter(this.lastSelectedId ?? this.currentLeafId);
		}
	}

	private flattenTree(
		nodes: SessionTreeNode[],
		depth: number,
		ancestorIsLast: boolean[],
		getLabel?: (entryId: string) => string | undefined,
	): void {
		for (const [index, node] of nodes.entries()) {
			const isLast = index === nodes.length - 1;
			const label = getLabel?.(node.entry.id);
			const preview = this.getPreviewText(node.entry);
			this.parentById.set(node.entry.id, node.entry.parentId);
			this.flatNodes.push({
				node,
				depth,
				isLast,
				ancestorIsLast,
				label,
				preview,
				defaultVisible: this.isDefaultVisible(node.entry, preview, label),
				searchable: this.getSearchableText(node.entry, preview, label),
			});
			this.flattenTree(node.children, depth + 1, [...ancestorIsLast, isLast], getLabel);
		}
	}

	private buildActivePath(): void {
		this.activePathIds.clear();
		let currentId = this.currentLeafId;
		while (currentId) {
			this.activePathIds.add(currentId);
			currentId = this.parentById.get(currentId) ?? null;
		}
	}

	private applyFilter(preferredId: string | null): void {
		const query = this.searchInput.getValue().trim().toLowerCase();
		const tokens = query.split(/\s+/).filter(Boolean);
		this.filteredNodes = this.flatNodes.filter((item) => {
			if (tokens.length > 0) {
				return tokens.every((token) => item.searchable.includes(token));
			}
			return item.defaultVisible || item.label !== undefined || item.node.entry.id === this.currentLeafId;
		});

		if (this.filteredNodes.length === 0) {
			this.selectedIndex = 0;
			return;
		}

		this.selectedIndex = this.findNearestVisibleIndex(preferredId);
		this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
	}

	private findNearestVisibleIndex(entryId: string | null): number {
		if (this.filteredNodes.length === 0) return 0;
		const indexById = new Map(this.filteredNodes.map((item, index) => [item.node.entry.id, index]));
		let currentId = entryId;
		while (currentId) {
			const index = indexById.get(currentId);
			if (index !== undefined) return index;
			currentId = this.parentById.get(currentId) ?? null;
		}
		return Math.min(this.selectedIndex, this.filteredNodes.length - 1);
	}

	private moveSelection(delta: number): void {
		if (this.filteredNodes.length === 0) return;
		const next = this.selectedIndex + delta;
		this.selectedIndex = Math.max(0, Math.min(this.filteredNodes.length - 1, next));
		this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
	}

	private renderSearchLine(width: number): string {
		const label = this.theme.selectList.description("Search ");
		const inputWidth = Math.max(1, width - visibleWidth(label));
		const inputLine = this.searchInput.render(inputWidth)[0] ?? "";
		return label + inputLine;
	}

	private renderStatusLine(width: number): string {
		const query = this.searchInput.getValue().trim();
		const currentText = this.currentLeafId ? `current ${this.currentLeafId}` : "no current leaf";
		const text =
			query.length > 0
				? `${this.filteredNodes.length} search matches across ${this.flatNodes.length} entries · ${currentText}`
				: `focus view: ${this.filteredNodes.length}/${this.flatNodes.length} entries · type to search hidden tool/bookkeeping entries · ${currentText}`;
		return truncateToWidth(this.theme.selectList.scrollInfo(text), width, "...", true);
	}

	private renderList(width: number): string[] {
		if (this.filteredNodes.length === 0) {
			return [truncateToWidth(this.theme.selectList.noMatch("No matching tree entries"), width, "...", true)];
		}

		const lines: string[] = [];
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisibleRows / 2),
				Math.max(0, this.filteredNodes.length - this.maxVisibleRows),
			),
		);
		const endIndex = Math.min(this.filteredNodes.length, startIndex + this.maxVisibleRows);

		for (let index = startIndex; index < endIndex; index++) {
			lines.push(this.renderRow(this.filteredNodes[index], index === this.selectedIndex, width));
		}

		if (this.filteredNodes.length > this.maxVisibleRows) {
			lines.push(
				truncateToWidth(
					this.theme.selectList.scrollInfo(`Showing ${startIndex + 1}-${endIndex} of ${this.filteredNodes.length}`),
					width,
					"...",
					true,
				),
			);
		}

		return lines;
	}

	private renderRow(item: FlattenedTreeNode, isSelected: boolean, width: number): string {
		const selectionPrefix = isSelected ? this.theme.selectList.selectedPrefix("→ ") : "  ";
		const treePrefix = this.renderTreePrefix(item);
		const branchMarker = this.renderBranchMarker(item.node.entry.id);
		const label = item.label ? this.styleLabel(`[${item.label}] `) : "";
		const title = this.renderEntryTitle(item.node.entry, item.preview);
		const idSuffix = this.theme.selectList.description(` · ${item.node.entry.id}`);
		const line = truncateToWidth(
			`${selectionPrefix}${treePrefix}${branchMarker}${label}${title}${idSuffix}`,
			width,
			"...",
			true,
		);
		return isSelected ? this.theme.selectList.selectedText(line) : line;
	}

	private renderTreePrefix(item: FlattenedTreeNode): string {
		const parts: string[] = [];
		for (let depth = 0; depth < item.depth; depth++) {
			const isParentLast = item.ancestorIsLast[depth];
			if (depth === item.depth - 1) {
				parts.push(this.theme.systemMessage.border?.(item.isLast ? "└─" : "├─") ?? (item.isLast ? "└─" : "├─"));
			} else {
				parts.push(this.theme.systemMessage.border?.(isParentLast ? "  " : "│ ") ?? (isParentLast ? "  " : "│ "));
			}
		}
		return parts.join("");
	}

	private renderBranchMarker(entryId: string): string {
		if (entryId === this.currentLeafId) {
			return this.theme.systemMessage.success?.("● ") ?? "● ";
		}
		if (this.activePathIds.has(entryId)) {
			return this.theme.systemMessage.info?.("• ") ?? "• ";
		}
		return "";
	}

	private renderDetails(width: number): string[] {
		const selected = this.getSelectedNode();
		if (!selected) {
			return [truncateToWidth(this.theme.selectList.description("No entry selected"), width, "...", true)];
		}

		const lines: string[] = [];
		const entry = selected.node.entry;
		lines.push(truncateToWidth(this.renderEntryTitle(entry, selected.preview), width, "...", true));

		const meta = [
			entry.id,
			this.getEntryKind(entry),
			this.formatTimestamp(entry.timestamp),
			selected.label ? `label ${selected.label}` : undefined,
		]
			.filter(Boolean)
			.join(" · ");
		lines.push(truncateToWidth(this.theme.selectList.description(meta), width, "...", true));

		const relations = [
			entry.parentId ? `parent ${entry.parentId}` : "root",
			`${selected.node.children.length} child${selected.node.children.length === 1 ? "" : "ren"}`,
			selected.node.entry.id === this.currentLeafId
				? "current leaf"
				: this.activePathIds.has(entry.id)
					? "active path"
					: undefined,
			!selected.defaultVisible ? "shown via search" : undefined,
		]
			.filter(Boolean)
			.join(" · ");
		lines.push(truncateToWidth(this.theme.selectList.description(relations), width, "...", true));

		const detailLines = this.wrapDetailText(this.getDetailText(entry), width, this.maxDetailLines - 4);
		lines.push(...detailLines);
		lines.push(
			truncateToWidth(
				this.theme.selectList.scrollInfo(
					"Selecting this entry moves branch context here; your next prompt continues from this point.",
				),
				width,
				"...",
				true,
			),
		);

		return lines.slice(0, this.maxDetailLines);
	}

	private getSelectedNode(): FlattenedTreeNode | undefined {
		return this.filteredNodes[this.selectedIndex];
	}

	private wrapDetailText(text: string, width: number, maxLines: number): string[] {
		if (!text) return [];
		const wrapped = wrapTextWithAnsi(this.theme.systemMessage.text?.(text) ?? text, width);
		return wrapped.slice(0, Math.max(0, maxLines));
	}

	private renderEntryTitle(entry: SessionEntry, preview: string): string {
		switch (entry.type) {
			case "message": {
				switch (entry.message.role) {
					case "user":
						return `${this.theme.userMessage.label("user")}: ${this.theme.userMessage.text(preview || "(empty message)")}`;
					case "assistant":
						return `${this.theme.assistantMessage.label("assistant")}: ${this.theme.assistantMessage.text(preview || "(tool-only step)")}`;
					case "toolResult": {
						const toolName =
							typeof (entry.message as { toolName?: unknown }).toolName === "string"
								? ((entry.message as { toolName: string }).toolName ?? "tool")
								: "tool";
						const style = (entry.message as { isError?: boolean }).isError
							? this.theme.systemMessage.error
							: this.theme.systemMessage.warning;
						return `${style?.(`[${toolName}]`) ?? `[${toolName}]`} ${this.theme.systemMessage.text?.(preview || "tool result") ?? (preview || "tool result")}`;
					}
					default:
						return `${this.theme.systemMessage.label?.(entry.message.role) ?? entry.message.role}: ${preview}`;
				}
			}
			case "branch_summary":
				return `${this.theme.systemMessage.warning?.("branch summary") ?? "branch summary"}: ${preview}`;
			case "compaction":
				return `${this.theme.systemMessage.info?.("compaction") ?? "compaction"}: ${preview}`;
			case "settings_change":
				return `${this.theme.systemMessage.info?.("settings") ?? "settings"}: ${preview}`;
			case "session_info":
				return `${this.theme.systemMessage.info?.("session") ?? "session"}: ${preview}`;
			case "label":
				return `${this.theme.systemMessage.info?.("label") ?? "label"}: ${preview}`;
			case "extension":
				return `${this.theme.systemMessage.info?.("extension") ?? "extension"}: ${preview}`;
			default:
				return preview;
		}
	}

	private styleLabel(text: string): string {
		return this.theme.systemMessage.warning?.(text) ?? text;
	}

	private isDefaultVisible(entry: SessionEntry, preview: string, label: string | undefined): boolean {
		if (label) return true;
		if (entry.id === this.currentLeafId) return true;
		switch (entry.type) {
			case "message": {
				switch (entry.message.role) {
					case "user":
						return true;
					case "assistant":
						return preview.length > 0 || this.isAssistantErrorLike(entry.message);
					case "toolResult":
						return false;
					default:
						return true;
				}
			}
			case "branch_summary":
			case "compaction":
				return true;
			case "settings_change":
			case "session_info":
			case "label":
			case "extension":
				return false;
			default:
				return true;
		}
	}

	private isAssistantErrorLike(message: unknown): boolean {
		if (!message || typeof message !== "object") return false;
		const candidate = message as { stopReason?: unknown; errorMessage?: unknown; error?: unknown };
		if (typeof candidate.errorMessage === "string" && candidate.errorMessage.trim().length > 0) {
			return true;
		}
		if (typeof candidate.error === "string" && candidate.error.trim().length > 0) {
			return true;
		}
		return candidate.stopReason === "aborted" || candidate.stopReason === "error";
	}

	private getSearchableText(entry: SessionEntry, preview: string, label: string | undefined): string {
		return [
			entry.id,
			entry.parentId ?? "",
			entry.type,
			this.getEntryKind(entry),
			label ?? "",
			preview,
			this.getDetailText(entry),
		]
			.join(" ")
			.toLowerCase();
	}

	private getEntryKind(entry: SessionEntry): string {
		if (entry.type === "message") return entry.message.role;
		return entry.type;
	}

	private getPreviewText(entry: SessionEntry): string {
		switch (entry.type) {
			case "message": {
				switch (entry.message.role) {
					case "user":
						return this.extractTextContent((entry.message as { content?: unknown }).content);
					case "assistant": {
						const assistant = entry.message as {
							content?: unknown;
							error?: unknown;
							errorMessage?: unknown;
							stopReason?: unknown;
						};
						const text = this.extractTextContent(assistant.content);
						if (text) return text;
						if (typeof assistant.errorMessage === "string" && assistant.errorMessage.trim()) {
							return assistant.errorMessage.trim();
						}
						if (assistant.stopReason === "aborted") return "aborted";
						return "";
					}
					case "toolResult": {
						const toolMessage = entry.message as { toolName?: unknown; content?: unknown; isError?: unknown };
						const toolText = this.extractTextContent(toolMessage.content);
						const toolName = typeof toolMessage.toolName === "string" ? toolMessage.toolName : "tool";
						const prefix = toolMessage.isError ? `${toolName} error` : toolName;
						return toolText ? `${prefix}: ${toolText}` : prefix;
					}
					default:
						return this.extractTextContent((entry.message as { content?: unknown }).content);
				}
			}
			case "branch_summary":
				return this.normalizeWhitespace(entry.summary);
			case "compaction":
				return this.normalizeWhitespace(entry.summary || `summarized ${Math.round(entry.tokensBefore / 1000)}k tokens`);
			case "settings_change": {
				const changes = [
					entry.model ? `model ${entry.model.modelId}` : undefined,
					entry.thinkingLevel ? `thinking ${entry.thinkingLevel}` : undefined,
				]
					.filter(Boolean)
					.join(" · ");
				return changes || "settings updated";
			}
			case "session_info":
				return entry.name?.trim() || "session title updated";
			case "label":
				return entry.label?.trim()
					? `${entry.label.trim()} → ${entry.targetId}`
					: `cleared label from ${entry.targetId}`;
			case "extension":
				return `${entry.namespace}${entry.subtype ? `/${entry.subtype}` : ""}`;
			default:
				return "";
		}
	}

	private getDetailText(entry: SessionEntry): string {
		switch (entry.type) {
			case "message":
				return this.getPreviewText(entry) || `message role: ${entry.message.role}`;
			case "branch_summary":
				return `Summarizes abandoned work from ${entry.fromId}. ${this.normalizeWhitespace(entry.summary)}`;
			case "compaction":
				return `Compacted earlier context, keeping entries from ${entry.firstKeptEntryId}. ${this.normalizeWhitespace(entry.summary)}`;
			case "settings_change":
				return this.getPreviewText(entry);
			case "session_info":
				return this.getPreviewText(entry);
			case "label":
				return this.getPreviewText(entry);
			case "extension":
				return `Extension namespace ${entry.namespace}${entry.subtype ? ` (${entry.subtype})` : ""}`;
			default:
				return "";
		}
	}

	private extractTextContent(content: unknown): string {
		if (typeof content === "string") {
			return this.normalizeWhitespace(content).slice(0, 180);
		}
		if (!Array.isArray(content)) return "";

		let result = "";
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			const type = (block as { type?: unknown }).type;
			if (type === "text" && typeof (block as { text?: unknown }).text === "string") {
				result += ` ${(block as { text: string }).text}`;
			}
		}

		return this.normalizeWhitespace(result).slice(0, 180);
	}

	private normalizeWhitespace(text: string): string {
		return text
			.replace(/[\r\n\t]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	private formatTimestamp(timestamp: string): string {
		const date = new Date(timestamp);
		if (Number.isNaN(date.getTime())) return timestamp;
		const year = date.getFullYear();
		const month = `${date.getMonth() + 1}`.padStart(2, "0");
		const day = `${date.getDate()}`.padStart(2, "0");
		const hours = `${date.getHours()}`.padStart(2, "0");
		const minutes = `${date.getMinutes()}`.padStart(2, "0");
		return `${year}-${month}-${day} ${hours}:${minutes}`;
	}
}

export function createTreeSelector(tui: TUI, tree: SessionTreeNode[], options: TreeSelectorOptions): OverlayHandle {
	const selector = new TreeSelectorComponent(tree, options);
	const overlay = tui.showOverlay(selector, {
		anchor: "center",
		width: options.width ?? "84%",
		minWidth: options.minWidth ?? 72,
		maxHeight: options.maxHeight ?? 24,
	});
	selector.onSelect = (entryId) => {
		overlay.hide();
		options.onSelect?.(entryId);
	};
	selector.onCancel = () => {
		overlay.hide();
		options.onCancel?.();
	};
	return overlay;
}
