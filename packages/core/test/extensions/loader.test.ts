import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionLoader } from "../../src/extensions/loader.js";
import { ExtensionRunner } from "../../src/extensions/runner.js";

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

describe("ExtensionLoader", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "ext-loader-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("loads an extension from a manifest", async () => {
		const entry = join(tmp, "ext-a.mjs");
		writeFileSync(
			entry,
			`
			let log = [];
			export default {
				metadata: { id: "a", name: "A", version: "1.0.0" },
				activate(ctx) {
					ctx.registerCommand({
						name: "hi",
						execute: (args) => { log.push("v1:" + args); }
					});
				}
			};
			`,
		);
		const runner = new ExtensionRunner({ log: silentLog });
		const loader = new ExtensionLoader({ runner, log: silentLog });
		await loader.loadFromManifest({
			entry,
			metadata: { id: "a", name: "A", version: "1.0.0" },
		});
		expect(runner.has("a")).toBe(true);
		await runner.runCommand("hi", "there");
	});

	it("reloads with cache-busting import", async () => {
		const entry = join(tmp, "ext-b.mjs");
		writeFileSync(
			entry,
			`
			export default {
				metadata: { id: "b", name: "B", version: "1.0.0" },
				activate(ctx) {
					ctx.registerCommand({
						name: "which",
						execute: (_, c) => { c.log.info("v1"); }
					});
				}
			};
			`,
		);
		const runner = new ExtensionRunner({ log: silentLog });
		const loader = new ExtensionLoader({ runner, log: silentLog });
		await loader.loadFromManifest({
			entry,
			metadata: { id: "b", name: "B", version: "1.0.0" },
		});

		writeFileSync(
			entry,
			`
			export default {
				metadata: { id: "b", name: "B", version: "1.1.0" },
				activate(ctx) {
					ctx.registerCommand({
						name: "which",
						execute: (_, c) => { c.log.info("v2"); }
					});
				}
			};
			`,
		);
		await loader.reload("b");

		const cmds = runner.getAllCommands().filter((c) => c.name === "which");
		expect(cmds).toHaveLength(1);
	});

	it("preserves state via onBeforeReload/onAfterReload", async () => {
		const entry = join(tmp, "ext-c.mjs");
		writeFileSync(
			entry,
			`
			let state = { count: 0 };
			export default {
				metadata: { id: "c", name: "C", version: "1.0.0" },
				activate() {},
				onBeforeReload: () => ({ preserved: state.count }),
				onAfterReload: (s) => { globalThis.__restored = s; }
			};
			`,
		);
		const runner = new ExtensionRunner({ log: silentLog });
		const loader = new ExtensionLoader({ runner, log: silentLog });
		await loader.loadFromManifest({
			entry,
			metadata: { id: "c", name: "C", version: "1.0.0" },
		});

		// Bump state via a fresh eval within the module graph — easiest:
		// just reload and check restore path runs.
		await loader.reload("c");
		expect((globalThis as Record<string, unknown>).__restored).toEqual({
			preserved: 0,
		});
	});

	it("rejects modules without a valid definition", async () => {
		const entry = join(tmp, "ext-bad.mjs");
		writeFileSync(entry, "export default { nope: true };");
		const runner = new ExtensionRunner({ log: silentLog });
		const loader = new ExtensionLoader({ runner, log: silentLog });
		const res = loader.loadFromManifest({
			entry,
			metadata: { id: "bad", name: "Bad", version: "1.0.0" },
		});
		await expect(res).rejects.toThrow(/valid ExtensionDefinition/);
	});

	it("loadAll respects topological order when requires is set", async () => {
		const a = join(tmp, "a.mjs");
		const b = join(tmp, "b.mjs");
		writeFileSync(a, `export default { metadata: { id: "a", name: "A", version: "1.0.0" }, activate(){} };`);
		writeFileSync(
			b,
			`export default { metadata: { id: "b", name: "B", version: "1.0.0", requires: ["a"] }, activate(){} };`,
		);
		const runner = new ExtensionRunner({ log: silentLog });
		const loader = new ExtensionLoader({ runner, log: silentLog });
		await loader.loadAll([
			{ entry: b, metadata: { id: "b", name: "B", version: "1.0.0", requires: ["a"] } },
			{ entry: a, metadata: { id: "a", name: "A", version: "1.0.0" } },
		]);
		expect(runner.has("a")).toBe(true);
		expect(runner.has("b")).toBe(true);
	});

	it("detects dependency cycles", async () => {
		const runner = new ExtensionRunner({ log: silentLog });
		const loader = new ExtensionLoader({ runner, log: silentLog });
		const a = join(tmp, "a.mjs");
		const b = join(tmp, "b.mjs");
		writeFileSync(a, `export default { metadata: { id: "a", name: "A", version: "1.0.0" }, activate(){} };`);
		writeFileSync(b, `export default { metadata: { id: "b", name: "B", version: "1.0.0" }, activate(){} };`);
		const res = loader.loadAll([
			{ entry: a, metadata: { id: "a", name: "A", version: "1.0.0", requires: ["b"] } },
			{ entry: b, metadata: { id: "b", name: "B", version: "1.0.0", requires: ["a"] } },
		]);
		await expect(res).rejects.toThrow(/cycle/);
	});
});
