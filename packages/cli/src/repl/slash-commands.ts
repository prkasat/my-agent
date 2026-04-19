/**
 * Slash command handler for the CLI REPL.
 *
 * Handlers receive a session manager and the current input string and
 * return a `SlashResult` describing what the REPL should do next.
 *
 * Kept independent of the REPL loop so the same handler can be exercised
 * directly in tests without spinning up stdin / stdout.
 */

import type { SessionInfo, SessionManager } from "@my-agent/core";
import type { PromptTemplate } from "@my-agent/core";
import type { OAuthStorage } from "../config/oauth-storage.js";
import type { Settings } from "../config/settings.js";
import { handleLogin, handleLogout } from "../commands/login.js";
import { exportFromSessionManager, getExportFilename } from "../commands/export.js";
import { expandTemplate, getTemplateHelp } from "@my-agent/core";
import * as path from "node:path";

/**
 * What the REPL should do after a slash command runs.
 *
 * - "continue": stay in the REPL with the same session
 * - "switch-session": load a different session file at the given path
 * - "quit": exit the REPL
 * - "prompt": expand a template and run it as a prompt
 */
export type SlashResult =
  | { action: "continue"; output?: string }
  | { action: "switch-session"; sessionPath: string; output?: string }
  | { action: "quit"; output?: string }
  | { action: "prompt"; prompt: string; output?: string };

/**
 * Minimal session-manager surface a slash command needs.
 *
 * Pulled into its own type so:
 *   - the CLI doesn't depend on every method of SessionManager
 *   - tests can substitute a fake without bringing in the file system
 */
export interface SlashSessionManager {
  getSessionId(): string;
  getSessionFile?(): string | undefined;
  getCwd(): string;
  /** Fork the current branch into a new session file. */
  forkSession(leafId?: string): string | undefined;
  /** List all sessions for this cwd. */
  listSessionsForCwd?(): Promise<SessionInfo[]>;
  /** Get entries for export. */
  getEntries?(): SessionManager["getEntries"] extends () => infer R ? R : never;
  /** Get header for export. */
  getHeader?(): SessionManager["getHeader"] extends () => infer R ? R : never;
}

/**
 * Context for slash commands that need access to app-level resources.
 */
export interface SlashContext {
  session: SlashSessionManager;
  oauthStorage?: OAuthStorage;
  templates?: Map<string, PromptTemplate>;
  settings?: Settings;
}

/**
 * Built-in slash commands.
 */
function getHelpText(templates?: Map<string, PromptTemplate>): string {
  let text = `Available commands:
  /help                Show this help
  /branch [name]       Fork the current session into a new branch (alias: /fork)
  /sessions            List sessions for this working directory
  /login [provider]    Login via OAuth (anthropic, github-copilot)
  /logout <provider>   Logout from a provider
  /export [path]       Export session to standalone HTML file
  /settings            Show current settings
  /model               Show current model
  /quit, /exit         Exit the REPL`;

  if (templates && templates.size > 0) {
    text += "\n\nPrompt templates:";
    for (const [name, template] of templates) {
      const desc = template.description || "(no description)";
      text += `\n  /${name} - ${desc}`;
    }
  }

  return text;
}

/**
 * Parse and dispatch a slash command.
 *
 * Returns a SlashResult, or `null` when the input is not a slash command
 * (lets the caller fall through to the agent loop).
 *
 * Why null instead of throwing or passing through silently: a slash command
 * that fails to parse is still a slash command; it should never silently
 * become a prompt to the LLM. Returning null is reserved for "this isn't
 * one of mine" — the REPL can route accordingly.
 */
/**
 * Parse command-line-style arguments (respects quotes).
 */
function parseCommandArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (const char of input) {
    if (inQuote) {
      if (char === quoteChar) {
        inQuote = false;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = true;
      quoteChar = char;
    } else if (char === " ") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);

  return args;
}

