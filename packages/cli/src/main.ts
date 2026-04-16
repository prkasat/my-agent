#!/usr/bin/env node

/**
 * my-agent CLI entry point.
 *
 * Three modes:
 *   - default (no args): interactive REPL with /branch, /sessions, /help
 *   - "<prompt>": one-shot run, prints the agent's reply, exits
 *   - --rpc: stay attached and speak JSONL on stdin/stdout (host process driver)
 */

import { runRepl } from "./repl/repl.js";
import { startRpcServer } from "./modes/rpc.js";
import { SessionManager } from "@my-agent/core";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }

  if (argv[0] === "--rpc") {
    startRpcServer(undefined);
    return;
  }

  // For now, both REPL and one-shot modes share session bootstrap.
  let session = SessionManager.continueRecent(process.cwd());

  if (argv.length > 0 && !argv[0].startsWith("-")) {
    // One-shot prompt mode — Tier 2 will plug a streaming agent loop here.
    // For now we just record the user message so the session file is real.
    // SessionManager defers the first write until an assistant message
    // arrives, so without an explicit flush() this stub-only entry would
    // be lost on process exit. Force the flush so /sessions surfaces it.
    const prompt = argv.join(" ");
    session.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
    session.flush();
    process.stdout.write(`(stub) recorded prompt: ${prompt}\n`);
    return;
  }

  await runRepl({
    getSession: () => session,
    switchSession: async (path) => {
      session = SessionManager.open(path);
    },
    runPrompt: async (prompt) => {
      // Hook point for the agent loop. Until Tier 2 wires the streaming
      // agent in, just echo the prompt and persist it so /sessions has
      // something to show. Same flush rationale as the one-shot path —
      // without it, a REPL that exits before any assistant turn loses
      // every prompt typed.
      session.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
      session.flush();
      process.stdout.write(`(stub) you said: ${prompt}\n`);
    },
  });
}

function printUsage(): void {
  process.stdout.write(`my-agent — interactive coding assistant

Usage:
  my-agent                Start interactive REPL
  my-agent "<prompt>"     One-shot prompt
  my-agent --rpc          JSONL RPC mode for host integrations
  my-agent --help         Show this help

REPL slash commands: /help /branch /sessions /quit
`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
