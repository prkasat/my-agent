import * as readline from "node:readline";
import type {
	AskDecision,
	LoadResourcePackagesResult,
	PermissionAskContext,
	PromptTemplate,
	SkillDefinition,
} from "@my-agent/core";
import { SessionManager } from "@my-agent/core";
import type { AuthStorage } from "../config/auth-storage.js";
import type { Settings } from "../config/settings.js";
import { formatRuntimeProfile, type RuntimeResult, runAgent } from "../runtime/agent-runtime.js";
import { listModelAvailability, resolveConfiguredModel } from "../runtime/model-registry.js";
import { trace } from "../runtime/trace.js";

const RPC_PROTOCOL_VERSION = "1.0";

/**
 * RPC mode: headless agent server.
 *
 * Protocol: JSONL over stdin/stdout.
 * Commands: prompt, abort, getState, listModels
 * Events: ready, prompt.started, prompt.text, prompt.thinking,
 *         tool.start, tool.end, prompt.completed
 */

export interface RpcConfig {
	cwd?: string;
	settings?: Settings;
	authStorage?: AuthStorage;
	templates?: Map<string, PromptTemplate>;
	skills?: Map<string, SkillDefinition>;
	resources?: LoadResourcePackagesResult;
	disableExtensions?: boolean;
}

export interface RpcCommand {
	id: string;
	method: string;
	params?: Record<string, unknown>;
}

export interface RpcResponse {
	id: string;
	result?: unknown;
	error?: string;
}

export interface RpcEvent {
	event: string;
	data: unknown;
}

export interface RpcServer {
	handleLine(line: string): Promise<void>;
	close(): Promise<void>;
}

interface ActivePrompt {
	controller: AbortController;
	startedAt: number;
}

