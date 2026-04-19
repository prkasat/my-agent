import { Type as T } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import { ExtensionRunner } from "../../src/extensions/runner.js";
import type { ExtensionDefinition, ToolInterceptResult, ToolResultModification } from "../../src/extensions/types.js";

function makeDefinition(
	overrides: Partial<ExtensionDefinition> & Pick<ExtensionDefinition, "metadata" | "activate">,
): ExtensionDefinition {
	return {
		metadata: overrides.metadata,
		activate: overrides.activate,
		deactivate: overrides.deactivate,
		config: overrides.config,
		onBeforeReload: overrides.onBeforeReload,
		onAfterReload: overrides.onAfterReload,
	};
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

describe("ExtensionRunner — registration & lifecycle", () => {
	it("loads and activates an extension", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		const activate = vi.fn();
		await runner.load(
			makeDefinition({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate,
			}),
		);
		expect(activate).toHaveBeenCalledTimes(1);
		expect(runner.has("a")).toBe(true);
	});

	it("rejects duplicate load of same id", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		const def = makeDefinition({
			metadata: { id: "a", name: "A", version: "1.0.0" },
			activate: () => {},
		});
		await runner.load(def);
		await expect(runner.load(def)).rejects.toThrow(/already loaded/);
	});

	it("unload calls deactivate and removes the extension", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		const deactivate = vi.fn();
		await runner.load(
			makeDefinition({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate: () => {},
				deactivate,
			}),
		);
		await runner.unload("a");
		expect(deactivate).toHaveBeenCalledTimes(1);
		expect(runner.has("a")).toBe(false);
	});

	it("survives deactivate errors so shutdown-time extension crashes do not brick teardown", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		await runner.load(
			makeDefinition({
				metadata: { id: "crashy", name: "Crashy", version: "1.0.0" },
				activate: () => {},
				deactivate: () => {
					throw new Error("shutdown boom");
				},
			}),
		);
		await expect(runner.unload("crashy")).resolves.toBeUndefined();
		expect(runner.has("crashy")).toBe(false);
	});

	it("reload preserves state via onBeforeReload/onAfterReload", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		let captured: unknown;
		const def1: ExtensionDefinition = {
			metadata: { id: "a", name: "A", version: "1.0.0" },
			activate: () => {},
			onBeforeReload: () => ({ counter: 42 }),
		};
		const def2: ExtensionDefinition = {
			metadata: { id: "a", name: "A", version: "1.0.1" },
			activate: () => {},
			onAfterReload: (state) => {
				captured = state;
			},
		};
		await runner.load(def1);
		await runner.reload(def2);
		expect(captured).toEqual({ counter: 42 });
	});

	it("validates config against a typebox schema", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		const schema = T.Object({
			timeout: T.Number({ minimum: 0 }),
			label: T.Optional(T.String()),
		});
		const def: ExtensionDefinition = {
			metadata: { id: "a", name: "A", version: "1.0.0" },
			config: { schema, defaults: { timeout: 30 } },
			activate: (ctx) => {
				expect((ctx.config as { timeout: number }).timeout).toBe(30);
			},
		};
		await runner.load(def);
	});

	it("rejects invalid config", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		const schema = T.Object({ timeout: T.Number({ minimum: 0 }) });
		const def: ExtensionDefinition = {
			metadata: { id: "a", name: "A", version: "1.0.0" },
			config: { schema },
			activate: () => {},
		};
		await expect(runner.load(def, { timeout: -5 })).rejects.toThrow(/config is invalid/);
	});
});

describe("ExtensionRunner — event dispatch", () => {
	it("delivers events to subscribed handlers", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		const received: unknown[] = [];
		await runner.load(
			makeDefinition({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate: (ctx) => {
					ctx.on("turn_start", (e) => {
						received.push(e.turnIndex);
					});
				},
			}),
		);
		await runner.dispatch({ type: "turn_start", turnIndex: 1 });
		await runner.dispatch({ type: "turn_start", turnIndex: 2 });
		expect(received).toEqual([1, 2]);
	});

	it("onAny sees every event", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		const types: string[] = [];
		await runner.load(
			makeDefinition({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate: (ctx) => {
					ctx.onAny((e) => {
						types.push(e.type);
					});
				},
			}),
		);
		await runner.dispatch({ type: "turn_start", turnIndex: 1 });
		await runner.dispatch({ type: "turn_end", turnIndex: 1 });
		expect(types).toEqual(["turn_start", "turn_end"]);
	});

	it("extension_loaded is NOT delivered to the extension that was just loaded", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		const aSaw: string[] = [];
		const bSaw: string[] = [];
		await runner.load(
			makeDefinition({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate: (ctx) => {
					ctx.on("extension_loaded", (e) => aSaw.push(e.extensionId));
				},
			}),
		);
		await runner.load(
			makeDefinition({
				metadata: { id: "b", name: "B", version: "1.0.0" },
				activate: (ctx) => {
					ctx.on("extension_loaded", (e) => bSaw.push(e.extensionId));
				},
			}),
		);
		expect(aSaw).toEqual(["b"]);
		expect(bSaw).toEqual([]);
	});
});

