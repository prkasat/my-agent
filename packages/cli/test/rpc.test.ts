import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Model,
	registerProvider,
	type StreamOptions,
} from "@my-agent/ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/config/auth-storage.js";
import { getDefaultSettings } from "../src/config/settings.js";
import { createRpcServer, type RpcEvent, type RpcResponse } from "../src/modes/rpc.js";

let currentStream: (
	model: Model,
	context: Context,
	options: StreamOptions,
) => EventStream<AssistantMessageEvent, AssistantMessage>;

beforeAll(() => {
	registerProvider("openrouter", async () => (model, context, options) => currentStream(model, context, options));
});

describe("rpc server", () => {
	let tmpDir: string;
	let originalOpenRouterKey: string | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "my-agent-rpc-"));
		originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_API_KEY = "rpc-test-key";
	});

	afterEach(async () => {
		if (originalOpenRouterKey === undefined) {
			process.env.OPENROUTER_API_KEY = undefined;
		} else {
			process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("executes prompts and emits structured events", async () => {
		currentStream = (model) => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "hello from rpc" }],
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(event) => event.type === "done",
				(event) => {
					if (event.type === "done") return event.message;
					throw new Error("unexpected");
				},
			);
			queueMicrotask(() => {
				stream.push({ type: "start", message: { role: "assistant", content: [] } });
				stream.push({ type: "text_delta", text: "hello from rpc" });
				stream.push({ type: "done", message });
			});
			return stream;
		};

		const sent: Array<RpcResponse | RpcEvent> = [];
		const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
		await authStorage.load();
		const server = createRpcServer((message) => sent.push(message), {
			cwd: tmpDir,
			settings: getDefaultSettings(),
			authStorage,
			disableExtensions: true,
		});

		await server.handleLine(JSON.stringify({ id: "1", method: "prompt", params: { prompt: "hi" } }));
		await waitFor(() => sent.some(isPromptCompleted));

		expect(sent.find((message): message is RpcResponse => "id" in message && message.id === "1")?.result).toEqual({
			status: "started",
			requestId: "1",
		});
		expect(sent.some((message) => isEvent(message, "prompt.started"))).toBe(true);
		expect(sent.some((message) => isEvent(message, "prompt.text"))).toBe(true);
		expect(sent.some((message) => isEvent(message, "prompt.completed"))).toBe(true);

		await server.handleLine(JSON.stringify({ id: "2", method: "getState" }));
		const state = sent.find((message): message is RpcResponse => "id" in message && message.id === "2");
		expect(state?.result).toMatchObject({
			cwd: tmpDir,
			activePromptIds: [],
			safeMode: true,
		});
	});

	it("supports aborting an in-flight prompt", async () => {
		currentStream = (_model, _context, options) => {
			const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(event) => event.type === "done" || event.type === "error",
				(event) => {
					if (event.type === "done") return event.message;
					throw new Error(event.error);
				},
			);
			stream.push({ type: "start", message: { role: "assistant", content: [] } });

			const timer = setTimeout(() => {
				if (options.signal?.aborted) return;
				stream.push({ type: "text_delta", text: "too late" });
				stream.push({
					type: "done",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "too late" }],
						stopReason: "stop",
						timestamp: Date.now(),
					},
				});
			}, 1000);

			options.signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					stream.push({ type: "error", error: "aborted" });
				},
				{ once: true },
			);

			return stream;
		};

		const sent: Array<RpcResponse | RpcEvent> = [];
		const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
		await authStorage.load();
		const server = createRpcServer((message) => sent.push(message), {
			cwd: tmpDir,
			settings: getDefaultSettings(),
			authStorage,
			disableExtensions: true,
		});

		await server.handleLine(JSON.stringify({ id: "run-1", method: "prompt", params: { prompt: "slow" } }));
		await waitFor(() => sent.some((message) => isEvent(message, "prompt.started")));
		await server.handleLine(JSON.stringify({ id: "abort-1", method: "abort", params: { requestId: "run-1" } }));
		await waitFor(() => sent.some((message) => isEvent(message, "prompt.completed")));

		expect(sent.find((message): message is RpcResponse => "id" in message && message.id === "abort-1")?.result).toEqual(
			{
				status: "aborting",
				requestId: "run-1",
			},
		);
		expect(
			sent.some(
				(message) => isEvent(message, "prompt.completed") && Boolean((message.data as { aborted?: boolean }).aborted),
			),
		).toBe(true);
	});
});

function isEvent(message: RpcResponse | RpcEvent, eventName: string): message is RpcEvent {
	return "event" in message && message.event === eventName;
}

function isPromptCompleted(message: RpcResponse | RpcEvent): boolean {
	return isEvent(message, "prompt.completed");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error("waitFor timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
