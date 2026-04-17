/**
 * ToolDefinition — the full package for a tool, including UI metadata.
 * AgentTool (in agent/types.ts) — the minimal runtime contract.
 * wrapToolDefinition() bridges them.
 */

import type { ImageContent, TextContent } from "@my-agent/ai";
import type { Static, TSchema } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "../agent/types.js";

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
	name: string;
	label: string;
	description: string;
	/**
	 * Schema version for `parameters`. Required so every shipped tool
	 * carries an explicit baseline; mirrors `AgentTool.version` (which is
	 * optional only because not every external consumer of AgentTool
	 * sets it). Bump when changing the parameter shape in a
	 * backwards-incompatible way.
	 */
	version: number;
	/** One-liner injected into system prompt */
	promptSnippet?: string;
	/** Usage guidelines for the LLM */
	promptGuidelines?: string[];
	parameters: TParams;
	/** Transform raw args before validation (compat shim) */
	prepareArguments?: (raw: unknown) => Static<TParams>;
	/** Execute the tool */
	execute: (
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal,
		onUpdate?: (update: Partial<AgentToolResult<TDetails>>) => void,
	) => Promise<AgentToolResult<TDetails>>;
}

/** Strip UI metadata from a ToolDefinition to produce an AgentTool. */
export function wrapToolDefinition<TParams extends TSchema, TDetails = unknown>(
	def: ToolDefinition<TParams, TDetails>,
): AgentTool<TParams, TDetails> {
	return {
		name: def.name,
		description: def.description,
		parameters: def.parameters,
		version: def.version,
		prepareArguments: def.prepareArguments,
		execute: def.execute,
	};
}

/** Batch wrapper. */
export function wrapToolDefinitions(defs: ToolDefinition[]): AgentTool[] {
	return defs.map((d) => wrapToolDefinition(d));
}

/** Synthesize a minimal ToolDefinition from an AgentTool. */
export function createToolDefinitionFromAgentTool(tool: AgentTool): ToolDefinition {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		// Default to v1 when the source AgentTool didn't declare a version —
		// matches the documented "treat undefined as 1" reader contract.
		version: tool.version ?? 1,
		parameters: tool.parameters,
		prepareArguments: tool.prepareArguments,
		execute: tool.execute as ToolDefinition["execute"],
	};
}
