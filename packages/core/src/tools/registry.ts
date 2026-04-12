/**
 * Tool registry — factory functions for creating tool sets scoped to a working directory.
 */

import type { AgentTool } from "../agent/types.js";
import { type BashToolOptions, createBashToolDefinition } from "./bash.js";
import { createEditToolDefinition } from "./edit.js";
import { createFindToolDefinition } from "./find.js";
import { createGrepToolDefinition } from "./grep.js";
import { createLsToolDefinition } from "./ls.js";
import { type ReadToolOptions, createReadToolDefinition } from "./read.js";
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
