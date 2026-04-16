import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	expandPath,
	isPathWithinBoundary,
	resolveAndValidatePath,
	resolveReadPath,
	resolveToCwd,
} from "../../src/tools/path-utils.js";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";

describe("path-utils", () => {
	describe("expandPath", () => {
		it("expands ~ to home directory", () => {
			expect(expandPath("~")).toBe(os.homedir());
			expect(expandPath("~/foo")).toBe(os.homedir() + "/foo");
		});

		it("strips @ prefix", () => {
			expect(expandPath("@/path/to/file")).toBe("/path/to/file");
		});

		it("normalizes unicode spaces", () => {
			expect(expandPath("/path\u00A0with\u00A0spaces")).toBe("/path with spaces");
		});
	});

	describe("resolveToCwd", () => {
		it("resolves relative paths against cwd", () => {
			expect(resolveToCwd("foo/bar", "/home/user")).toBe("/home/user/foo/bar");
		});

		it("returns absolute paths unchanged", () => {
			expect(resolveToCwd("/absolute/path", "/home/user")).toBe("/absolute/path");
		});

		it("expands ~ before resolving", () => {
			const result = resolveToCwd("~/docs", "/home/user");
			expect(result).toBe(os.homedir() + "/docs");
		});
	});

	describe("isPathWithinBoundary", () => {
		it("returns true for paths within boundary", () => {
			expect(isPathWithinBoundary("/home/user/project/file.ts", "/home/user/project")).toBe(true);
			expect(isPathWithinBoundary("/home/user/project/sub/dir/file.ts", "/home/user/project")).toBe(true);
		});

		it("returns true for exact boundary match", () => {
			expect(isPathWithinBoundary("/home/user/project", "/home/user/project")).toBe(true);
		});

		it("returns false for paths outside boundary", () => {
			expect(isPathWithinBoundary("/home/user/other/file.ts", "/home/user/project")).toBe(false);
			expect(isPathWithinBoundary("/etc/passwd", "/home/user/project")).toBe(false);
		});

		it("returns false for path traversal attempts", () => {
			expect(isPathWithinBoundary("/home/user/project/../other/file.ts", "/home/user/project")).toBe(false);
			expect(isPathWithinBoundary("/home/user/project/../../etc/passwd", "/home/user/project")).toBe(false);
		});

		it("handles prefix attacks", () => {
			expect(isPathWithinBoundary("/home/user/project-evil/file.ts", "/home/user/project")).toBe(false);
		});
	});

	// Tests that depend on the real filesystem need an isolated tmp tree
	// so we can create real symlinks. macOS prefixes /tmp with /private,
	// so always realpath the test root.
	describe("resolveAndValidatePath (filesystem-backed)", () => {
		let root: string;
		let cwd: string;
		let outside: string;

		beforeAll(() => {
			const raw = mkdtempSync(path.join(os.tmpdir(), "my-agent-path-utils-"));
			root = realpathSync(raw);
			cwd = path.join(root, "project");
			outside = path.join(root, "outside");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(outside, { recursive: true });
			writeFileSync(path.join(outside, "secret"), "top-secret");
			mkdirSync(path.join(cwd, "sub"), { recursive: true });
			writeFileSync(path.join(cwd, "sub", "ok.txt"), "fine");

			// Two symlinks inside cwd:
			// - "good-link" points to an intra-cwd directory (allowed)
			// - "evil-link" points outside cwd (blocked)
			symlinkSync(path.join(cwd, "sub"), path.join(cwd, "good-link"));
			symlinkSync(outside, path.join(cwd, "evil-link"));
		});

		afterAll(() => {
			rmSync(root, { recursive: true, force: true });
		});

		it("allows relative paths inside cwd", () => {
			expect(resolveAndValidatePath("sub/ok.txt", cwd)).toBe(path.join(cwd, "sub", "ok.txt"));
		});

		it("allows new-file paths inside cwd (target doesn't exist yet)", () => {
			// The write tool needs this case: create a new file under cwd.
			expect(resolveAndValidatePath("sub/new-file.txt", cwd)).toBe(path.join(cwd, "sub", "new-file.txt"));
			expect(resolveAndValidatePath("brand-new-dir/nested.txt", cwd)).toBe(
				path.join(cwd, "brand-new-dir", "nested.txt"),
			);
		});

		it("allows intra-cwd symlinks", () => {
			expect(resolveAndValidatePath("good-link/ok.txt", cwd)).toBe(path.join(cwd, "good-link", "ok.txt"));
		});

		it("blocks .. traversal escapes", () => {
			expect(() => resolveAndValidatePath("../outside/secret", cwd)).toThrow("Path traversal denied");
			expect(() => resolveAndValidatePath("sub/../../outside/secret", cwd)).toThrow("Path traversal denied");
		});

		it("blocks absolute paths outside cwd", () => {
			expect(() => resolveAndValidatePath(path.join(outside, "secret"), cwd)).toThrow("Path traversal denied");
			expect(() => resolveAndValidatePath("/etc/passwd", cwd)).toThrow("Path traversal denied");
		});

		it("blocks symlinks that escape cwd", () => {
			// "evil-link" is inside cwd lexically but its realpath is outside.
			expect(() => resolveAndValidatePath("evil-link/secret", cwd)).toThrow("Path traversal denied");
			expect(() => resolveAndValidatePath("evil-link", cwd)).toThrow("Path traversal denied");
		});

		it("blocks new-file paths through escaping symlinks", () => {
			// Writing to "evil-link/new-file" would create the file in /outside.
			expect(() => resolveAndValidatePath("evil-link/new-file.txt", cwd)).toThrow("Path traversal denied");
		});

		it("returns the original resolved path, not the realpath", () => {
			// good-link → sub. Tool callers expect the symlink path back, not the target.
			const result = resolveAndValidatePath("good-link/ok.txt", cwd);
			expect(result).toBe(path.join(cwd, "good-link", "ok.txt"));
			expect(result).not.toBe(path.join(cwd, "sub", "ok.txt"));
		});
	});

	describe("resolveReadPath (filesystem-backed)", () => {
		let root: string;
		let cwd: string;
		let outside: string;

		beforeAll(() => {
			const raw = mkdtempSync(path.join(os.tmpdir(), "my-agent-readpath-"));
			root = realpathSync(raw);
			cwd = path.join(root, "project");
			outside = path.join(root, "outside");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(outside, { recursive: true });
			writeFileSync(path.join(outside, "secret"), "top-secret");
			writeFileSync(path.join(cwd, "real.txt"), "hello");
			symlinkSync(outside, path.join(cwd, "evil-link"));
		});

		afterAll(() => {
			rmSync(root, { recursive: true, force: true });
		});

		it("returns the resolved path for an existing file inside cwd", () => {
			expect(resolveReadPath("real.txt", cwd)).toBe(path.join(cwd, "real.txt"));
		});

		it("blocks reads through escaping symlinks", () => {
			expect(() => resolveReadPath("evil-link/secret", cwd)).toThrow("Path traversal denied");
		});

		it("blocks absolute reads outside cwd", () => {
			expect(() => resolveReadPath(path.join(outside, "secret"), cwd)).toThrow("Path traversal denied");
		});

		it("regression: macOS variant fallback re-validates symlinked variants", () => {
			// Setup: the user requests `screenshot AM.png` (regular space). The
			// file does not exist with that exact name, so the resolver tries
			// the macOS NARROW NO-BREAK SPACE variant (`screenshot\u202fAM.png`).
			// We plant that variant as a SYMLINK pointing to /outside/secret.
			//
			// Before the fix, the variant fallback skipped boundary
			// re-validation: it would happily return the symlinked path and
			// the read tool would follow it to /outside/secret.
			const variantName = `screenshot${"\u202F"}AM.png`;
			const requestedName = "screenshot AM.png";
			const variantPath = path.join(cwd, variantName);
			symlinkSync(path.join(outside, "secret"), variantPath);

			try {
				// resolveReadPath should NOT silently return the escaping variant.
				// It should fall back to the original (non-existent) resolved path.
				const result = resolveReadPath(requestedName, cwd);
				expect(result).toBe(path.join(cwd, requestedName));
				// And specifically NOT the variant that escapes
				expect(result).not.toBe(variantPath);
			} finally {
				rmSync(variantPath);
			}
		});

		it("regression: NFD-variant fallback never returns an escaping symlink", () => {
			// Same threat model with NFD decomposition. User asks for "café.txt"
			// (NFC, single composed char); the planted NFD-named symlink
			// (`cafe` + combining accent) points to /outside/secret.
			//
			// macOS APFS treats NFC and NFD as the same inode, so the OUTER
			// `resolveAndValidatePath` will throw before the variant code even
			// runs. Linux ext4 keeps them distinct, in which case the variant
			// fallback exercises the re-validation guard. Either outcome is
			// safe — what we MUST NOT see is a returned path that resolves
			// to /outside/secret.
			const composed = "caf\u00E9.txt"; // NFC
			const decomposed = "cafe\u0301.txt"; // NFD
			const variantPath = path.join(cwd, decomposed);
			symlinkSync(path.join(outside, "secret"), variantPath);

			try {
				let returned: string | undefined;
				let threw = false;
				try {
					returned = resolveReadPath(composed, cwd);
				} catch {
					threw = true;
				}

				if (threw) {
					// macOS path: blocked at the outer resolver. Safe.
					expect(threw).toBe(true);
				} else {
					// Linux path: returned, but must NOT be the escaping variant.
					expect(returned).not.toBe(variantPath);
					// And the returned path must not symlink-resolve outside.
					expect(returned).toBe(path.join(cwd, composed));
				}
			} finally {
				rmSync(variantPath);
			}
		});
	});
});
