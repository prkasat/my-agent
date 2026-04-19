import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadThemes, resolveThemeSelection } from "../../src/ui/theme-loader.js";

describe("theme loader", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "my-agent-theme-loader-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("loads declarative theme files and resolves the selected theme", async () => {
		const cwd = path.join(tmpDir, "project");
		const globalDir = path.join(tmpDir, "home", ".my-agent");
		const themeDir = path.join(cwd, ".my-agent", "themes");
		await fs.mkdir(themeDir, { recursive: true });
		await fs.writeFile(
			path.join(themeDir, "night.json"),
			JSON.stringify({
				name: "night",
				footer: {
					background: "bgBlue",
					model: "bold white",
				},
			}),
			"utf-8",
		);

		const result = await loadThemes({ cwd, globalDir });
		expect(result.warnings).toEqual([]);
		expect(result.themes.has("default")).toBe(true);
		expect(result.themes.has("night")).toBe(true);

		const selected = await resolveThemeSelection("night", result);
		expect(selected.name).toBe("night");
		expect(selected.theme.footer.model("x")).not.toBe("x");
	});
});
