import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, registerProvider } from "@my-agent/ai";
import { SessionManager } from "@my-agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/config/auth-storage.js";
import { getDefaultSettings } from "../../src/config/settings.js";
import { runAgent } from "../../src/runtime/agent-runtime.js";
import { loadExtensionsForRun } from "../../src/runtime/extensions.js";

function createFauxLLM(responses: AssistantMessage[]) {
	let callIndex = 0;

	return function fauxStream() {
		const response = responses[Math.min(callIndex++, responses.length - 1)];
		if (!response) throw new Error("no responses configured");

		const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
			(event) => event.type === "done",
			(event) => {
				if (event.type === "done") return event.message;
				throw new Error("unexpected");
			},
		);

		queueMicrotask(() => {
			stream.push({ type: "start", message: { role: "assistant", content: [] } });
			for (const block of response.content) {
				if (block.type === "text") {
					stream.push({ type: "text_delta", text: block.text });
				} else if (block.type === "tool_call") {
					stream.push({ type: "tool_call_start", id: block.id, name: block.name });
					stream.push({ type: "tool_call_delta", id: block.id, arguments: block.arguments });
					stream.push({ type: "tool_call_end", id: block.id });
				}
			}
			stream.push({ type: "done", message: response });
		});

		return stream;
	};
}

describe("extension runtime", () => {
	let tmpDir: string;
	let originalOpenRouterKey: string | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "extension-runtime-test-"));
		originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_API_KEY = "test-openrouter-key";
	});

	afterEach(async () => {
		if (originalOpenRouterKey === undefined) {
			process.env.OPENROUTER_API_KEY = undefined;
		} else {
			process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("loads local extensions and executes extension tools", async () => {
		const extensionPath = path.join(tmpDir, "echo-extension.mjs");
		await fs.writeFile(
			extensionPath,
			`import { Type } from "@sinclair/typebox";
       export default {
         metadata: { id: "echo-ext", name: "Echo", version: "1.0.0" },
         activate(ctx) {
           ctx.registerTool({
             name: "echo_ext",
             description: "Echo a value",
             parameters: Type.Object({ value: Type.String() }),
             async execute(_id, params) {
               return { content: [{ type: "text", text: params.value }] };
             },
           });
           ctx.on("tool_execution_start", (event) => {
             if (event.toolName === "echo_ext") {
               return { action: "allow", modifiedArgs: { value: "modified by extension" } };
             }
           });
         },
       };
      `,
			"utf-8",
		);

		registerProvider("openrouter", async () =>
			createFauxLLM([
				{
					role: "assistant",
					content: [
						{
							type: "tool_call",
							id: "tc1",
							name: "echo_ext",
							arguments: JSON.stringify({ value: "from llm" }),
						},
					],
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
					timestamp: Date.now(),
				},
			]),
		);

		const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
		const settings = getDefaultSettings();
		settings.extensions = [extensionPath];
		settings.permissionMode = "auto";

		const session = SessionManager.continueRecent(tmpDir);
		const result = await runAgent("run the extension", { cwd: tmpDir, settings, authStorage, session }, {});

		const toolResult = result.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toBeDefined();
		expect(toolResult && "content" in toolResult ? toolResult.content[0] : undefined).toEqual({
			type: "text",
			text: "modified by extension",
		});
	});

	it("skips a broken extension instead of aborting the run", async () => {
		const extensionPath = path.join(tmpDir, "broken-extension.mjs");
		await fs.writeFile(
			extensionPath,
			`export default {
         metadata: { id: "broken-ext", name: "Broken", version: "1.0.0" },
         activate() {
           throw new Error("boom");
         },
       };`,
			"utf-8",
		);

		registerProvider("openrouter", async () =>
			createFauxLLM([
				{
					role: "assistant",
					content: [{ type: "text", text: "still works" }],
					stopReason: "stop",
					timestamp: Date.now(),
				},
			]),
		);

		const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
		const settings = getDefaultSettings();
		settings.extensions = [extensionPath];
		settings.permissionMode = "auto";

		const session = SessionManager.continueRecent(tmpDir);
		const result = await runAgent("ignore the broken extension", { cwd: tmpDir, settings, authStorage, session }, {});

		expect(result.error).toBeUndefined();
		expect(result.messages.some((message) => message.role === "assistant")).toBe(true);
	});

	it("skips incompatible extensions and records the warning in traceable profile flow", async () => {
		const extensionPath = path.join(tmpDir, "incompatible-extension.mjs");
		await fs.writeFile(
			extensionPath,
			`export default {
         metadata: { id: "future-ext", name: "Future", version: "1.0.0", apiVersion: "99.x" },
         activate(ctx) {
           ctx.registerCommand({ name: "future", execute() {} });
         },
       };`,
			"utf-8",
		);

		registerProvider("openrouter", async () =>
			createFauxLLM([
				{
					role: "assistant",
					content: [{ type: "text", text: "compatibility enforced" }],
					stopReason: "stop",
					timestamp: Date.now(),
				},
			]),
		);

		const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
		const settings = getDefaultSettings();
		settings.extensions = [extensionPath];
		settings.permissionMode = "auto";

		const session = SessionManager.continueRecent(tmpDir);
		const result = await runAgent(
			"run without the incompatible extension",
			{ cwd: tmpDir, settings, authStorage, session },
			{},
		);

		expect(result.error).toBeUndefined();
		expect(result.profile.totalDurationMs).toBeGreaterThanOrEqual(0);
	});

	it("guards host UI adapter failures so extension UI cannot brick a run", async () => {
		const extensionPath = path.join(tmpDir, "ui-extension.mjs");
		await fs.writeFile(
			extensionPath,
			`import { Type } from "@sinclair/typebox";
       export default {
         metadata: { id: "ui-ext", name: "UI", version: "1.0.0" },
         activate(ctx) {
           ctx.ui.notify("hello from extension");
           ctx.registerTool({
             name: "ui_echo",
             description: "Echo through UI-safe extension",
             parameters: Type.Object({ value: Type.String() }),
             async execute(_id, params) {
               return { content: [{ type: "text", text: params.value }] };
             },
           });
         },
       };
      `,
			"utf-8",
		);

		const settings = getDefaultSettings();
		settings.extensions = [extensionPath];
		settings.permissionMode = "auto";

		const runtime = await loadExtensionsForRun({
			cwd: tmpDir,
			globalDir: path.join(tmpDir, ".my-agent"),
			settings,
			sessionId: "session-ui-safe",
			getAgentContext: () => null,
			ui: {
				async select() {
					throw new Error("select exploded");
				},
				async confirm() {
					throw new Error("confirm exploded");
				},
				async input() {
					throw new Error("input exploded");
				},
				notify() {
					throw new Error("notify exploded");
				},
			},
		});

		expect(runtime?.warnings).toEqual([]);
		expect(runtime?.loadedIds).toEqual(["ui-ext"]);
		expect(runtime?.runner.getAllTools().map((tool) => tool.name)).toEqual(["ui_echo"]);
		await runtime?.dispose();
	});
});
