import * as fs from "node:fs/promises";
import type { AgentMessage, SessionEntry, SessionHeader, SessionManager } from "@my-agent/core";

/**
 * Export a session to a standalone HTML file.
 *
 * The result is a single .html file that works offline.
 */

export interface ExportOptions {
	entries: SessionEntry[];
	header: SessionHeader;
	outputPath: string;
}

export async function exportSessionToHtml(options: ExportOptions): Promise<void> {
	const { entries, header, outputPath } = options;

	const messages = entries
		.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message")
		.map((e) => e.message);

	const html = buildExportHtml(messages, header);
	await fs.writeFile(outputPath, html, "utf-8");
}

export async function exportFromSessionManager(sessionManager: SessionManager, outputPath: string): Promise<void> {
	const entries = sessionManager.getEntries();
	const header = sessionManager.getHeader();

	if (!header) {
		throw new Error("Session has no header");
	}

	await exportSessionToHtml({ entries, header, outputPath });
}

function buildExportHtml(messages: AgentMessage[], header: SessionHeader): string {
	const messageHtml = messages.map(renderMessage).join("\n");
	const createdAt = new Date(header.timestamp).getTime();

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Session ${header.id.substring(0, 8)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0d1117; color: #c9d1d9; max-width: 900px; margin: 0 auto; padding: 2rem; }
    .message { margin: 1rem 0; padding: 1rem 1.5rem; border-radius: 12px; }
    .user { background: #1c2128; border-left: 3px solid #58a6ff; }
    .assistant { background: #161b22; border-left: 3px solid #3fb950; }
    .tool-result { background: #1c2128; border-left: 3px solid #d29922; font-size: 0.9em; }
    .role { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; color: #8b949e; margin-bottom: 0.5rem; }
    pre { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 1rem; overflow-x: auto; font-size: 0.85rem; margin: 0.5rem 0; white-space: pre-wrap; }
    code { font-family: 'SF Mono', 'Fira Code', monospace; }
    .header { text-align: center; padding: 2rem 0; border-bottom: 1px solid #30363d; margin-bottom: 2rem; }
    .header h1 { font-size: 1.5rem; color: #58a6ff; }
    .header p { color: #8b949e; font-size: 0.85rem; margin-top: 0.5rem; }
    .tool-name { color: #d29922; font-weight: 600; }
    .error { border-left-color: #f85149; }
    .error .role { color: #f85149; }
    .content { white-space: pre-wrap; word-wrap: break-word; }
    details { margin: 0.5rem 0; }
    summary { cursor: pointer; color: #8b949e; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Agent Session</h1>
    <p>Session ${header.id.substring(0, 8)} | ${new Date(createdAt).toLocaleString()}</p>
    <div style="color:#8b949e;font-size:0.8em;margin-top:1em;">
      Exported: ${new Date().toISOString()}<br>
      Working directory: ${header.cwd}<br>
      Messages: ${messages.length}
    </div>
  </div>
  ${messageHtml}
  <script>
    document.querySelectorAll('.content').forEach(el => {
      el.innerHTML = el.innerHTML.replace(/\`\`\`(\\w+)?\\n([\\s\\S]*?)\`\`\`/g,
        '<pre><code class="language-$1">$2</code></pre>');
      el.innerHTML = el.innerHTML.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    });
  </script>
</body>
</html>`;
}

function renderMessage(msg: AgentMessage): string {
	if (msg.role === "user") {
		const text = typeof msg.content === "string" ? msg.content : "[complex content]";
		return `<div class="message user"><div class="role">User</div><div class="content">${escapeHtml(text)}</div></div>`;
	}

	if (msg.role === "assistant") {
		const parts = (msg.content as Array<{ type: string; text?: string; name?: string; arguments?: string }>)
			.map((c) => {
				if (c.type === "text") return escapeHtml(c.text || "");
				if (c.type === "tool_call")
					return `<div class="tool-name">Tool: ${c.name}(${escapeHtml((c.arguments || "").substring(0, 200))}...)</div>`;
				if (c.type === "thinking")
					return `<details><summary style="color:#8b949e;cursor:pointer">Thinking...</summary>${escapeHtml(c.text || "")}</details>`;
				return "";
			})
			.join("\n");
		return `<div class="message assistant"><div class="role">Assistant</div><div class="content">${parts}</div></div>`;
	}

	if (msg.role === "toolResult") {
		const toolMsg = msg as {
			role: "toolResult";
			toolName: string;
			isError?: boolean;
			content: Array<{ type: string; text?: string }>;
		};
		const text = toolMsg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		const cls = toolMsg.isError ? "tool-result error" : "tool-result";
		return `<div class="message ${cls}"><div class="role">Tool: ${toolMsg.toolName}</div><div class="content"><pre>${escapeHtml(text.substring(0, 5000))}</pre></div></div>`;
	}

	return "";
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function getExportFilename(sessionId: string): string {
	const date = new Date().toISOString().split("T")[0];
	return `session-${sessionId.substring(0, 8)}-${date}.html`;
}
