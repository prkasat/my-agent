import { existsSync, readdirSync, statSync } from "node:fs";
import nodePath from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import type { AgentTool } from "../agent/types.js";
import { resolveAndValidatePath } from "./path-utils.js";
import type { ToolDefinition } from "./tool-definition.js";
import { wrapToolDefinition } from "./tool-definition.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

export type LsToolInput = Static<typeof lsSchema>;
const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

export interface LsOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
	exists: existsSync,
	stat: statSync,
	readdir: readdirSync,
};

export interface LsToolOptions {
	operations?: LsOperations;
}

export function createLsToolDefinition(
	cwd: string,
	options?: LsToolOptions,
): ToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
	const ops = options?.operations ?? defaultLsOperations;
	return {
		name: "ls",
		label: "ls",
		version: 1,
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: "List directory contents",
		parameters: lsSchema,
		async execute(_toolCallId, { path, limit }, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");

			if (limit !== undefined && (limit < 1 || !Number.isInteger(limit))) {
				throw new Error("limit must be a positive integer");
			}

			const dirPath = resolveAndValidatePath(path || ".", cwd);
			const effectiveLimit = limit ?? DEFAULT_LIMIT;

			if (!(await ops.exists(dirPath))) throw new Error(`Path not found: ${dirPath}`);

			const stat = await ops.stat(dirPath);
			if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

			let entries: string[];
			try {
				entries = await ops.readdir(dirPath);
			} catch (e: any) {
				throw new Error(`Cannot read directory: ${e.message}`);
			}

			// Sort alphabetically, case-insensitive
			entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

			const results: string[] = [];
			let entryLimitReached = false;

			for (const entry of entries) {
				if (results.length >= effectiveLimit) {
					entryLimitReached = true;
					break;
				}
				const fullPath = nodePath.join(dirPath, entry);
				let suffix = "";
				try {
					const entryStat = await ops.stat(fullPath);
					if (entryStat.isDirectory()) suffix = "/";
				} catch {
					continue;
				}
				results.push(entry + suffix);
			}

			if (results.length === 0) {
				return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
			}

			const rawOutput = results.join("\n");
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: LsToolDetails = {};
			const notices: string[] = [];

			if (entryLimitReached) {
				notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
				details.entryLimitReached = effectiveLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

			return {
				content: [{ type: "text", text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
	};
}

export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	return wrapToolDefinition(createLsToolDefinition(cwd, options));
}
