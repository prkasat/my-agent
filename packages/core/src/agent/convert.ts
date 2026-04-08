import type { Message } from "@my-agent/ai";
import type { AgentMessage } from "./types.js";
import { customMessageToLlm } from "./custom-messages.js";
import type { CustomMessage } from "./custom-messages.js";

/**
 * Convert AgentMessages to LLM-compatible Messages.
 *
 * Custom messages are either filtered out entirely or converted
 * via customMessageToLlm (e.g. compaction summaries become user messages).
 *
 * Contract (from Pi-Mono): MUST NOT throw.
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	const result: Message[] = [];

	for (const msg of messages) {
		if ("role" in msg && msg.role === "custom") {
			// Try converting custom message to LLM format
			const converted = customMessageToLlm(msg as CustomMessage);
			if (converted) {
				result.push(converted);
			}
			continue;
		}

		if ("role" in msg) {
			switch (msg.role) {
				case "user":
				case "assistant":
				case "toolResult":
					result.push(msg);
					break;
			}
		}
	}

	return result;
}
