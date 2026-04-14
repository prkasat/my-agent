/**
 * Tests for SessionSelector component
 */

import { describe, it, expect, vi } from "vitest";
import { createSessionSelector, type SessionInfo } from "../../../src/components/selectors/session-selector.js";
import type { SelectListTheme, TUI } from "@mariozechner/pi-tui";

// Simple theme without styling for testing
const testTheme: SelectListTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

// Mock TUI
function createMockTUI(): TUI {
	return {
		showOverlay: vi.fn().mockReturnValue({
			hide: vi.fn(),
			isVisible: vi.fn().mockReturnValue(true),
		}),
	} as unknown as TUI;
}

const sampleSessions: SessionInfo[] = [
	{
		id: "session-1",
		name: "Test Session 1",
		createdAt: new Date("2026-04-13T10:00:00Z"),
		lastActiveAt: new Date("2026-04-14T08:00:00Z"),
		messageCount: 10,
	},
	{
		id: "session-2",
		name: "Test Session 2",
		createdAt: new Date("2026-04-12T10:00:00Z"),
		lastActiveAt: new Date("2026-04-13T08:00:00Z"),
		messageCount: 5,
		isActive: true,
	},
];

describe("createSessionSelector", () => {
	it("creates selector with sessions and new session option", () => {
		const tui = createMockTUI();

		const overlay = createSessionSelector(tui, sampleSessions, {
			theme: testTheme,
		});

		expect(tui.showOverlay).toHaveBeenCalled();
		expect(overlay).toBeDefined();
	});

	it("creates selector without new session option", () => {
		const tui = createMockTUI();

		const overlay = createSessionSelector(tui, sampleSessions, {
			theme: testTheme,
			showNewSession: false,
		});

		expect(tui.showOverlay).toHaveBeenCalled();
		expect(overlay).toBeDefined();
	});

	it("throws error when no items would be shown", () => {
		const tui = createMockTUI();

		expect(() =>
			createSessionSelector(tui, [], {
				theme: testTheme,
				showNewSession: false,
			})
		).toThrow("SessionSelector requires at least one item");
	});

	it("allows empty sessions if showNewSession is true", () => {
		const tui = createMockTUI();

		// Should not throw - "New Session" option provides an item
		const overlay = createSessionSelector(tui, [], {
			theme: testTheme,
			showNewSession: true,
		});

		expect(overlay).toBeDefined();
	});

	it("throws error if session ID collides with internal sentinel (fixed bug)", () => {
		const tui = createMockTUI();

		// Create a session with ID matching the internal sentinel
		const collidingSessions: SessionInfo[] = [
			{
				id: "\0__new_session__", // Matches the internal sentinel
				name: "Collision Session",
				createdAt: new Date(),
				lastActiveAt: new Date(),
				messageCount: 0,
			},
		];

		expect(() =>
			createSessionSelector(tui, collidingSessions, {
				theme: testTheme,
			})
		).toThrow(/collides with internal sentinel/);
	});
});
