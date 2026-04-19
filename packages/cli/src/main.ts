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
import * as path from "node:path";
import * as readline from "node:readline";
import { registerBuiltinOAuthProviders } from "@my-agent/ai";
import {
	type AskDecision,
	type PermissionAskContext,
	SessionManager,
	loadPromptTemplates,
	loadResourcePackages,
	loadSkills,
} from "@my-agent/core";
import { Chalk } from "chalk";
import { replayFile } from "./commands/replay.js";
import { AuthStorage } from "./config/auth-storage.js";
import { loadSettings, saveSettings } from "./config/settings.js";
import { startRpcServer } from "./modes/rpc.js";
import { runRepl } from "./repl/repl.js";
import { formatRuntimeProfile, runAgent } from "./runtime/agent-runtime.js";
import { formatModelResolutionError, listModelAvailability, resolveConfiguredModel } from "./runtime/model-registry.js";
import { getTraceFilePath, initializeTracing, trace } from "./runtime/trace.js";
import { runTuiApp } from "./tui/app.js";
import { loadThemes } from "./ui/theme-loader.js";

const require = createRequire(import.meta.url);
const { version: CLI_VERSION } = require("../package.json") as { version: string };
const chalk = new Chalk({ level: process.stdout.isTTY ? 3 : 0 });

function printReplStartup(options: {
	resolvedModel?: { key: string; provider: string };
	modelError?: unknown;
	safeMode: boolean;
	templateCount: number;
	skillsCount: number;
	packageCount: number;
	themeCount: number;
	traceFilePath?: string;
	resourceWarnings: string[];
}): void {
	const lines: string[] = [];
	lines.push(chalk.bold.cyan(`my-agent ${CLI_VERSION}`));

	if (options.resolvedModel) {
		lines.push(
			`${chalk.green("Ready")} ${chalk.bold(options.resolvedModel.key)} via ${options.resolvedModel.provider}${options.safeMode ? chalk.dim(" · safe-mode") : ""}`,
		);
	} else {
		const rawMessage =
			options.modelError instanceof Error ? options.modelError.message : String(options.modelError ?? "");
		const summary = rawMessage.split("\n")[0] || "No authenticated models are available.";
		lines.push(`${chalk.yellow("Not connected")} ${summary}`);
		lines.push("Connect a provider:");
		lines.push(`  1. ${chalk.bold("export OPENROUTER_API_KEY=...")}`);
		lines.push(`  2. ${chalk.bold("/login anthropic")}`);
		lines.push(`  3. ${chalk.bold("/login openai-codex")}`);
		lines.push(`  4. ${chalk.bold("/model")} to choose the model you want`);
		lines.push(chalk.dim("Need details? Run my-agent --doctor or my-agent --list-models."));
	}

	lines.push(
		`${chalk.dim("Resources")} prompts=${options.templateCount} skills=${options.skillsCount} packages=${options.packageCount} themes=${options.themeCount}${options.safeMode ? " · safe-mode" : ""}`,
	);
	lines.push(chalk.dim("Data lives in ~/.my-agent (auth, sessions, prompts, extensions, packages, themes)."));
	lines.push(
		chalk.dim("Type a task at the › prompt below. Tab completes slash commands. Use /help for a command index."),
	);
	if (options.traceFilePath) {
		lines.push(`${chalk.dim("Trace")} ${options.traceFilePath}`);
	}
	for (const warning of options.resourceWarnings) {
		lines.push(`${chalk.yellow("warning:")} ${warning}`);
	}

	process.stdout.write(`${lines.join("\n")}\n\n`);
}

