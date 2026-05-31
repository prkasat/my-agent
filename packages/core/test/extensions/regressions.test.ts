/**
 * Regression tests for issues surfaced during the codex validation pass.
 * Each test documents the specific bug it guards against.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionRunner } from "../../src/extensions/runner.js";
import { FileExtensionStorage } from "../../src/extensions/storage.js";
import type { ExtensionDefinition } from "../../src/extensions/types.js";

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

function def(overrides: ExtensionDefinition): ExtensionDefinition {
	return overrides;
}

describe("regressions — storage race", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ext-race-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("two storage instances writing disjoint keys do not clobber each other", () => {
		// Previously: instance-level cache snapshot would overwrite newer keys
		// from the sibling instance.
		const a = new FileExtensionStorage({ root, extensionId: "e1" });
		const b = new FileExtensionStorage({ root, extensionId: "e1" });
		a.set("k1", "A", "global");
		b.set("k2", "B", "global");
		const c = new FileExtensionStorage({ root, extensionId: "e1" });
		expect(c.get("k1", "global")).toBe("A");
		expect(c.get("k2", "global")).toBe("B");
	});
});

describe("regressions — middleware goes through runGuarded", () => {
	it("middleware errors count as an extension error and respect continue mode", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		await runner.load(
			def({
				metadata: { id: "bad", name: "B", version: "1.0.0" },
				activate(ctx) {
					ctx.use(async () => {
						throw new Error("mw boom");
					});
				},
			}),
		);
		// No throw — continue mode swallows the error.
		const out = await runner.runToolMiddleware({ toolCallId: "c1", toolName: "bash", args: {} }, async () => ({
			content: [{ type: "text", text: "ok" }],
		}));
		expect(out.error).toBeInstanceOf(Error);
		expect(runner.getMetrics("bad")?.errors).toBe(1);
	});

	it("middleware errors with abort mode propagate", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		await runner.load(
			def({
				metadata: {
					id: "bad",
					name: "B",
					version: "1.0.0",
					failureMode: "abort",
				},
				activate(ctx) {
					ctx.use(async () => {
						throw new Error("mw boom");
					});
				},
			}),
		);
		await expect(
			runner.runToolMiddleware({ toolCallId: "c1", toolName: "bash", args: {} }, async () => ({
				content: [{ type: "text", text: "ok" }],
			})),
		).rejects.toThrow(/mw boom/);
	});

	it("throws if middleware calls next() more than once", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		await runner.load(
			def({
				metadata: { id: "double", name: "D", version: "1.0.0" },
				activate(ctx) {
					ctx.use(async (_c, next) => {
						await next();
						await next();
					});
				},
			}),
		);
		const _out = await runner.runToolMiddleware({ toolCallId: "c1", toolName: "bash", args: {} }, async () => ({
			content: [{ type: "text", text: "ok" }],
		}));
		// After double-next, the middleware threw on the second call; the
		// runner counts that as a middleware error.
		expect(runner.getMetrics("double")?.errors).toBe(1);
	});
});

describe("regressions — disabled extension breaks out of current dispatch", () => {
	it("when failureMode=disable, later handlers of the same extension are NOT called in the same dispatch", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		let secondCalled = false;
		await runner.load(
			def({
				metadata: {
					id: "bad",
					name: "B",
					version: "1.0.0",
					failureMode: "disable",
				},
				activate(ctx) {
					ctx.on("turn_start", () => {
						throw new Error("boom");
					});
					ctx.on("turn_start", () => {
						secondCalled = true;
					});
				},
			}),
		);
		await runner.dispatch({ type: "turn_start", turnIndex: 1 });
		expect(secondCalled).toBe(false);
	});

	it("disabled extension's onAny handlers do not run after disable in same dispatch", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		let anySaw = 0;
		await runner.load(
			def({
				metadata: {
					id: "bad",
					name: "B",
					version: "1.0.0",
					failureMode: "disable",
				},
				activate(ctx) {
					ctx.on("turn_start", () => {
						throw new Error("boom");
					});
					ctx.onAny(() => {
						anySaw++;
					});
				},
			}),
		);
		await runner.dispatch({ type: "turn_start", turnIndex: 1 });
		expect(anySaw).toBe(0);
	});
});

describe("regressions — runCommand returns false when command body errors", () => {
	it("runCommand returns false when command throws (continue mode)", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		await runner.load(
			def({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate(ctx) {
					ctx.registerCommand({
						name: "boom",
						execute: () => {
							throw new Error("cmd failed");
						},
					});
				},
			}),
		);
		const result = await runner.runCommand("boom", "");
		expect(result).toBe(false);
		expect(runner.getMetrics("a")?.errors).toBe(1);
	});
});

describe("regressions — unload aborts signal before deactivate", () => {
	it("ctx.signal fires before deactivate runs", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		let signaledBeforeDeactivate = false;
		await runner.load(
			def({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate(ctx) {
					ctx.on("turn_start", () => {});
					// Capture signal aborted state at deactivation time.
					(ctx as unknown as { __probe: () => void }).__probe = () => {
						signaledBeforeDeactivate = ctx.signal.aborted;
					};
				},
				deactivate(ctx) {
					(ctx as unknown as { __probe: () => void }).__probe();
				},
			}),
		);
		await runner.unload("a");
		expect(signaledBeforeDeactivate).toBe(true);
	});
});

describe("regressions — cross-extension command/tool collision", () => {
	it("second extension registering same command name gets a no-op registration", async () => {
		const warnings: string[] = [];
		const runner = new ExtensionRunner({
			log: { ...silentLog, warn: (m) => warnings.push(m) },
		});
		await runner.load(
			def({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate(ctx) {
					ctx.registerCommand({ name: "x", execute: () => {} });
				},
			}),
		);
		let bRan = false;
		await runner.load(
			def({
				metadata: { id: "b", name: "B", version: "1.0.0" },
				activate(ctx) {
					ctx.registerCommand({
						name: "x",
						execute: () => {
							bRan = true;
						},
					});
				},
			}),
		);
		await runner.runCommand("x", "");
		expect(bRan).toBe(false);
		expect(warnings.some((w) => /already registered/.test(w))).toBe(true);
	});
});

describe("regressions — loader id mismatch", () => {
	it("throws when manifest id and module id disagree", async () => {
		const { ExtensionLoader } = await import("../../src/extensions/loader.js");
		const { writeFileSync, mkdtempSync: mk } = await import("node:fs");
		const tmp = mk(join(tmpdir(), "ext-idcheck-"));
		try {
			const p = join(tmp, "ext.mjs");
			writeFileSync(p, `export default { metadata: { id: "real", name: "R", version: "1.0.0" }, activate(){} };`);
			const runner = new ExtensionRunner({ log: silentLog });
			const loader = new ExtensionLoader({ runner, log: silentLog });
			await expect(
				loader.loadFromManifest({
					entry: p,
					metadata: { id: "wrong", name: "W", version: "1.0.0" },
				}),
			).rejects.toThrow(/does not match module id/);
			// The loader's internal entry map should NOT have been populated.
			await expect(loader.reload("wrong")).rejects.toThrow(/not loaded/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("regressions — activation failure rollback", () => {
	it("releases command owner reservations when activate() throws after registering", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		const bad: ExtensionDefinition = {
			metadata: { id: "bad", name: "B", version: "1.0.0" },
			activate(ctx) {
				ctx.registerCommand({ name: "x", execute: () => {} });
				throw new Error("activate failed");
			},
		};
		await expect(runner.load(bad)).rejects.toThrow(/activate failed/);
		// Now a different extension should be able to claim "x".
		const good: ExtensionDefinition = {
			metadata: { id: "good", name: "G", version: "1.0.0" },
			activate(ctx) {
				ctx.registerCommand({ name: "x", execute: () => {} });
			},
		};
		await runner.load(good);
		expect(runner.getAllCommands().map((c) => c.extensionId)).toEqual(["good"]);
	});
});

// Note: a regression test for `loader.reload()` refusing an id change
// cannot run under vitest because vitest's module loader caches file://
// imports by canonical path and does not honor the `?v=N` cache-busting
// query string we use in production Node. The behavior is verified
// manually via a standalone script (see commit history / PR) and the
// same id-match check path is exercised by
// "loader.test.ts :: rejects modules without a valid definition".

describe("regressions — middleware errors after next() are surfaced", () => {
	it("error thrown after await next() appears on chainCtx.error", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		await runner.load(
			def({
				metadata: { id: "bad", name: "B", version: "1.0.0" },
				activate(ctx) {
					ctx.use(async (_c, next) => {
						await next();
						throw new Error("post-next boom");
					});
				},
			}),
		);
		const out = await runner.runToolMiddleware({ toolCallId: "c1", toolName: "bash", args: {} }, async () => ({
			content: [{ type: "text", text: "ok" }],
		}));
		expect(out.error).toBeInstanceOf(Error);
		expect(out.error?.message).toMatch(/post-next boom/);
		expect(out.result).toBeDefined(); // tool DID execute
	});
});

describe("regressions — MetricsRecorder exposed on ctx", () => {
	it("extensions can record their own token usage and api calls", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		await runner.load(
			def({
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate(ctx) {
					ctx.recorder.recordTokens(100);
					ctx.recorder.recordTokens(50);
					ctx.recorder.recordApiCall();
				},
			}),
		);
		const m = runner.getMetrics("a");
		expect(m?.tokensUsed).toBe(150);
		expect(m?.apiCalls).toBe(1);
	});
});
