/**
 * Slash command handler for the CLI REPL.
 *
 * Handlers receive a session manager and the current input string and
 * return a `SlashResult` describing what the REPL should do next.
 *
 * Kept independent of the REPL loop so the same handler can be exercised
 * directly in tests without spinning up stdin / stdout.
 */

import type { SessionInfo } from "@my-agent/core";

/**
 * What the REPL should do after a slash command runs.
 *
 * - "continue": stay in the REPL with the same session
 * - "switch-session": load a different session file at the given path
 * - "quit": exit the REPL
 */
export type SlashResult =
  | { action: "continue"; output?: string }
  | { action: "switch-session"; sessionPath: string; output?: string }
  | { action: "quit"; output?: string };

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
}

/**
 * Built-in slash commands.
 */
const HELP_TEXT = `Available commands:
  /help                Show this help
  /branch [name]       Fork the current session into a new branch (alias: /fork)
  /sessions            List sessions for this working directory
  /quit, /exit         Exit the REPL`;

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
export async function handleSlashCommand(
  input: string,
  session: SlashSessionManager,
): Promise<SlashResult | null> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const [rawCmd, ...args] = trimmed.slice(1).split(/\s+/);
  const cmd = rawCmd.toLowerCase();

  switch (cmd) {
    case "help":
    case "?":
      return { action: "continue", output: HELP_TEXT };

    case "quit":
    case "exit":
      return { action: "quit", output: "bye." };

    case "branch":
    case "fork": {
      // Why ignore extra args: the in-tree session model has no first-class
      // "branch label" yet (Tier-4 work). For now we accept it and discard
      // it so users from the course don't get an error; we document the
      // discard in the success line.
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

    default:
      return {
        action: "continue",
        output: `unknown command: /${cmd} — try /help`,
      };
  }
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1)}…`;
}
