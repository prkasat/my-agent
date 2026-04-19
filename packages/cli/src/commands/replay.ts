import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function replayFile(filePath: string): Promise<string> {
	const absolute = path.resolve(filePath);
	const content = await fs.readFile(absolute, "utf-8");
	const lines = content.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0) {
		throw new Error(`Replay file is empty: ${absolute}`);
	}

	const first = JSON.parse(lines[0]) as Record<string, unknown>;
	if (typeof first.scope === "string" && typeof first.type === "string") {
		return renderTraceReplay(lines);
	}
	if (first.type === "session") {
		return renderSessionReplay(lines);
	}

	throw new Error(`Unrecognized replay file format: ${absolute}`);
}

function renderTraceReplay(lines: string[]): string {
	const out = ["Trace replay:"];
	for (const line of lines) {
		const event = JSON.parse(line) as {
			timestamp?: string;
			scope?: string;
			type?: string;
			data?: Record<string, unknown>;
		};
		const summary = summarizeData(event.data);
		out.push(
			`  [${event.timestamp ?? "unknown"}] ${event.scope ?? "?"}.${event.type ?? "?"}${summary ? ` - ${summary}` : ""}`,
		);
	}
	return out.join("\n");
}

function renderSessionReplay(lines: string[]): string {
	const out = ["Session replay:"];
	for (const line of lines) {
		const entry = JSON.parse(line) as Record<string, unknown>;
		if (entry.type === "session") {
			out.push(`  session ${String(entry.id ?? "unknown")} cwd=${String(entry.cwd ?? "")}`);
			continue;
		}
		if (entry.type !== "message") continue;

		const message = entry.message as Record<string, unknown> | undefined;
		if (!message || typeof message.role !== "string") continue;

		if (message.role === "user") {
			out.push(`  user: ${stringifyContent(message.content)}`);
		} else if (message.role === "assistant") {
			out.push(`  assistant: ${stringifyContent(message.content)}`);
		} else if (message.role === "toolResult") {
			out.push(`  toolResult ${String(message.toolName ?? "unknown")}: ${stringifyContent(message.content)}`);
		}
	}
	return out.join("\n");
}

function summarizeData(data: Record<string, unknown> | undefined): string {
	if (!data) return "";
	const preferredKeys = [
		"requestId",
		"toolName",
		"sessionId",
		"configuredModel",
		"resolvedModel",
		"provider",
		"action",
		"error",
	];
	const parts = preferredKeys.filter((key) => key in data).map((key) => `${key}=${JSON.stringify(data[key])}`);
	return parts.join(" ");
}

function stringifyContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (!item || typeof item !== "object") return JSON.stringify(item);
				const block = item as Record<string, unknown>;
				if (typeof block.text === "string") return block.text;
				if (typeof block.name === "string") return `[tool:${block.name}]`;
				return JSON.stringify(block);
			})
			.join(" ");
	}
	return JSON.stringify(content);
}
