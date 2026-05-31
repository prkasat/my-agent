/**
 * ToolDefinition — the full package for a tool, including UI metadata.
 * AgentTool (in agent/types.ts) — the minimal runtime contract.
 * wrapToolDefinition() bridges them.
 */

import type { Static, TSchema } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "../agent/types.js";

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
	name: string;
	label: string;
	description: string;
	/**
	 * Schema version for `parameters`. Optional at the type boundary so
	 * external custom-tool authors aren't forced to set it on upgrade —
	 * `wrapToolDefinition` and `createToolDefinitionFromAgentTool`
	 * normalize a missing value to 1 (matching the documented "treat
	 * undefined as 1" reader contract). Bump when changing the parameter
	 * shape in a backwards-incompatible way (rename a field, drop a
	 * field, change a required type). Stable tweaks like description text
	 * or new optional fields don't require a bump. All shipped my-agent
	 * tools declare `version` explicitly.
	 */
	version?: number;
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
		// Default to v1 when the source ToolDefinition didn't declare a
		// version — matches the documented "treat undefined as 1" reader
		// contract and keeps the public surface non-breaking for external
		// custom-tool authors.
		version: def.version ?? 1,
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
