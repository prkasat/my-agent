/**
 * Custom message types for internal agent state.
 *
 * All share role: "custom" — filtered out by convertToLlm.
 * Some are selectively sent to the LLM via customMessageToLlm.
 */

export interface BashExecutionMessage {
	role: "custom";
	type: "bash_execution";
	command: string;
	output: string;
	exitCode: number | null;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "custom";
	type: "compaction_summary";
	summary: string;
	tokensBefore: number;
	tokensAfter: number;
	timestamp: number;
	/**
	 * Cumulative `usage.cost` across every non-aborted/non-error
	 * assistant message that was folded into this compaction (plus
	 * any prior compaction's snapshot). Used by the cost tracker's
	 * `loadFromMessages` replay on resume so a hard
	 * `maxCostPerSession` cap survives session compaction. Optional
	 * for backward compat with summaries written before this field
	 * existed; readers MUST treat `undefined` as "unknown prior
	 * spend, don't seed". Codex budget-fix pass-4 finding.
	 */
	priorCumulativeCost?: number;
}

export interface BranchSummaryMessage {
	role: "custom";
	type: "branch_summary";
	summary: string;
	sourceSessionId: string;
	timestamp: number;
}

export interface ExtensionMessage {
	role: "custom";
	type: "extension";
	extensionName: string;
	content: string;
	sendToLlm?: boolean;
	timestamp: number;
}

export type CustomMessage = BashExecutionMessage | CompactionSummaryMessage | BranchSummaryMessage | ExtensionMessage;

/**
 * Convert a custom message to LLM-compatible format.
 * Returns null if the message should not be sent to the LLM.
 */
export function customMessageToLlm(msg: CustomMessage): { role: "user"; content: string } | null {
	if (msg.type === "extension" && msg.sendToLlm) {
		return { role: "user", content: msg.content };
	}

	if (msg.type === "compaction_summary") {
		return { role: "user", content: `[Previous conversation summary]\n${msg.summary}` };
	}

	if (msg.type === "branch_summary") {
		return { role: "user", content: `[Branch context]\n${msg.summary}` };
	}

	return null;
}
