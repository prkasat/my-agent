/**
 * Tests for DiffViewer component and parsing
 */

import { describe, it, expect } from "vitest";
import { DiffViewer, MultiDiffViewer, parseDiff, parseMultiDiff, type DiffData } from "../../../src/ui/components/diff-viewer.js";
import type { DiffViewerTheme } from "../../../src/ui/theme.js";

// Simple theme without styling for testing
const testTheme: DiffViewerTheme = {
	added: (text: string) => text,
	removed: (text: string) => text,
	context: (text: string) => text,
	header: (text: string) => text,
	lineNumber: (text: string) => text,
	hunkHeader: (text: string) => text,
};

const sampleDiff: DiffData = {
	oldPath: "file.txt",
	newPath: "file.txt",
	hunks: [
		{
			oldStart: 1,
			oldLines: 3,
			newStart: 1,
			newLines: 4,
			lines: [" context line", "-removed line", "+added line 1", "+added line 2", " more context"],
		},
	],
};

describe("DiffViewer", () => {
	it("renders diff with header", () => {
		const viewer = new DiffViewer(sampleDiff, { theme: testTheme });
		const lines = viewer.render(80);

		expect(lines.length).toBeGreaterThan(0);
		expect(lines[0]).toContain("file.txt");
	});

	it("shows hunk header", () => {
		const viewer = new DiffViewer(sampleDiff, { theme: testTheme });
		const lines = viewer.render(80);

		const hasHunkHeader = lines.some((line) => line.includes("@@"));
		expect(hasHunkHeader).toBe(true);
	});

	it("renders added and removed lines", () => {
		const viewer = new DiffViewer(sampleDiff, { theme: testTheme });
		const lines = viewer.render(80);

		const content = lines.join("\n");
		expect(content).toContain("+added line");
		expect(content).toContain("-removed line");
	});

	it("shows collapsed indicator when collapsed", () => {
		const viewer = new DiffViewer(sampleDiff, { theme: testTheme, collapsed: true });
		const lines = viewer.render(80);

		// Collapsed shows header + summary
		expect(lines.length).toBe(2);
		// Should show change counts
		const content = lines.join("\n");
		expect(content).toContain("+");
	});

	it("toggles collapsed state", () => {
		const viewer = new DiffViewer(sampleDiff, { theme: testTheme, collapsed: false });
		expect(viewer.isCollapsed()).toBe(false);

		viewer.toggleCollapsed();
		expect(viewer.isCollapsed()).toBe(true);

		const lines = viewer.render(80);
		expect(lines.length).toBe(2); // Collapsed
	});

	it("caches rendered output", () => {
		const viewer = new DiffViewer(sampleDiff, { theme: testTheme });
		const lines1 = viewer.render(80);
		const lines2 = viewer.render(80);

		expect(lines1).toBe(lines2);
	});

	it("limits lines per hunk", () => {
		const largeDiff: DiffData = {
			oldPath: "file.txt",
			newPath: "file.txt",
			hunks: [
				{
					oldStart: 1,
					oldLines: 20,
					newStart: 1,
					newLines: 20,
					lines: Array(20)
						.fill(null)
						.map((_, i) => ` line ${i}`),
				},
			],
		};

		const viewer = new DiffViewer(largeDiff, { theme: testTheme, maxLinesPerHunk: 5 });
		const lines = viewer.render(80);

		const content = lines.join("\n");
		expect(content).toContain("more lines");
	});

	it("calculates line number width based on last displayed line, not exclusive end", () => {
		// Hunk starting at line 9999 with 1 line should use width for 9999, not 10000
		const highLineNumDiff: DiffData = {
			oldPath: "file.txt",
			newPath: "file.txt",
			hunks: [
				{
					oldStart: 9999,
					oldLines: 1,
					newStart: 9999,
					newLines: 1,
					lines: [" line 9999"],
				},
			],
		};

		const viewer = new DiffViewer(highLineNumDiff, { theme: testTheme });
		const lines = viewer.render(80);

		// Line numbers should fit within 4 chars (9999), not 5 (10000)
		// The output should contain "9999" but not be padded for 5-digit numbers
		const content = lines.join("\n");
		expect(content).toContain("9999");
		// Verify the line number column isn't unnecessarily wide
		// With min width of 4, 9999 should fit exactly
		expect(content).not.toContain("     9999"); // No 5-char padding
	});
});

describe("parseDiff", () => {
	it("parses simple unified diff", () => {
		const diffText = `--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 context
-removed
+added 1
+added 2
 context`;

		const result = parseDiff(diffText);

		expect(result.oldPath).toBe("file.txt");
		expect(result.newPath).toBe("file.txt");
		expect(result.hunks.length).toBe(1);
		expect(result.hunks[0].lines.length).toBe(5);
	});

	it("skips completely empty lines (fixed bug)", () => {
		const diffText = `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 context

-removed
+added`;

		const result = parseDiff(diffText);
		// The empty line between context and -removed should be skipped
		// Only actual diff lines should be counted
		const hunk = result.hunks[0];
		expect(hunk.lines).not.toContain(" "); // No phantom context from empty line
		expect(hunk.lines.length).toBe(3); // context, -removed, +added
	});

	it("handles diff with explicit space prefix context", () => {
		const diffText = `--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line 1
 line 2
 line 3`;

		const result = parseDiff(diffText);
		expect(result.hunks[0].lines.length).toBe(3);
		// All should start with space (context)
		result.hunks[0].lines.forEach((line) => {
			expect(line.startsWith(" ")).toBe(true);
		});
	});

	it("parses hunk header with optional line counts", () => {
		// Single line hunks can omit the line count
		const diffText = `--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-old
+new`;

		const result = parseDiff(diffText);
		const hunk = result.hunks[0];
		expect(hunk.oldStart).toBe(1);
		expect(hunk.oldLines).toBe(1);
		expect(hunk.newStart).toBe(1);
		expect(hunk.newLines).toBe(1);
	});

	it("returns empty diff for invalid input", () => {
		const result = parseDiff("not a diff");
		expect(result.hunks.length).toBe(0);
	});
});

