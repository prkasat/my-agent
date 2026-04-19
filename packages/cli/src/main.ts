#!/usr/bin/env node

/**
 * my-agent CLI entry point.
 *
 * Three modes:
 *   - default (no args): interactive REPL with /branch, /sessions, /help
 *   - "<prompt>": one-shot run, prints the agent's reply, exits
 *   - --rpc: stay attached and speak JSONL on stdin/stdout (host process driver)
 */

import { createRequire } from "node:module";
import { runRepl } from "./repl/repl.js";
import { startRpcServer } from "./modes/rpc.js";
import { runAgent } from "./runtime/agent-runtime.js";
import {
  type AskDecision,
  type PermissionAskContext,
  SessionManager,
  loadPromptTemplates,
} from "@my-agent/core";
import { loadSettings } from "./config/settings.js";
import { AuthStorage } from "./config/auth-storage.js";
import { registerBuiltinOAuthProviders } from "@my-agent/ai";
import { listModelAvailability, resolveConfiguredModel } from "./runtime/model-registry.js";
import * as path from "node:path";
import * as readline from "node:readline";

const require = createRequire(import.meta.url);
const { version: CLI_VERSION } = require("../package.json") as { version: string };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${CLI_VERSION}\n`);
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

  const safeMode = argv.includes("--safe-mode");

  if (argv.includes("--doctor")) {
    await runDoctor({ cwd, settings, authStorage, safeMode });
    return;
  }

  if (argv.includes("--list-models")) {
    const availability = await listModelAvailability(authStorage);
    for (const entry of availability) {
      const status = entry.available ? "available" : `unavailable: ${entry.reason}`;
      process.stdout.write(`${entry.key} (${entry.model.provider}) - ${status}\n`);
    }
    return;
  }

  // RPC mode (after initialization so settings/OAuth are available)
  if (argv[0] === "--rpc") {
    startRpcServer({ settings, authStorage, templates });
    return;
  }

  const promptInput = async (message: string): Promise<string> => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await new Promise<string>((resolve) => {
        rl.question(`${message} `, (answer) => resolve(answer));
      });
    } finally {
      rl.close();
    }
  };

  const askPermission = async (ctx: PermissionAskContext): Promise<AskDecision> => {
    const location = ctx.command ?? ctx.filePath ?? JSON.stringify(ctx.args);
    process.stderr.write(`\nPermission required for ${ctx.toolName}\n${location}\n`);
    const answer = (await promptInput("Allow? [y]es once / [a]llow session / [n]o:"))
      .trim()
      .toLowerCase();
    if (answer === "a") return "allow_session";
    if (answer === "y") return "allow_once";
    return "deny";
  };

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
        { cwd, settings, authStorage, session, signal: controller.signal, askPermission, disableExtensions: safeMode },
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
  const resolvedModel = await resolveConfiguredModel(settings, authStorage);
  process.stdout.write(`model: ${resolvedModel.key} | provider: ${resolvedModel.model.provider}${safeMode ? " | safe-mode" : ""}\n`);
  if (templates.size > 0) {
    process.stdout.write(`loaded ${templates.size} template(s)\n`);
  }

  await runRepl({
    getSession: () => session,
    switchSession: async (sessionPath) => {
      session = SessionManager.open(sessionPath);
    },
    runPrompt: async (prompt, abortSignal, promptLine) => {
      const permissionPrompter = promptLine
        ? async (ctx: PermissionAskContext): Promise<AskDecision> => {
            const location = ctx.command ?? ctx.filePath ?? JSON.stringify(ctx.args);
            const answer = (await promptLine(`Allow ${ctx.toolName}? ${location} [y/a/n]:`)).trim().toLowerCase();
            if (answer === "a") return "allow_session";
            if (answer === "y") return "allow_once";
            return "deny";
          }
        : askPermission;
      const result = await runAgent(
        prompt,
        {
          cwd,
          settings,
          authStorage,
          session,
          signal: abortSignal,
          askPermission: permissionPrompter,
          disableExtensions: safeMode,
        },
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

async function runDoctor(options: {
  cwd: string;
  settings: Awaited<ReturnType<typeof loadSettings>>;
  authStorage: AuthStorage;
  safeMode: boolean;
}): Promise<void> {
  const availability = await listModelAvailability(options.authStorage);
  const lines = [
    `my-agent doctor ${CLI_VERSION}`,
    `cwd: ${options.cwd}`,
    `safeMode: ${options.safeMode ? "on" : "off"}`,
    `configuredModel: ${options.settings.model}`,
    `configuredProvider: ${options.settings.provider}`,
    `openrouterAuth: ${await options.authStorage.hasAuth("openrouter")}`,
    `anthropicAuth: ${await options.authStorage.hasAuth("anthropic")}`,
    `openaiCodexAuth: ${await options.authStorage.hasAuth("openai-codex")}`,
    `extensionPaths: ${options.settings.extensions.length || 0}`,
  ];

  try {
    const resolved = await resolveConfiguredModel(options.settings, options.authStorage);
    lines.push(`resolvedModel: ${resolved.key} (${resolved.model.provider})`);
  } catch (error) {
    lines.push(`resolvedModel: error - ${error instanceof Error ? error.message : String(error)}`);
  }

  lines.push("availableModels:");
  for (const entry of availability) {
    lines.push(`  - ${entry.key} (${entry.model.provider}): ${entry.available ? "ok" : entry.reason}`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

function printUsage(): void {
  process.stdout.write(`my-agent — interactive coding assistant

Usage:
  my-agent                Start interactive REPL
  my-agent "<prompt>"     One-shot prompt
  my-agent --rpc          JSONL RPC mode for host integrations
  my-agent --doctor       Run startup diagnostics
  my-agent --list-models  List models visible with current auth state
  my-agent --safe-mode    Disable extension loading for this run
  my-agent --version      Show CLI version
  my-agent --help         Show this help

REPL slash commands:
  /help                Show all commands and templates
  /branch [name]       Fork session into new branch
  /sessions            List sessions for this directory
  /login [provider]    OAuth login (anthropic, openai-codex, github-copilot)
  /logout <provider>   OAuth logout
  /extensions          Show configured extension paths
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
