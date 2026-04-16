/**
 * CLI REPL — minimal interactive driver.
 *
 * Reads lines from stdin, dispatches slash commands locally and forwards
 * everything else to the agent loop. Output is plain text streamed to
 * stdout. The TUI package handles the full Ink-based rendering; this REPL
 * is the headless equivalent for scripting and debug.
 */

import * as readline from "node:readline";
import { handleSlashCommand, type SlashSessionManager } from "./slash-commands.js";

export interface ReplDeps {
  /**
   * The current session manager. The REPL calls this lazily so that the
   * /branch slash command can swap the manager out for the freshly-forked
   * session without the REPL having to re-import anything.
   */
  getSession: () => SlashSessionManager;
  /**
   * Called when the user wants to switch to a different session file
   * (e.g., after /branch). The host owns session lifecycle; the REPL
   * just routes the request.
   */
  switchSession: (sessionPath: string) => Promise<void> | void;
  /**
   * Send a free-text prompt to the agent loop. The host streams the
   * agent's output to stdout itself; the REPL just awaits completion.
   */
  runPrompt: (prompt: string) => Promise<void>;
  /** stdin / stdout for prompts (defaults to process). */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const rl = readline.createInterface({
    input,
    output,
    terminal: false,
  });

  const writeLine = (line: string): void => {
    output.write(`${line}\n`);
  };

  writeLine('my-agent REPL — type /help for commands, /quit to exit');

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("/")) {
      const result = await handleSlashCommand(line, deps.getSession());
      if (result?.output) writeLine(result.output);
      if (result?.action === "quit") break;
      if (result?.action === "switch-session") {
        await deps.switchSession(result.sessionPath);
      }
      continue;
    }

    try {
      await deps.runPrompt(line);
    } catch (err) {
      writeLine(`error: ${(err as Error).message}`);
    }
  }

  rl.close();
}
