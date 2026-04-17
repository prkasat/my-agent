import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ImageContent, TextContent } from "@my-agent/ai";
import { type Static, Type } from "@sinclair/typebox";
import type { AgentTool } from "../agent/types.js";
import { formatDimensionNote, resizeImage } from "./image-resize.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolDefinition } from "./tool-definition.js";
import { wrapToolDefinition } from "./tool-definition.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, formatSize, truncateHead } from "./truncate.js";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

export interface ReadOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type. Return null/undefined for non-images. */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

function detectImageMimeFromPath(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_EXTENSIONS[ext] ?? null;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: async (path) => detectImageMimeFromPath(path),
};

export interface ReadToolOptions {
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
	/** Whether to auto-resize images to fit within LLM limits. Default: true */
	autoResizeImages?: boolean;
}

function isBinaryBuffer(buffer: Buffer): boolean {
	const checkLength = Math.min(buffer.length, 512);
	for (let i = 0; i < checkLength; i++) {
		if (buffer[i] === 0) return true;
	}
	return false;
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const ops = options?.operations ?? defaultReadOperations;
	const autoResizeImages = options?.autoResizeImages ?? true;

	return {
		name: "read",
		label: "read",
		version: 1,
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments (auto-resized if needed). For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		parameters: readSchema,
		async execute(_toolCallId, { path, offset, limit }, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (offset !== undefined && (offset < 1 || !Number.isInteger(offset))) {
				throw new Error("offset must be a positive integer (1-indexed)");
			}
			if (limit !== undefined && (limit < 1 || !Number.isInteger(limit))) {
				throw new Error("limit must be a positive integer");
			}

			const absolutePath = resolveReadPath(path, cwd);
			await ops.access(absolutePath);

			if (signal?.aborted) throw new Error("Operation aborted");

			// Check for image files — return as ImageContent for multimodal LLMs
			const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : null;
			if (mimeType) {
				const buffer = await ops.readFile(absolutePath);
				const base64 = buffer.toString("base64");
				const base64Size = Buffer.byteLength(base64, "utf-8");

				// Default max size for inline images (4.5MB, below Anthropic's 5MB limit)
				const maxInlineSize = 4.5 * 1024 * 1024;

				if (autoResizeImages) {
					// Resize image if needed to fit within LLM limits
					const resized = await resizeImage({ type: "image", data: base64, mimeType });

					if (resized) {
						// Successfully resized (or no resize needed)
						const dimensionNote = formatDimensionNote(resized);
						let textNote = `Read image file [${resized.mimeType}]`;
						if (dimensionNote) textNote += `\n${dimensionNote}`;

						const content: (TextContent | ImageContent)[] = [
							{ type: "text", text: textNote },
							{ type: "image", data: resized.data, mimeType: resized.mimeType },
						];
						return { content, details: undefined };
					}

					// resizeImage returned null - either image library unavailable or truly too large
					// If image is small enough, send it anyway (library might just be unavailable)
					if (base64Size <= maxInlineSize) {
						const content: (TextContent | ImageContent)[] = [
							{ type: "text", text: `Read image file [${mimeType}]` },
							{ type: "image", data: base64, mimeType },
						];
						return { content, details: undefined };
					}

					// Image is too large and couldn't be resized
					const content: (TextContent | ImageContent)[] = [
						{
							type: "text",
							text: `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit (${formatSize(base64Size)} exceeds ${formatSize(maxInlineSize)}).]`,
						},
					];
					return { content, details: undefined };
				}

				// No resize - send as-is
				const content: (TextContent | ImageContent)[] = [
					{ type: "text", text: `Read image file [${mimeType}]` },
					{ type: "image", data: base64, mimeType },
				];
				return { content, details: undefined };
			}

			const buffer = await ops.readFile(absolutePath);

			if (isBinaryBuffer(buffer)) {
				return {
					content: [{ type: "text", text: `Binary file (${formatSize(buffer.length)})` }],
					details: undefined,
				};
			}

			const textContent = buffer.toString("utf-8");
			const allLines = textContent.split("\n");
			const totalFileLines = allLines.length;
			const startLine = offset ? Math.max(0, offset - 1) : 0;
			const startLineDisplay = startLine + 1;

			if (startLine >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
			}

			let selectedContent: string;
			let userLimitedLines: number | undefined;

			if (limit !== undefined) {
				const endLine = Math.min(startLine + limit, allLines.length);
				selectedContent = allLines.slice(startLine, endLine).join("\n");
				userLimitedLines = endLine - startLine;
			} else {
				selectedContent = allLines.slice(startLine).join("\n");
			}

			const truncation = truncateHead(selectedContent);
			let outputText: string;
			let details: ReadToolDetails | undefined;

			if (truncation.truncated) {
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;
				outputText = truncation.content;

				if (truncation.firstLinePartial) {
					// First line was too large — we got partial content from its start
					const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
					outputText += `\n\n[Line ${startLineDisplay} is ${firstLineSize}, showing first ${formatSize(truncation.outputBytes)}. Use bash for full line: sed -n '${startLineDisplay}p' ${path}]`;
				} else if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
				}
				details = { truncation };
			} else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
				const remaining = allLines.length - (startLine + userLimitedLines);
				const nextOffset = startLine + userLimitedLines + 1;
				outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			} else {
				outputText = truncation.content;
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
