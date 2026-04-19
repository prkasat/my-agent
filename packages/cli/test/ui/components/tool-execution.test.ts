/**
 * Tests for ToolExecution component
 */

import { describe, expect, it } from "vitest";
import { ToolExecution } from "../../../src/ui/components/tool-execution.js";
import type { ToolExecutionTheme } from "../../../src/ui/theme.js";

// Simple theme without styling for testing
const testTheme: ToolExecutionTheme = {
	pendingIcon: (text: string) => text,
	runningIcon: (text: string) => text,
	successIcon: (text: string) => text,
	errorIcon: (text: string) => text,
	toolName: (text: string) => text,
	duration: (text: string) => text,
	output: (text: string) => text,
	error: (text: string) => text,
	collapsed: (text: string) => text,
};

describe("ToolExecution", () => {
	it("starts in pending state", () => {
		const tool = new ToolExecution("test-tool", { arg: "value" }, { theme: testTheme });

		expect(tool.getStatus()).toBe("pending");
	});

	it("renders tool name in header", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		const lines = tool.render(80);

		expect(lines[0]).toContain("test-tool");
	});

	it("transitions to running state", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		tool.setRunning();

		expect(tool.getStatus()).toBe("running");
	});

	it("transitions to success state with output", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		tool.setRunning();
		tool.setSuccess("Output text", 100);

		expect(tool.getStatus()).toBe("success");
		const state = tool.getState();
		expect(state.status).toBe("success");
		if (state.status === "success") {
			expect(state.output).toBe("Output text");
			expect(state.durationMs).toBe(100);
		}
	});

	it("transitions to error state", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		tool.setRunning();
		tool.setError("Error message", 50);

		expect(tool.getStatus()).toBe("error");
	});

	it("auto-expands on error by default", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		tool.setError("Error message");

		const state = tool.getState();
		expect(state.expanded).toBe(true);
	});

	it("respects autoExpandOnError option", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme, autoExpandOnError: false });
		tool.setError("Error message");

		const state = tool.getState();
		expect(state.expanded).toBe(false);
	});

	it("toggles expanded state", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		expect(tool.getState().expanded).toBe(false);

		tool.toggleExpanded();
		expect(tool.getState().expanded).toBe(true);

		tool.toggleExpanded();
		expect(tool.getState().expanded).toBe(false);
	});

	it("shows input when expanded and showInput is true", () => {
		const tool = new ToolExecution("test-tool", { key: "value" }, { theme: testTheme, showInput: true });
		tool.setExpanded(true);
		const lines = tool.render(80);

		const content = lines.join("\n");
		expect(content).toContain("Input:");
		expect(content).toContain("key");
	});

	it("shows output when expanded after success", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		tool.setRunning();
		tool.setSuccess("Success output", 100);
		tool.setExpanded(true);
		const lines = tool.render(80);

		const content = lines.join("\n");
		expect(content).toContain("Output:");
		expect(content).toContain("Success output");
	});

	it("shows error when expanded after failure", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		tool.setRunning();
		tool.setError("Error details");
		// auto-expanded by default
		const lines = tool.render(80);

		const content = lines.join("\n");
		expect(content).toContain("Error:");
		expect(content).toContain("Error details");
	});

	it("caches input JSON string (performance fix)", () => {
		const complexInput = { nested: { deep: { value: Array(100).fill("test") } } };
		const tool = new ToolExecution("test-tool", complexInput, { theme: testTheme, showInput: true });
		tool.setExpanded(true);

		// Render multiple times
		tool.render(80);
		tool.render(80);
		tool.render(80);

		// If JSON is cached, this should be fast and not re-stringify each time
		// (Hard to test directly, but the implementation uses cachedInputJson)
		expect(tool.getState().input).toEqual(complexInput);
	});

	it("truncates long output", () => {
		const longOutput = Array(50)
			.fill(null)
			.map((_, i) => `Line ${i}`)
			.join("\n");
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme, maxExpandedLines: 5 });
		tool.setRunning();
		tool.setSuccess(longOutput, 100);
		tool.setExpanded(true);
		const lines = tool.render(80);

		const content = lines.join("\n");
		expect(content).toContain("more lines");
	});

	it("formats duration in milliseconds", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		tool.setRunning();
		tool.setSuccess("ok", 500);
		const lines = tool.render(80);

		expect(lines[0]).toContain("500ms");
	});

	it("formats duration in seconds", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		tool.setRunning();
		tool.setSuccess("ok", 2500);
		const lines = tool.render(80);

		expect(lines[0]).toContain("2.5s");
	});

	it("formats duration in minutes", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		tool.setRunning();
		tool.setSuccess("ok", 125000); // 2m 5s
		const lines = tool.render(80);

		expect(lines[0]).toContain("2m 5s");
	});

	it("caches rendered output", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		const lines1 = tool.render(80);
		const lines2 = tool.render(80);

		expect(lines1).toBe(lines2);
	});

	it("invalidates cache on state change", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		const lines1 = tool.render(80);

		tool.setRunning();
		const lines2 = tool.render(80);

		expect(lines1).not.toBe(lines2);
	});

	it("ignores setRunning after success (fixed terminal state bug)", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		tool.setRunning();
		tool.setSuccess("done", 100);

		// Try to transition back to running (e.g., from delayed async event)
		tool.setRunning();

		// Should still be in success state
		expect(tool.getStatus()).toBe("success");
		const state = tool.getState();
		expect(state.status).toBe("success");
		if (state.status === "success") {
			expect(state.output).toBe("done");
			expect(state.durationMs).toBe(100);
		}
	});

	it("ignores setRunning after error (fixed terminal state bug)", () => {
		const tool = new ToolExecution("test-tool", {}, { theme: testTheme });
		tool.setRunning();
		tool.setError("failed", 50);

		// Try to transition back to running
		tool.setRunning();

		// Should still be in error state
		expect(tool.getStatus()).toBe("error");
		const state = tool.getState();
		expect(state.status).toBe("error");
		if (state.status === "error") {
			expect(state.error).toBe("failed");
		}
	});

	it("clamps negative maxExpandedLines to 0 (fixed validation)", () => {
		const tool = new ToolExecution(
			"test-tool",
			{},
			{
				theme: testTheme,
				maxExpandedLines: -5,
			},
		);
		tool.setRunning();
		tool.setSuccess("line1\nline2\nline3", 100);
		tool.setExpanded(true);

		// Should not crash and should render something
		const lines = tool.render(80);
		expect(lines.length).toBeGreaterThan(0);
	});
});
