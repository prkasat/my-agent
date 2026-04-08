/**
 * Generate a unified diff between old and new content.
 * Used by the edit tool to show what changed.
 */

export interface DiffResult {
	diff: string;
	firstChangedLine: number;
	linesAdded: number;
	linesRemoved: number;
}

export function computeDiff(oldContent: string, newContent: string, contextLines = 4): DiffResult {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");

	// Find first and last changed lines
	let firstDiff = 0;
	while (firstDiff < oldLines.length && firstDiff < newLines.length && oldLines[firstDiff] === newLines[firstDiff]) {
		firstDiff++;
	}

	let lastOldDiff = oldLines.length - 1;
	let lastNewDiff = newLines.length - 1;
	while (
		lastOldDiff > firstDiff &&
		lastNewDiff > firstDiff &&
		oldLines[lastOldDiff] === newLines[lastNewDiff]
	) {
		lastOldDiff--;
		lastNewDiff--;
	}

	// Build diff output with context
	const startLine = Math.max(0, firstDiff - contextLines);
	const endOldLine = Math.min(oldLines.length - 1, lastOldDiff + contextLines);
	const padWidth = Math.max(String(endOldLine + 1).length, String(lastNewDiff + 1).length);

	const diffLines: string[] = [];

	// Context before
	for (let i = startLine; i < firstDiff; i++) {
		diffLines.push(` ${pad(i + 1, padWidth)} ${oldLines[i]}`);
	}

	// Removed lines
	for (let i = firstDiff; i <= lastOldDiff; i++) {
		diffLines.push(`-${pad(i + 1, padWidth)} ${oldLines[i]}`);
	}

	// Added lines
	for (let i = firstDiff; i <= lastNewDiff; i++) {
		diffLines.push(`+${pad(i + 1, padWidth)} ${newLines[i]}`);
	}

	// Context after
	const afterStart = lastOldDiff + 1;
	const afterEnd = Math.min(oldLines.length - 1, afterStart + contextLines - 1);
	for (let i = afterStart; i <= afterEnd; i++) {
		if (oldLines[i] !== undefined) {
			diffLines.push(` ${pad(i + 1, padWidth)} ${oldLines[i]}`);
		}
	}

	return {
		diff: diffLines.join("\n"),
		firstChangedLine: firstDiff + 1,
		linesAdded: lastNewDiff - firstDiff + 1,
		linesRemoved: lastOldDiff - firstDiff + 1,
	};
}

function pad(n: number, width: number): string {
	return String(n).padStart(width);
}
