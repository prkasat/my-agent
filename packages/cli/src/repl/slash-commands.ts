/**
 * Slash command handler for the CLI REPL.
 *
 * Handlers receive a session manager and the current input string and
 * return a `SlashResult` describing what the REPL should do next.
 *
 * Kept independent of the REPL loop so the same handler can be exercised
 * directly in tests without spinning up stdin / stdout.
 */

import * as path from "node:path";
import type {
	LoadResourcePackagesResult,
	PromptTemplate,
	SessionInfo,
	SessionManager,
	SessionTreeNode,
	SkillDefinition,
} from "@my-agent/core";
import { expandSkill, expandTemplate, findSkillByCommand, getSkillHelp, getTemplateHelp } from "@my-agent/core";
import { exportFromSessionManager, getExportFilename } from "../commands/export.js";
import { handleLogin, handleLogout, isLoginCancelledError } from "../commands/login.js";
import type { AuthStorage } from "../config/auth-storage.js";
import type { Settings } from "../config/settings.js";
import {
	getNextThinkingLevel,
	getThinkingLevelDescription,
	isThinkingLevel,
	THINKING_LEVELS,
} from "../config/thinking-levels.js";
import { inspectExtensions, runExtensionCommand } from "../runtime/extensions.js";
import { getModelProviderForKey, listModelAvailability } from "../runtime/model-registry.js";
import type { LoadThemesResult } from "../ui/theme-loader.js";

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
	/** Get the current session tree. */
	getTree?(): SessionTreeNode[];
	/** Get the current leaf id. */
	getLeafId?(): string | null;
	/** Point the current branch context at a different entry. */
	branch?(entryId: string): void;
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
	authStorage?: AuthStorage;
	templates?: Map<string, PromptTemplate>;
	skills?: Map<string, SkillDefinition>;
	settings?: Settings;
	resources?: LoadResourcePackagesResult;
	themes?: LoadThemesResult;
	globalDir?: string;
	disableExtensions?: boolean;
	persistSettings?: (settings: Partial<Settings>, scope?: "user" | "project") => Promise<void>;
	promptInput?: (message: string) => Promise<string>;
	printLine?: (line: string) => void;
	loginSignal?: AbortSignal;
}

/**
 * Built-in slash commands.
 */
interface SlashCommandListing {
	name: string;
	usage: string;
	description: string;
	section: string;
}

const BUILTIN_SLASH_COMMANDS: SlashCommandListing[] = [
	{ name: "help", usage: "/help", description: "Show command help and shortcuts", section: "Basics" },
	{ name: "quit", usage: "/quit", description: "Exit the REPL", section: "Basics" },
	{ name: "exit", usage: "/exit", description: "Exit the REPL", section: "Basics" },
	{
		name: "branch",
		usage: "/branch [name]",
		description: "Fork the current session into a new branch",
		section: "Sessions",
	},
	{ name: "fork", usage: "/fork", description: "Alias for /branch", section: "Sessions" },
	{
		name: "sessions",
		usage: "/sessions",
		description: "List sessions for this working directory",
		section: "Sessions",
	},
	{ name: "tree", usage: "/tree", description: "Show the current session tree", section: "Sessions" },
	{
		name: "tree switch",
		usage: "/tree switch <id>",
		description: "Set the active branch context for the next prompt",
		section: "Sessions",
	},
	{ name: "login", usage: "/login [provider]", description: "Login via OAuth", section: "Auth" },
	{ name: "logout", usage: "/logout <provider>", description: "Logout from a provider", section: "Auth" },
	{
		name: "model",
		usage: "/model [name]",
		description: "Show or set the current model",
		section: "Configuration",
	},
	{
		name: "theme",
		usage: "/theme [name]",
		description: "Show or set the current theme",
		section: "Configuration",
	},
	{
		name: "thinking",
		usage: "/thinking [level]",
		description: "Show or set the current thinking level",
		section: "Configuration",
	},
	{ name: "settings", usage: "/settings", description: "Show current settings", section: "Configuration" },
	{
		name: "extensions",
		usage: "/extensions",
		description: "Show configured extension paths",
		section: "Resources",
	},
	{
		name: "packages",
		usage: "/packages",
		description: "Show loaded resource packages",
		section: "Resources",
	},
	{ name: "skills", usage: "/skills", description: "List loaded skills", section: "Resources" },
	{ name: "templates", usage: "/templates", description: "List prompt templates", section: "Resources" },
	{
		name: "export",
		usage: "/export [path]",
		description: "Export session to standalone HTML",
		section: "Resources",
	},
];

