/**
 * Tool registry — factory functions for creating tool sets scoped to a working directory.
 */

import type { AgentTool } from "../agent/types.js";
import { type BashToolOptions, createBashToolDefinition } from "./bash.js";
import { createEditToolDefinition } from "./edit.js";
import { createFindToolDefinition } from "./find.js";
import { createGrepToolDefinition } from "./grep.js";
import { createLsToolDefinition } from "./ls.js";
import { createReadToolDefinition, type ReadToolOptions } from "./read.js";
import type { ToolDefinition } from "./tool-definition.js";
import { wrapToolDefinition } from "./tool-definition.js";
import { createWriteToolDefinition } from "./write.js";

export type ToolDef = ToolDefinition<any, any>;
export type Tool = AgentTool<any, any>;
export type ToolName = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls";

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		write: createWriteToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		bash: createBashToolDefinition(cwd, options?.bash),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
	};
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const defs = createAllToolDefinitions(cwd, options);
	const result: Record<string, Tool> = {};
	for (const [name, def] of Object.entries(defs)) {
		result[name] = wrapToolDefinition(def);
	}
	return result as Record<ToolName, Tool>;
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd),
	];
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return createCodingToolDefinitions(cwd, options).map(wrapToolDefinition);
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return createReadOnlyToolDefinitions(cwd, options).map(wrapToolDefinition);
}

/**
 * Snapshot of every shipped tool's current schema version.
 *
 * The session file records each tool call with its arguments at the
 * version that produced them. When a tool's schema changes in a
 * backwards-incompatible way (rename a field, drop a field, change a
 * required type), bump that tool's `version` AND register an args
 * migrator. Reading an old session entry would then key off the
 * stored `toolVersion` to translate the args before re-executing or
 * re-displaying.
 *
 * Today every tool is at v1 and there is no migration framework yet —
 * this is the baseline so future bumps have a "from" to migrate from.
 *
 * The snapshot is built from the same factory the agent uses, with a
 * throwaway cwd, so it can never drift from the actual shipped
 * versions. If you add a tool, add it to createAllToolDefinitions and
 * this function automatically picks it up.
 */
export function getToolVersions(): Record<ToolName, number> {
	const defs = createAllToolDefinitions("/");
	const out: Record<string, number> = {};
	for (const [name, def] of Object.entries(defs)) {
		// Tool definition `version` is optional at the type boundary;
		// treat undefined as 1 per the reader contract. Every shipped
		// tool sets it explicitly, so this branch only fires for hand-
		// rolled definitions that omitted it.
		out[name] = def.version ?? 1;
	}
	return out as Record<ToolName, number>;
}
