import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Chalk } from "chalk";
import {
	type AgentTheme,
	createTheme,
	defaultAgentTheme,
	defaultAssistantMessageTheme,
	defaultDiffViewerTheme,
	defaultFooterTheme,
	defaultUserMessageTheme,
} from "./theme.js";

const chalk = new Chalk({ level: 3 });
const SUPPORTED_THEME_FILES = /\.(json|mjs|cjs|js)$/i;

const BUILTIN_THEMES: Array<{ name: string; description: string; theme: AgentTheme }> = [
	{
		name: "default",
		description: "Built-in default theme",
		theme: defaultAgentTheme,
	},
	{
		name: "dark",
		description: "Built-in dark theme",
		theme: createTheme({
			footer: {
				...defaultFooterTheme,
				background: (text: string) => chalk.bgBlackBright.white(text),
				model: (text: string) => chalk.bold.white(text),
				mode: (text: string) => chalk.cyanBright(text),
			},
			assistantMessage: {
				...defaultAssistantMessageTheme,
				label: (text: string) => chalk.bold.greenBright(text),
			},
			userMessage: {
				...defaultUserMessageTheme,
				label: (text: string) => chalk.bold.blueBright(text),
			},
		}),
	},
	{
		name: "light",
		description: "Built-in light theme",
		theme: createTheme({
			footer: {
				...defaultFooterTheme,
				background: (text: string) => chalk.bgWhite.black(text),
				model: (text: string) => chalk.bold.black(text),
				mode: (text: string) => chalk.blue(text),
				separator: (text: string) => chalk.gray(text),
			},
			diffViewer: {
				...defaultDiffViewerTheme,
				header: (text: string) => chalk.bold.blue(text),
				hunkHeader: (text: string) => chalk.blue(text),
			},
		}),
	},
];

export interface LoadedTheme {
	name: string;
	description?: string;
	filePath?: string;
	source: "project" | "global" | "explicit" | "builtin";
	theme: AgentTheme;
}

export interface LoadThemesConfig {
	cwd: string;
	globalDir: string;
	extraEntries?: string[];
}

export interface LoadThemesResult {
	themes: Map<string, LoadedTheme>;
	warnings: string[];
}

export async function loadThemes(config: LoadThemesConfig): Promise<LoadThemesResult> {
	const themes = new Map<string, LoadedTheme>();
	const warnings: string[] = [];

	for (const builtin of BUILTIN_THEMES) {
		themes.set(builtin.name, {
			name: builtin.name,
			description: builtin.description,
			source: "builtin",
			theme: builtin.theme,
		});
	}

	for (const dir of [path.join(config.cwd, ".my-agent", "themes")]) {
		await loadThemeEntry(dir, "project", themes, warnings);
	}

	for (const entry of config.extraEntries ?? []) {
		await loadThemeEntry(entry, "explicit", themes, warnings);
	}

	await loadThemeEntry(path.join(config.globalDir, "themes"), "global", themes, warnings);

	return { themes, warnings };
}

export async function resolveThemeSelection(
	selection: string | undefined,
	result: LoadThemesResult,
): Promise<LoadedTheme> {
	const defaultTheme = result.themes.get("default") ?? {
		name: "default",
		source: "builtin" as const,
		theme: defaultAgentTheme,
	};

	if (!selection || selection === "default") {
		return defaultTheme;
	}

	const byName = result.themes.get(selection);
	if (byName) return byName;

	const stat = await safeStat(selection);
	if (stat?.isFile()) {
		return await loadSingleTheme(selection, "explicit");
	}

	return defaultTheme;
}

