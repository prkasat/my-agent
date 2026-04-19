import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Prompt template system.
 *
 * Templates are markdown files with YAML frontmatter.
 * Stored in ~/.my-agent/prompts/ or .my-agent/prompts/
 * Bash-style argument substitution ($1, $@, ${@:N:L})
 */

export interface PromptTemplate {
  name: string;
  description: string;
  content: string;
  filePath: string;
  source: "global" | "project" | "explicit";
}

export interface TemplateLoadConfig {
  cwd: string;
  globalDir: string;
  extraDirs?: string[];
}

export async function loadPromptTemplates(config: TemplateLoadConfig): Promise<Map<string, PromptTemplate>> {
  const templates = new Map<string, PromptTemplate>();

  const projectDirs = [
    path.join(config.cwd, ".my-agent", "prompts"),
    path.join(config.cwd, ".claude", "prompts"),
  ];
  for (const dir of projectDirs) {
    await loadFromDir(dir, "project", templates);
  }

  for (const dir of config.extraDirs || []) {
    await loadFromDir(dir, "explicit", templates);
  }

  await loadFromDir(path.join(config.globalDir, "prompts"), "global", templates);

  return templates;
}

async function loadFromDir(
  dir: string,
  source: PromptTemplate["source"],
  templates: Map<string, PromptTemplate>,
): Promise<void> {
  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const name = file.replace(/\.md$/, "");

      if (templates.has(name)) continue;

      const filePath = path.join(dir, file);
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = parseFrontmatter(content);

      templates.set(name, {
        name,
        description: parsed.frontmatter.description || "",
        content: parsed.body,
        filePath,
        source,
      });
    }
  } catch {
    // Directory doesn't exist
  }
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
      frontmatter[key.trim()] = valueParts.join(":").trim().replace(/^["']|["']$/g, "");
    }
  }

  return { frontmatter, body: match[2].trim() };
}

export function expandTemplate(template: PromptTemplate, args: string[]): string {
  let text = template.content;

  for (let i = 0; i < args.length; i++) {
    text = text.replace(new RegExp(`\\$${i + 1}\\b`, "g"), args[i]);
  }

  text = text.replace(/\$@|\$ARGUMENTS/g, args.join(" "));

  text = text.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, start, length) => {
    const s = parseInt(start) - 1;
    if (length !== undefined) {
      return args.slice(s, s + parseInt(length)).join(" ");
    }
    return args.slice(s).join(" ");
  });

  return text;
}

export function matchTemplate(
  input: string,
  templates: Map<string, PromptTemplate>,
): { template: PromptTemplate; args: string[] } | null {
  if (!input.startsWith("/")) return null;

  const parts = parseCommandArgs(input.slice(1));
  const name = parts[0];
  const args = parts.slice(1);

  const template = templates.get(name);
  if (!template) return null;

  return { template, args };
}

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

export function getTemplateHelp(templates: Map<string, PromptTemplate>): string {
  if (templates.size === 0) {
    return "No prompt templates loaded.";
  }

  const lines = ["Available templates:"];
  for (const [name, template] of templates) {
    const desc = template.description || "(no description)";
    lines.push(`  /${name} - ${desc}`);
  }
  return lines.join("\n");
}
