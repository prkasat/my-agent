/**
 * Shared truncation utilities for tool outputs.
 *
 * Two independent limits — whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Both head and tail truncation may return partial lines when a single line
 * exceeds the byte limit — this ensures the LLM always gets some content.
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500;

export interface TruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	/** Whether the first line in output was partially truncated (head truncation edge case) */
	firstLinePartial: boolean;
	/** Whether the last line in output was partially truncated (tail truncation edge case) */
	lastLinePartial: boolean;
	maxLines: number;
	maxBytes: number;
}

export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Keep first N lines/bytes. Used for file reads where you want the beginning.
 * May return a partial first line if the first line alone exceeds the byte limit.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			firstLinePartial: false,
			lastLinePartial: false,
			maxLines,
			maxBytes,
		};
	}

	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let firstLinePartial = false;

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0);
		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// Edge case: if we haven't added ANY lines yet and this line exceeds maxBytes,
			// take the start of the line (partial)
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromStart(lines[i], maxBytes);
				outputLinesArr.push(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				firstLinePartial = true;
			}
			break;
		}
		outputLinesArr.push(lines[i]);
		outputBytesCount += lineBytes;
	}

	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: Buffer.byteLength(outputContent, "utf-8"),
		firstLinePartial,
		lastLinePartial: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Keep last N lines/bytes. Used for bash output where the end (errors) matters most.
 * May return a partial first line if the last line alone exceeds the byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			firstLinePartial: false,
			lastLinePartial: false,
			maxLines,
			maxBytes,
		};
	}

	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);
		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			if (outputLinesArr.length === 0) {
				const truncated = truncateStringToBytesFromEnd(lines[i], maxBytes);
				outputLinesArr.unshift(truncated);
				outputBytesCount = Buffer.byteLength(truncated, "utf-8");
				lastLinePartial = true;
			}
			break;
		}
		outputLinesArr.unshift(lines[i]);
		outputBytesCount += lineBytes;
	}

	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: Buffer.byteLength(outputContent, "utf-8"),
		firstLinePartial: false,
		lastLinePartial,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate a string to fit within a byte limit (keep the start).
 * Handles multi-byte UTF-8 characters correctly.
 */
function truncateStringToBytesFromStart(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) return str;

	let end = maxBytes;
	// Back up to a valid UTF-8 boundary (avoid cutting in the middle of a multi-byte char)
	while (end > 0 && (buf[end] & 0xc0) === 0x80) {
		end--;
	}

	return buf.slice(0, end).toString("utf-8");
}

/**
 * Truncate a string to fit within a byte limit (keep the end).
 * Handles multi-byte UTF-8 characters correctly.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) return str;
	let start = buf.length - maxBytes;
	// Find valid UTF-8 boundary
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}
	return buf.slice(start).toString("utf-8");
}

/**
 * Truncate a single line to max characters. Used for grep match lines.
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) return { text: line, wasTruncated: false };
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
