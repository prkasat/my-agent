/**
 * Tests for keybindings
 */

import { describe, it, expect } from "vitest";
import {
	AGENT_KEYBINDINGS,
	getAgentKeybindingActions,
	getDefaultKeyForAction,
	getActionDescription,
} from "../../src/ui/keybindings.js";

describe("AGENT_KEYBINDINGS", () => {
	it("defines all expected action categories", () => {
		const actions = Object.keys(AGENT_KEYBINDINGS);

		// Tool execution controls
		expect(actions).toContain("agent.tool.expand");
		expect(actions).toContain("agent.tool.expandAll");
		expect(actions).toContain("agent.tool.collapseAll");

		// Message navigation
		expect(actions).toContain("agent.message.previous");
		expect(actions).toContain("agent.message.next");

		// Session controls
		expect(actions).toContain("agent.session.cancel");
		expect(actions).toContain("agent.session.interrupt");

		// Mode switching
		expect(actions).toContain("agent.mode.normal");
		expect(actions).toContain("agent.mode.plan");
		expect(actions).toContain("agent.mode.auto");

		// Model selection
		expect(actions).toContain("agent.model.select");

		// Diff controls
		expect(actions).toContain("agent.diff.toggle");
		expect(actions).toContain("agent.diff.accept");
		expect(actions).toContain("agent.diff.reject");

		// Help
		expect(actions).toContain("agent.help.show");
		expect(actions).toContain("agent.help.shortcuts");
	});

	it("uses standard key bindings (no non-standard combos)", () => {
		// Check that help.show uses f1 (standard) not ctrl+? (non-standard)
		const helpKey = getDefaultKeyForAction("agent.help.show");
		expect(helpKey).toBe("f1");
	});

	it("all bindings have defaultKeys and description", () => {
		for (const [action, binding] of Object.entries(AGENT_KEYBINDINGS)) {
			expect(binding.defaultKeys, `${action} missing defaultKeys`).toBeDefined();
			expect(binding.description, `${action} missing description`).toBeDefined();
			expect(binding.description.length, `${action} description too short`).toBeGreaterThan(5);
		}
	});
});

describe("getAgentKeybindingActions", () => {
	it("returns all action names", () => {
		const actions = getAgentKeybindingActions();

		expect(actions.length).toBeGreaterThan(10);
		expect(actions).toContain("agent.tool.expand");
		expect(actions).toContain("agent.session.cancel");
	});
});

describe("getDefaultKeyForAction", () => {
	it("returns key for valid action", () => {
		expect(getDefaultKeyForAction("agent.session.cancel")).toBe("escape");
		expect(getDefaultKeyForAction("agent.session.interrupt")).toBe("ctrl+c");
	});

	it("returns undefined for invalid action", () => {
		expect(getDefaultKeyForAction("nonexistent.action")).toBeUndefined();
	});
});

describe("getActionDescription", () => {
	it("returns description for valid action", () => {
		const desc = getActionDescription("agent.session.cancel");
		expect(desc).toBe("Cancel current operation");
	});

	it("returns undefined for invalid action", () => {
		expect(getActionDescription("nonexistent.action")).toBeUndefined();
	});
});
