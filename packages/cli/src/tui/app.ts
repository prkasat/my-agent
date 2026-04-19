import * as path from "node:path";
import {
	type AskDecision,
	type LoadResourcePackagesResult,
	type PermissionAskContext,
	type PromptTemplate,
	SessionManager,
	type SessionTreeNode,
	type SkillDefinition,
} from "@my-agent/core";
import { handleLogin } from "../commands/login.js";
import type { AuthStorage } from "../config/auth-storage.js";
import type { Settings } from "../config/settings.js";
import { saveSettings } from "../config/settings.js";
import { handleSlashCommand } from "../repl/slash-commands.js";
import { runAgent } from "../runtime/agent-runtime.js";
import {
	formatModelResolutionError,
	getModelProviderForKey,
	listModelAvailability,
} from "../runtime/model-registry.js";
import { trace } from "../runtime/trace.js";
import {
	Box,
	Editor,
	Footer,
	MultiDiffViewer,
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
	parseMultiDiff,
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

	const extractDiff = (details: unknown): string | undefined => {
		if (!details || typeof details !== "object") return undefined;
		const maybeDiff = (details as { diff?: unknown }).diff;
		return typeof maybeDiff === "string" && maybeDiff.length > 0 ? maybeDiff : undefined;
	};

	const flattenTree = (
		nodes: SessionTreeNode[],
		prefix = "",
	): Array<{ value: string; label: string; description: string }> => {
		const items: Array<{ value: string; label: string; description: string }> = [];
		for (const [index, node] of nodes.entries()) {
			const isLast = index === nodes.length - 1;
			const branchPrefix = `${prefix}${isLast ? "└─" : "├─"}`;
			items.push({
				value: node.entry.id,
				label: `${branchPrefix} ${node.entry.id}`,
				description: node.entry.type,
			});
			items.push(...flattenTree(node.children, `${prefix}${isLast ? "  " : "│ "}`));
		}
		return items;
	};

	const runPrompt = async (prompt: string): Promise<void> => {
		trace("runtime", "tui.prompt.start", { promptLength: prompt.length });
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
					extensionUI: {
						select: async (items, uiOptions) => {
							return await new Promise<string | null>((resolve) => {
								const list = new SelectList(items, items.length, theme.selectList);
								list.onSelect = (item) => {
									handle.hide();
									tui.setFocus(editor);
									resolve(item.value);
								};
								list.onCancel = () => {
									handle.hide();
									tui.setFocus(editor);
									resolve(null);
								};
								const handle = tui.showOverlay(list, {
									anchor: "center",
									width: "70%",
									maxHeight: Math.max(8, items.length + (uiOptions?.title ? 2 : 0)),
								});
							});
						},
						confirm: async (message, uiOptions) => {
							return await new Promise<boolean>((resolve) => {
								const list = new SelectList(
									[
										{ value: "yes", label: "Yes", description: message },
										{ value: "no", label: "No", description: message },
									],
									2,
									theme.selectList,
								);
								list.onSelect = (item) => {
									handle.hide();
									tui.setFocus(editor);
									resolve(item.value === "yes");
								};
								list.onCancel = () => {
									handle.hide();
									tui.setFocus(editor);
									resolve(uiOptions?.defaultValue ?? false);
								};
								const handle = tui.showOverlay(list, { anchor: "center", width: "60%", maxHeight: 8 });
							});
						},
						input: async (message, uiOptions) => {
							const value = await promptInput(
								message + (uiOptions?.defaultValue ? ` (${uiOptions.defaultValue})` : ""),
							);
							return value || uiOptions?.defaultValue || null;
						},
						notify: (message) => appendSystem(message),
					},
				},
				{
					onText: (text) => {
						assistant.appendToken(text);
						tui.requestRender();
					},
					onThinking: () => {
						footer.setThinking(true);
					},
					onTurnEnd: ({ costs }) => {
						footer.setTokens(costs.totalInputTokens, costs.totalOutputTokens);
						footer.setCost(costs.totalCost);
					},
					onToolStart: (toolName, toolCallId, args) => {
						const toolView = new ToolExecution(
							toolName,
							typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
							{ theme: theme.toolExecution, onInvalidate: () => tui.requestRender() },
						);
						toolView.setRunning();
						pendingToolViews.set(toolCallId, toolView);
						messages.addChild(toolView);
						tui.requestRender();
					},
					onToolEnd: (_toolName, isError, info) => {
						const toolView = pendingToolViews.get(info.toolCallId);
						if (!toolView) return;
						const outputText =
							info.result?.content
								?.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join("\n") || (isError ? "Tool failed" : "Tool completed");
						if (isError) {
							toolView.setError(outputText, info.durationMs);
						} else {
							toolView.setSuccess(outputText, info.durationMs);
						}
						const diffText = extractDiff(info.result?.details);
						if (diffText) {
							const diffs = parseMultiDiff(diffText, toolView.getName());
							if (diffs.length > 0) {
								messages.addChild(
									new MultiDiffViewer(diffs, {
										theme: theme.diffViewer,
										maxLinesPerHunk: 12,
										onInvalidate: () => tui.requestRender(),
									}),
								);
							}
						}
						tui.requestRender();
					},
				},
			);

			assistant.finalize();
			footer.setTokens(result.profile.costs.totalInputTokens, result.profile.costs.totalOutputTokens);
			footer.setCost(result.profile.costs.totalCost);
			if (result.error) {
				appendSystem(`error: ${result.error}`);
			}
			if (result.aborted) {
				appendSystem("aborted");
			}
		} catch (error) {
			trace("runtime", "tui.prompt.error", { error: error instanceof Error ? error.message : String(error) });
			appendSystem(formatModelResolutionError(error));
		} finally {
			trace("runtime", "tui.prompt.end", { activeToolViews: pendingToolViews.size });
			footer.setThinking(false);
			activeController = null;
			tui.requestRender();
		}
	};

	const openModelSelector = async (): Promise<void> => {
		trace("runtime", "tui.overlay.open", { overlay: "model-selector" });
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
					trace("runtime", "tui.model.select", { model: model.id });
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
		trace("runtime", "tui.overlay.open", { overlay: "session-selector" });
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
						trace("runtime", "tui.session.new", {});
						session = SessionManager.create(options.cwd);
						appendSystem(`new session ${session.getSessionId()}`);
						return;
					}
					trace("runtime", "tui.session.switch", { sessionPath: result.session.id });
					session = SessionManager.open(result.session.id);
					appendSystem(`switched session -> ${result.session.id}`);
				},
			},
		);
	};

	const openTreeSelector = (): void => {
		trace("runtime", "tui.overlay.open", { overlay: "tree-selector" });
		const items = flattenTree(session.getTree());
		if (items.length === 0) {
			appendSystem("tree: empty session");
			return;
		}
		const currentLeafId = session.getLeafId();
		const list = new SelectList(
			items.map((item) => ({
				...item,
				label: item.value === currentLeafId ? `${item.label} (current)` : item.label,
			})),
			items.length,
			theme.selectList,
		);
		list.onSelect = (item) => {
			handle.hide();
			try {
				trace("runtime", "tui.tree.switch", { entryId: item.value });
				session.branch(item.value);
				appendSystem(`branch context set to ${item.value}`);
			} catch (error) {
				appendSystem(`tree switch failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			tui.setFocus(editor);
		};
		list.onCancel = () => {
			handle.hide();
			tui.setFocus(editor);
		};
		const handle = tui.showOverlay(list, { anchor: "center", width: "70%", maxHeight: 18 });
	};

	const openProviderSelector = (): void => {
		trace("runtime", "tui.overlay.open", { overlay: "provider-selector" });
		const providers = options.authStorage.getOAuthProviders().map((provider) => ({
			value: provider.id,
			label: provider.name,
			description: provider.id,
		}));
		const list = new SelectList(providers, providers.length, theme.selectList);
		list.onSelect = async (item) => {
			handle.hide();
			tui.setFocus(editor);
			trace("runtime", "tui.login.start", { providerId: item.value });
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
		trace("runtime", "tui.overlay.open", { overlay: "help" });
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
		if (trimmed === "/tree") {
			openTreeSelector();
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
