#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventStream, registerProvider } from "@my-agent/ai";
import { SessionManager } from "@my-agent/core";
import { AuthStorage } from "../packages/cli/dist/config/auth-storage.js";
import { getDefaultSettings } from "../packages/cli/dist/config/settings.js";
import { runAgent } from "../packages/cli/dist/runtime/agent-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const taskRoot = path.join(repoRoot, "evals", "tasks");

let currentTask = null;
registerProvider("openrouter", async () => (model) => {
	if (!currentTask) throw new Error("No current task configured");
	const stream = new EventStream(
		(event) => event.type === "done",
		(event) => {
			if (event.type === "done") return event.message;
			throw new Error("unexpected");
		},
	);
	queueMicrotask(() => {
		stream.push({ type: "start", message: { role: "assistant", content: [] } });
		stream.push({ type: "text_delta", text: currentTask.mockAssistantText });
		stream.push({
			type: "done",
			message: {
				role: "assistant",
				content: [{ type: "text", text: currentTask.mockAssistantText }],
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				timestamp: Date.now(),
			},
		});
	});
	return stream;
});

async function main() {
	const tasks = await loadTasks(taskRoot);
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "my-agent-eval-"));
	process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "mock-eval-key";
	const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
	await authStorage.load();
	const settings = getDefaultSettings();
	settings.permissionMode = "auto";

	const results = [];
	for (const task of tasks) {
		currentTask = task;
		const session = SessionManager.inMemory(tmpDir);
		const started = Date.now();
		const result = await runAgent(task.prompt, {
			cwd: repoRoot,
			settings,
			authStorage,
			session,
			disableExtensions: true,
		});
		const durationMs = Date.now() - started;
		const assistantText = result.messages
			.filter((message) => message.role === "assistant")
			.flatMap((message) => message.content)
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join(" ");
		const passed = task.expectedContains.every((snippet) => assistantText.includes(snippet));
		results.push({
			id: task.id,
			type: task.type,
			passed,
			durationMs,
			expectedContains: task.expectedContains,
			outputPreview: assistantText.slice(0, 160),
		});
	}

	const summary = {
		total: results.length,
		passed: results.filter((result) => result.passed).length,
		failed: results.filter((result) => !result.passed).length,
		results,
	};
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function loadTasks(root) {
	const tasks = [];
	for (const group of ["coding", "non-coding"]) {
		const dir = path.join(root, group);
		const files = await fs.readdir(dir);
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const task = JSON.parse(await fs.readFile(path.join(dir, file), "utf-8"));
			tasks.push({ ...task, type: group });
		}
	}
	return tasks;
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
	process.exit(1);
});
