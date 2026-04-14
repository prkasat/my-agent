/**
 * Tests for UserMessage component
 */

import { describe, it, expect } from "vitest";
import { UserMessage } from "../../src/components/user-message.js";
import type { UserMessageTheme } from "../../src/theme.js";

// Simple theme without styling for testing
const testTheme: UserMessageTheme = {
	label: (text: string) => text,
	text: (text: string) => text,
};

describe("UserMessage", () => {
	it("renders simple message with label", () => {
		const msg = new UserMessage("Hello world", { theme: testTheme });
		const lines = msg.render(40);

		expect(lines.length).toBeGreaterThan(0);
		expect(lines[0]).toContain("You:");
		expect(lines[0]).toContain("Hello world");
	});

	it("renders empty message with just label", () => {
		const msg = new UserMessage("", { theme: testTheme });
		const lines = msg.render(40);

		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("You:");
	});

	it("wraps long text correctly", () => {
		const longText = "This is a very long message that should wrap across multiple lines when rendered";
		const msg = new UserMessage(longText, { theme: testTheme });
		const lines = msg.render(30);

		// Should have multiple lines
		expect(lines.length).toBeGreaterThan(1);
		// All lines should fit within width
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(30);
		}
	});

	it("handles CJK characters correctly (fixed unicode slicing bug)", () => {
		// CJK characters are 2 cells wide each
		// "你好世界" = 4 characters, 8 cells
		const msg = new UserMessage("你好世界 more text after", { theme: testTheme });
		const lines = msg.render(20);

		// Should not corrupt text - join all lines and check content preserved
		const allContent = lines.join(" ");
		expect(allContent).toContain("你好");
		expect(allContent).toContain("text");
	});

	it("uses custom label", () => {
		const msg = new UserMessage("Test", { theme: testTheme, label: "Human" });
		const lines = msg.render(40);

		expect(lines[0]).toContain("Human:");
	});

	it("caches rendered output", () => {
		const msg = new UserMessage("Test", { theme: testTheme });
		const lines1 = msg.render(40);
		const lines2 = msg.render(40);

		// Should return same array reference when cached
		expect(lines1).toBe(lines2);
	});

	it("invalidates cache on setText", () => {
		const msg = new UserMessage("Test", { theme: testTheme });
		const lines1 = msg.render(40);

		msg.setText("Updated");
		const lines2 = msg.render(40);

		// Should return different array after update
		expect(lines1).not.toBe(lines2);
		expect(lines2[0]).toContain("Updated");
	});

	it("respects padding options", () => {
		const msg = new UserMessage("Test", {
			theme: testTheme,
			paddingX: 3,
			paddingY: 1,
		});
		const lines = msg.render(40);

		// Should have top/bottom padding lines
		expect(lines.length).toBe(3);
		// First and last should be padding (all spaces)
		expect(lines[0].trim()).toBe("");
		expect(lines[2].trim()).toBe("");
	});
});
