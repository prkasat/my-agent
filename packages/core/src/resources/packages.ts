import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ResourcePackageManifest {
	name: string;
	description?: string;
	prompts?: string[];
	skills?: string[];
	extensions?: string[];
	themes?: string[];
}

export interface ResourcePackage {
	name: string;
	description?: string;
	rootDir: string;
	manifestPath?: string;
	source: "project" | "global" | "explicit";
	prompts: string[];
	skills: string[];
	extensions: string[];
	themes: string[];
}

export interface LoadResourcePackagesConfig {
	cwd: string;
	globalDir: string;
	entries?: string[];
}

export interface LoadResourcePackagesResult {
	packages: ResourcePackage[];
	warnings: string[];
}

const MANIFEST_FILES = ["my-agent.package.json", "my-agent-package.json", "package.json"];
const SUPPORTED_SCRIPT_FILES = /\.(mjs|cjs|js)$/i;
const SUPPORTED_THEME_FILES = /\.(json|mjs|cjs|js)$/i;

export async function loadResourcePackages(config: LoadResourcePackagesConfig): Promise<LoadResourcePackagesResult> {
	const warnings: string[] = [];
	const loaded = new Map<string, ResourcePackage>();

	const candidates = [
		...(config.entries ?? []),
		path.join(config.cwd, ".my-agent", "packages"),
		path.join(config.globalDir, "packages"),
	];

	for (const candidate of candidates) {
		for (const resolved of resolveCandidatePaths(candidate, config.cwd, config.globalDir)) {
			await discoverPackagesAt(resolved, classifySource(resolved, config.cwd, config.globalDir), loaded, warnings);
		}
	}

	return {
		packages: [...loaded.values()].sort((a, b) => a.name.localeCompare(b.name)),
		warnings,
	};
}

async function discoverPackagesAt(
	target: string,
	source: ResourcePackage["source"],
	loaded: Map<string, ResourcePackage>,
	warnings: string[],
): Promise<void> {
	const stat = await safeStat(target);
	if (!stat) return;

	if (stat.isFile()) {
		const pkg = await loadPackageFromPath(path.dirname(target), target, source, warnings);
		if (pkg) loaded.set(pkg.rootDir, pkg);
		return;
	}

	const direct = await loadPackageFromPath(target, undefined, source, warnings);
	if (direct) {
		loaded.set(direct.rootDir, direct);
		return;
	}

	try {
		const children = await fs.readdir(target);
		for (const child of children) {
			const childPath = path.join(target, child);
			const childStat = await safeStat(childPath);
			if (!childStat) continue;

			if (childStat.isDirectory()) {
				const nested = await loadPackageFromPath(childPath, undefined, source, warnings);
				if (nested) loaded.set(nested.rootDir, nested);
			} else if (childStat.isFile() && MANIFEST_FILES.includes(path.basename(childPath))) {
				const pkg = await loadPackageFromPath(path.dirname(childPath), childPath, source, warnings);
				if (pkg) loaded.set(pkg.rootDir, pkg);
			}
		}
	} catch {
		// ignore unreadable directories
	}
}