export function createRpcServer(send: (message: RpcResponse | RpcEvent) => void, config: RpcConfig = {}): RpcServer {
	const cwd = config.cwd ?? process.cwd();
	trace("rpc", "server.create", { cwd, safeMode: config.disableExtensions ?? false });
	const settings = config.settings;
	const authStorage = config.authStorage;
	let session = SessionManager.continueRecent(cwd);
	const activePrompts = new Map<string, ActivePrompt>();

	async function respondState(commandId: string): Promise<void> {
		if (!settings || !authStorage) {
			send({ id: commandId, error: "RPC server not initialized with settings/auth storage" });
			return;
		}

		let resolvedModel: { key: string; provider: string } | { error: string };
		try {
			const resolved = await resolveConfiguredModel(settings, authStorage);
			resolvedModel = { key: resolved.key, provider: resolved.model.provider };
		} catch (error) {
			resolvedModel = { error: error instanceof Error ? error.message : String(error) };
		}

		send({
			id: commandId,
			result: {
				protocolVersion: RPC_PROTOCOL_VERSION,
				cwd,
				sessionId: session.getSessionId(),
				sessionPath: session.getSessionFile?.(),
				configuredModel: settings.model,
				configuredProvider: settings.provider,
				resolvedModel,
				activePromptIds: [...activePrompts.keys()],
				templateCount: config.templates?.size ?? 0,
				skillCount: config.skills?.size ?? 0,
				packageCount: config.resources?.packages.length ?? 0,
				safeMode: config.disableExtensions ?? false,
			},
		});
	}

	async function respondListModels(commandId: string): Promise<void> {
		if (!authStorage) {
			send({ id: commandId, error: "RPC server not initialized with auth storage" });
			return;
		}
		const models = await listModelAvailability(authStorage);
		send({ id: commandId, result: models });
	}

	async function executePrompt(command: RpcCommand, prompt: string, params: Record<string, unknown>): Promise<void> {
		if (!settings || !authStorage) {
			send({ id: command.id, error: "RPC server not initialized with settings/auth storage" });
			return;
		}

		const sessionPath = typeof params.sessionPath === "string" ? params.sessionPath : undefined;
		if (sessionPath) {
			session = SessionManager.open(sessionPath);
		}

		const controller = new AbortController();
		activePrompts.set(command.id, { controller, startedAt: Date.now() });

		trace("rpc", "prompt.start", { requestId: command.id, sessionId: session.getSessionId() });
		send({
			event: "prompt.started",
			data: {
				requestId: command.id,
				cwd,
				sessionId: session.getSessionId(),
				sessionPath: session.getSessionFile?.(),
			},
		});

		const askPermission = async (_ctx: PermissionAskContext): Promise<AskDecision> => "deny";

		let result: RuntimeResult;
		try {
			result = await runAgent(
				prompt,
				{
					cwd,
					settings,
					authStorage,
					session,
					signal: controller.signal,
					askPermission,
					disableExtensions: config.disableExtensions,
					resourceExtensionEntries: config.resources?.packages.flatMap((pkg) => pkg.extensions) ?? [],
				},
				{
					onText: (text) => {
						send({ event: "prompt.text", data: { requestId: command.id, text } });
					},
					onThinking: (text) => {
						send({ event: "prompt.thinking", data: { requestId: command.id, text } });
					},
					onToolStart: (toolName, toolCallId, args) => {
						send({ event: "tool.start", data: { requestId: command.id, toolName, toolCallId, args } });
					},
					onToolEnd: (toolName, isError, info) => {
						send({
							event: "tool.end",
							data: {
								requestId: command.id,
								toolName,
								isError,
								toolCallId: info.toolCallId,
								durationMs: info.durationMs,
								result: info.result,
							},
						});
					},
				},
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			trace("rpc", "prompt.error", { requestId: command.id, error: message });
			send({ event: "prompt.completed", data: { requestId: command.id, aborted: false, error: message } });
			activePrompts.delete(command.id);
			return;
		}

		trace("rpc", "prompt.completed", {
			requestId: command.id,
			aborted: result.aborted,
			error: result.error,
			profile: result.profile,
		});
		send({
			event: "prompt.completed",
			data: {
				requestId: command.id,
				aborted: result.aborted,
				error: result.error,
				durationMs: Date.now() - (activePrompts.get(command.id)?.startedAt ?? Date.now()),
				messageCount: result.messages.length,
				sessionId: session.getSessionId(),
				sessionPath: session.getSessionFile?.(),
				profile: result.profile,
				profileSummary: formatRuntimeProfile(result.profile),
			},
		});
		activePrompts.delete(command.id);
	}

	return {
		async handleLine(line: string): Promise<void> {
			let command: RpcCommand;
			try {
				command = JSON.parse(line) as RpcCommand;
			} catch {
				trace("rpc", "command.invalid_json", { line });
				send({ id: "?", error: "Invalid JSON" });
				return;
			}

			if (!command.id || !command.method) {
				send({ id: command.id || "?", error: "RPC command requires id and method" });
				return;
			}

			trace("rpc", "command.received", { id: command.id, method: command.method });
			switch (command.method) {
				case "prompt": {
					const prompt = typeof command.params?.prompt === "string" ? command.params.prompt : undefined;
					if (!prompt) {
						send({ id: command.id, error: "prompt params.prompt must be a string" });
						return;
					}
					send({ id: command.id, result: { status: "started", requestId: command.id } });
					void executePrompt(command, prompt, command.params ?? {});
					return;
				}

				case "abort": {
					const requestId = typeof command.params?.requestId === "string" ? command.params.requestId : command.id;
					const active = activePrompts.get(requestId);
					if (!active) {
						send({ id: command.id, result: { status: "not_found", requestId } });
						return;
					}
					active.controller.abort();
					send({ id: command.id, result: { status: "aborting", requestId } });
					return;
				}

				case "getState":
					await respondState(command.id);
					return;

				case "listModels":
					await respondListModels(command.id);
					return;

				default:
					send({ id: command.id, error: `Unknown method: ${command.method}` });
			}
		},

		async close(): Promise<void> {
			for (const active of activePrompts.values()) {
				active.controller.abort();
			}
			activePrompts.clear();
		},
	};
}

export function startRpcServer(config?: RpcConfig): void {
	const rl = readline.createInterface({ input: process.stdin });
	const send = (message: RpcResponse | RpcEvent): void => {
		process.stdout.write(`${JSON.stringify(message)}\n`);
	};

	const server = createRpcServer(send, config);
	rl.on("line", async (line) => {
		await server.handleLine(line);
	});
	rl.on("close", () => {
		void server.close();
	});

	send({
		event: "ready",
		data: {
			protocolVersion: RPC_PROTOCOL_VERSION,
			version: "0.1.0",
			methods: ["prompt", "abort", "getState", "listModels"],
		},
	});
}
