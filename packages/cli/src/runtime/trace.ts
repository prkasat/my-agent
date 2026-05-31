import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { redactValue } from "@my-agent/core";

export type TraceScope = "runtime" | "auth" | "permissions" | "extensions" | "rpc" | "resources";

export interface TraceEvent {
	id: string;
	timestamp: string;
	scope: TraceScope;
	type: string;
	data: unknown;
}

class TraceWriter {
	private readonly dir: string;
	private readonly scopes: Set<TraceScope> | null;
	private readonly filePath: string;
	private initialized = false;

	constructor(dir: string, scopes?: TraceScope[]) {
		this.dir = dir;
		this.scopes = scopes && scopes.length > 0 ? new Set(scopes) : null;
		this.filePath = path.join(
			dir,
			`${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID().slice(0, 8)}.jsonl`,
		);
	}

	getPath(): string {
		return this.filePath;
	}

	isEnabled(scope: TraceScope): boolean {
		return this.scopes === null || this.scopes.has(scope);
	}

	async write(scope: TraceScope, type: string, data: unknown): Promise<void> {
		if (!this.isEnabled(scope)) return;
		if (!this.initialized) {
			await fs.mkdir(this.dir, { recursive: true });
			this.initialized = true;
		}

		const event: TraceEvent = {
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			scope,
			type,
			data: redactValue(data),
		};
		await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf-8");
	}
}

let writer: TraceWriter | undefined;

export function initializeTracing(options: { enabled?: boolean; dir: string; scopes?: TraceScope[] }): void {
	const envEnabled = isTruthy(process.env.MY_AGENT_TRACE);
	const enabled = options.enabled || envEnabled;
	if (!enabled) {
		writer = undefined;
		return;
	}

	const scopes = options.scopes ?? parseScopes(process.env.MY_AGENT_TRACE_SCOPES);
	writer = new TraceWriter(options.dir, scopes);
}

export function getTraceFilePath(): string | undefined {
	return writer?.getPath();
}

export function trace(scope: TraceScope, type: string, data: unknown): void {
	void writer?.write(scope, type, data);
}

export function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function parseScopes(value: string | undefined): TraceScope[] | undefined {
	if (!value) return undefined;
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry): entry is TraceScope =>
			["runtime", "auth", "permissions", "extensions", "rpc", "resources"].includes(entry),
		);
}

function isTruthy(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}
