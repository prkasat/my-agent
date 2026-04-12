import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { glob as nodeGlob } from "node:fs/promises";
import nodePath from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import type { AgentTool } from "../agent/types.js";
import { resolveToCwd } from "./path-utils.js";
import type { ToolDefinition } from "./tool-definition.js";
import { wrapToolDefinition } from "./tool-definition.js";
import { DEFAULT_MAX_BYTES, type TruncationResult, formatSize, truncateHead } from "./truncate.js";

function toPosixPath(value: string): string {
	return value.split(nodePath.sep).join("/");
}

const findSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts', '**/*.json'" }),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export type FindToolInput = Static<typeof findSchema>;
const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

export interface FindOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

export interface FindToolOptions {
	operations?: FindOperations;
}

function findFd(): string | null {
	try {
		return execSync("which fd", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim() || null;
	} catch {
		return null;
	}
}

async function findFilesWithNodeGlob(pattern: string, searchPath: string, limit: number): Promise<string[]> {
	const results: string[] = [];
	const IGNORED = new Set(["node_modules", ".git"]);
	for await (const entry of nodeGlob(pattern, { cwd: searchPath })) {
		// Skip paths containing ignored directory segments
		const parts = entry.split(nodePath.sep);
		if (parts.some((p) => IGNORED.has(p))) continue;
		results.push(nodePath.resolve(searchPath, entry));
		if (results.length >= limit) break;
	}
	return results;
}

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore when fd is available, otherwise skips node_modules and .git. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: "Find files by glob pattern (respects .gitignore)",
		parameters: findSchema,
		async execute(_toolCallId, { pattern, path: searchDir, limit }, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (limit !== undefined && (limit < 1 || !Number.isInteger(limit))) {
				throw new Error("limit must be a positive integer");
			}

			const searchPath = resolveToCwd(searchDir || ".", cwd);
			const effectiveLimit = limit ?? DEFAULT_LIMIT;

			// Use custom operations if provided
			if (customOps?.glob) {
				if (!(await customOps.exists(searchPath))) throw new Error(`Path not found: ${searchPath}`);

				const results = await customOps.glob(pattern, searchPath, {
					ignore: ["**/node_modules/**", "**/.git/**"],
					limit: effectiveLimit,
				});

				if (results.length === 0) {
					return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
				}

				return formatFindResults(results, searchPath, effectiveLimit);
			}

			// Try fd first, fall back to Node glob
			const fdPath = findFd();
			let rawLines: string[];

			if (fdPath) {
				const args: string[] = ["--glob", "--color=never", "--hidden", "--max-results", String(effectiveLimit)];
				// Use -- to prevent pattern from being interpreted as a flag
				args.push("--", pattern, searchPath);

				const result = spawnSync(fdPath, args, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
				if (result.error) throw new Error(`Failed to run fd: ${result.error.message}`);

				const output = result.stdout?.trim() || "";
				if (result.status !== 0 && !output) {
					const errorMsg = result.stderr?.trim() || `fd exited with code ${result.status}`;
					throw new Error(errorMsg);
				}
				if (!output) {
					return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
				}
				rawLines = output.split("\n");
			} else {
				// Fallback to Node glob
				const results = await findFilesWithNodeGlob(pattern, searchPath, effectiveLimit);
				if (results.length === 0) {
					return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
				}
				rawLines = results;
			}

			// Relativize paths
			const relativized: string[] = [];
			for (const rawLine of rawLines) {
				const line = rawLine.replace(/\r$/, "").trim();
				if (!line) continue;
				const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
				let relativePath = line.startsWith(searchPath)
					? line.slice(searchPath.length + 1)
					: nodePath.relative(searchPath, line);
				if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
				relativized.push(toPosixPath(relativePath));
			}

			return formatFindResults(relativized, searchPath, effectiveLimit);
		},
	};
}

function formatFindResults(
	results: string[],
	searchPath: string,
	effectiveLimit: number,
): { content: Array<{ type: "text"; text: string }>; details: FindToolDetails | undefined } {
	// Relativize if absolute
	const relativized = results.map((p) => {
		if (p.startsWith(searchPath)) return toPosixPath(p.slice(searchPath.length + 1));
		if (nodePath.isAbsolute(p)) return toPosixPath(nodePath.relative(searchPath, p));
		return toPosixPath(p);
	});

	const resultLimitReached = relativized.length >= effectiveLimit;
	const rawOutput = relativized.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: FindToolDetails = {};
	const notices: string[] = [];

	if (resultLimitReached) {
		notices.push(
			`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
		);
		details.resultLimitReached = effectiveLimit;
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
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
