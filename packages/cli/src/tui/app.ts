import * as path from "node:path";
import {
	type AskDecision,
	type LoadResourcePackagesResult,
	type PermissionAskContext,
	type PromptTemplate,
	SessionManager,
	type SkillDefinition,
} from "@my-agent/core";
import { handleLogin } from "../commands/login.js";
import type { AuthStorage } from "../config/auth-storage.js";
import type { Settings } from "../config/settings.js";
import { saveSettings } from "../config/settings.js";
import { handleSlashCommand } from "../repl/slash-commands.js";
import { runAgent } from "../runtime/agent-runtime.js";
import { getModelProviderForKey, listModelAvailability } from "../runtime/model-registry.js";
import {
	Box,
	Editor,
	Footer,
	ProcessTerminal,
	SelectList,
	Spacer,
	StreamingMessage,
	TUI,
	Text,
	ToolExecution,
	UserMessage,
	createModelSelector,
	createSessionSelector,
	defaultAgentTheme,
} from "../ui/index.js";
import { type LoadThemesResult, loadThemes, resolveThemeSelection } from "../ui/theme-loader.js";

export interface TuiOptions {
	cwd: string;
	globalDir: string;
	settings: Settings;
	authStorage: AuthStorage;
	session: SessionManager;
	templates?: Map<string, PromptTemplate>;
	skills?: Map<string, SkillDefinition>;
	resources?: LoadResourcePackagesResult;
	themes: LoadThemesResult;
	safeMode?: boolean;
}

