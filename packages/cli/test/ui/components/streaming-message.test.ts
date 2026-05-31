/**
 * Tests for StreamingMessage component
 */

import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { StreamingMessage } from "../../../src/ui/components/streaming-message.js";
import type { AssistantMessageTheme } from "../../../src/ui/theme.js";

// Simple theme without styling for testing
const testMarkdownTheme: MarkdownTheme = {
	heading: (text: string) => text,
	link: (text: string) => text,
	linkUrl: (text: string) => text,
	code: (text: string) => text,
	codeBlock: (text: string) => text,
	codeBlockBorder: (text: string) => text,
	quote: (text: string) => text,
	quoteBorder: (text: string) => text,
	hr: (text: string) => text,
	listBullet: (text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
};

const testMessageTheme: AssistantMessageTheme = {
	label: (text: string) => text,
	text: (text: string) => text,
};

describe("StreamingMessage", () => {
	it("starts in streaming mode", () => {
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
		});

		expect(msg.getIsStreaming()).toBe(true);
	});

	it("appends tokens during streaming", () => {
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
		});

		msg.appendToken("Hello ");
		msg.appendToken("world");

		expect(msg.getText()).toBe("Hello world");
	});

	it("renders content during streaming", () => {
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
		});

		msg.appendToken("Test content");
		const lines = msg.render(40);

		expect(lines.length).toBeGreaterThan(0);
		expect(lines.join("\n")).toContain("Test content");
	});

	it("ignores tokens after finalization and returns false", () => {
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
		});

		expect(msg.appendToken("Before ")).toBe(true);
		msg.finalize();
		expect(msg.appendToken("After")).toBe(false);

		expect(msg.getText()).toBe("Before ");
	});

	it("finalizes to markdown mode", () => {
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
		});

		msg.appendToken("Content");
		msg.finalize();

		expect(msg.getIsStreaming()).toBe(false);
	});

	it("renders with label when provided", () => {
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
			label: "Assistant",
		});

		msg.appendToken("Response");
		const lines = msg.render(40);

		expect(lines[0]).toContain("Assistant");
	});

	it("handles empty content gracefully", () => {
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
			label: "Assistant",
		});

		const lines = msg.render(40);
		// Should render without errors even with no content
		expect(lines.length).toBeGreaterThanOrEqual(0);
	});

	it("wraps text correctly with label (fixed first line width)", () => {
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
			label: "Assistant",
		});

		// Long text that needs wrapping
		const longText = "This is a long message that should wrap correctly accounting for label width";
		msg.setText(longText);
		const lines = msg.render(40);

		// All lines should fit within width
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(40);
		}
	});

	it("has consistent label position between streaming and finalized (fixed layout jump)", () => {
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
			label: "Assistant",
		});

		msg.appendToken("Test content");
		const streamingLines = msg.render(60);

		msg.finalize();
		const finalizedLines = msg.render(60);

		expect(streamingLines[0]).toContain("Assistant");
		expect(finalizedLines[0]).toContain("Assistant");
		expect(streamingLines.length).toBeGreaterThan(2);
		expect(finalizedLines.length).toBeGreaterThan(2);
	});

	it("resets to initial state", () => {
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
		});

		msg.appendToken("Content");
		msg.finalize();
		msg.reset();

		expect(msg.getText()).toBe("");
		expect(msg.getIsStreaming()).toBe(true);
	});

	it("setText works for non-streaming scenarios", () => {
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
		});

		msg.setText("Full message");
		expect(msg.getText()).toBe("Full message");
	});

	it("caches rendered output", () => {
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
		});

		msg.appendToken("Test");
		const lines1 = msg.render(40);
		const lines2 = msg.render(40);

		expect(lines1).toBe(lines2);
	});

	it("invalidates cache on new token", () => {
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
		});

		msg.appendToken("Test");
		const lines1 = msg.render(40);

		msg.appendToken(" more");
		const lines2 = msg.render(40);

		expect(lines1).not.toBe(lines2);
	});

	it("supports collapsible thinking blocks", () => {
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
			label: "Thinking",
			collapsible: true,
			collapsed: true,
			collapsedPreviewLines: 1,
		});

		msg.appendToken("Line one\nLine two\nLine three");
		let lines = msg.render(60);
		expect(lines[0]).toContain("[+]");
		expect(lines.join("\n")).toContain("Line one");

		msg.toggleCollapsed();
		lines = msg.render(60);
		expect(msg.getCollapsed()).toBe(false);
		expect(lines[0]).toContain("[-]");
		expect(lines.join("\n")).toContain("Line three");
	});

	it("calls onInvalidate callback on changes", () => {
		let callCount = 0;
		const msg = new StreamingMessage({
			markdownTheme: testMarkdownTheme,
			messageTheme: testMessageTheme,
			onInvalidate: () => {
				callCount++;
			},
		});

		msg.appendToken("a");
		msg.appendToken("b");
		msg.finalize();

		expect(callCount).toBe(3);
	});
});
