import type { SessionInfo } from "@my-agent/core";
import { describe, expect, it } from "vitest";
import { type SlashContext, type SlashSessionManager, handleSlashCommand } from "../src/repl/slash-commands.js";

function makeSession(overrides: Partial<SlashSessionManager> = {}): SlashSessionManager {
	return {
		getSessionId: () => "session-id",
		getCwd: () => "/test/cwd",
		forkSession: () => "/sessions/new.jsonl",
		getSessionFile: () => "/sessions/current.jsonl",
		listSessionsForCwd: async () => [],
		...overrides,
	};
}

function makeContext(sessionOverrides: Partial<SlashSessionManager> = {}): SlashContext {
	return {
		session: makeSession(sessionOverrides),
	};
}

describe("handleSlashCommand", () => {
	it("returns null for non-slash input so the REPL can route it to the agent", async () => {
		const result = await handleSlashCommand("hello world", makeContext());
		expect(result).toBeNull();
	});

	it("returns help text for /help", async () => {
		const result = await handleSlashCommand("/help", makeContext());
		expect(result?.action).toBe("continue");
		expect(result?.output).toMatch(/\/branch/);
		expect(result?.output).toMatch(/\/sessions/);
		expect(result?.output).toMatch(/\/quit/);
	});

	it("aliases /? to /help", async () => {
		const result = await handleSlashCommand("/?", makeContext());
		expect(result?.output).toMatch(/\/branch/);
	});

	it("returns quit action for /quit and /exit", async () => {
		const quit = await handleSlashCommand("/quit", makeContext());
		expect(quit?.action).toBe("quit");
		const exit = await handleSlashCommand("/exit", makeContext());
		expect(exit?.action).toBe("quit");
	});

	it("/branch forks the session and returns switch-session with the new path", async () => {
		let forkArg: string | undefined;
		const ctx = makeContext({
			forkSession: (leafId) => {
				forkArg = leafId;
				return "/sessions/forked.jsonl";
			},
		});
		const result = await handleSlashCommand("/branch", ctx);
		expect(result?.action).toBe("switch-session");
		if (result?.action === "switch-session") {
			expect(result.sessionPath).toBe("/sessions/forked.jsonl");
			expect(result.output).toMatch(/forked\.jsonl/);
		}
		// Without an explicit leafId, the handler should let SessionManager
		// default to its current leaf — i.e., not pass anything.
		expect(forkArg).toBeUndefined();
	});

	it("/fork is an alias for /branch", async () => {
		const result = await handleSlashCommand("/fork", makeContext());
		expect(result?.action).toBe("switch-session");
	});

	it("/branch surfaces a friendly message when forkSession returns no path (in-memory)", async () => {
		const ctx = makeContext({
			forkSession: () => undefined,
		});
		const result = await handleSlashCommand("/branch", ctx);
		expect(result?.action).toBe("continue");
		expect(result?.output).toMatch(/branch failed/);
	});

	it("/branch catches SessionManager errors instead of crashing the REPL", async () => {
		const ctx = makeContext({
			forkSession: () => {
				throw new Error("No leaf to fork from");
			},
		});
		const result = await handleSlashCommand("/branch", ctx);
		expect(result?.action).toBe("continue");
		expect(result?.output).toMatch(/No leaf to fork from/);
	});

	it("/sessions lists sessions and marks the current one", async () => {
		const sessions: SessionInfo[] = [
			{
				path: "/sessions/a.jsonl",
				id: "a",
				cwd: "/test/cwd",
				created: new Date(),
				modified: new Date(),
				messageCount: 3,
				firstMessage: "Hello world",
			},
			{
				path: "/sessions/current.jsonl",
				id: "current",
				cwd: "/test/cwd",
				created: new Date(),
				modified: new Date(),
				messageCount: 7,
				firstMessage: "Refactor the parser to support multi-line strings",
			},
		];
		const ctx = makeContext({
			listSessionsForCwd: async () => sessions,
		});
		const result = await handleSlashCommand("/sessions", ctx);
		expect(result?.action).toBe("continue");
		expect(result?.output).toMatch(/a \(3 msgs\)/);
		expect(result?.output).toMatch(/current \(7 msgs\)/);
		// Current session must be marked
		expect(result?.output).toMatch(/current \(7 msgs\).*current/);
		expect(result?.output).not.toMatch(/a \(3 msgs\).*current/);
	});

	it("/sessions reports empty state cleanly", async () => {
		const result = await handleSlashCommand("/sessions", makeContext({ listSessionsForCwd: async () => [] }));
		expect(result?.output).toMatch(/no sessions/i);
	});

	it("/sessions handles host without listSessionsForCwd", async () => {
		const ctx = makeContext();
		(ctx.session as { listSessionsForCwd?: unknown }).listSessionsForCwd = undefined;
		const result = await handleSlashCommand("/sessions", ctx);
		expect(result?.output).toMatch(/not available/);
	});

	it("/tree shows the current session tree when available", async () => {
		const result = await handleSlashCommand("/tree", {
			...makeContext({
				getTree: () => [
					{
						entry: {
							id: "root",
							type: "message",
							parentId: null,
							timestamp: new Date().toISOString(),
							message: { role: "user", content: "hi" },
						} as any,
						children: [
							{
								entry: {
									id: "child",
									type: "message",
									parentId: "root",
									timestamp: new Date().toISOString(),
									message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
								} as any,
								children: [],
							},
						],
					},
				],
			}),
		});
		expect(result?.output).toMatch(/root/);
		expect(result?.output).toMatch(/child/);
	});

	it("/extensions reports configured extension paths", async () => {
		const result = await handleSlashCommand("/extensions", {
			...makeContext(),
			settings: {
				model: "openrouter-auto",
				provider: "openrouter",
				thinkingLevel: "medium",
				compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60000 },
				extensions: ["./extensions/demo.mjs"],
				packages: [],
				skills: [],
				theme: "default",
				enabledModels: ["*"],
				maxTurns: 50,
				permissionMode: "ask",
			},
		});
		expect(result?.output).toMatch(/demo\.mjs/);
	});

	it("/skills lists loaded skills", async () => {
		const result = await handleSlashCommand("/skills", {
			...makeContext(),
			skills: new Map([
				[
					"research",
					{
						name: "Research",
						description: "Summarize a topic",
						prompt: "Research $@",
						command: "research",
						aliases: ["investigate"],
						filePath: "/tmp/research.md",
						source: "project",
					},
				],
			]),
		});
		expect(result?.output).toMatch(/research/);
		expect(result?.output).toMatch(/investigate/);
	});

	it("skill commands expand into prompts", async () => {
		const result = await handleSlashCommand("/research agents", {
			...makeContext(),
			skills: new Map([
				[
					"research",
					{
						name: "Research",
						description: "Summarize a topic",
						prompt: "Research $@",
						command: "research",
						aliases: [],
						filePath: "/tmp/research.md",
						source: "project",
					},
				],
			]),
		});
		expect(result?.action).toBe("prompt");
		if (result?.action === "prompt") {
			expect(result.prompt).toBe("Research agents");
		}
	});

	it("/packages lists loaded package resources", async () => {
		const result = await handleSlashCommand("/packages", {
			...makeContext(),
			resources: {
				warnings: [],
				packages: [
					{
						name: "research-bundle",
						description: "",
						rootDir: "/tmp/research-bundle",
						source: "project",
						prompts: ["/tmp/research-bundle/prompts"],
						skills: ["/tmp/research-bundle/skills"],
						extensions: ["/tmp/research-bundle/extensions/tool.mjs"],
						themes: ["/tmp/research-bundle/themes/default.json"],
					},
				],
			},
		});
		expect(result?.output).toMatch(/research-bundle/);
		expect(result?.output).toMatch(/extensions/);
	});

	it("/model updates the current model", async () => {
		const persistCalls: Array<Record<string, unknown>> = [];
		const settings = {
			model: "openrouter-auto",
			provider: "openrouter",
			thinkingLevel: "medium",
			compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60000 },
			extensions: [],
			packages: [],
			skills: [],
			theme: "default",
			enabledModels: ["*"],
			maxTurns: 50,
			permissionMode: "ask",
		} as const;
		const result = await handleSlashCommand("/model claude-opus-4", {
			...makeContext(),
			settings: settings as any,
			persistSettings: async (next) => {
				persistCalls.push(next as Record<string, unknown>);
			},
		});
		expect(result?.output).toMatch(/claude-opus-4/);
		expect((settings as any).provider).toBe("anthropic");
		expect(persistCalls[0]).toEqual({ model: "claude-opus-4" });
	});

	it("/theme lists loaded themes", async () => {
		const result = await handleSlashCommand("/theme", {
			...makeContext(),
			settings: {
				model: "openrouter-auto",
				provider: "openrouter",
				thinkingLevel: "medium",
				compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60000 },
				extensions: [],
				packages: [],
				skills: [],
				theme: "night",
				enabledModels: ["*"],
				maxTurns: 50,
				permissionMode: "ask",
			},
			themes: {
				warnings: [],
				themes: new Map([
					["default", { name: "default", source: "builtin", theme: {} as any }],
					["night", { name: "night", source: "project", filePath: "/tmp/night.json", theme: {} as any }],
				]),
			},
		});
		expect(result?.output).toMatch(/night/);
		expect(result?.output).toMatch(/current/);
	});

	it("unknown commands return a continue action with a help hint", async () => {
		const result = await handleSlashCommand("/wat", makeContext());
		expect(result?.action).toBe("continue");
		expect(result?.output).toMatch(/unknown command/);
		expect(result?.output).toMatch(/\/help/);
	});

	it("is case-insensitive for command names", async () => {
		const result = await handleSlashCommand("/HELP", makeContext());
		expect(result?.output).toMatch(/\/branch/);
	});

	it("ignores extra whitespace and tolerates leading/trailing spaces", async () => {
		const result = await handleSlashCommand("   /help   ", makeContext());
		expect(result?.output).toMatch(/\/branch/);
	});
});
