import {
	type AutocompleteItem,
	CombinedAutocompleteProvider,
	Key,
	type SlashCommand,
	matchesKey,
} from "@mariozechner/pi-tui";
import {
	type AskDecision,
	type LoadResourcePackagesResult,
	type PermissionAskContext,
	type PromptTemplate,
	type SessionEntry,
	SessionManager,
	type SessionTreeNode,
	type SkillDefinition,
	getToolPath,
} from "@my-agent/core";
import { handleLogin, isLoginCancelledError } from "../commands/login.js";
import type { AuthStorage } from "../config/auth-storage.js";
import type { Settings } from "../config/settings.js";
import { saveSettings } from "../config/settings.js";
import {
	THINKING_LEVELS,
	type ThinkingLevel,
	getNextThinkingLevel,
	getThinkingLevelDescription,
	isThinkingLevel,
} from "../config/thinking-levels.js";
import { handleSlashCommand, listSlashCommandSuggestions } from "../repl/slash-commands.js";
import { runAgent } from "../runtime/agent-runtime.js";
import {
	formatModelResolutionError,
	getModelProviderForKey,
	listModelAvailability,
	resolveConfiguredModel,
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
	SystemMessage,
	type SystemMessageVariant,
	TUI,
	Text,
	TimelineMarker,
	ToolExecution,
	UserMessage,
	createModelSelector,
	createSessionSelector,
	createTreeSelector,
	defaultAgentTheme,
	parseMultiDiff,
} from "../ui/index.js";
import { type LoadThemesResult, resolveThemeSelection } from "../ui/theme-loader.js";

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

