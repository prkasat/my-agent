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
import { runAgent } from "./runtime/agent-runtime.js";
import { SessionManager, loadPromptTemplates } from "@my-agent/core";
import { loadSettings } from "./config/settings.js";
import { AuthStorage } from "./config/auth-storage.js";
import { registerBuiltinOAuthProviders } from "@my-agent/ai";
import * as path from "node:path";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }

  const cwd = process.cwd();
  const globalDir = path.join(process.env.HOME || ".", ".my-agent");

  // Load settings (user + project merged)
  const settings = await loadSettings(cwd);

  // Register built-in OAuth providers.
  registerBuiltinOAuthProviders();

  // Load prompt templates
  const templates = await loadPromptTemplates({
    cwd,
    globalDir,
  });

  // Initialize credential storage.
  const authStorage = new AuthStorage();
  await authStorage.load();

  // RPC mode (after initialization so settings/OAuth are available)
  if (argv[0] === "--rpc") {
    startRpcServer({ settings, authStorage, templates });
    return;
  }

  // For now, both REPL and one-shot modes share session bootstrap.
  let session = SessionManager.continueRecent(cwd);

  if (argv.length > 0 && !argv[0].startsWith("-")) {
    // One-shot prompt mode with abort support
    const prompt = argv.join(" ");
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.on("SIGINT", onSigint);
    let result;
    try {
      result = await runAgent(
        prompt,
        { cwd, settings, authStorage, session, signal: controller.signal },
        {
          onText: (text) => process.stdout.write(text),
          onToolStart: (name) => process.stderr.write(`\n[${name}] `),
          onToolEnd: (name, isError) => process.stderr.write(isError ? "✗\n" : "✓\n"),
        },
      );
    } finally {
      process.off("SIGINT", onSigint);
    }
    if (result.aborted) {
      process.stderr.write("\naborted\n");
      process.exit(130);
    }
    if (result.error) {
      process.stderr.write(`error: ${result.error}\n`);
      process.exit(1);
    }
    process.stdout.write("\n");
    return;
  }

  // Print startup info
  process.stdout.write(`model: ${settings.model} | provider: ${settings.provider}\n`);
  if (templates.size > 0) {
    process.stdout.write(`loaded ${templates.size} template(s)\n`);
  }

  await runRepl({
    getSession: () => session,
    switchSession: async (sessionPath) => {
      session = SessionManager.open(sessionPath);
    },
    runPrompt: async (prompt, abortSignal) => {
      const result = await runAgent(
        prompt,
        { cwd, settings, authStorage, session, signal: abortSignal },
        {
          onText: (text) => process.stdout.write(text),
          onToolStart: (name) => process.stderr.write(`\n[${name}] `),
          onToolEnd: (name, isError) => process.stderr.write(isError ? "✗\n" : "✓\n"),
        },
      );
      if (result.aborted) {
        process.stderr.write("\naborted\n");
      } else if (result.error) {
        process.stderr.write(`error: ${result.error}\n`);
      }
      process.stdout.write("\n");
    },
    authStorage,
    templates,
    settings,
  });
}

function printUsage(): void {
  process.stdout.write(`my-agent — interactive coding assistant

Usage:
  my-agent                Start interactive REPL
  my-agent "<prompt>"     One-shot prompt
  my-agent --rpc          JSONL RPC mode for host integrations
  my-agent --help         Show this help

REPL slash commands:
  /help                Show all commands and templates
  /branch [name]       Fork session into new branch
  /sessions            List sessions for this directory
  /login [provider]    OAuth login (anthropic, github-copilot)
  /logout <provider>   OAuth logout
  /export [path]       Export session to HTML
  /settings            Show current settings
  /model               Show current model
  /templates           List available prompt templates
  /quit                Exit

Prompt templates:
  Place .md files in ~/.my-agent/prompts/ or .my-agent/prompts/
  Invoke with /<template-name> [args...]
`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
