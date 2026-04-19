/**
 * CLI REPL — minimal interactive driver.
 *
 * Reads lines from stdin, dispatches slash commands locally and forwards
 * everything else to the agent loop. Output is plain text streamed to
 * stdout. The TUI package handles the full Ink-based rendering; this REPL
 * is the headless equivalent for scripting and debug.
 */

import * as readline from "node:readline";
import type { LoadResourcePackagesResult, PromptTemplate, SkillDefinition } from "@my-agent/core";
import { Chalk } from "chalk";
import type { AuthStorage } from "../config/auth-storage.js";
import type { Settings } from "../config/settings.js";
import type { LoadThemesResult } from "../ui/theme-loader.js";
import {
	type SlashContext,
	type SlashSessionManager,
	handleSlashCommand,
	listSlashCommandSuggestions,
} from "./slash-commands.js";

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
	 * The optional signal allows cancellation via Ctrl+C.
	 */
	runPrompt: (
		prompt: string,
		signal?: AbortSignal,
		promptInput?: (message: string) => Promise<string>,
	) => Promise<void>;
	/** Credential storage for /login and /logout. */
	authStorage?: AuthStorage;
	/** Loaded prompt templates for template expansion. */
	templates?: Map<string, PromptTemplate>;
	/** Current settings for /settings and /model. */
	settings?: Settings;
	/** Loaded skills. */
	skills?: Map<string, SkillDefinition>;
	/** Loaded resource packages. */
	resources?: LoadResourcePackagesResult;
	/** Loaded themes. */
	themes?: LoadThemesResult;
	/** Global config directory. */
	globalDir?: string;
	/** Disable extension command loading. */
	disableExtensions?: boolean;
	/** Persist settings changes. */
	persistSettings?: (settings: Partial<Settings>, scope?: "user" | "project") => Promise<void>;
	/** stdin / stdout for prompts (defaults to process). */
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
	/** Whether to print the default REPL intro line. Default: true. */
	showIntro?: boolean;
}

export async function runRepl(deps: ReplDeps): Promise<void> {
	const input = deps.input ?? process.stdin;
	const output = deps.output ?? process.stdout;
	const interactive = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY);
	const chalk = new Chalk({ level: interactive ? 3 : 0 });
	const promptMarker = interactive ? chalk.bold.cyan("› ") : "";
	const slashSuggestions = listSlashCommandSuggestions({ templates: deps.templates, skills: deps.skills });
	const completer = (line: string): [string[], string] => {
		if (!line.startsWith("/")) {
			return [[], line];
		}
		const matches = slashSuggestions
			.filter((entry) => entry.value.startsWith(line))
			.map((entry) => entry.value)
			.sort();
		return [matches.length > 0 ? matches : slashSuggestions.map((entry) => entry.value), line];
	};
	const rl = readline.createInterface({
		input,
		output,
		terminal: interactive,
		completer,
	});
	if (interactive) {
		rl.setPrompt(promptMarker);
	}

	const writeLine = (line: string): void => {
		output.write(`${line}\n`);
	};
	const writeBlock = (text: string): void => {
		if (interactive) {
			output.write(`\n${text}\n`);
		} else {
			writeLine(text);
		}
	};

	const promptInput = async (message: string): Promise<string> => {
		return await new Promise<string>((resolve) => {
			rl.question(interactive ? `${chalk.dim("?")} ${message} ` : `${message} `, (answer) => resolve(answer));
		});
	};

	const templateCount = deps.templates?.size || 0;
	const templateNote = templateCount > 0 ? ` Templates: ${templateCount}.` : "";
	const autocompleteNote = interactive ? " Tab completes slash commands." : "";
	if (deps.showIntro !== false) {
		writeLine(
			`Type a prompt at the ${interactive ? "›" : "prompt"} marker. /help for commands, /quit to exit.${autocompleteNote}${templateNote}`,
		);
	}
	if (interactive) {
		rl.prompt();
	}

	for await (const raw of rl) {
		const line = raw.trim();
		if (!line) {
			if (interactive) rl.prompt();
			continue;
		}

		if (line.startsWith("/")) {
			const controller = new AbortController();
			const onSigint = () => controller.abort();
			process.on("SIGINT", onSigint);
			try {
				const ctx: SlashContext = {
					session: deps.getSession(),
					authStorage: deps.authStorage,
					templates: deps.templates,
					skills: deps.skills,
					settings: deps.settings,
					resources: deps.resources,
					themes: deps.themes,
					globalDir: deps.globalDir,
					disableExtensions: deps.disableExtensions,
					persistSettings: deps.persistSettings,
					promptInput,
					printLine: writeLine,
					loginSignal: controller.signal,
				};
				const result = await handleSlashCommand(line, ctx);

				if (result?.action === "switch-session") {
					try {
						await deps.switchSession(result.sessionPath);
						if (result.output) writeBlock(result.output);
					} catch (err) {
						writeBlock(`branch failed: ${(err as Error).message}`);
					}
					if (interactive) rl.prompt();
					continue;
				}

				if (result?.action === "prompt") {
					// Template expansion — run the expanded prompt through the agent
					if (result.output) writeBlock(result.output);
					const promptController = new AbortController();
					const onPromptSigint = () => promptController.abort();
					process.off("SIGINT", onSigint);
					process.on("SIGINT", onPromptSigint);
					try {
						await deps.runPrompt(result.prompt, promptController.signal, promptInput);
					} catch (err) {
						writeBlock(`error: ${(err as Error).message}`);
					} finally {
						process.off("SIGINT", onPromptSigint);
						process.on("SIGINT", onSigint);
					}
					if (interactive) rl.prompt();
					continue;
				}

				if (result?.output) writeBlock(result.output);
				if (result?.action === "quit") break;
				if (interactive) rl.prompt();
				continue;
			} finally {
				process.off("SIGINT", onSigint);
			}
		}

		const controller = new AbortController();
		const onSigint = () => controller.abort();
		process.on("SIGINT", onSigint);
		try {
			await deps.runPrompt(line, controller.signal, promptInput);
		} catch (err) {
			writeBlock(`error: ${(err as Error).message}`);
		} finally {
			process.off("SIGINT", onSigint);
		}
		if (interactive) rl.prompt();
	}

	rl.close();
}
