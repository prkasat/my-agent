/**
 * Tests for Footer component
 */

import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { Footer, type FooterData } from "../../../src/ui/components/footer.js";
import type { FooterTheme } from "../../../src/ui/theme.js";

// Simple theme without styling for testing
const testTheme: FooterTheme = {
	background: (text: string) => text,
	model: (text: string) => text,
	mode: (text: string) => text,
	cost: (text: string) => text,
	tokens: (text: string) => text,
	thinking: (text: string) => text,
	separator: (text: string) => text,
};

const defaultData: FooterData = {
	model: "test-model",
	mode: "normal",
	inputTokens: 100,
	outputTokens: 50,
	cost: 0.001,
	thinking: false,
};

describe("Footer", () => {
	it("renders model and mode", () => {
		const footer = new Footer(defaultData, { theme: testTheme });
		const lines = footer.render(80);

		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("test-model");
		expect(lines[0]).toContain("normal");
	});

	it("shows thinking indicator when thinking", () => {
		const footer = new Footer({ ...defaultData, thinking: true }, { theme: testTheme });
		const lines = footer.render(80);

		expect(lines[0]).toContain("thinking...");
	});

	it("shows custom status text", () => {
		const footer = new Footer({ ...defaultData, statusText: "Processing..." }, { theme: testTheme });
		const lines = footer.render(80);

		expect(lines[0]).toContain("Processing...");
	});

	it("formats small token counts", () => {
		const footer = new Footer({ ...defaultData, inputTokens: 500, outputTokens: 200 }, { theme: testTheme });
		const lines = footer.render(80);

		expect(lines[0]).toContain("500");
		expect(lines[0]).toContain("200");
	});

	it("formats token counts in k", () => {
		const footer = new Footer({ ...defaultData, inputTokens: 5000, outputTokens: 2000 }, { theme: testTheme });
		const lines = footer.render(80);

		expect(lines[0]).toContain("5.0k");
		expect(lines[0]).toContain("2.0k");
	});

	it("transitions to M at 999,950+ tokens (fixed bug)", () => {
		const footer = new Footer({ ...defaultData, inputTokens: 999950, outputTokens: 1000000 }, { theme: testTheme });
		const lines = footer.render(80);

		// Should show M, not 1000.0k
		expect(lines[0]).not.toContain("1000.0k");
		expect(lines[0]).toContain("1.0M");
	});

	it("formats cost with appropriate precision", () => {
		// Small cost
		let footer = new Footer({ ...defaultData, cost: 0.0012 }, { theme: testTheme });
		expect(footer.render(80)[0]).toContain("$0.0012");

		// Medium cost
		footer = new Footer({ ...defaultData, cost: 0.123 }, { theme: testTheme });
		expect(footer.render(80)[0]).toContain("$0.123");

		// Large cost
		footer = new Footer({ ...defaultData, cost: 1.5 }, { theme: testTheme });
		expect(footer.render(80)[0]).toContain("$1.50");
	});

	it("caches rendered output", () => {
		const footer = new Footer(defaultData, { theme: testTheme });
		const lines1 = footer.render(80);
		const lines2 = footer.render(80);

		// Footer returns the cached array on subsequent renders
		expect(lines1).toStrictEqual(lines2);
	});

	it("invalidates cache on update", () => {
		const footer = new Footer(defaultData, { theme: testTheme });
		const lines1 = footer.render(80);

		footer.setModel("new-model");
		const lines2 = footer.render(80);

		expect(lines1).not.toBe(lines2);
		expect(lines2[0]).toContain("new-model");
	});

	it("handles narrow terminals with progressive compaction", () => {
		const footer = new Footer(defaultData, { theme: testTheme });
		const narrowLines = footer.render(30);

		expect(narrowLines.length).toBe(1);
		// Should still be valid but may be truncated - check visible width
		expect(visibleWidth(narrowLines[0])).toBeLessThanOrEqual(30);
	});

	it("getData returns a copy to prevent external mutation (fixed bug)", () => {
		const footer = new Footer(defaultData, { theme: testTheme });
		const lines1 = footer.render(80);

		// Get data and mutate it
		const data = footer.getData();
		// @ts-expect-error - Testing that mutation doesn't affect internal state
		data.model = "mutated-model";

		// Re-render should still show original model (mutation didn't affect internal state)
		const lines2 = footer.render(80);
		expect(lines2[0]).not.toContain("mutated-model");
		expect(lines2[0]).toContain("test-model"); // Original model still shown
		expect(lines1).toStrictEqual(lines2); // Content should be the same
	});
});
