import type { SessionTreeNode } from "@my-agent/core";
import { describe, expect, it, vi } from "vitest";
import { TreeSelectorComponent } from "../../../../src/ui/components/selectors/tree-selector.js";
import { defaultAgentTheme } from "../../../../src/ui/theme.js";

const CURSOR_MARKER = "\u001b_pi:c\u0007";
const ESC = "\u001b";

function stripAnsi(text: string): string {
	const input = text.replaceAll(CURSOR_MARKER, "");
	let result = "";

	for (let index = 0; index < input.length; index++) {
		if (input[index] !== ESC) {
			result += input[index];
			continue;
		}

		const next = input[index + 1];
		if (next === "[") {
			index += 2;
			while (index < input.length) {
				const code = input.charCodeAt(index);
				if (code >= 0x40 && code <= 0x7e) break;
				index++;
			}
			continue;
		}

		index += 1;
	}

	return result;
}

function renderPlain(component: TreeSelectorComponent, width = 100): string {
	return stripAnsi(component.render(width).join("\n"));
}

function makeTree(): SessionTreeNode[] {
	const u1 = {
		entry: {
			type: "message",
			id: "u1aa11aa",
			parentId: null,
			timestamp: "2026-04-20T10:00:00.000Z",
			message: { role: "user", content: "Investigate why the /tree popup is hard to navigate", timestamp: Date.now() },
		},
		children: [],
	} satisfies SessionTreeNode;

	const a1 = {
		entry: {
			type: "message",
			id: "a1bb22bb",
			parentId: "u1aa11aa",
			timestamp: "2026-04-20T10:01:00.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "I will inspect the session tree UI and simplify the navigation." }],
				timestamp: Date.now(),
			},
		},
		children: [],
	} satisfies SessionTreeNode;

	const t1 = {
		entry: {
			type: "message",
			id: "t1cc33cc",
			parentId: "a1bb22bb",
			timestamp: "2026-04-20T10:02:00.000Z",
			message: {
				role: "toolResult",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "packages/cli/src/tui/app.ts" }],
				timestamp: Date.now(),
			},
		},
		children: [],
	} satisfies SessionTreeNode;

	const s1 = {
		entry: {
			type: "settings_change",
			id: "s1dd44dd",
			parentId: "t1cc33cc",
			timestamp: "2026-04-20T10:03:00.000Z",
			model: { provider: "openai-codex", modelId: "gpt-5.4" },
		},
		children: [],
	} satisfies SessionTreeNode;

	const u2 = {
		entry: {
			type: "message",
			id: "u2ee55ee",
			parentId: "s1dd44dd",
			timestamp: "2026-04-20T10:04:00.000Z",
			message: { role: "user", content: "Make it feel more like pi-mono", timestamp: Date.now() },
		},
		children: [],
	} satisfies SessionTreeNode;

	u1.children.push(a1);
	a1.children.push(t1);
	t1.children.push(s1);
	s1.children.push(u2);
	return [u1];
}

describe("TreeSelectorComponent", () => {
	it("renders meaningful previews and hides noisy bookkeeping in focus view", () => {
		const component = new TreeSelectorComponent(makeTree(), {
			theme: defaultAgentTheme,
			currentLeafId: "u2ee55ee",
			getLabel: (entryId) => (entryId === "a1bb22bb" ? "checkpoint" : undefined),
			maxVisibleRows: 6,
			maxDetailLines: 5,
		});

		const text = renderPlain(component);

		expect(text).toContain("user: Investigate why the /tree popup is hard to navigate");
		expect(text).toContain("assistant: I will inspect the session tree UI and simplify the navigatio");
		expect(text).toContain("[checkpoint]");
		expect(text).toContain("user: Make it feel more like pi-mono");
		expect(text).not.toContain("settings: model gpt-5.4");
		expect(text).not.toContain("[read] read: packages/cli/src/tui/app.ts");
	});

	it("search reveals hidden tool entries so specific nodes are still reachable", () => {
		const component = new TreeSelectorComponent(makeTree(), {
			theme: defaultAgentTheme,
			currentLeafId: "u2ee55ee",
			maxVisibleRows: 6,
			maxDetailLines: 5,
		});

		for (const ch of "read") component.handleInput(ch);
		const text = renderPlain(component);

		expect(text).toContain("1 search matches across 5 entries");
		expect(text).toContain("[read] read: packages/cli/src/tui/app.ts");
	});

	it("clears search on first escape and only cancels when already cleared", () => {
		const component = new TreeSelectorComponent(makeTree(), {
			theme: defaultAgentTheme,
			currentLeafId: "u2ee55ee",
			maxVisibleRows: 6,
			maxDetailLines: 5,
		});
		const onCancel = vi.fn();
		component.onCancel = onCancel;

		for (const ch of "read") component.handleInput(ch);
		component.handleInput("\u001b");

		expect(onCancel).not.toHaveBeenCalled();
		expect(renderPlain(component)).not.toContain("1 search matches across 5 entries");

		component.handleInput("\u001b");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
