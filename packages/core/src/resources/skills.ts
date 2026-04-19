import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface SkillDefinition {
	name: string;
	description: string;
	prompt: string;
	command: string;
	aliases: string[];
	filePath: string;
	source: "global" | "project" | "explicit";
}

export interface LoadSkillsConfig {
	cwd: string;
	globalDir: string;
	extraDirs?: string[];
}

export interface LoadSkillsResult {
	skills: Map<string, SkillDefinition>;
	warnings: string[];
}

const SUPPORTED_SKILL_FILES = /\.(skill\.(md|json)|md|json)$/i;

export async function loadSkills(config: LoadSkillsConfig): Promise<LoadSkillsResult> {
	const skills = new Map<string, SkillDefinition>();
	const warnings: string[] = [];

	const projectDirs = [path.join(config.cwd, ".my-agent", "skills")];
	for (const dir of projectDirs) {
		await loadSkillDir(dir, "project", skills, warnings);
	}

	for (const dir of config.extraDirs ?? []) {
		await loadSkillDir(dir, "explicit", skills, warnings);
	}

	await loadSkillDir(path.join(config.globalDir, "skills"), "global", skills, warnings);

	return { skills, warnings };
}

async function loadSkillDir(
	dir: string,
	source: SkillDefinition["source"],
	skills: Map<string, SkillDefinition>,
	warnings: string[],
): Promise<void> {
	try {
		const files = await fs.readdir(dir);
		for (const file of files) {
			if (!SUPPORTED_SKILL_FILES.test(file)) continue;
			const filePath = path.join(dir, file);
			try {
				const skill = await loadSkillFile(filePath, source);
				if (!skills.has(skill.command)) {
					skills.set(skill.command, skill);
				}
			} catch (error) {
				warnings.push(`Failed to load skill ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	} catch {
		// missing directory is fine
	}
}

async function loadSkillFile(filePath: string, source: SkillDefinition["source"]): Promise<SkillDefinition> {
	if (filePath.endsWith(".json") || filePath.endsWith(".skill.json")) {
		const raw = JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
		return normalizeSkill(raw, filePath, source);
	}

	const content = await fs.readFile(filePath, "utf-8");
	const parsed = parseFrontmatter(content);
	return normalizeSkill(
		{
			...parsed.frontmatter,
			prompt: parsed.body,
		},
		filePath,
		source,
	);
}

function normalizeSkill(
	raw: Record<string, unknown>,
	filePath: string,
	source: SkillDefinition["source"],
): SkillDefinition {
	const inferredName = inferSkillName(filePath);
	const aliases = normalizeAliases(raw.aliases ?? raw.shortcut ?? raw.shortcuts);
	const command = typeof raw.command === "string" && raw.command.trim().length > 0 ? raw.command.trim() : inferredName;
	const prompt =
		typeof raw.prompt === "string" && raw.prompt.trim().length > 0
			? raw.prompt.trim()
			: typeof raw.content === "string" && raw.content.trim().length > 0
				? raw.content.trim()
				: "";

	if (!prompt) {
		throw new Error("Skill prompt is required");
	}

	return {
		name: typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name.trim() : inferredName,
		description: typeof raw.description === "string" && raw.description.trim().length > 0 ? raw.description.trim() : "",
		prompt,
		command,
		aliases,
		filePath,
		source,
	};
}

function inferSkillName(filePath: string): string {
	const base = path
		.basename(filePath)
		.replace(/\.skill\.(md|json)$/i, "")
		.replace(/\.(md|json)$/i, "");
	return base;
}

function parseFrontmatter(content: string): {
	frontmatter: Record<string, string>;
	body: string;
} {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };

	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const [key, ...valueParts] = line.split(":");
		if (key && valueParts.length) {
			frontmatter[key.trim()] = valueParts
				.join(":")
				.trim()
				.replace(/^["']|["']$/g, "");
		}
	}

	return { frontmatter, body: match[2].trim() };
}

function normalizeAliases(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
	}
	return [];
}

export function findSkillByCommand(command: string, skills: Map<string, SkillDefinition>): SkillDefinition | undefined {
	const direct = skills.get(command);
	if (direct) return direct;
	return [...skills.values()].find((skill) => skill.aliases.includes(command));
}

export function expandSkill(skill: SkillDefinition, args: string[]): string {
	let text = skill.prompt;

	for (let i = 0; i < args.length; i++) {
		text = text.replace(new RegExp(`\\$${i + 1}\\b`, "g"), args[i]);
	}

	text = text.replace(/\$@|\$ARGUMENTS/g, args.join(" "));

	text = text.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, start, length) => {
		const s = Number.parseInt(start, 10) - 1;
		if (length !== undefined) {
			return args.slice(s, s + Number.parseInt(length, 10)).join(" ");
		}
		return args.slice(s).join(" ");
	});

	return text;
}

export function getSkillHelp(skills: Map<string, SkillDefinition>): string {
	if (skills.size === 0) {
		return "No skills loaded.";
	}

	const lines = ["Available skills:"];
	for (const [command, skill] of skills) {
		const aliasText = skill.aliases.length > 0 ? ` (aliases: ${skill.aliases.join(", ")})` : "";
		lines.push(`  /${command} - ${skill.description || skill.name}${aliasText}`);
	}
	return lines.join("\n");
}
