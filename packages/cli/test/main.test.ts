import { spawn, spawnSync } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(process.cwd());
const cliDistPath = path.join(repoRoot, "packages", "cli", "dist", "main.js");

async function runCli(
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cliDistPath, ...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({
				code,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
	});
}

describe("CLI one-shot mode", () => {
	let tmpDir: string;
	let homeDir: string;

	beforeAll(async () => {
		const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
		const result = spawnSync(npmCmd, ["run", "build"], {
			cwd: repoRoot,
			encoding: "utf8",
			shell: process.platform === "win32",
		});
		if (result.status !== 0) {
			const details = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");
			throw new Error(`Failed to build CLI for integration test:\n${details}`);
		}

		tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cli-main-test-"));
		homeDir = path.join(tmpDir, "home");
		await fsp.mkdir(homeDir, { recursive: true });
	});

	afterAll(async () => {
		if (tmpDir) {
			await fsp.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("prints actionable onboarding when one-shot mode runs without authentication", async () => {
		const result = await runCli(["say hello from one-shot"], {
			cwd: tmpDir,
			env: {
				...process.env,
				HOME: homeDir,
				OPENROUTER_API_KEY: "",
			},
		});

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/No model is ready yet:/);
		expect(result.stderr).toMatch(/OpenRouter: export OPENROUTER_API_KEY/);
		expect(result.stderr).toMatch(/Anthropic: \/login anthropic/);
		expect(result.stderr).toMatch(/OpenAI Codex: \/login openai-codex/);
	});
});
