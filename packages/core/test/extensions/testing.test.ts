import { describe, it, expect } from "vitest";
import {
	createMockContext,
	createMockUI,
	createMockActions,
	activateForTest,
} from "../../src/extensions/testing.js";
import type { ExtensionDefinition } from "../../src/extensions/types.js";

describe("testing utilities", () => {
	it("createMockContext routes handlers through emit()", async () => {
		const ctx = createMockContext();
		const seen: number[] = [];
		ctx.on("turn_start", (e) => {
			seen.push(e.turnIndex);
		});
		await ctx.emit({ type: "turn_start", turnIndex: 5 });
		expect(seen).toEqual([5]);
	});

	it("createMockUI queues and records calls", async () => {
		const ui = createMockUI();
		ui.enqueueSelect("a");
		ui.enqueueConfirm(true);
		ui.enqueueInput("user typed");
		expect(await ui.select([{ value: "a", label: "A" }])).toBe("a");
		expect(await ui.confirm("ok?")).toBe(true);
		expect(await ui.input("name?")).toBe("user typed");
		ui.notify("hello", "warn");
		expect(ui.selectCalls).toHaveLength(1);
		expect(ui.confirmCalls).toHaveLength(1);
		expect(ui.inputCalls).toHaveLength(1);
		expect(ui.notifications).toEqual([{ message: "hello", level: "warn" }]);
	});

	it("createMockActions records sendMessage / setModel / setActiveTools", () => {
		const a = createMockActions();
		a.sendMessage("hi");
		a.setModel({
			id: "x",
			name: "X",
			provider: "openrouter",
			contextWindow: 1,
			maxOutputTokens: 1,
			supportsTools: false,
			supportsStreaming: false,
			supportsThinking: false,
		});
		a.setActiveTools([]);
		expect(a.sent).toEqual(["hi"]);
		expect(a.modelsSet).toHaveLength(1);
		expect(a.toolsSet).toHaveLength(1);
	});

	it("activateForTest builds a real runner", async () => {
		const def: ExtensionDefinition = {
			metadata: { id: "a", name: "A", version: "1.0.0" },
			activate(ctx) {
				ctx.registerCommand({ name: "hi", execute: () => {} });
			},
		};
		const runner = await activateForTest(def);
		expect(runner.has("a")).toBe(true);
		expect(runner.getAllCommands()).toHaveLength(1);
	});
});