export async function handleSlashCommand(
  input: string,
  ctx: SlashContext,
): Promise<SlashResult | null> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const parts = parseCommandArgs(trimmed.slice(1));
  const cmd = (parts[0] || "").toLowerCase();
  const args = parts.slice(1);
  const { session, oauthStorage, templates, settings } = ctx;

  switch (cmd) {
    case "help":
    case "?":
      return { action: "continue", output: getHelpText(templates) };

    case "quit":
    case "exit":
      return { action: "quit", output: "bye." };

    case "branch":
    case "fork": {
      const label = args.join(" ").trim();
      try {
        const newPath = session.forkSession();
        if (!newPath) {
          return {
            action: "continue",
            output: "branch failed: no leaf to fork from (empty session)",
          };
        }
        const note = label ? ` (label "${label}" not yet persisted)` : "";
        return {
          action: "switch-session",
          sessionPath: newPath,
          output: `branched session -> ${newPath}${note}`,
        };
      } catch (err) {
        return {
          action: "continue",
          output: `branch failed: ${(err as Error).message}`,
        };
      }
    }

    case "sessions": {
      if (!session.listSessionsForCwd) {
        return {
          action: "continue",
          output: "sessions: not available in this build",
        };
      }
      try {
        const sessions = await session.listSessionsForCwd();
        if (sessions.length === 0) {
          return { action: "continue", output: "no sessions for this cwd." };
        }
        const currentFile = session.getSessionFile?.();
        const lines = sessions.map((s) => {
          const marker = s.path === currentFile ? " <- current" : "";
          const name = s.name ? ` "${s.name}"` : "";
          const preview = s.firstMessage
            ? ` ${truncate(s.firstMessage, 60)}`
            : "";
          return `  ${s.id}${name} (${s.messageCount} msgs)${preview}${marker}`;
        });
        return { action: "continue", output: lines.join("\n") };
      } catch (err) {
        return {
          action: "continue",
          output: `sessions failed: ${(err as Error).message}`,
        };
      }
    }

    case "login": {
      if (!oauthStorage) {
        return { action: "continue", output: "login: OAuth storage not initialized" };
      }
      const output: string[] = [];
      try {
        await handleLogin(args[0], oauthStorage, (line) => output.push(line));
      } catch (err) {
        output.push(`login failed: ${(err as Error).message}`);
      }
      return { action: "continue", output: output.join("\n") };
    }

    case "logout": {
      if (!oauthStorage) {
        return { action: "continue", output: "logout: OAuth storage not initialized" };
      }
      const output: string[] = [];
      try {
        await handleLogout(args[0], oauthStorage, (line) => output.push(line));
      } catch (err) {
        output.push(`logout failed: ${(err as Error).message}`);
      }
      return { action: "continue", output: output.join("\n") };
    }

    case "export": {
      if (!session.getEntries || !session.getHeader) {
        return { action: "continue", output: "export: session manager does not support export" };
      }
      try {
        const entries = session.getEntries();
        const header = session.getHeader();
        if (!header) {
          return { action: "continue", output: "export: session has no header" };
        }
        const filename = args[0] || getExportFilename(session.getSessionId());
        const outputPath = path.isAbsolute(filename) ? filename : path.join(session.getCwd(), filename);
        await exportFromSessionManager(
          { getEntries: () => entries, getHeader: () => header } as any,
          outputPath,
        );
        return { action: "continue", output: `exported to ${outputPath}` };
      } catch (err) {
        return { action: "continue", output: `export failed: ${(err as Error).message}` };
      }
    }

    case "settings": {
      if (!settings) {
        return { action: "continue", output: "settings: not loaded" };
      }
      const lines = [
        `model: ${settings.model}`,
        `provider: ${settings.provider}`,
        `thinkingLevel: ${settings.thinkingLevel}`,
        `permissionMode: ${settings.permissionMode}`,
        `maxTurns: ${settings.maxTurns}`,
        `compaction: ${settings.compaction.enabled ? "enabled" : "disabled"}`,
        `retry: ${settings.retry.enabled ? `enabled (max ${settings.retry.maxRetries})` : "disabled"}`,
        `extensions: ${settings.extensions.length || "none"}`,
      ];
      return { action: "continue", output: lines.join("\n") };
    }

    case "model": {
      if (!settings) {
        return { action: "continue", output: "model: settings not loaded" };
      }
      return { action: "continue", output: `current model: ${settings.model} (provider: ${settings.provider})` };
    }

    case "templates": {
      if (!templates || templates.size === 0) {
        return { action: "continue", output: "no templates loaded" };
      }
      return { action: "continue", output: getTemplateHelp(templates) };
    }

    default: {
      // Check if it matches a prompt template
      if (templates) {
        const template = templates.get(cmd);
        if (template) {
          const expanded = expandTemplate(template, args);
          return { action: "prompt", prompt: expanded, output: `[template: ${cmd}]` };
        }
      }

      return {
        action: "continue",
        output: `unknown command: /${cmd} — try /help`,
      };
    }
  }
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1)}…`;
}