async function main(): Promise<void> {
	const cliStartedAt = Date.now();
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) {
		printUsage();
		return;
	}
	if (argv.includes("--version") || argv.includes("-v")) {
		process.stdout.write(`${CLI_VERSION}\n`);
		return;
	}

	const replayIndex = argv.indexOf("--replay");
	if (replayIndex >= 0) {
		const target = argv[replayIndex + 1];
		if (!target) {
			throw new Error("--replay requires a file path");
		}
		process.stdout.write(`${await replayFile(target)}\n`);
		return;
	}

	const optionValueIndexes = new Set<number>();
	if (replayIndex >= 0 && argv[replayIndex + 1]) {
		optionValueIndexes.add(replayIndex + 1);
	}
	const promptArgs = argv.filter((arg, index) => !arg.startsWith("-") && !optionValueIndexes.has(index));

	const cwd = process.cwd();
	const globalDir = path.join(process.env.HOME || ".", ".my-agent");
	initializeTracing({
		enabled: argv.includes("--trace"),
		dir: path.join(globalDir, "traces"),
	});
	trace("runtime", "cli.start", { argv, cwd });

	// Load settings (user + project merged)
	const settings = await loadSettings(cwd);

	// Register built-in OAuth providers.
	registerBuiltinOAuthProviders();

	// Initialize credential storage.
	const authStorage = new AuthStorage();
	await authStorage.load();

	const safeMode = argv.includes("--safe-mode");
	const profileMode = argv.includes("--profile");

	const resources = safeMode
		? { packages: [], warnings: [] }
		: await loadResourcePackages({
				cwd,
				globalDir,
				entries: settings.packages,
			});

	// Load prompt templates + skills from local resources and packages.
	const templates = await loadPromptTemplates({
		cwd,
		globalDir,
		extraDirs: resources.packages.flatMap((pkg) => pkg.prompts),
	});
	const skills = await loadSkills({
		cwd,
		globalDir,
		extraDirs: [...settings.skills, ...resources.packages.flatMap((pkg) => pkg.skills)],
	});
	const themes = await loadThemes({
		cwd,
		globalDir,
		extraEntries: resources.packages.flatMap((pkg) => pkg.themes),
	});
	const resourceWarnings = [...resources.warnings, ...skills.warnings, ...themes.warnings];
	trace("resources", "loaded", {
		packageCount: resources.packages.length,
		templateCount: templates.size,
		skillCount: skills.skills.size,
		themeCount: themes.themes.size,
		warnings: resourceWarnings.length,
	});

	if (argv.includes("--doctor")) {
		trace("runtime", "cli.ready", { mode: "doctor", durationMs: Date.now() - cliStartedAt });
		await runDoctor({
			cwd,
			settings,
			authStorage,
			safeMode,
			resources,
			resourceWarnings,
			skillsCount: skills.skills.size,
			templateCount: templates.size,
			themeCount: themes.themes.size,
		});
		return;
	}

	if (argv.includes("--list-models")) {
		trace("runtime", "cli.ready", { mode: "list-models", durationMs: Date.now() - cliStartedAt });
		const availability = await listModelAvailability(authStorage);
		for (const entry of availability) {
			const status = entry.available ? "available" : `unavailable: ${entry.reason}`;
			process.stdout.write(`${entry.key} (${entry.model.provider}) - ${status}\n`);
		}
		return;
	}

	// RPC mode (after initialization so settings/OAuth are available)
	if (argv[0] === "--rpc") {
		trace("runtime", "cli.ready", { mode: "rpc", durationMs: Date.now() - cliStartedAt });
		startRpcServer({
			settings,
			authStorage,
			templates,
			skills: skills.skills,
			resources,
			disableExtensions: safeMode,
		});
		return;
	}

	if (argv.includes("--tui")) {
		trace("runtime", "cli.ready", { mode: "tui", durationMs: Date.now() - cliStartedAt });
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error("--tui requires an interactive TTY");
		}
		await runTuiApp({
			cwd,
			globalDir,
			settings,
			authStorage,
			session: SessionManager.continueRecent(cwd),
			templates,
			skills: skills.skills,
			resources,
			themes,
			safeMode,
		});
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
		const answer = (await promptInput("Allow? [y]es once / [a]llow session / [n]o:")).trim().toLowerCase();
		if (answer === "a") return "allow_session";
		if (answer === "y") return "allow_once";
		return "deny";
	};

	// For now, both REPL and one-shot modes share session bootstrap.
	let session = SessionManager.continueRecent(cwd);

	if (promptArgs.length > 0) {
		trace("runtime", "cli.ready", { mode: "one-shot", durationMs: Date.now() - cliStartedAt });
		// One-shot prompt mode with abort support
		const prompt = promptArgs.join(" ");
		const controller = new AbortController();
		const onSigint = () => controller.abort();
		process.on("SIGINT", onSigint);
		let result: Awaited<ReturnType<typeof runAgent>>;
		try {
			result = await runAgent(
				prompt,
				{
					cwd,
					settings,
					authStorage,
					session,
					signal: controller.signal,
					askPermission,
					disableExtensions: safeMode,
					resourceExtensionEntries: resources.packages.flatMap((pkg) => pkg.extensions),
				},
				{
					onText: (text) => process.stdout.write(text),
					onToolStart: (name) => process.stderr.write(`\n[${name}] `),
					onToolEnd: (_name, isError) => process.stderr.write(isError ? "✗\n" : "✓\n"),
				},
			);
		} catch (error) {
			process.stderr.write(`${formatModelResolutionError(error)}\n`);
			process.exit(1);
			return;
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
		if (profileMode) {
			process.stderr.write(`${formatRuntimeProfile(result.profile)}\n`);
		}
		return;
	}

	// Print startup info
	let replResolvedModel: { key: string; provider: string } | undefined;
	let replModelError: unknown;
	try {
		const resolvedModel = await resolveConfiguredModel(settings, authStorage);
		replResolvedModel = { key: resolvedModel.key, provider: resolvedModel.model.provider };
	} catch (error) {
		replModelError = error;
	}
	printReplStartup({
		resolvedModel: replResolvedModel,
		modelError: replModelError,
		safeMode,
		templateCount: templates.size,
		skillsCount: skills.skills.size,
		packageCount: resources.packages.length,
		themeCount: themes.themes.size,
		traceFilePath: getTraceFilePath() ?? undefined,
		resourceWarnings,
	});

	trace("runtime", "cli.ready", { mode: "repl", durationMs: Date.now() - cliStartedAt });
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
			const interactiveRepl = Boolean(process.stdin.isTTY && process.stdout.isTTY);
			const toolOutput = interactiveRepl ? process.stdout : process.stderr;
			let assistantStarted = false;
			const beginAssistant = () => {
				if (!interactiveRepl || assistantStarted) return;
				assistantStarted = true;
				process.stdout.write(`${chalk.bold.green("assistant")}\n`);
			};
			try {
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
						resourceExtensionEntries: resources.packages.flatMap((pkg) => pkg.extensions),
					},
					{
						onText: (text) => {
							beginAssistant();
							process.stdout.write(text);
						},
						onToolStart: (name) => {
							if (interactiveRepl) {
								beginAssistant();
								toolOutput.write(`\n${chalk.dim("tool")} ${chalk.cyan(name)} …`);
							} else {
								toolOutput.write(`\n[${name}] `);
							}
						},
						onToolEnd: (_name, isError) => {
							if (interactiveRepl) {
								toolOutput.write(isError ? ` ${chalk.red("✗")}\n` : ` ${chalk.green("✓")}\n`);
							} else {
								toolOutput.write(isError ? "✗\n" : "✓\n");
							}
						},
					},
				);
				if (result.aborted) {
					process.stderr.write("\naborted\n");
				} else if (result.error) {
					process.stderr.write(`error: ${result.error}\n`);
				}
				process.stdout.write("\n");
				if (profileMode) {
					process.stderr.write(`${formatRuntimeProfile(result.profile)}\n`);
				}
			} catch (error) {
				process.stderr.write(`${formatModelResolutionError(error)}\n`);
			}
		},
		authStorage,
		templates,
		skills: skills.skills,
		settings,
		resources,
		globalDir,
		disableExtensions: safeMode,
		persistSettings: (nextSettings, scope) => saveSettings(nextSettings, scope ?? "project", cwd),
		themes,
		showIntro: false,
	});
}