function filterAutocompleteItems(items: AutocompleteItem[], prefix: string): AutocompleteItem[] {
	const query = prefix.trim().toLowerCase();
	if (!query) return items;

	const ranked = items
		.map((item) => {
			const value = item.value.toLowerCase();
			const label = item.label.toLowerCase();
			const prefixMatch = value.startsWith(query) || label.startsWith(query);
			const containsMatch = value.includes(query) || label.includes(query);
			const score = prefixMatch ? 2 : containsMatch ? 1 : 0;
			return { item, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.item.value.localeCompare(b.item.value));

	return ranked.map((entry) => entry.item);
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

	const refreshFooterStatus = (): void => {
		const prefixes = [options.safeMode ? "safe-mode" : undefined, `thinking: ${options.settings.thinkingLevel}`].filter(
			Boolean,
		);
		const prefixText = prefixes.length > 0 ? `${prefixes.join(" · ")} · ` : "";
		footer.setStatusText(`${prefixText}Tab autocomplete · F1 help`);
	};

	const thinkingMessageTheme = {
		...theme.assistantMessage,
		text: (text: string) => (theme.systemMessage.muted ?? ((value: string) => value))(text),
		border: theme.footer.thinking,
		title: theme.footer.thinking,
		background: theme.toolExecution.pendingBackground ?? theme.assistantMessage.background,
	};

	let session = options.session;
	let activeController: AbortController | null = null;
	let loginController: AbortController | null = null;
	let cancelActivePromptInput: (() => void) | null = null;
	let stopping = false;
	let tuiStopped = false;
	let resolveStopped: (() => void) | undefined;
	const pendingToolViews = new Map<string, ToolExecution>();
	const allToolViews: ToolExecution[] = [];
	const allThinkingViews: StreamingMessage[] = [];

	const safeStop = (): void => {
		if (tuiStopped) return;
		tuiStopped = true;
		try {
			tui.stop();
		} catch {
			// Ignore cleanup errors while restoring the terminal.
		}
	};

	const appendRich = (component: { invalidate?: () => void }): void => {
		const lastChild = messages.children[messages.children.length - 1];
		if (lastChild && !(lastChild instanceof Spacer)) {
			messages.addChild(new Spacer(1));
		}
		messages.addChild(component as any);
		tui.requestRender();
	};

	const removeRich = (component: { invalidate?: () => void }): void => {
		const index = messages.children.indexOf(component as any);
		if (index === -1) return;
		const previous = index > 0 ? messages.children[index - 1] : undefined;
		messages.removeChild(component as any);
		if (previous instanceof Spacer) {
			messages.removeChild(previous);
		}
		tui.requestRender();
	};

	const appendSystem = (text: string, variant: SystemMessageVariant = "info"): void => {
		messages.addChild(
			new SystemMessage(text, {
				theme: theme.systemMessage,
				variant,
				onInvalidate: () => tui.requestRender(),
			}),
		);
		tui.requestRender();
	};

	const toggleAllToolExpansion = (): void => {
		if (allToolViews.length === 0) return;
		const shouldExpand = allToolViews.some((view) => !view.getState().expanded);
		for (const view of allToolViews) {
			view.setExpanded(shouldExpand);
		}
		tui.requestRender();
	};

	const toggleAllThinkingBlocks = (): void => {
		if (allThinkingViews.length === 0) return;
		const shouldCollapse = allThinkingViews.some((view) => !view.getCollapsed());
		for (const view of allThinkingViews) {
			view.setCollapsed(shouldCollapse);
		}
		tui.requestRender();
	};

	const reportError = (error: unknown, context?: string): void => {
		const message = formatModelResolutionError(error);
		appendSystem(context ? `${context}: ${message}` : message, "error");
	};

	const invokeSafely = (task: () => Promise<void> | void, context?: string): void => {
		void Promise.resolve()
			.then(task)
			.catch((error) => {
				trace("runtime", "tui.handler.error", {
					context: context ?? "async-handler",
					error: error instanceof Error ? error.message : String(error),
				});
				reportError(error, context);
			});
	};

	const appendUser = (text: string): void => {
		appendRich(new UserMessage(text, { theme: theme.userMessage, label: "", onInvalidate: () => tui.requestRender() }));
	};

	const promptInput = async (message: string): Promise<string> => {
		return await new Promise<string>((resolve) => {
			let settled = false;
			const finish = (value: string) => {
				if (settled) return;
				settled = true;
				cancelActivePromptInput = null;
				handle.hide();
				tui.setFocus(editor);
				resolve(value);
			};
			const dialog = new InputDialog(
				message,
				(value) => finish(value),
				() => finish(""),
			);
			const handle = tui.showOverlay(dialog, { anchor: "center", width: "70%", maxHeight: 8 });
			cancelActivePromptInput = () => finish("");
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

	const normalizeTreePreview = (text: string): string =>
		text
			.replace(/[\r\n\t]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();

	const extractTreeTextPreview = (content: unknown, maxLength = 120): string => {
		if (typeof content === "string") {
			return normalizeTreePreview(content).slice(0, maxLength);
		}
		if (!Array.isArray(content)) return "";

		let result = "";
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			if ((block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
				result += ` ${(block as { text: string }).text}`;
			}
		}

		return normalizeTreePreview(result).slice(0, maxLength);
	};

	const getTreeAutocompletePreview = (entry: SessionEntry): string => {
		switch (entry.type) {
			case "message": {
				switch (entry.message.role) {
					case "user": {
						const text = extractTreeTextPreview((entry.message as { content?: unknown }).content);
						return `user: ${text || "(empty message)"}`;
					}
					case "assistant": {
						const assistant = entry.message as { content?: unknown; errorMessage?: unknown; stopReason?: unknown };
						const text = extractTreeTextPreview(assistant.content);
						const fallback =
							typeof assistant.errorMessage === "string" && assistant.errorMessage.trim().length > 0
								? assistant.errorMessage.trim()
								: assistant.stopReason === "aborted"
									? "aborted"
									: "(tool-only step)";
						return `assistant: ${text || fallback}`;
					}
					case "toolResult": {
						const toolMessage = entry.message as { toolName?: unknown; content?: unknown; isError?: unknown };
						const toolName = typeof toolMessage.toolName === "string" ? toolMessage.toolName : "tool";
						const text = extractTreeTextPreview(toolMessage.content);
						const prefix = toolMessage.isError ? `[${toolName} error]` : `[${toolName}]`;
						return text ? `${prefix} ${text}` : prefix;
					}
					default: {
						const text = extractTreeTextPreview((entry.message as { content?: unknown }).content);
						return text ? `${entry.message.role}: ${text}` : entry.message.role;
					}
				}
			}
			case "branch_summary":
				return `branch summary: ${normalizeTreePreview(entry.summary)}`;
			case "compaction":
				return `compaction: ${normalizeTreePreview(entry.summary || `summarized ${Math.round(entry.tokensBefore / 1000)}k tokens`)}`;
			case "settings_change": {
				const changes = [
					entry.model ? `model ${entry.model.modelId}` : undefined,
					entry.thinkingLevel ? `thinking ${entry.thinkingLevel}` : undefined,
				]
					.filter(Boolean)
					.join(" · ");
				return `settings: ${changes || "updated"}`;
			}
			case "session_info":
				return `session: ${entry.name?.trim() || "title updated"}`;
			case "label":
				return entry.label?.trim()
					? `label: ${entry.label.trim()} → ${entry.targetId}`
					: `label cleared from ${entry.targetId}`;
			case "extension":
				return `extension: ${entry.namespace}${entry.subtype ? `/${entry.subtype}` : ""}`;
			default:
				return "entry";
		}
	};

	const buildTreeAutocompleteItems = (
		nodes: SessionTreeNode[],
		currentLeafId: string | null,
		ancestorIsLast: boolean[] = [],
	): Array<{ value: string; label: string; description: string }> => {
		const items: Array<{ value: string; label: string; description: string }> = [];
		for (const [index, node] of nodes.entries()) {
			const isLast = index === nodes.length - 1;
			const treePrefix = `${ancestorIsLast.map((value) => (value ? "  " : "│ ")).join("")}${isLast ? "└─" : "├─"}`;
			const label = session.getLabel(node.entry.id);
			const currentMarker = node.entry.id === currentLeafId ? "● " : "";
			const preview = getTreeAutocompletePreview(node.entry);
			items.push({
				value: node.entry.id,
				label: `${treePrefix} ${currentMarker}${label ? `[${label}] ` : ""}${preview}`,
				description: `${node.entry.id} · ${node.entry.type}${node.entry.id === currentLeafId ? " · current" : ""}`,
			});
			items.push(...buildTreeAutocompleteItems(node.children, currentLeafId, [...ancestorIsLast, isLast]));
		}
		return items;
	};

	const slashCommands: SlashCommand[] = [
		{ name: "help", description: "Show the help overlay" },
		{ name: "quit", description: "Exit the TUI" },
		{ name: "sessions", description: "Open the session selector" },
		{
			name: "tree",
			description: "Show the current session tree or switch branches",
			getArgumentCompletions: async (prefix) => {
				const items = buildTreeAutocompleteItems(session.getTree(), session.getLeafId()).map((item) => ({
					value: `switch ${item.value}`,
					label: item.label,
					description: item.description,
				}));
				return filterAutocompleteItems(items, prefix);
			},
		},
		{
			name: "login",
			description: "Login with an OAuth provider",
			getArgumentCompletions: async (prefix) => {
				const items = options.authStorage.getOAuthProviders().map((provider) => ({
					value: provider.id,
					label: provider.id,
					description: provider.name,
				}));
				return filterAutocompleteItems(items, prefix);
			},
		},
		{
			name: "logout",
			description: "Logout from an OAuth provider",
			getArgumentCompletions: async (prefix) => {
				const providers = await options.authStorage.listProviders();
				const items = providers.map((providerId) => ({
					value: providerId,
					label: providerId,
					description: "Logged-in provider",
				}));
				return filterAutocompleteItems(items, prefix);
			},
		},
		{
			name: "model",
			description: "Show or change the current model",
			getArgumentCompletions: async (prefix) => {
				const availability = await listModelAvailability(options.authStorage);
				const items = availability.map((entry) => ({
					value: entry.key,
					label: entry.key,
					description: entry.available
						? `${entry.model.provider} · ready`
						: `${entry.model.provider} · ${entry.reason ?? "unavailable"}`,
				}));
				return filterAutocompleteItems(items, prefix);
			},
		},
		{
			name: "theme",
			description: "Show or change the current theme",
			getArgumentCompletions: async (prefix) => {
				const items = [...options.themes.themes.values()].map((themeOption) => ({
					value: themeOption.name,
					label: themeOption.name,
					description: themeOption.source,
				}));
				return filterAutocompleteItems(items, prefix);
			},
		},
		{
			name: "thinking",
			description: "Show or change thinking level",
			getArgumentCompletions: async (prefix) => {
				const items = THINKING_LEVELS.map((level) => ({
					value: level,
					label: level,
					description: getThinkingLevelDescription(level),
				}));
				return filterAutocompleteItems(items, prefix);
			},
		},
		{ name: "settings", description: "Show current settings" },
		{ name: "extensions", description: "Show configured extensions" },
		{ name: "packages", description: "Show loaded resource packages" },
		{ name: "skills", description: "List loaded skills" },
		{ name: "templates", description: "List prompt templates" },
		{ name: "export", description: "Export the current session" },
	];
	for (const command of listSlashCommandSuggestions({ templates: options.templates, skills: options.skills })) {
		const name = command.value.startsWith("/") ? command.value.slice(1) : command.value;
		if (name.length === 0 || name.includes(" ")) continue;
		if (!slashCommands.some((entry) => entry.name === name)) {
			slashCommands.push({ name, description: command.description });
		}
	}
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, options.cwd, getToolPath("fd")));
	editor.setAutocompleteMaxVisible(8);
	refreshFooterStatus();

	const runPrompt = async (prompt: string): Promise<void> => {
		trace("runtime", "tui.prompt.start", { promptLength: prompt.length });
		appendUser(prompt);
		footer.setThinking(true);
		activeController = new AbortController();
		pendingToolViews.clear();

		type TurnUiState = {
			turnIndex: number;
			marker?: TimelineMarker;
			waiting?: SystemMessage;
			thinking?: StreamingMessage;
			assistant?: StreamingMessage;
		};
		let currentTurn: TurnUiState | null = null;

		const clearWaiting = (turn = currentTurn): void => {
			if (!turn?.waiting) return;
			removeRich(turn.waiting);
			turn.waiting = undefined;
		};

		const finalizeThinkingView = (turn = currentTurn): void => {
			if (turn?.thinking?.getIsStreaming()) {
				turn.thinking.finalize();
			}
		};

		const finalizeAssistantView = (turn = currentTurn): void => {
			if (turn?.assistant?.getIsStreaming()) {
				turn.assistant.finalize();
			}
		};

		const finalizeTurn = (turn = currentTurn): void => {
			if (!turn) return;
			clearWaiting(turn);
			finalizeThinkingView(turn);
			finalizeAssistantView(turn);
			if (currentTurn === turn) currentTurn = null;
			tui.requestRender();
		};

		const startTurn = (turnIndex: number): TurnUiState => {
			finalizeTurn();
			const marker = new TimelineMarker(`Turn ${turnIndex + 1}`, {
				theme: theme.systemMessage,
				onInvalidate: () => tui.requestRender(),
			});
			appendRich(marker);
			const waiting = new SystemMessage("Thinking…", {
				theme: theme.systemMessage,
				variant: "muted",
				onInvalidate: () => tui.requestRender(),
			});
			appendRich(waiting);
			currentTurn = { turnIndex, marker, waiting };
			footer.setThinking(true);
			return currentTurn;
		};

		const ensureTurn = (): TurnUiState => currentTurn ?? startTurn(0);

		const ensureThinkingView = (): StreamingMessage => {
			const turn = ensureTurn();
			clearWaiting(turn);
			if (!turn.thinking) {
				turn.thinking = new StreamingMessage({
					markdownTheme: theme.markdown,
					messageTheme: thinkingMessageTheme,
					collapsible: true,
					collapsedPreviewLines: 2,
					onInvalidate: () => tui.requestRender(),
				});
				allThinkingViews.push(turn.thinking);
				appendRich(turn.thinking);
			}
			return turn.thinking;
		};

		const ensureAssistantView = (): StreamingMessage => {
			const turn = ensureTurn();
			clearWaiting(turn);
			finalizeThinkingView(turn);
			if (!turn.assistant) {
				turn.assistant = new StreamingMessage({
					markdownTheme: theme.markdown,
					messageTheme: theme.assistantMessage,
					onInvalidate: () => tui.requestRender(),
				});
				appendRich(turn.assistant);
			}
			return turn.assistant;
		};

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
					onTurnStart: (turnIndex) => {
						startTurn(turnIndex);
					},
					onText: (text) => {
						ensureAssistantView().appendToken(text);
						footer.setThinking(false);
						tui.requestRender();
					},
					onThinking: (text) => {
						footer.setThinking(true);
						ensureThinkingView().appendToken(text);
						tui.requestRender();
					},
					onTurnEnd: ({ costs }) => {
						footer.setTokens(costs.totalInputTokens, costs.totalOutputTokens);
						footer.setCost(costs.totalCost);
						finalizeTurn();
						footer.setThinking(false);
					},
					onToolStart: (toolName, toolCallId, args) => {
						const turn = ensureTurn();
						clearWaiting(turn);
						finalizeThinkingView(turn);
						const toolView = new ToolExecution(
							toolName,
							typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
							{
								theme: theme.toolExecution,
								maxExpandedLines: 40,
								maxInputLines: 10,
								maxCollapsedPreviewLines: 3,
								onInvalidate: () => tui.requestRender(),
							},
						);
						toolView.setRunning();
						pendingToolViews.set(toolCallId, toolView);
						allToolViews.push(toolView);
						appendRich(toolView);
						footer.setThinking(false);
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
								appendRich(
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

			finalizeTurn();
			footer.setTokens(result.profile.costs.totalInputTokens, result.profile.costs.totalOutputTokens);
			footer.setCost(result.profile.costs.totalCost);
			if (result.error) {
				appendSystem(result.error, "error");
			}
			if (result.aborted) {
				appendSystem("aborted", "warning");
			}
		} catch (error) {
			trace("runtime", "tui.prompt.error", { error: error instanceof Error ? error.message : String(error) });
			reportError(error);
		} finally {
			finalizeTurn();
			trace("runtime", "tui.prompt.end", { activeToolViews: pendingToolViews.size });
			footer.setThinking(false);
			activeController = null;
			tui.requestRender();
		}
	};

	const setThinkingLevel = async (level: ThinkingLevel): Promise<void> => {
		options.settings.thinkingLevel = level;
		await saveSettings({ thinkingLevel: level }, "project", options.cwd);
		refreshFooterStatus();
		appendSystem(`thinking level set to ${level} — ${getThinkingLevelDescription(level)}`, "success");
	};

	const openThinkingSelector = (): void => {
		trace("runtime", "tui.overlay.open", { overlay: "thinking-selector" });
		const items = THINKING_LEVELS.map((level) => ({
			value: level,
			label: level === options.settings.thinkingLevel ? `${level} (current)` : level,
			description: getThinkingLevelDescription(level),
		}));
		const list = new SelectList(items, items.length, theme.selectList);
		list.onSelect = (item) => {
			handle.hide();
			tui.setFocus(editor);
			invokeSafely(async () => {
				if (isThinkingLevel(item.value) && item.value !== options.settings.thinkingLevel) {
					await setThinkingLevel(item.value);
				}
			}, "thinking selector");
		};
		list.onCancel = () => {
			handle.hide();
			tui.setFocus(editor);
		};
		const handle = tui.showOverlay(list, { anchor: "center", width: "60%", maxHeight: 10 });
	};

	const openModelSelector = async (): Promise<void> => {
		trace("runtime", "tui.overlay.open", { overlay: "model-selector" });
		const availability = await listModelAvailability(options.authStorage);
		const available = availability.filter((entry) => entry.available);
		if (available.length === 0) {
			appendSystem("No authenticated models available. Use /login or set OPENROUTER_API_KEY.", "warning");
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
				onSelect: (model) => {
					invokeSafely(async () => {
						trace("runtime", "tui.model.select", { model: model.id });
						options.settings.model = model.id;
						options.settings.provider = getModelProviderForKey(model.id) ?? options.settings.provider;
						await saveSettings({ model: model.id }, "project", options.cwd);
						footer.setModel(model.id);
						appendSystem(`model set to ${model.id}`, "success");
					}, "model selection");
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
				onSelect: (result) => {
					invokeSafely(async () => {
						if (result.kind === "new") {
							trace("runtime", "tui.session.new", {});
							session = SessionManager.create(options.cwd);
							appendSystem(`new session ${session.getSessionId()}`, "success");
							return;
						}
						trace("runtime", "tui.session.switch", { sessionPath: result.session.id });
						session = SessionManager.open(result.session.id);
						appendSystem(`switched session -> ${result.session.id}`, "success");
					}, "session switch");
				},
			},
		);
	};

	const openTreeSelector = (): void => {
		trace("runtime", "tui.overlay.open", { overlay: "tree-selector" });
		const tree = session.getTree();
		if (tree.length === 0) {
			appendSystem("tree: empty session", "warning");
			return;
		}
		createTreeSelector(tui, tree, {
			theme,
			currentLeafId: session.getLeafId(),
			getLabel: (entryId) => session.getLabel(entryId),
			maxVisibleRows: 8,
			maxDetailLines: 5,
			width: "84%",
			maxHeight: 24,
			onSelect: (entryId) => {
				try {
					trace("runtime", "tui.tree.switch", { entryId });
					session.branch(entryId);
					appendSystem(`branch context set to ${entryId}`, "success");
				} catch (error) {
					reportError(error, "tree switch failed");
				} finally {
					tui.setFocus(editor);
				}
			},
			onCancel: () => {
				tui.setFocus(editor);
			},
		});
	};

	const openProviderSelector = (): void => {
		trace("runtime", "tui.overlay.open", { overlay: "provider-selector" });
		const providers = options.authStorage.getOAuthProviders().map((provider) => ({
			value: provider.id,
			label: provider.name,
			description: provider.id,
		}));
		const list = new SelectList(providers, providers.length, theme.selectList);
		list.onSelect = (item) => {
			handle.hide();
			tui.setFocus(editor);
			trace("runtime", "tui.login.start", { providerId: item.value });
			invokeSafely(() => login(item.value), "login");
		};
		list.onCancel = () => {
			handle.hide();
			tui.setFocus(editor);
		};
		const handle = tui.showOverlay(list, { anchor: "center", width: "60%", maxHeight: 10 });
	};

	const login = async (providerId: string): Promise<void> => {
		const controller = new AbortController();
		loginController = controller;
		try {
			await handleLogin(providerId, options.authStorage, appendSystem, promptInput, controller.signal);
		} catch (error) {
			appendSystem(
				isLoginCancelledError(error)
					? "Login cancelled."
					: `login failed: ${error instanceof Error ? error.message : String(error)}`,
				isLoginCancelledError(error) ? "warning" : "error",
			);
		} finally {
			if (loginController === controller) {
				loginController = null;
			}
		}
	};

	const showHelpOverlay = (): void => {
		trace("runtime", "tui.overlay.open", { overlay: "help" });
		const overlay = new DismissibleOverlay(
			[
				"my-agent TUI",
				"",
				"Prompting:",
				"  Type in the editor below and press Enter to send.",
				"  Tab autocompletes slash commands and common arguments.",
				"  Up/Down cycle prompt history.",
				"",
				"Slash commands:",
				"  /help",
				"  /login [provider]",
				"  /model [name]",
				"  /sessions",
				"  /tree",
				"  /theme [name]",
				"  /thinking [level]",
				"  /skills",
				"  /packages",
				"  /extensions",
				"  /quit",
				"",
				"Shortcuts:",
				"  F1           Help",
				"  F2           Model selector",
				"  F3           Session selector",
				"  F4           Tree selector",
				"  F5           Login selector",
				"  F6           Thinking selector",
				"  Shift+Tab    Cycle thinking level",
				"  Ctrl+O       Expand/collapse tool output",
				"  Ctrl+T       Expand/collapse thinking blocks",
				"  Ctrl+C       Abort run / exit when idle",
				"",
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
		if (trimmed === "/thinking") {
			openThinkingSelector();
			return;
		}

		const slashLoginController = trimmed === "/login" || trimmed.startsWith("/login ") ? new AbortController() : null;
		if (slashLoginController) {
			loginController = slashLoginController;
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
			printLine: appendSystem,
			loginSignal: slashLoginController?.signal,
		});
		if (slashLoginController && loginController === slashLoginController) {
			loginController = null;
		}

		if (!result) {
			await runPrompt(text);
			return;
		}

		refreshFooterStatus();
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
			safeStop();
			resolveStopped?.();
		}
	};

	editor.onSubmit = (value) => {
		const text = value.trim();
		editor.setText("");
		if (!text) return;
		editor.addToHistory(text);
		invokeSafely(() => handleCommand(text), "command");
	};

	const exitFatal = (error: unknown, origin: string): void => {
		trace("runtime", "tui.fatal", {
			origin,
			error: error instanceof Error ? error.message : String(error),
		});
		safeStop();
		process.stderr.write(`fatal (${origin}): ${formatModelResolutionError(error)}\n`);
		process.exit(1);
	};
	const onUncaughtException = (error: Error) => exitFatal(error, "uncaughtException");
	const onUnhandledRejection = (reason: unknown) => exitFatal(reason, "unhandledRejection");
	const onSigterm = () => {
		safeStop();
		process.exit(143);
	};

	process.on("uncaughtException", onUncaughtException);
	process.on("unhandledRejection", onUnhandledRejection);
	process.on("SIGTERM", onSigterm);

	tui.addInputListener((data) => {
		if (matchesKey(data, Key.f1)) {
			showHelpOverlay();
			return { consume: true };
		}
		if (matchesKey(data, Key.f2)) {
			invokeSafely(() => openModelSelector(), "model selector");
			return { consume: true };
		}
		if (matchesKey(data, Key.f3)) {
			invokeSafely(() => openSessionSelector(), "session selector");
			return { consume: true };
		}
		if (matchesKey(data, Key.f4)) {
			openTreeSelector();
			return { consume: true };
		}
		if (matchesKey(data, Key.f5)) {
			openProviderSelector();
			return { consume: true };
		}
		if (matchesKey(data, Key.f6)) {
			openThinkingSelector();
			return { consume: true };
		}
		if (matchesKey(data, Key.shift("tab"))) {
			invokeSafely(async () => {
				await setThinkingLevel(getNextThinkingLevel(options.settings.thinkingLevel, 1));
			}, "thinking cycle");
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("o"))) {
			toggleAllToolExpansion();
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("t"))) {
			toggleAllThinkingBlocks();
			return { consume: true };
		}
		if (data === "\u0003") {
			if (activeController) {
				activeController.abort();
			} else if (loginController) {
				cancelActivePromptInput?.();
				loginController.abort();
			} else if (!stopping) {
				stopping = true;
				safeStop();
				resolveStopped?.();
			}
			return { consume: true };
		}
		return undefined;
	});

	appendSystem(`my-agent TUI · theme ${selectedTheme.name}`, "muted");
	appendSystem(
		"Tab autocompletes slash commands, models, themes, tree ids, and thinking levels. F1 help · F6 thinking · Shift+Tab cycles thinking · Ctrl+O tools · Ctrl+T thinking.",
		"muted",
	);
	try {
		const resolved = await resolveConfiguredModel(options.settings, options.authStorage);
		appendSystem(`ready: ${resolved.key} via ${resolved.model.provider}`, "success");
	} catch {
		appendSystem("no model connected yet — use /login or set OPENROUTER_API_KEY, then /model", "warning");
	}
	if (options.safeMode) {
		appendSystem("safe-mode enabled", "warning");
	}

	try {
		tui.start();
		await new Promise<void>((resolve) => {
			resolveStopped = resolve;
		});
	} finally {
		process.off("uncaughtException", onUncaughtException);
		process.off("unhandledRejection", onUnhandledRejection);
		process.off("SIGTERM", onSigterm);
		safeStop();
	}
}

function requirePiTui(): typeof import("@mariozechner/pi-tui") {
	return require("@mariozechner/pi-tui");
}

// Node ESM-friendly lazy require for Input/Container classes used in helper dialogs.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
