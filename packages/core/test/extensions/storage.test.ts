import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FileExtensionStorage,
	MemoryExtensionStorage,
} from "../../src/extensions/storage.js";

describe("MemoryExtensionStorage", () => {
	it("get/set/delete within a scope", () => {
		const s = new MemoryExtensionStorage();
		s.set("k", 1);
		expect(s.get("k")).toBe(1);
		expect(s.delete("k")).toBe(true);
		expect(s.get("k")).toBeUndefined();
		expect(s.delete("k")).toBe(false);
	});

	it("isolates session and global scopes", () => {
		const s = new MemoryExtensionStorage();
		s.set("k", "session-val", "session");
		s.set("k", "global-val", "global");
		expect(s.get("k", "session")).toBe("session-val");
		expect(s.get("k", "global")).toBe("global-val");
	});

	it("keys and clear", () => {
		const s = new MemoryExtensionStorage();
		s.set("a", 1);
		s.set("b", 2);
		expect(s.keys().sort()).toEqual(["a", "b"]);
		s.clear();
		expect(s.keys()).toEqual([]);
	});
});

describe("FileExtensionStorage", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ext-storage-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("persists across instances (global scope)", () => {
		const a = new FileExtensionStorage({ root, extensionId: "e1" });
		a.set("k", { v: 42 }, "global");
		const b = new FileExtensionStorage({ root, extensionId: "e1" });
		expect(b.get("k", "global")).toEqual({ v: 42 });
	});

	it("persists session-scoped state per sessionId", () => {
		const s1 = new FileExtensionStorage({ root, extensionId: "e1", sessionId: "s1" });
		const s2 = new FileExtensionStorage({ root, extensionId: "e1", sessionId: "s2" });
		s1.set("k", "one");
		s2.set("k", "two");
		const s1b = new FileExtensionStorage({ root, extensionId: "e1", sessionId: "s1" });
		expect(s1b.get("k")).toBe("one");
		const s2b = new FileExtensionStorage({ root, extensionId: "e1", sessionId: "s2" });
		expect(s2b.get("k")).toBe("two");
	});

	it("throws on session scope without sessionId", () => {
		const s = new FileExtensionStorage({ root, extensionId: "e1" });
		expect(() => s.set("k", 1)).toThrow(/session scope requires a sessionId/);
	});

	it("rejects invalid extension ids", () => {
		expect(() => new FileExtensionStorage({ root, extensionId: ".." })).toThrow();
	});

	it("tolerates corrupt data by starting fresh", () => {
		const s = new FileExtensionStorage({ root, extensionId: "e1" });
		s.set("k", "v", "global");
		// Overwrite file with garbage.
		const fs = require("node:fs");
		const p = join(root, "global", "e1.json");
		fs.writeFileSync(p, "{ not json");
		const s2 = new FileExtensionStorage({ root, extensionId: "e1" });
		expect(s2.get("k", "global")).toBeUndefined();
	});
});