async function loadPackageFromPath(
	rootDir: string,
	explicitManifestPath: string | undefined,
	source: ResourcePackage["source"],
	warnings: string[],
): Promise<ResourcePackage | undefined> {
	const manifestPath = explicitManifestPath ?? (await findManifest(rootDir));
	if (manifestPath) {
		try {
			const manifest = await parseManifest(manifestPath);
			return normalizePackage(rootDir, manifestPath, source, manifest);
		} catch (error) {
			warnings.push(
				`Failed to load package manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

	const inferred = await inferPackage(rootDir, source);
	return inferred;
}

async function findManifest(rootDir: string): Promise<string | undefined> {
	for (const name of MANIFEST_FILES) {
		const candidate = path.join(rootDir, name);
		const stat = await safeStat(candidate);
		if (stat?.isFile()) return candidate;
	}
	return undefined;
}

async function parseManifest(manifestPath: string): Promise<ResourcePackageManifest> {
	const raw = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as Record<string, unknown>;

	if (path.basename(manifestPath) === "package.json") {
		const myAgent = (raw.myAgent ?? raw["my-agent"]) as Record<string, unknown> | undefined;
		return normalizeManifestFromUnknown(myAgent ?? {});
	}

	return normalizeManifestFromUnknown(raw);
}

function normalizeManifestFromUnknown(raw: Record<string, unknown>): ResourcePackageManifest {
	return {
		name: typeof raw.name === "string" ? raw.name : "unnamed-package",
		description: typeof raw.description === "string" ? raw.description : undefined,
		prompts: normalizeStringArray(raw.prompts),
		skills: normalizeStringArray(raw.skills),
		extensions: normalizeStringArray(raw.extensions),
		themes: normalizeStringArray(raw.themes),
	};
}

async function inferPackage(rootDir: string, source: ResourcePackage["source"]): Promise<ResourcePackage | undefined> {
	const promptsDir = path.join(rootDir, "prompts");
	const skillsDir = path.join(rootDir, "skills");
	const extensionsDir = path.join(rootDir, "extensions");
	const themesDir = path.join(rootDir, "themes");

	const prompts = (await safeStat(promptsDir))?.isDirectory() ? [promptsDir] : [];
	const skills = (await safeStat(skillsDir))?.isDirectory() ? [skillsDir] : [];
	const extensions = (await gatherFiles(extensionsDir, SUPPORTED_SCRIPT_FILES)) ?? [];
	const themes = (await gatherFiles(themesDir, SUPPORTED_THEME_FILES)) ?? [];

	if (prompts.length === 0 && skills.length === 0 && extensions.length === 0 && themes.length === 0) {
		return undefined;
	}

	return {
		name: path.basename(rootDir),
		rootDir: path.resolve(rootDir),
		source,
		prompts,
		skills,
		extensions,
		themes,
	};
}

function normalizePackage(
	rootDir: string,
	manifestPath: string,
	source: ResourcePackage["source"],
	manifest: ResourcePackageManifest,
): ResourcePackage {
	return {
		name: manifest.name || path.basename(rootDir),
		description: manifest.description,
		rootDir: path.resolve(rootDir),
		manifestPath,
		source,
		prompts: resolvePaths(rootDir, manifest.prompts),
		skills: resolvePaths(rootDir, manifest.skills),
		extensions: resolvePaths(rootDir, manifest.extensions),
		themes: resolvePaths(rootDir, manifest.themes),
	};
}

function resolvePaths(rootDir: string, entries: string[] | undefined): string[] {
	return (entries ?? []).map((entry) => path.resolve(rootDir, entry));
}

function normalizeStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	}
	return [];
}

function resolveCandidatePaths(entry: string, cwd: string, globalDir: string): string[] {
	if (!entry) return [];
	if (path.isAbsolute(entry)) return [entry];
	if (entry.startsWith("~/")) return [path.join(process.env.HOME || ".", entry.slice(2))];

	const cwdPath = path.resolve(cwd, entry);
	const globalPath = path.resolve(globalDir, entry);
	return cwdPath === globalPath ? [cwdPath] : [cwdPath, globalPath];
}

function classifySource(resolvedPath: string, cwd: string, globalDir: string): ResourcePackage["source"] {
	const absolute = path.resolve(resolvedPath);
	if (absolute.startsWith(path.resolve(globalDir))) return "global";
	if (absolute.startsWith(path.resolve(cwd))) return "project";
	return "explicit";
}

async function gatherFiles(dir: string, matcher: RegExp): Promise<string[] | undefined> {
	const stat = await safeStat(dir);
	if (!stat?.isDirectory()) return undefined;
	const entries = await fs.readdir(dir);
	return entries
		.filter((entry) => matcher.test(entry))
		.map((entry) => path.join(dir, entry))
		.sort();
}

async function safeStat(target: string): Promise<import("node:fs").Stats | undefined> {
	try {
		return await fs.stat(target);
	} catch {
		return undefined;
	}
}