async function loadThemeEntry(
	entry: string,
	source: LoadedTheme["source"],
	themes: Map<string, LoadedTheme>,
	warnings: string[],
): Promise<void> {
	const stat = await safeStat(entry);
	if (!stat) return;

	if (stat.isFile()) {
		try {
			const theme = await loadSingleTheme(entry, source);
			if (!themes.has(theme.name)) themes.set(theme.name, theme);
		} catch (error) {
			warnings.push(`Failed to load theme ${entry}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return;
	}

	const files = await fs.readdir(entry);
	for (const file of files) {
		if (!SUPPORTED_THEME_FILES.test(file)) continue;
		const filePath = path.join(entry, file);
		try {
			const theme = await loadSingleTheme(filePath, source);
			if (!themes.has(theme.name)) themes.set(theme.name, theme);
		} catch (error) {
			warnings.push(`Failed to load theme ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

async function loadSingleTheme(filePath: string, source: LoadedTheme["source"]): Promise<LoadedTheme> {
	if (filePath.endsWith(".json")) {
		const raw = JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
		return compileDeclarativeTheme(raw, filePath, source);
	}

	const mod = (await import(pathToFileURL(path.resolve(filePath)).href)) as Record<string, unknown>;
	const exported = (mod.default ?? mod.theme ?? mod) as Record<string, unknown>;
	const name =
		typeof exported.name === "string" ? exported.name : path.basename(filePath).replace(/\.(json|mjs|cjs|js)$/i, "");
	const description = typeof exported.description === "string" ? exported.description : undefined;
	const overrides = (exported.overrides ?? exported.theme ?? exported) as Partial<AgentTheme>;

	return {
		name,
		description,
		filePath,
		source,
		theme: createTheme(overrides),
	};
}

function compileDeclarativeTheme(
	raw: Record<string, unknown>,
	filePath: string,
	source: LoadedTheme["source"],
): LoadedTheme {
	const name = typeof raw.name === "string" ? raw.name : path.basename(filePath).replace(/\.(json|mjs|cjs|js)$/i, "");
	const description = typeof raw.description === "string" ? raw.description : undefined;

	const compiled = createTheme({
		toolExecution: compileSection(raw.toolExecution as Record<string, unknown> | undefined),
		footer: compileSection(raw.footer as Record<string, unknown> | undefined),
		systemMessage: compileSection(raw.systemMessage as Record<string, unknown> | undefined),
		userMessage: compileSection(raw.userMessage as Record<string, unknown> | undefined),
		assistantMessage: compileSection(raw.assistantMessage as Record<string, unknown> | undefined),
		diffViewer: compileSection(raw.diffViewer as Record<string, unknown> | undefined),
		markdown: compileSection(raw.markdown as Record<string, unknown> | undefined),
		editor: {
			...compileSection(raw.editor as Record<string, unknown> | undefined),
			selectList: compileSection(
				((raw.editor as Record<string, unknown> | undefined)?.selectList as Record<string, unknown> | undefined) ??
					(raw.selectList as Record<string, unknown> | undefined),
			),
		},
		selectList: compileSection(raw.selectList as Record<string, unknown> | undefined),
	} as unknown as Partial<AgentTheme>);

	return {
		name,
		description,
		filePath,
		source,
		theme: compiled,
	};
}

function compileSection(section: Record<string, unknown> | undefined): Record<string, (text: string) => string> {
	if (!section) return {};
	const compiled: Record<string, (text: string) => string> = {};
	for (const [key, value] of Object.entries(section)) {
		if (typeof value === "function") {
			compiled[key] = value as (text: string) => string;
		} else if (typeof value === "string") {
			compiled[key] = compileStyle(value);
		}
	}
	return compiled;
}

function compileStyle(spec: string): (text: string) => string {
	const tokens = spec.split(/\s+/).filter(Boolean);
	return (text: string) => {
		let current: unknown = chalk;
		for (const token of tokens) {
			const next = (current as Record<string, unknown>)[token];
			if (!next) {
				throw new Error(`Unknown chalk style token: ${token}`);
			}
			current = next;
		}
		if (typeof current !== "function") {
			throw new Error(`Theme style does not resolve to a function: ${spec}`);
		}
		return (current as (value: string) => string)(text);
	};
}

async function safeStat(target: string): Promise<import("node:fs").Stats | undefined> {
	try {
		return await fs.stat(target);
	} catch {
		return undefined;
	}
}