describe("parseMultiDiff", () => {
	it("parses multiple file diffs", () => {
		const diffText = `--- a/file1.txt
+++ b/file1.txt
@@ -1,2 +1,2 @@
-old1
+new1
--- a/file2.txt
+++ b/file2.txt
@@ -1,2 +1,2 @@
-old2
+new2`;

		const results = parseMultiDiff(diffText);

		expect(results.length).toBe(2);
		expect(results[0].newPath).toBe("file1.txt");
		expect(results[1].newPath).toBe("file2.txt");
	});

	it("handles file rename", () => {
		const diffText = `--- a/old-name.txt
+++ b/new-name.txt
@@ -1 +1 @@
 content`;

		const results = parseMultiDiff(diffText);

		expect(results[0].oldPath).toBe("old-name.txt");
		expect(results[0].newPath).toBe("new-name.txt");
	});

	it("handles literal --- in diff content", () => {
		// This tests the fix for the header parsing bug
		const diffText = `--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 normal line
-removed --- with dashes
+added line`;

		const results = parseMultiDiff(diffText);

		expect(results.length).toBe(1);
		expect(results[0].hunks[0].lines.length).toBe(3);
		expect(results[0].hunks[0].lines[1]).toBe("-removed --- with dashes");
	});

	it("strips timestamp suffix from file headers (fixed bug)", () => {
		// Standard unified diff format includes timestamps after a tab
		const diffText = `--- a/file.txt\t2026-04-14 10:00:00.000000000 +0000
+++ b/file.txt\t2026-04-14 10:05:00.000000000 +0000
@@ -1 +1 @@
-old
+new`;

		const results = parseMultiDiff(diffText);

		expect(results.length).toBe(1);
		expect(results[0].oldPath).toBe("file.txt");
		expect(results[0].newPath).toBe("file.txt");
		// Should not include the timestamp in the path
		expect(results[0].oldPath).not.toContain("2026");
	});

	it("parses binary file diffs (fixed - previously dropped)", () => {
		const diffText = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ`;

		const results = parseMultiDiff(diffText);

		expect(results.length).toBe(1);
		expect(results[0].oldPath).toBe("image.png");
		expect(results[0].newPath).toBe("image.png");
		expect(results[0].hunks.length).toBe(1);
		expect(results[0].hunks[0].lines[0]).toContain("Binary file");
	});

	it("parses new binary file diff", () => {
		const diffText = `diff --git a/new.png b/new.png
Binary files /dev/null and b/new.png differ`;

		const results = parseMultiDiff(diffText);

		expect(results.length).toBe(1);
		expect(results[0].newPath).toBe("new.png");
	});
});

describe("MultiDiffViewer", () => {
	const multiDiffData: DiffData[] = [
		{
			oldPath: "file1.txt",
			newPath: "file1.txt",
			hunks: [
				{
					oldStart: 1,
					oldLines: 2,
					newStart: 1,
					newLines: 2,
					lines: ["-old1", "+new1"],
				},
			],
		},
		{
			oldPath: "file2.txt",
			newPath: "file2.txt",
			hunks: [
				{
					oldStart: 1,
					oldLines: 2,
					newStart: 1,
					newLines: 2,
					lines: ["-old2", "+new2"],
				},
			],
		},
	];

	it("renders multiple files", () => {
		const viewer = new MultiDiffViewer(multiDiffData, { theme: testTheme });
		const lines = viewer.render(80);

		const content = lines.join("\n");
		expect(content).toContain("file1.txt");
		expect(content).toContain("file2.txt");
	});

	it("accepts MultiDiffData format", () => {
		const viewer = new MultiDiffViewer({ files: multiDiffData }, { theme: testTheme });
		const diffs = viewer.getDiffs();

		expect(diffs.length).toBe(2);
	});

	it("collapses all files", () => {
		const viewer = new MultiDiffViewer(multiDiffData, { theme: testTheme });

		viewer.setAllCollapsed(true);
		const collapsedLines = viewer.render(80);

		// Collapsed view should be shorter
		viewer.setAllCollapsed(false);
		const expandedLines = viewer.render(80);

		expect(collapsedLines.length).toBeLessThan(expandedLines.length);
	});

	it("preserves collapsed state on setDiffs (fixed bug)", () => {
		const viewer = new MultiDiffViewer(multiDiffData, { theme: testTheme });

		viewer.setAllCollapsed(true);
		const collapsedLines1 = viewer.render(80);

		// setDiffs should preserve the collapsed state
		viewer.setDiffs(multiDiffData);
		const collapsedLines2 = viewer.render(80);

		// Lines should be same length since collapsed state is preserved
		expect(collapsedLines1.length).toBe(collapsedLines2.length);
	});

	it("caches rendered output", () => {
		const viewer = new MultiDiffViewer(multiDiffData, { theme: testTheme });
		const lines1 = viewer.render(80);
		const lines2 = viewer.render(80);

		expect(lines1).toBe(lines2);
	});

	it("invalidates cache on setDiffs", () => {
		const viewer = new MultiDiffViewer(multiDiffData, { theme: testTheme });
		const lines1 = viewer.render(80);

		viewer.setDiffs([multiDiffData[0]]);
		const lines2 = viewer.render(80);

		expect(lines1).not.toBe(lines2);
		expect(lines2.join("\n")).not.toContain("file2.txt");
	});
});
