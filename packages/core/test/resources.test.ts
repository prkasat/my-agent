import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandSkill, findSkillByCommand, loadResourcePackages, loadSkills } from "../src/index.js";

describe("resource loaders", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "my-agent-resources-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("loads resource packages from manifests and inferred directories", async () => {
		const cwd = path.join(tmpDir, "project");
		const globalDir = path.join(tmpDir, "home", ".my-agent");
		const explicitPackage = path.join(tmpDir, "explicit-package");
		const inferredPackage = path.join(cwd, ".my-agent", "packages", "inferred-bundle");

		await fs.mkdir(path.join(explicitPackage, "prompts"), { recursive: true });
		await fs.mkdir(path.join(explicitPackage, "skills"), { recursive: true });
		await fs.mkdir(path.join(explicitPackage, "extensions"), { recursive: true });
		await fs.mkdir(path.join(explicitPackage, "themes"), { recursive: true });
		await fs.writeFile(
			path.join(explicitPackage, "my-agent.package.json"),
			JSON.stringify({
				name: "explicit-bundle",
				prompts: ["prompts"],
				skills: ["skills"],
				extensions: ["extensions/demo.mjs"],
				themes: ["themes/night.json"],
			}),
		);
		await fs.writeFile(path.join(explicitPackage, "extensions", "demo.mjs"), "export default {};\n");
		await fs.writeFile(path.join(explicitPackage, "themes", "night.json"), "{}\n");

		await fs.mkdir(path.join(inferredPackage, "prompts"), { recursive: true });
		await fs.mkdir(path.join(inferredPackage, "skills"), { recursive: true });
		await fs.mkdir(path.join(inferredPackage, "extensions"), { recursive: true });
		await fs.mkdir(path.join(inferredPackage, "themes"), { recursive: true });
		await fs.writeFile(path.join(inferredPackage, "extensions", "tool.mjs"), "export default {};\n");
		await fs.writeFile(path.join(inferredPackage, "themes", "default.json"), "{}\n");

		const result = await loadResourcePackages({
			cwd,
			globalDir,
			entries: [explicitPackage],
		});

		expect(result.warnings).toEqual([]);
		expect(result.packages.map((pkg) => pkg.name)).toEqual(["explicit-bundle", "inferred-bundle"]);
		expect(result.packages[0]?.extensions[0]).toMatch(/demo\.mjs$/);
		expect(result.packages[1]?.themes[0]).toMatch(/default\.json$/);
	});

	it("loads skills with precedence and alias lookup", async () => {
		const cwd = path.join(tmpDir, "project");
		const globalDir = path.join(tmpDir, "home", ".my-agent");
		const packageSkills = path.join(tmpDir, "bundle", "skills");

		await fs.mkdir(path.join(cwd, ".my-agent", "skills"), { recursive: true });
		await fs.mkdir(path.join(globalDir, "skills"), { recursive: true });
		await fs.mkdir(packageSkills, { recursive: true });

		await fs.writeFile(
			path.join(globalDir, "skills", "research.md"),
			"---\ndescription: global version\ncommand: research\n---\nGlobal $@\n",
		);
		await fs.writeFile(
			path.join(packageSkills, "triage.md"),
			"---\ndescription: package triage\ncommand: triage\naliases: review, inbox\n---\nTriage $1\n",
		);
		await fs.writeFile(
			path.join(cwd, ".my-agent", "skills", "research.md"),
			"---\ndescription: project version\ncommand: research\n---\nProject $@\n",
		);

		const result = await loadSkills({
			cwd,
			globalDir,
			extraDirs: [packageSkills],
		});

		expect(result.warnings).toEqual([]);
		const research = result.skills.get("research");
		expect(research?.description).toBe("project version");
		if (!research) throw new Error("research skill not loaded");
		expect(expandSkill(research, ["alpha", "beta"])).toBe("Project alpha beta");

		const triage = findSkillByCommand("review", result.skills);
		expect(triage?.command).toBe("triage");
		if (!triage) throw new Error("triage skill not loaded");
		expect(expandSkill(triage, ["ticket-123"])).toBe("Triage ticket-123");
	});
});