export function listSlashCommandSuggestions(options?: {
	templates?: Map<string, PromptTemplate>;
	skills?: Map<string, SkillDefinition>;
}): Array<{ value: string; description?: string }> {
	const values = new Map<string, string | undefined>();
	for (const command of BUILTIN_SLASH_COMMANDS) {
		const key = `/${command.name}`;
		values.set(key, command.description);
	}
	for (const [name, skill] of options?.skills ?? []) {
		values.set(`/${name}`, skill.description || skill.name);
	}
	for (const [name, template] of options?.templates ?? []) {
		values.set(`/${name}`, template.description || "Prompt template");
	}
	return [...values.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([value, description]) => ({ value, description }));
}

function getHelpText(templates?: Map<string, PromptTemplate>, skills?: Map<string, SkillDefinition>): string {
	const sections = new Map<string, SlashCommandListing[]>();
	for (const command of BUILTIN_SLASH_COMMANDS) {
		const section = sections.get(command.section) ?? [];
		section.push(command);
		sections.set(command.section, section);
	}

	let text = [
		"Use the prompt for normal tasks. Slash commands manage auth, sessions, and resources.",
		"",
		"Quick start:",
		"  - Connect a model: export OPENROUTER_API_KEY=... or /login anthropic or /login openai-codex",
		"  - Pick a model: /model",
		"  - Inspect the current session: /tree or /sessions",
	].join("\n");

	for (const [sectionName, commands] of sections) {
		text += `\n\n${sectionName}:`;
		for (const command of commands) {
			text += `\n  ${command.usage.padEnd(20)} ${command.description}`;
		}
	}

	if (skills && skills.size > 0) {
		text += "\n\nSkills:";
		for (const [name, skill] of skills) {
			const desc = skill.description || skill.name;
			text += `\n  /${name.padEnd(18)} ${desc}`;
		}
	}

	if (templates && templates.size > 0) {
		text += "\n\nPrompt templates:";
		for (const [name, template] of templates) {
			const desc = template.description || "Prompt template";
			text += `\n  /${name.padEnd(18)} ${desc}`;
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

export async function handleSlashCommand(input: string, ctx: SlashContext): Promise<SlashResult | null> {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return null;

	const parts = parseCommandArgs(trimmed.slice(1));
	const cmd = (parts[0] || "").toLowerCase();
	const args = parts.slice(1);
	const {
		session,
		authStorage,
		templates,
		skills,
		settings,
		resources,
		themes,
		globalDir,
		disableExtensions,
		persistSettings,
		promptInput,
		printLine,
		loginSignal,
	} = ctx;

	switch (cmd) {
		case "help":
		case "?":
			return { action: "continue", output: getHelpText(templates, skills) };

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
					const preview = s.firstMessage ? ` ${truncate(s.firstMessage, 60)}` : "";
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

		case "tree": {
			if (args[0] === "switch") {
				const entryId = args[1];
				if (!entryId) {
					return { action: "continue", output: "usage: /tree switch <entry-id>" };
				}
				if (!session.branch) {
					return { action: "continue", output: "tree switch: not available in this build" };
				}
				try {
					session.branch(entryId);
					return { action: "continue", output: `branch context set to ${entryId}` };
				} catch (err) {
					return { action: "continue", output: `tree switch failed: ${(err as Error).message}` };
				}
			}
			if (!session.getTree) {
				return { action: "continue", output: "tree: not available in this build" };
			}
			const lines: string[] = [];
			const currentLeafId = session.getLeafId?.();
			const walk = (nodes: SessionTreeNode[], prefix = ""): void => {
				for (const [index, node] of nodes.entries()) {
					const isLast = index === nodes.length - 1;
					const marker = node.entry.id === currentLeafId ? " <- current" : "";
					lines.push(`${prefix}${isLast ? "└─" : "├─"} ${node.entry.id} (${node.entry.type})${marker}`);
					walk(node.children, `${prefix}${isLast ? "  " : "│ "}`);
				}
			};
			walk(session.getTree());
			return {
				action: "continue",
				output:
					lines.length > 0
						? `${lines.join("\n")}\n\nUse /tree switch <entry-id> to change branch context.`
						: "tree: empty session",
			};
		}

		case "login": {
			if (!authStorage) {
				return { action: "continue", output: "login: auth storage not initialized" };
			}
			const output: string[] = [];
			const emit = (line: string): void => {
				output.push(line);
				printLine?.(line);
			};
			try {
				await handleLogin(args[0], authStorage, emit, promptInput, loginSignal);
			} catch (err) {
				emit(isLoginCancelledError(err) ? "Login cancelled." : `login failed: ${(err as Error).message}`);
			}
			return { action: "continue", output: printLine ? undefined : output.join("\n") };
		}

		case "logout": {
			if (!authStorage) {
				return { action: "continue", output: "logout: auth storage not initialized" };
			}
			const output: string[] = [];
			const emit = (line: string): void => {
				output.push(line);
				printLine?.(line);
			};
			try {
				await handleLogout(args[0], authStorage, emit);
			} catch (err) {
				emit(`logout failed: ${(err as Error).message}`);
			}
			return { action: "continue", output: printLine ? undefined : output.join("\n") };
		}

		case "extensions": {
			if (!settings) {
				return { action: "continue", output: "extensions: settings not loaded" };
			}
			const configuredEntries = [
				...settings.extensions,
				...(resources?.packages ?? []).flatMap((pkg) => pkg.extensions),
			];
			const configured =
				configuredEntries.length > 0 ? configuredEntries.map((entry) => `  ${entry}`).join("\n") : "  (none)";
			if (!globalDir || disableExtensions) {
				return {
					action: "continue",
					output: `configured extensions:\n${configured}`,
				};
			}
			const inspection = await inspectExtensions({
				cwd: session.getCwd(),
				globalDir,
				settings,
				sessionId: session.getSessionId(),
				extraEntries: (resources?.packages ?? []).flatMap((pkg) => pkg.extensions),
			});
			const commandLines =
				inspection.commands.length > 0
					? inspection.commands.map((command) => `  /${command.name} (${command.extensionId})`).join("\n")
					: "  (none)";
			const toolLines =
				inspection.tools.length > 0 ? inspection.tools.map((tool) => `  ${tool}`).join("\n") : "  (none)";
			const warningLines =
				inspection.warnings.length > 0
					? `\nwarnings:\n${inspection.warnings.map((warning) => `  ${warning}`).join("\n")}`
					: "";
			return {
				action: "continue",
				output: `configured extensions:\n${configured}\n\nloaded extension commands:\n${commandLines}\n\nloaded extension tools:\n${toolLines}${warningLines}`,
			};
		}

		case "packages": {
			const packages = resources?.packages ?? [];
			if (packages.length === 0) {
				return { action: "continue", output: "no resource packages loaded" };
			}
			const lines = packages.map((pkg) => {
				const counts = [
					pkg.prompts.length > 0 ? `${pkg.prompts.length} prompt dirs` : undefined,
					pkg.skills.length > 0 ? `${pkg.skills.length} skill dirs` : undefined,
					pkg.extensions.length > 0 ? `${pkg.extensions.length} extensions` : undefined,
					pkg.themes.length > 0 ? `${pkg.themes.length} themes` : undefined,
				]
					.filter(Boolean)
					.join(", ");
				return `  ${pkg.name} (${pkg.source})${counts ? ` - ${counts}` : ""}`;
			});
			return { action: "continue", output: lines.join("\n") };
		}

		case "skills": {
			if (!skills || skills.size === 0) {
				return { action: "continue", output: "no skills loaded" };
			}
			return { action: "continue", output: getSkillHelp(skills) };
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
				await exportFromSessionManager({ getEntries: () => entries, getHeader: () => header } as any, outputPath);
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
				`provider: ${getModelProviderForKey(settings.model) || settings.provider}`,
				`thinkingLevel: ${settings.thinkingLevel}`,
				`permissionMode: ${settings.permissionMode}`,
				`maxTurns: ${settings.maxTurns}`,
				`theme: ${settings.theme}`,
				`compaction: ${settings.compaction.enabled ? "enabled" : "disabled"}`,
				`retry: ${settings.retry.enabled ? `enabled (max ${settings.retry.maxRetries})` : "disabled"}`,
				`extensions: ${settings.extensions.length || "none"}`,
				`packages: ${settings.packages.length || "none"}`,
				`skills: ${settings.skills.length || "none"}`,
			];
			return { action: "continue", output: lines.join("\n") };
		}

		case "model": {
			if (!settings) {
				return { action: "continue", output: "model: settings not loaded" };
			}

			if (args[0] === "list") {
				if (!authStorage) {
					return { action: "continue", output: "model list: auth storage not initialized" };
				}
				const availability = await listModelAvailability(authStorage);
				return {
					action: "continue",
					output: availability
						.map((entry) => `  ${entry.key} (${entry.model.provider}) - ${entry.available ? "ok" : entry.reason}`)
						.join("\n"),
				};
			}

			if (args[0]) {
				const provider = getModelProviderForKey(args[0]);
				if (!provider) {
					return { action: "continue", output: `unknown model: ${args[0]}` };
				}
				settings.model = args[0];
				settings.provider = provider;
				await persistSettings?.({ model: args[0] }, "project");
				return {
					action: "continue",
					output: `current model: ${settings.model} (provider: ${provider})`,
				};
			}

			return {
				action: "continue",
				output: `current model: ${settings.model} (provider: ${getModelProviderForKey(settings.model) || settings.provider})\nrun /model list to inspect available models`,
			};
		}

		case "theme": {
			if (!themes) {
				return { action: "continue", output: "theme: themes not loaded" };
			}
			if (!args[0]) {
				const lines = [...themes.themes.values()].map((theme) => {
					const marker = theme.name === settings?.theme ? " <- current" : "";
					return `  ${theme.name} (${theme.source})${marker}`;
				});
				return { action: "continue", output: lines.join("\n") };
			}
			const selected = themes.themes.get(args[0]);
			if (!selected) {
				return { action: "continue", output: `unknown theme: ${args[0]}` };
			}
			if (settings) {
				settings.theme = selected.name;
				await persistSettings?.({ theme: selected.name }, "project");
			}
			return { action: "continue", output: `current theme: ${selected.name}` };
		}

		case "thinking": {
			if (!settings) {
				return { action: "continue", output: "thinking: settings not loaded" };
			}
			if (!args[0]) {
				return {
					action: "continue",
					output: [
						`current thinking level: ${settings.thinkingLevel}`,
						`available: ${THINKING_LEVELS.join(", ")}`,
						"tip: /thinking high",
					].join("\n"),
				};
			}
			const requested = args[0].toLowerCase();
			let nextLevel: (typeof THINKING_LEVELS)[number];
			if (requested === "next") {
				nextLevel = getNextThinkingLevel(settings.thinkingLevel, 1);
			} else if (requested === "prev" || requested === "previous") {
				nextLevel = getNextThinkingLevel(settings.thinkingLevel, -1);
			} else if (isThinkingLevel(requested)) {
				nextLevel = requested;
			} else {
				return {
					action: "continue",
					output: `unknown thinking level: ${args[0]} (expected one of: ${THINKING_LEVELS.join(", ")})`,
				};
			}
			settings.thinkingLevel = nextLevel;
			await persistSettings?.({ thinkingLevel: nextLevel }, "project");
			return {
				action: "continue",
				output: `current thinking level: ${nextLevel} — ${getThinkingLevelDescription(nextLevel)}`,
			};
		}

		case "templates": {
			if (!templates || templates.size === 0) {
				return { action: "continue", output: "no templates loaded" };
			}
			return { action: "continue", output: getTemplateHelp(templates) };
		}

		default: {
			if (skills) {
				const skill = findSkillByCommand(cmd, skills);
				if (skill) {
					const expanded = expandSkill(skill, args);
					return { action: "prompt", prompt: expanded, output: `[skill: ${skill.command}]` };
				}
			}

			// Check if it matches a prompt template
			if (templates) {
				const template = templates.get(cmd);
				if (template) {
					const expanded = expandTemplate(template, args);
					return { action: "prompt", prompt: expanded, output: `[template: ${cmd}]` };
				}
			}

			if (settings && globalDir && !disableExtensions) {
				const extensionResult = await runExtensionCommand({
					cwd: session.getCwd(),
					globalDir,
					settings,
					sessionId: session.getSessionId(),
					command: cmd,
					args: args.join(" "),
					extraEntries: (resources?.packages ?? []).flatMap((pkg) => pkg.extensions),
				});

				if (extensionResult.matched) {
					if (extensionResult.prompts.length > 0) {
						return {
							action: "prompt",
							prompt: extensionResult.prompts.join("\n\n"),
							output: extensionResult.output.join("\n") || `[extension: ${cmd}]`,
						};
					}
					return {
						action: "continue",
						output: extensionResult.output.join("\n") || `[extension: ${cmd}]`,
					};
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