describe("ExtensionRunner — tool interception", () => {
	it("blocks tool execution when a handler returns action: 'block'", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		await runner.load(
			makeDefinition({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate: (ctx) => {
					ctx.on("tool_execution_start", () => {
						return { action: "block", reason: "not allowed" };
					});
				},
			}),
		);
		const result = await runner.dispatchToolStart("c1", "bash", { command: "rm -rf /" });
		expect(result).toEqual({ action: "block", reason: "not allowed" });
	});

	it("composes modifiedArgs across handlers in registration order", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		await runner.load(
			makeDefinition({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate: (ctx) => {
					ctx.on("tool_execution_start", (e) => {
						const args = e.args as Record<string, unknown>;
						return {
							action: "allow",
							modifiedArgs: { ...args, addedByA: true },
						} satisfies ToolInterceptResult;
					});
				},
			}),
		);
		await runner.load(
			makeDefinition({
				metadata: { id: "b", name: "B", version: "1.0.0" },
				activate: (ctx) => {
					ctx.on("tool_execution_start", (e) => {
						const args = e.args as Record<string, unknown>;
						return {
							action: "allow",
							modifiedArgs: { ...args, addedByB: true },
						} satisfies ToolInterceptResult;
					});
				},
			}),
		);
		const result = await runner.dispatchToolStart("c1", "bash", { cmd: "ls" });
		expect(result).toEqual({
			action: "allow",
			modifiedArgs: { cmd: "ls", addedByA: true, addedByB: true },
		});
	});

	it("modifies tool result in tool_execution_end", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		await runner.load(
			makeDefinition({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate: (ctx) => {
					ctx.on("tool_execution_end", () => {
						return {
							content: [{ type: "text", text: "redacted" }],
							isError: false,
						} satisfies ToolResultModification;
					});
				},
			}),
		);
		const original: AgentToolResult = {
			content: [{ type: "text", text: "secret" }],
		};
		const mod = await runner.dispatchToolEnd("c1", "bash", original, false, 10);
		expect(mod?.content?.[0]).toEqual({ type: "text", text: "redacted" });
	});

	it("transforms user_input in registration order", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		await runner.load(
			makeDefinition({
				metadata: { id: "upper", name: "U", version: "1.0.0" },
				activate: (ctx) => {
					ctx.on("user_input", (e) => e.content.toUpperCase());
				},
			}),
		);
		await runner.load(
			makeDefinition({
				metadata: { id: "suffix", name: "S", version: "1.0.0" },
				activate: (ctx) => {
					ctx.on("user_input", (e) => `${e.content}!`);
				},
			}),
		);
		const out = await runner.dispatchUserInput("hello");
		expect(out).toBe("HELLO!");
	});
});

describe("ExtensionRunner — middleware", () => {
	it("runs middleware around tool execution (outermost first)", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		const log: string[] = [];

		await runner.load(
			makeDefinition({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate: (ctx) => {
					ctx.use(async (_c, next) => {
						log.push("A:before");
						await next();
						log.push("A:after");
					});
				},
			}),
		);
		await runner.load(
			makeDefinition({
				metadata: { id: "b", name: "B", version: "1.0.0" },
				activate: (ctx) => {
					ctx.use(async (_c, next) => {
						log.push("B:before");
						await next();
						log.push("B:after");
					});
				},
			}),
		);

		const final = await runner.runToolMiddleware({ toolCallId: "c1", toolName: "bash", args: {} }, async () => {
			log.push("execute");
			return { content: [{ type: "text", text: "ok" }] };
		});

		expect(log).toEqual(["A:before", "B:before", "execute", "B:after", "A:after"]);
		expect(final.result?.content[0]).toEqual({ type: "text", text: "ok" });
		expect(typeof final.durationMs).toBe("number");
	});

	it("middleware can short-circuit by not calling next", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		let executed = false;
		await runner.load(
			makeDefinition({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate: (ctx) => {
					ctx.use(async (c, _next) => {
						c.blocked = true;
						// Intentionally do not call next.
					});
				},
			}),
		);
		const out = await runner.runToolMiddleware({ toolCallId: "c1", toolName: "bash", args: {} }, async () => {
			executed = true;
			return { content: [{ type: "text", text: "ok" }] };
		});
		expect(executed).toBe(false);
		expect(out.blocked).toBe(true);
	});
});