class InputDialog extends Box {
	private readonly messageText: Text;
	private readonly input: import("@mariozechner/pi-tui").Input;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(message: string, onSubmit: (value: string) => void, onCancel: () => void) {
		super(1, 1);
		this.messageText = new Text(message, 0, 0);
		this.input = new (requirePiTui().Input)();
		this.input.onSubmit = onSubmit;
		this.input.onEscape = onCancel;
		this.addChild(this.messageText);
		this.addChild(this.input);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

class DismissibleOverlay extends Box {
	constructor(
		text: string,
		private readonly onDismiss: () => void,
	) {
		super(1, 1);
		this.addChild(new Text(text, 0, 0));
	}

	handleInput(): void {
		this.onDismiss();
	}
}

export async function runTuiApp(options: TuiOptions): Promise<void> {
	const selectedTheme = await resolveThemeSelection(options.settings.theme, options.themes).catch(() => ({
		name: "default",
		source: "builtin" as const,
		theme: defaultAgentTheme,
	}));
	const theme = selectedTheme.theme;
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	const messages = new (requirePiTui().Container)();
	const editor = new Editor(tui, theme.editor);
	const footer = new Footer(
		{
			model: options.settings.model,
			mode: "normal",
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			thinking: false,
			statusText: options.safeMode ? "safe-mode" : undefined,
		},
		{ theme: theme.footer, onInvalidate: () => tui.requestRender() },
	);

	tui.addChild(messages);
	tui.addChild(new Spacer(1));
	tui.addChild(editor);
	tui.addChild(footer);
	tui.setFocus(editor);

	let session = options.session;
	let activeController: AbortController | null = null;
	let stopping = false;
	let resolveStopped: (() => void) | undefined;
	const pendingToolViews = new Map<string, ToolExecution>();

	const appendSystem = (text: string): void => {
		messages.addChild(new Text(text, 1, 0));
		tui.requestRender();
	};

	const appendUser = (text: string): void => {
		messages.addChild(new UserMessage(text, { theme: theme.userMessage, onInvalidate: () => tui.requestRender() }));
		tui.requestRender();
	};

	const promptInput = async (message: string): Promise<string> => {
		return await new Promise<string>((resolve) => {
			const dialog = new InputDialog(
				message,
				(value) => {
					handle.hide();
					tui.setFocus(editor);
					resolve(value);
				},
				() => {
					handle.hide();
					tui.setFocus(editor);
					resolve("");
				},
			);
			const handle = tui.showOverlay(dialog, { anchor: "center", width: "70%", maxHeight: 8 });
			tui.setFocus(dialog as any);
		});
	};

	const askPermission = async (ctx: PermissionAskContext): Promise<AskDecision> => {
		const location = ctx.command ?? ctx.filePath ?? JSON.stringify(ctx.args);
		const items = [
			{ value: "allow_once", label: "Allow once", description: location },
			{ value: "allow_session", label: "Allow for session", description: location },
			{ value: "deny", label: "Deny", description: location },
		];

		return await new Promise<AskDecision>((resolve) => {
			const list = new SelectList(items, items.length, theme.selectList);
			list.onSelect = (item) => {
				handle.hide();
				tui.setFocus(editor);
				resolve(item.value as AskDecision);
			};
			list.onCancel = () => {
				handle.hide();
				tui.setFocus(editor);
				resolve("deny");
			};
			const handle = tui.showOverlay(list, { anchor: "center", width: "70%", maxHeight: 8 });
		});
	};

	const runPrompt = async (prompt: string): Promise<void> => {
		appendUser(prompt);
		const assistant = new StreamingMessage({
			markdownTheme: theme.markdown,
			messageTheme: theme.assistantMessage,
			label: "Assistant",
			onInvalidate: () => tui.requestRender(),
		});
		messages.addChild(assistant);
		footer.setThinking(true);
		activeController = new AbortController();
		pendingToolViews.clear();

		try {
			const result = await runAgent(
				prompt,
				{
					cwd: options.cwd,
					settings: options.settings,
					authStorage: options.authStorage,
					session,
					signal: activeController.signal,
					askPermission,
					disableExtensions: options.safeMode,
					resourceExtensionEntries: options.resources?.packages.flatMap((pkg) => pkg.extensions) ?? [],
				},
				{
					onText: (text) => {
						assistant.appendToken(text);
						tui.requestRender();
					},
					onThinking: () => {
						footer.setThinking(true);
					},
					onToolStart: (toolName, toolCallId) => {
						const toolView = new ToolExecution(
							toolName,
							{},
							{ theme: theme.toolExecution, onInvalidate: () => tui.requestRender() },
						);
						toolView.setRunning();
						pendingToolViews.set(toolCallId, toolView);
						messages.addChild(toolView);
						tui.requestRender();
					},
					onToolEnd: (toolName, isError) => {
						const entry = [...pendingToolViews.entries()].find(([, view]) => view.getName() === toolName);
						if (!entry) return;
						const [, toolView] = entry;
						if (isError) {
							toolView.setError("Tool failed");
						} else {
							toolView.setSuccess("Tool completed", 0);
						}
						tui.requestRender();
					},
				},
			);

			assistant.finalize();
			if (result.error) {
				appendSystem(`error: ${result.error}`);
			}
			if (result.aborted) {
				appendSystem("aborted");
			}
		} finally {
			footer.setThinking(false);
			activeController = null;
			tui.requestRender();
		}
	};

	const openModelSelector = async (): Promise<void> => {
		const availability = await listModelAvailability(options.authStorage);
		const available = availability.filter((entry) => entry.available);
		if (available.length === 0) {
			appendSystem("No authenticated models available. Use /login or set OPENROUTER_API_KEY.");
			return;
		}

		createModelSelector(
			tui,
			available.map((entry) => ({
				id: entry.key,
				name: entry.model.name,
				provider: entry.model.provider,
				description: entry.reason ?? undefined,
				isDefault: entry.key === options.settings.model,
			})),
			{
				theme: theme.selectList,
				onSelect: async (model) => {
					options.settings.model = model.id;
					options.settings.provider = getModelProviderForKey(model.id) ?? options.settings.provider;
					await saveSettings({ model: model.id }, "project", options.cwd);
					footer.setModel(model.id);
					appendSystem(`model set to ${model.id}`);
				},
			},
		);
	};

	const openSessionSelector = async (): Promise<void> => {
		const sessions = await session.listSessionsForCwd();
		createSessionSelector(
			tui,
			sessions.map((item) => ({
				id: item.path,
				name: item.name || item.id,
				createdAt: item.created,
				lastActiveAt: item.modified,
				messageCount: item.messageCount,
				preview: item.firstMessage,
				isActive: item.path === session.getSessionFile(),
			})),
			{
				theme: theme.selectList,
				onSelect: async (result) => {
					if (result.kind === "new") {
						session = SessionManager.create(options.cwd);
						appendSystem(`new session ${session.getSessionId()}`);
						return;
					}
					session = SessionManager.open(result.session.id);
					appendSystem(`switched session -> ${result.session.id}`);
				},
			},
		);
	};

	const openProviderSelector = (): void => {
		const providers = options.authStorage.getOAuthProviders().map((provider) => ({
			value: provider.id,
			label: provider.name,
			description: provider.id,
		}));
		const list = new SelectList(providers, providers.length, theme.selectList);
		list.onSelect = async (item) => {
			handle.hide();
			tui.setFocus(editor);
			await login(item.value);
		};
		list.onCancel = () => {
			handle.hide();
			tui.setFocus(editor);
		};
		const handle = tui.showOverlay(list, { anchor: "center", width: "60%", maxHeight: 10 });
	};

	const login = async (providerId: string): Promise<void> => {
		const lines: string[] = [];
		try {
			await handleLogin(providerId, options.authStorage, (line) => lines.push(line), promptInput);
		} catch (error) {
			lines.push(`login failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		appendSystem(lines.join("\n"));
	};

	const showHelpOverlay = (): void => {
		const overlay = new DismissibleOverlay(
			[
				"my-agent TUI",
				"",
				"Slash commands:",
				"  /help",
				"  /login [provider]",
				"  /model [name]",
				"  /sessions",
				"  /tree",
				"  /theme [name]",
				"  /skills",
				"  /packages",
				"  /extensions",
				"  /quit",
				"",
				"Ctrl+C aborts the current run or exits when idle.",
				"Press any key to dismiss.",
			].join("\n"),
			() => {
				handle.hide();
				tui.setFocus(editor);
			},
		);
		const handle = tui.showOverlay(overlay, { anchor: "center", width: "70%", maxHeight: 18 });
	};

	const handleCommand = async (text: string): Promise<void> => {
		const trimmed = text.trim();
		if (trimmed === "/help" || trimmed === "/?") {
			showHelpOverlay();
			return;
		}
		if (trimmed === "/model") {
			await openModelSelector();
			return;
		}
		if (trimmed === "/sessions") {
			await openSessionSelector();
			return;
		}
		if (trimmed === "/login") {
			openProviderSelector();
			return;
		}

		const result = await handleSlashCommand(trimmed, {
			session,
			authStorage: options.authStorage,
			templates: options.templates,
			skills: options.skills,
			settings: options.settings,
			resources: options.resources,
			themes: options.themes,
			globalDir: options.globalDir,
			disableExtensions: options.safeMode,
			persistSettings: (next, scope) => saveSettings(next, scope ?? "project", options.cwd),
			promptInput,
		});

		if (!result) {
			await runPrompt(text);
			return;
		}

		if (result.output) appendSystem(result.output);
		if (result.action === "prompt") {
			await runPrompt(result.prompt);
			return;
		}
		if (result.action === "switch-session") {
			session = SessionManager.open(result.sessionPath);
			return;
		}
		if (result.action === "quit") {
			stopping = true;
			tui.stop();
			resolveStopped?.();
		}
	};

	editor.onSubmit = (value) => {
		const text = value.trim();
		editor.setText("");
		if (!text) return;
		void handleCommand(text);
	};

	tui.addInputListener((data) => {
		if (data === "\u0003") {
			if (activeController) {
				activeController.abort();
			} else if (!stopping) {
				stopping = true;
				tui.stop();
				resolveStopped?.();
			}
			return { consume: true };
		}
		return undefined;
	});

	appendSystem(`theme: ${selectedTheme.name}`);
	if (options.safeMode) {
		appendSystem("safe-mode enabled");
	}

	tui.start();
	await new Promise<void>((resolve) => {
		resolveStopped = resolve;
	});
}

function requirePiTui(): typeof import("@mariozechner/pi-tui") {
	return require("@mariozechner/pi-tui");
}

// Node ESM-friendly lazy require for Input/Container classes used in helper dialogs.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