async function runDoctor(options: {
	cwd: string;
	settings: Awaited<ReturnType<typeof loadSettings>>;
	authStorage: AuthStorage;
	safeMode: boolean;
	resources: { packages: Array<{ extensions: string[] }> };
	resourceWarnings: string[];
	skillsCount: number;
	templateCount: number;
	themeCount: number;
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
		`packageCount: ${options.resources.packages.length}`,
		`packageExtensionPaths: ${options.resources.packages.reduce((sum, pkg) => sum + pkg.extensions.length, 0)}`,
		`templateCount: ${options.templateCount}`,
		`skillsCount: ${options.skillsCount}`,
		`themeCount: ${options.themeCount}`,
	];

	try {
		const resolved = await resolveConfiguredModel(options.settings, options.authStorage);
		lines.push(`resolvedModel: ${resolved.key} (${resolved.model.provider})`);
	} catch (error) {
		lines.push(`resolvedModel: error - ${error instanceof Error ? error.message : String(error)}`);
	}

	if (options.resourceWarnings.length > 0) {
		lines.push("resourceWarnings:");
		for (const warning of options.resourceWarnings) {
			lines.push(`  - ${warning}`);
		}
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
  my-agent --tui          Start the full-screen TUI shell
  my-agent --doctor       Run startup diagnostics
  my-agent --list-models  List models visible with current auth state
  my-agent --safe-mode    Disable extension loading for this run
  my-agent --trace        Enable structured JSONL tracing
  my-agent --profile      Print runtime timing and cost summary
  my-agent --replay FILE  Replay a session or trace timeline
  my-agent --version      Show CLI version
  my-agent --help         Show this help

REPL slash commands:
  /help                Show all commands and templates
  /branch [name]       Fork session into new branch
  /sessions            List sessions for this directory
  /tree                Show the current session tree
  /tree switch <id>    Set the active branch context
  /login [provider]    OAuth login (anthropic, openai-codex)
  /logout <provider>   OAuth logout
  /extensions          Show configured extension paths
  /packages            Show loaded resource packages
  /skills              List available skills
  /export [path]       Export session to HTML
  /settings            Show current settings
  /model               Show current model
  /theme               Show current theme
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
