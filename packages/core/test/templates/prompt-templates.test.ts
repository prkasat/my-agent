import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	expandTemplate,
	getTemplateHelp,
	loadPromptTemplates,
	matchTemplate,
	type PromptTemplate,
} from "../../src/templates/prompt-templates.js";

describe("expandTemplate", () => {
	const template: PromptTemplate = {
		name: "test",
		description: "Test template",
		content: "Hello $1, you said $2. Args: $@",
		filePath: "/tmp/test.md",
		source: "project",
	};

	it("expands positional arguments", () => {
		const result = expandTemplate(template, ["World", "hi"]);
		expect(result).toBe("Hello World, you said hi. Args: World hi");
	});

	it("expands $@ to all args", () => {
		const tpl: PromptTemplate = {
			...template,
			content: "Review: $@",
		};
		const result = expandTemplate(tpl, ["file1.ts", "file2.ts", "file3.ts"]);
		expect(result).toBe("Review: file1.ts file2.ts file3.ts");
	});

	it("expands $ARGUMENTS alias", () => {
		const tpl: PromptTemplate = {
			...template,
			content: "Review: $ARGUMENTS",
		};
		const result = expandTemplate(tpl, ["file1.ts", "file2.ts"]);
		expect(result).toBe("Review: file1.ts file2.ts");
	});

	it("expands ${@:N} slices", () => {
		const tpl: PromptTemplate = {
			...template,
			content: "First: $1, Rest: ${@:2}",
		};
		const result = expandTemplate(tpl, ["main", "arg2", "arg3", "arg4"]);
		expect(result).toBe("First: main, Rest: arg2 arg3 arg4");
	});

	it("expands ${@:N:L} slices with length", () => {
		const tpl: PromptTemplate = {
			...template,
			content: "Slice: ${@:2:2}",
		};
		const result = expandTemplate(tpl, ["a", "b", "c", "d", "e"]);
		expect(result).toBe("Slice: b c");
	});
});

describe("matchTemplate", () => {
	const templates = new Map<string, PromptTemplate>([
		[
			"review",
			{
				name: "review",
				description: "Review code",
				content: "Review $@",
				filePath: "/tmp/review.md",
				source: "project",
			},
		],
	]);

	it("matches template by name", () => {
		const result = matchTemplate("/review file.ts", templates);
		expect(result).not.toBeNull();
		expect(result?.template.name).toBe("review");
		expect(result?.args).toEqual(["file.ts"]);
	});

	it("handles quoted arguments", () => {
		const result = matchTemplate('/review "my file.ts" quick', templates);
		expect(result).not.toBeNull();
		expect(result?.args).toEqual(["my file.ts", "quick"]);
	});

	it("returns null for non-slash input", () => {
		expect(matchTemplate("review file.ts", templates)).toBeNull();
	});

	it("returns null for unknown template", () => {
		expect(matchTemplate("/unknown arg", templates)).toBeNull();
	});
});

describe("getTemplateHelp", () => {
	it("lists available templates", () => {
		const templates = new Map<string, PromptTemplate>([
			[
				"review",
				{
					name: "review",
					description: "Review code",
					content: "",
					filePath: "",
					source: "project",
				},
			],
			[
				"refactor",
				{
					name: "refactor",
					description: "Refactor code",
					content: "",
					filePath: "",
					source: "global",
				},
			],
		]);

		const help = getTemplateHelp(templates);
		expect(help).toContain("/review");
		expect(help).toContain("Review code");
		expect(help).toContain("/refactor");
	});

	it("handles empty templates", () => {
		const help = getTemplateHelp(new Map());
		expect(help).toBe("No prompt templates loaded.");
	});
});

describe("loadPromptTemplates", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "templates-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("loads templates from directory", async () => {
		const promptDir = path.join(tmpDir, ".my-agent", "prompts");
		await fs.mkdir(promptDir, { recursive: true });
		await fs.writeFile(
			path.join(promptDir, "review.md"),
			`---
description: "Review code for issues"
---
Review the following: $@`,
		);

		const templates = await loadPromptTemplates({
			cwd: tmpDir,
			globalDir: "/nonexistent",
		});

		expect(templates.size).toBe(1);
		expect(templates.get("review")?.description).toBe("Review code for issues");
	});

	it("project templates override global", async () => {
		const projectDir = path.join(tmpDir, ".my-agent", "prompts");
		const globalDir = path.join(tmpDir, "global", "prompts");

		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(globalDir, { recursive: true });

		await fs.writeFile(
			path.join(projectDir, "review.md"),
			`---
description: "Project review"
---
Project content`,
		);
		await fs.writeFile(
			path.join(globalDir, "review.md"),
			`---
description: "Global review"
---
Global content`,
		);

		const templates = await loadPromptTemplates({
			cwd: tmpDir,
			globalDir: path.join(tmpDir, "global"),
		});

		expect(templates.get("review")?.description).toBe("Project review");
		expect(templates.get("review")?.source).toBe("project");
	});
});
