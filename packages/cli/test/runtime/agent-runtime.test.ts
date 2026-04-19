import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, registerProvider } from "@my-agent/ai";
import { SessionManager } from "@my-agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/config/auth-storage.js";
import { getDefaultSettings } from "../../src/config/settings.js";
import { formatRuntimeProfile, runAgent } from "../../src/runtime/agent-runtime.js";

let currentResponses: AssistantMessage[] = [];
let responseCallIndex = 0;

registerProvider("openrouter", async () => {
	return function fauxStream() {
		const response = currentResponses[Math.min(responseCallIndex++, currentResponses.length - 1)];
		if (!response) throw new Error("no eval response configured");
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
});

describe("agent runtime profile", () => {
	let tmpDir: string;
	let originalOpenRouterKey: string | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-runtime-profile-"));
		originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_API_KEY = "test-openrouter-key";
		responseCallIndex = 0;
	});

	afterEach(async () => {
		if (originalOpenRouterKey === undefined) process.env.OPENROUTER_API_KEY = undefined;
		else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("records timing and cumulative cost information", async () => {
		currentResponses = [
			{
				role: "assistant",
				content: [{ type: "text", text: "profiled reply" }],
				stopReason: "stop",
				timestamp: Date.now(),
				usage: { inputTokens: 123, outputTokens: 45, cost: 0.0123 },
			},
		];

		const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
		const settings = getDefaultSettings();
		settings.permissionMode = "auto";
		const session = SessionManager.continueRecent(tmpDir);

		const result = await runAgent("profile this", { cwd: tmpDir, settings, authStorage, session }, {});

		expect(result.error).toBeUndefined();
		expect(result.profile.totalDurationMs).toBeGreaterThanOrEqual(0);
		expect(result.profile.firstTokenLatencyMs).toBeGreaterThanOrEqual(0);
		expect(result.profile.costs.totalInputTokens).toBe(123);
		expect(result.profile.costs.totalOutputTokens).toBe(45);
		expect(result.profile.costs.totalCost).toBeCloseTo(0.0123, 6);
		expect(formatRuntimeProfile(result.profile)).toMatch(/profile:/);
	});

	it("invokes the interactive permission hook for risky tools", async () => {
		let permissionAsked = false;
		currentResponses = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_call",
						id: "tc1",
						name: "bash",
						arguments: JSON.stringify({ command: "echo hi" }),
					},
				],
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "permission handled" }],
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
		const settings = getDefaultSettings();
		settings.permissionMode = "ask";
		const session = SessionManager.continueRecent(tmpDir);

		const result = await runAgent(
			"try a risky tool",
			{
				cwd: tmpDir,
				settings,
				authStorage,
				session,
				askPermission: async () => {
					permissionAsked = true;
					return "deny";
				},
			},
			{},
		);

		expect(permissionAsked).toBe(true);
		expect(result.messages.some((message) => message.role === "toolResult")).toBe(true);
	});
});
