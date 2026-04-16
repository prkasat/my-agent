import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { type Static, Type } from "@sinclair/typebox";
import type { AgentTool } from "../agent/types.js";
import {
	type Edit,
	applyEditsToNormalizedContent,
	detectLineEnding,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.js";
import { withFileMutationLock } from "./file-mutation-queue.js";
import { resolveAndValidatePath } from "./path-utils.js";
import type { ToolDefinition } from "./tool-definition.js";
import { wrapToolDefinition } from "./tool-definition.js";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. Must be unique in the original file and must not overlap with other edits.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{ additionalProperties: false },
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits.",
		}),
	},
	{ additionalProperties: false },
);

export type EditToolInput = Static<typeof editSchema>;

type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

export interface EditToolDetails {
	diff: string;
	firstChangedLine?: number;
}

export interface EditOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	operations?: EditOperations;
}

/**
 * Accept both the new `edits[]` format and a legacy `{oldText, newText}` format.
 * Merges legacy fields into the edits array if present.
 */
function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") return input as EditToolInput;
	const args = input as LegacyEditToolInput;
	if (typeof args.oldText !== "string" || typeof args.newText !== "string") return input as EditToolInput;

	const edits = Array.isArray(args.edits) ? [...args.edits] : [];
	edits.push({ oldText: args.oldText, newText: args.newText });
	const { oldText: _o, newText: _n, ...rest } = args;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block, merge them into one edit.",
		promptSnippet: "Make precise file edits with exact text replacement",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple locations in one file, use one edit call with multiple entries in edits[]",
			"Each edits[].oldText is matched against the original file, not after earlier edits. Do not emit overlapping edits.",
			"Keep edits[].oldText as small as possible while still being unique.",
		],
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input, signal) {
			const { path, edits } = validateEditInput(input);
			const absolutePath = resolveAndValidatePath(path, cwd);

			return withFileMutationLock(
				absolutePath,
				async () => {
					if (signal?.aborted) throw new Error("Operation aborted");

					try {
						await ops.access(absolutePath);
					} catch {
						throw new Error(`File not found: ${path}`);
					}

					if (signal?.aborted) throw new Error("Operation aborted");

					const buffer = await ops.readFile(absolutePath);
					const rawContent = buffer.toString("utf-8");

					if (signal?.aborted) throw new Error("Operation aborted");

					const { bom, text: content } = stripBom(rawContent);
					const originalEnding = detectLineEnding(content);
					const normalizedContent = normalizeToLF(content);
					const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

					if (signal?.aborted) throw new Error("Operation aborted");

					const finalContent = bom + restoreLineEndings(newContent, originalEnding);
					await ops.writeFile(absolutePath, finalContent);

					const diffResult = generateDiffString(baseContent, newContent);
					return {
						content: [{ type: "text" as const, text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
						details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
					};
				},
				{ signal },
			);
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
