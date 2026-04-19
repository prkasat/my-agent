import * as readline from "node:readline";
import type { OAuthStorage } from "../config/oauth-storage.js";
import type { Settings } from "../config/settings.js";
import type { PromptTemplate } from "@my-agent/core";

/**
 * RPC mode: headless agent server.
 *
 * Protocol: JSONL over stdin/stdout.
 * Any process that can read/write lines of JSON can drive the agent.
 *
 * Commands: prompt, abort, getState
 * Events: ready, agent_start, message_update, tool_execution, agent_end
 */

export interface RpcConfig {
	settings?: Settings;
	oauthStorage?: OAuthStorage;
	templates?: Map<string, PromptTemplate>;
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

export function startRpcServer(config?: RpcConfig) {
	const rl = readline.createInterface({ input: process.stdin });

	function send(msg: RpcResponse | RpcEvent): void {
		process.stdout.write(`${JSON.stringify(msg)}\n`);
	}

	rl.on("line", async (line) => {
		let cmd: RpcCommand;
		try {
			cmd = JSON.parse(line);
		} catch {
			send({ id: "?", error: "Invalid JSON" });
			return;
		}

		switch (cmd.method) {
			case "prompt":
				send({ id: cmd.id, result: { status: "started" } });
				// Agent events streamed as RpcEvent...
				break;

			case "abort":
				send({ id: cmd.id, result: { status: "aborted" } });
				break;

			case "getState":
				send({ id: cmd.id, result: {} });
				break;

			default:
				send({ id: cmd.id, error: `Unknown method: ${cmd.method}` });
		}
	});

	// Signal ready to host process
	send({ event: "ready", data: { version: "0.1.0" } } as RpcEvent);
}