describe("ExtensionRunner — failure modes", () => {
	it("continues dispatch when a handler throws (default mode)", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		const bSaw: unknown[] = [];
		await runner.load(
			makeDefinition({
				metadata: { id: "bad", name: "Bad", version: "1.0.0" },
				activate: (ctx) => {
					ctx.on("turn_start", () => {
						throw new Error("boom");
					});
				},
			}),
		);
		await runner.load(
			makeDefinition({
				metadata: { id: "good", name: "Good", version: "1.0.0" },
				activate: (ctx) => {
					ctx.on("turn_start", (e) => {
						bSaw.push(e.turnIndex);
					});
				},
			}),
		);
		await runner.dispatch({ type: "turn_start", turnIndex: 1 });
		expect(bSaw).toEqual([1]);
		expect(runner.getMetrics("bad")?.errors).toBe(1);
	});

	it("aborts dispatch when failureMode is 'abort'", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		await runner.load(
			makeDefinition({
				metadata: {
					id: "bad",
					name: "Bad",
					version: "1.0.0",
					failureMode: "abort",
				},
				activate: (ctx) => {
					ctx.on("turn_start", () => {
						throw new Error("boom");
					});
				},
			}),
		);
		await expect(runner.dispatch({ type: "turn_start", turnIndex: 1 })).rejects.toThrow(/boom/);
	});

	it("disables extension when failureMode is 'disable'", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		let calls = 0;
		await runner.load(
			makeDefinition({
				metadata: {
					id: "bad",
					name: "Bad",
					version: "1.0.0",
					failureMode: "disable",
				},
				activate: (ctx) => {
					ctx.on("turn_start", () => {
						calls++;
						throw new Error("boom");
					});
				},
			}),
		);
		await runner.dispatch({ type: "turn_start", turnIndex: 1 });
		await runner.dispatch({ type: "turn_start", turnIndex: 2 });
		expect(calls).toBe(1);
		expect(runner.list().find((e) => e.id === "bad")?.disabled).toBe(true);
	});

	it("enforces handlerTimeoutMs", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		await runner.load(
			makeDefinition({
				metadata: {
					id: "slow",
					name: "S",
					version: "1.0.0",
					handlerTimeoutMs: 10,
				},
				activate: (ctx) => {
					ctx.on("turn_start", () => new Promise((r) => setTimeout(r, 200)));
				},
			}),
		);
		await runner.dispatch({ type: "turn_start", turnIndex: 1 });
		expect(runner.getMetrics("slow")?.errors).toBeGreaterThanOrEqual(1);
	});
});

describe("ExtensionRunner — commands & tools", () => {
	it("registers and runs commands", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		let gotArgs = "";
		await runner.load(
			makeDefinition({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate: (ctx) => {
					ctx.registerCommand({
						name: "hello",
						execute: (args) => {
							gotArgs = args;
						},
					});
				},
			}),
		);
		const ran = await runner.runCommand("hello", "world");
		expect(ran).toBe(true);
		expect(gotArgs).toBe("world");
		const cmds = runner.getAllCommands();
		expect(cmds.map((c) => c.name)).toEqual(["hello"]);
	});

	it("runCommand returns false when the command is unknown", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		const ran = await runner.runCommand("nope", "");
		expect(ran).toBe(false);
	});

	it("aggregates tools across extensions", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		const fakeTool = (name: string) => ({
			name,
			description: "t",
			parameters: T.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "" }] }),
		});
		await runner.load(
			makeDefinition({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate: (ctx) => {
					ctx.registerTool(fakeTool("t1"));
				},
			}),
		);
		await runner.load(
			makeDefinition({
				metadata: { id: "b", name: "B", version: "1.0.0" },
				activate: (ctx) => {
					ctx.registerTool(fakeTool("t2"));
				},
			}),
		);
		const names = runner
			.getAllTools()
			.map((t) => t.name)
			.sort();
		expect(names).toEqual(["t1", "t2"]);
	});
});

describe("ExtensionRunner — metrics", () => {
	it("counts errors and execution time", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		await runner.load(
			makeDefinition({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate: (ctx) => {
					ctx.on("turn_start", () => {
						// some work
					});
				},
			}),
		);
		await runner.dispatch({ type: "turn_start", turnIndex: 1 });
		const m = runner.getMetrics("a");
		expect(m?.errors).toBe(0);
		expect(m?.executionTimeMs).toBeGreaterThanOrEqual(0);
		expect(m?.lastActiveAt).toBeDefined();
	});
});
