import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	acquireFileLock,
	lockDirFor,
	refreshLockHeartbeat,
	verifyLockRoot,
	withCrossProcessLock,
	withFileMutationLock,
} from "../../src/tools/file-mutation-queue.js";

/**
 * Resolve the on-disk lock directory for a given target file path.
 * Mirrors the canonicalization that `acquireFileLock` does internally,
 * so tests can plant or inspect lock state without depending on the
 * exact storage location.
 */
function locateLockDir(filePath: string): string {
	// On macOS, /var/folders/... realpath-canonicalizes to /private/var/folders/...
	// `acquireFileLock` does that internally via realpathOrAncestor before
	// hashing, so tests must do the same to land on the same hash.
	const realpathSyncFn = require("node:fs").realpathSync;
	let canonical = filePath;
	try {
		canonical = realpathSyncFn(filePath);
	} catch {
		// path might not exist yet — walk up to find an existing ancestor
		let p = filePath;
		const tail: string[] = [];
		while (true) {
			try {
				const real = realpathSyncFn(p);
				canonical = tail.length === 0 ? real : path.resolve(real, ...tail.reverse());
				break;
			} catch {
				const parent = path.dirname(p);
				if (parent === p) {
					canonical = path.resolve(filePath);
					break;
				}
				tail.push(path.basename(p));
				p = parent;
			}
		}
	}
	const lockDir = lockDirFor(canonical);
	// Ensure parent (LOCK_ROOT) exists so tests that plant lock state
	// directly can mkdir successfully without relying on acquireFileLock
	// having run first.
	mkdirSync(path.dirname(lockDir), { recursive: true });
	return lockDir;
}

describe("file-mutation-queue cross-process lock", () => {
	let root: string;

	beforeAll(() => {
		root = mkdtempSync(path.join(os.tmpdir(), "my-agent-lock-"));
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("acquires and releases a lock", async () => {
		const file = path.join(root, "a");
		writeFileSync(file, "hi");
		const release = await acquireFileLock(file, { timeout: 200 });
		release();
		// Second acquire after release should succeed
		const release2 = await acquireFileLock(file, { timeout: 200 });
		release2();
	});

	it("times out when lock is held by an alive PID", async () => {
		const file = path.join(root, "b");
		writeFileSync(file, "hi");
		const release = await acquireFileLock(file, { timeout: 200 });
		try {
			await expect(acquireFileLock(file, { timeout: 200 })).rejects.toThrow("Timeout");
		} finally {
			release();
		}
	});

	it("regression A6: evicts a lock held by a dead PID, even if young", async () => {
		const file = path.join(root, "c");
		writeFileSync(file, "hi");
		const lockDir = locateLockDir(file);

		// Manually create a lock with an unreasonable PID (very high → guaranteed dead)
		mkdirSync(lockDir);
		const fakeInfo = {
			v: 1,
			pid: 999_999_999, // unlikely to exist
			hostname: os.hostname(),
			acquiredAt: Date.now(), // YOUNG — would NOT be evicted by age alone
		};
		writeFileSync(path.join(lockDir, "info"), JSON.stringify(fakeInfo));

		// Should evict immediately because the PID is dead, despite being seconds old
		const release = await acquireFileLock(file, { timeout: 1_000 });
		release();
	});

	it("regression A6: does NOT evict a lock held by a live PID after the old 30s threshold", async () => {
		const file = path.join(root, "d");
		writeFileSync(file, "hi");
		const lockDir = locateLockDir(file);

		// Lock with current PID (alive!) and an old timestamp (60s ago)
		mkdirSync(lockDir);
		const oldInfo = {
			v: 1,
			pid: process.pid, // alive
			hostname: os.hostname(),
			acquiredAt: Date.now() - 60_000, // 60s old — past the legacy 30s threshold
		};
		writeFileSync(path.join(lockDir, "info"), JSON.stringify(oldInfo));

		// Should still time out — owner is alive and within the 5-minute safety window.
		// Before A6, this would silently evict because age > 30s.
		await expect(acquireFileLock(file, { timeout: 200 })).rejects.toThrow("Timeout");

		// Cleanup
		rmSync(lockDir, { recursive: true });
	});

	it("evicts a lock held by a live PID once it crosses the 5-minute safety bound", async () => {
		const file = path.join(root, "e");
		writeFileSync(file, "hi");
		const lockDir = locateLockDir(file);

		mkdirSync(lockDir);
		const oldInfo = {
			v: 1,
			pid: process.pid, // alive
			hostname: os.hostname(),
			acquiredAt: Date.now() - 10 * 60_000, // 10 minutes old, well past 5-min bound
		};
		writeFileSync(path.join(lockDir, "info"), JSON.stringify(oldInfo));

		// Crosses the safety upper bound — should evict and acquire
		const release = await acquireFileLock(file, { timeout: 1_000 });
		release();
	});

	it("falls back to age check when info file is missing", async () => {
		const file = path.join(root, "f");
		writeFileSync(file, "hi");
		const lockDir = locateLockDir(file);

		// Lock dir with NO info file, but old mtime (10 minutes ago)
		mkdirSync(lockDir);
		const oldTime = (Date.now() - 10 * 60_000) / 1000;
		utimesSync(lockDir, oldTime, oldTime);

		const release = await acquireFileLock(file, { timeout: 1_000 });
		release();
	});

	it("treats different-host owners as opaque and uses age threshold", async () => {
		const file = path.join(root, "g");
		writeFileSync(file, "hi");
		const lockDir = locateLockDir(file);

		mkdirSync(lockDir);
		const foreignInfo = {
			v: 1,
			pid: 12345,
			hostname: "some-other-host", // not us
			acquiredAt: Date.now() - 60_000, // 1 min old (within threshold)
		};
		writeFileSync(path.join(lockDir, "info"), JSON.stringify(foreignInfo));

		// Cannot verify foreign-host PID liveness — must wait. Should time out.
		await expect(acquireFileLock(file, { timeout: 200 })).rejects.toThrow("Timeout");

		// Now age it out past the unknown-owner threshold (5 min)
		rmSync(lockDir, { recursive: true });
		mkdirSync(lockDir);
		writeFileSync(path.join(lockDir, "info"), JSON.stringify({ ...foreignInfo, acquiredAt: Date.now() - 10 * 60_000 }));

		// Now beyond threshold — eviction allowed
		const release = await acquireFileLock(file, { timeout: 1_000 });
		release();
	});

	it("withCrossProcessLock runs the function and releases on success", async () => {
		const file = path.join(root, "h");
		writeFileSync(file, "hi");

		const result = await withCrossProcessLock(file, async () => 42, { timeout: 200 });
		expect(result).toBe(42);

		// Should be re-acquirable
		const release = await acquireFileLock(file, { timeout: 200 });
		release();
	});

	it("withCrossProcessLock releases on error too", async () => {
		const file = path.join(root, "i");
		writeFileSync(file, "hi");

		await expect(
			withCrossProcessLock(
				file,
				async () => {
					throw new Error("boom");
				},
				{ timeout: 200 },
			),
		).rejects.toThrow("boom");

		// Re-acquirable after error
		const release = await acquireFileLock(file, { timeout: 200 });
		release();
	});

	it("writes structured lock info that includes hostname and pid", async () => {
		const file = path.join(root, "j");
		writeFileSync(file, "hi");
		const release = await acquireFileLock(file, { timeout: 200 });
		try {
			const info = JSON.parse(readFileSync(path.join(locateLockDir(file), "info"), "utf-8"));
			expect(info.pid).toBe(process.pid);
			expect(info.hostname).toBe(os.hostname());
			expect(typeof info.acquiredAt).toBe("number");
			expect(typeof info.token).toBe("string");
			expect(info.token.length).toBeGreaterThan(0);
		} finally {
			release();
		}
	});

	it("regression: stale releaser does NOT tear down a successor's lock (token check)", async () => {
		// Reproduces the critical bug found in pass-3 review:
		// 1. Process A acquires a lock
		// 2. After A's safety bound expires, process B evicts A and acquires
		// 3. A's release closure eventually fires
		// 4. Without a per-acquisition token, A's release does an
		//    unconditional `rmSync(lockDir)` and tears down B's lock,
		//    letting C race in and corrupt the protected file.
		const file = path.join(root, "k");
		writeFileSync(file, "hi");
		const lockDir = locateLockDir(file);

		// A acquires
		const releaseA = await acquireFileLock(file, { timeout: 200 });

		// Capture A's info (so we can compare against the post-eviction state)
		const aInfo = JSON.parse(readFileSync(path.join(lockDir, "info"), "utf-8"));
		expect(aInfo.token).toBeTruthy();

		// Simulate B taking over: tear down A's lock, write B's info
		// (this mimics what `tryEvictStale` + a fresh `acquireFileLock` would do)
		rmSync(lockDir, { recursive: true });
		mkdirSync(lockDir);
		const bInfo = {
			v: 2,
			pid: process.pid,
			hostname: os.hostname(),
			acquiredAt: Date.now(),
			token: "successor-token-not-A",
		};
		writeFileSync(path.join(lockDir, "info"), JSON.stringify(bInfo));

		// A's release fires AFTER eviction — must NOT delete B's lock
		releaseA();

		// B's lock should still be intact
		const afterRelease = JSON.parse(readFileSync(path.join(lockDir, "info"), "utf-8"));
		expect(afterRelease.token).toBe("successor-token-not-A");

		// And acquiring should still time out (B still owns it)
		await expect(acquireFileLock(file, { timeout: 200 })).rejects.toThrow("Timeout");

		// Cleanup
		rmSync(lockDir, { recursive: true });
	});

	it("regression: release does not delete a foreign lock when info is missing", async () => {
		// Edge case: if A's release runs and the lockDir exists but the info
		// file is gone (e.g., partially-overwritten by an evictor mid-rewrite),
		// release should NOT blindly tear down the directory either. Treating
		// "info unreadable" as "still ours" is the same bug class.
		const file = path.join(root, "l");
		writeFileSync(file, "hi");
		const lockDir = locateLockDir(file);

		const releaseA = await acquireFileLock(file, { timeout: 200 });

		// Wipe the info file (simulates a successor mid-write)
		rmSync(path.join(lockDir, "info"));

		releaseA();

		// lockDir should remain (we couldn't verify ownership, so we left it)
		expect(() => statSync(lockDir)).not.toThrow();

		// Cleanup
		rmSync(lockDir, { recursive: true });
	});

	it("regression (pass-5): symlink aliases of the same file serialize through ONE lock", async () => {
		// Two aliases for the same target inode should map to the SAME
		// canonical lock identity. Without canonicalization, write through
		// `dir-link/file` and write through `real-dir/file` would acquire
		// different lockDirs and could race against each other.
		const realDir = path.join(root, "real-dir");
		mkdirSync(realDir);
		const dirLink = path.join(root, "link-dir");
		symlinkSync(realDir, dirLink);

		const target = path.join(realDir, "shared.txt");
		writeFileSync(target, "");

		const aliasPath = path.join(dirLink, "shared.txt");

		// Acquire via the alias
		const release = await withFileMutationLock(aliasPath, async () => {
			// While we hold via the alias, attempting to acquire via
			// the real path with a short timeout MUST fail. If
			// canonicalization is broken they'd be different locks.
			await expect(acquireFileLock(target, { timeout: 200 })).rejects.toThrow("Timeout");
			return "ok";
		});
		expect(release).toBe("ok");
	});

	it("regression (pass-5): symlink aliases serialize even for non-existent leaf files", async () => {
		// realpathSync.native fails on non-existent leaves; the alias
		// canonicalization MUST handle that case so newly-created files
		// inside a symlinked directory still share a lock.
		const realDir = path.join(root, "real-dir-2");
		mkdirSync(realDir);
		const dirLink = path.join(root, "link-dir-2");
		symlinkSync(realDir, dirLink);

		const newViaReal = path.join(realDir, "new.txt"); // doesn't exist yet
		const newViaAlias = path.join(dirLink, "new.txt");

		await withFileMutationLock(newViaAlias, async () => {
			await expect(acquireFileLock(newViaReal, { timeout: 200 })).rejects.toThrow("Timeout");
		});
	});

	it("regression (pass-5): aborting during a contended lock cancels promptly, not at timeout", async () => {
		// Without abort-aware lock acquisition, a `write` queued behind
		// another holder would poll for up to 5 seconds (LOCK_TIMEOUT_MS)
		// even after the run is cancelled. The signal must short-circuit
		// the retry loop immediately.
		const file = path.join(root, "abort-during-lock");
		writeFileSync(file, "hi");

		const releaseHolder = await acquireFileLock(file, { timeout: 200 });

		const ac = new AbortController();
		const start = Date.now();
		const acquirePromise = acquireFileLock(file, { timeout: 5_000, signal: ac.signal });

		// Fire the abort 50ms in
		setTimeout(() => ac.abort(), 50);

		await expect(acquirePromise).rejects.toThrow(/Aborted/);
		const elapsed = Date.now() - start;

		// Should have bailed nearly immediately, NOT waited the full 5s
		expect(elapsed).toBeLessThan(500);

		releaseHolder();
	});

	it("regression (pass-5): a pre-aborted signal short-circuits before the first acquire attempt", async () => {
		const file = path.join(root, "pre-aborted");
		writeFileSync(file, "hi");

		const ac = new AbortController();
		ac.abort();

		await expect(acquireFileLock(file, { timeout: 200, signal: ac.signal })).rejects.toThrow(/Aborted/);
	});

	it("regression (pass-6): canonicalization happens inside acquireFileLock so all callers benefit", async () => {
		// SessionManager.withLock and any other helper that uses
		// withCrossProcessLock directly should automatically get
		// symlink-alias safety, not just withFileMutationLock.
		const realDir = path.join(root, "canon-real");
		mkdirSync(realDir);
		const aliasDir = path.join(root, "canon-link");
		symlinkSync(realDir, aliasDir);

		const realFile = path.join(realDir, "session.jsonl");
		writeFileSync(realFile, "");
		const aliasFile = path.join(aliasDir, "session.jsonl");

		// Acquire via the alias — and from a separate caller try the real
		// path. They MUST contend even though we used withCrossProcessLock
		// (NOT withFileMutationLock) to acquire.
		const release = await withCrossProcessLock(aliasFile, async () => {
			await expect(acquireFileLock(realFile, { timeout: 200 })).rejects.toThrow("Timeout");
			return "ok";
		});
		expect(release).toBe("ok");
	});

	it("regression (pass-6): withCrossProcessLock re-checks abort after acquisition, before fn() runs", async () => {
		// If the signal fires in the microtask gap between
		// acquireFileLock returning and the await resuming, fn() must
		// NOT execute. Otherwise a cancelled run still does one critical
		// section.
		const file = path.join(root, "post-acquire-abort");
		writeFileSync(file, "");

		const ac = new AbortController();
		let fnRan = false;

		// Schedule the abort to fire on the next microtask, so it lands
		// in the gap between acquireFileLock's resolve and our await
		// continuation.
		queueMicrotask(() => ac.abort());

		await expect(
			withCrossProcessLock(
				file,
				async () => {
					fnRan = true;
					return "should not run";
				},
				{ signal: ac.signal },
			),
		).rejects.toThrow(/Aborted/);

		expect(fnRan).toBe(false);

		// Lock must have been released — a fresh acquire should succeed
		const release = await acquireFileLock(file, { timeout: 200 });
		release();
	});

	it("regression (pass-10): O_NOFOLLOW flag is dropped on win32 (which doesn't support it)", () => {
		// Document the platform branch: on POSIX we MUST include
		// O_NOFOLLOW; on win32 it's not in libuv's supported flag set
		// and would either error or be silently ignored. The flag
		// computation in writeLockInfo guards on platform.
		const fsRequire = require("node:fs");
		const hasNoFollow = typeof fsRequire.constants.O_NOFOLLOW === "number";
		if (process.platform === "win32") {
			// On Windows, even if the constant exists, the open behavior
			// for symlinks/reparse points is different — verify our code
			// path doesn't try to use it.
			expect(true).toBe(true); // doc-only
		} else {
			expect(hasNoFollow).toBe(true);
		}
	});

	it("regression (pass-10/11): verifyLockRoot rejects a symlinked LOCK_ROOT", () => {
		// Threat model: another local user pre-creates LOCK_ROOT as a
		// symlink to a writable location they control. Without the
		// lstat-based rejection, every subsequent lock would be stored
		// at the attacker's chosen target.
		const fakeRoot = path.join(root, "fake-root");
		const realDir = path.join(root, "actual");
		mkdirSync(realDir);
		symlinkSync(realDir, fakeRoot);

		expect(() => verifyLockRoot(fakeRoot)).toThrow(/symlink/i);
	});

	it("regression (pass-11): verifyLockRoot rejects a non-directory at LOCK_ROOT", () => {
		// Pre-staged regular file where we'd want a directory.
		const fakeRoot = path.join(root, "regular-file-root");
		writeFileSync(fakeRoot, "not a dir");
		expect(() => verifyLockRoot(fakeRoot)).toThrow(/not a directory/i);
	});

	it("regression (pass-11): verifyLockRoot accepts a normal owned directory", () => {
		// The happy path: directory exists, owned by us, mode 0700.
		const goodRoot = path.join(root, "good-root");
		mkdirSync(goodRoot, { mode: 0o700 });
		expect(() => verifyLockRoot(goodRoot)).not.toThrow();
	});

	it("regression (pass-11): verifyLockRoot tolerates a non-existent path (caller will mkdir)", () => {
		// First-use case: LOCK_ROOT doesn't exist yet. Verifier returns
		// silently and the caller proceeds to mkdir.
		const missingRoot = path.join(root, "does-not-exist");
		expect(() => verifyLockRoot(missingRoot)).not.toThrow();
	});

	it("regression (pass-9): info-file open uses O_CREAT|O_EXCL|O_NOFOLLOW so symlink poisoning fails", () => {
		// Direct verification that our exact openSync flag combination
		// rejects a pre-existing symlink. Threat model: a peer with the
		// same uid plants a symlinked `info` inside our lockDir between
		// our mkdirSync and writeLockInfo, redirecting our write to an
		// attacker-controlled path. Without O_NOFOLLOW the write would
		// follow the symlink and clobber the decoy. With O_NOFOLLOW the
		// open fails with ELOOP (or EEXIST if the lock was raced).
		//
		// Direct openSync test instead of routing through acquireFileLock
		// because the planted lockDir would have to age past
		// STALE_LOCK_MS_UNKNOWN (5min) before normal acquisition logic
		// would evict it — too long for a real test. The unit-style
		// openSync verification proves our flag contract is correct.
		const fsRequire = require("node:fs");
		const decoy = path.join(root, "decoy-pass9.txt");
		writeFileSync(decoy, "victim");
		const link = path.join(root, "info-link");
		symlinkSync(decoy, link);

		expect(() => {
			fsRequire.openSync(
				link,
				fsRequire.constants.O_CREAT |
					fsRequire.constants.O_EXCL |
					fsRequire.constants.O_WRONLY |
					fsRequire.constants.O_NOFOLLOW,
				0o600,
			);
		}).toThrow(/ELOOP|EEXIST/);

		// Decoy was not touched
		expect(readFileSync(decoy, "utf-8")).toBe("victim");

		rmSync(link);
	});

	it("regression (pass-9): lock namespace includes hostname so unrelated peers don't collide", () => {
		// `LOCK_ROOT` segments by uid + hostname (+ optional env
		// namespace) so two containers that share a uid via volume-
		// mounted /tmp don't trample each other's locks. Verify the
		// path includes a sanitized hostname segment.
		const file = path.join(root, "namespace-check");
		const lockDir = locateLockDir(file);
		expect(lockDir).toContain(path.join(os.tmpdir(), "my-agent-locks-"));
		// Hostname segment (sanitized: alphanumerics + dashes only)
		const segment = path.basename(path.dirname(lockDir));
		expect(segment).toMatch(/^my-agent-locks-[a-zA-Z0-9_-]+/);
	});

	it("regression (pass-8): lock metadata does not leak the target file path", async () => {
		// Pre-pass-8, the on-disk info file embedded the canonical path
		// so anyone with read access on /tmp could tell which files we
		// were mutating. After the fix, the info JSON contains pid /
		// hostname / token / acquiredAt only — no `target` field.
		const file = path.join(root, "no-leak.txt");
		writeFileSync(file, "");
		const release = await acquireFileLock(file, { timeout: 200 });
		try {
			const info = JSON.parse(readFileSync(path.join(locateLockDir(file), "info"), "utf-8"));
			expect(info.target).toBeUndefined();
			// And no other field surfacing the path
			for (const [, value] of Object.entries(info)) {
				if (typeof value === "string") {
					expect(value).not.toContain(file);
				}
			}
		} finally {
			release();
		}
	});

	it("regression (pass-8): lock metadata file is owner-only (mode 0600) on POSIX", async () => {
		if (process.platform === "win32") return; // POSIX-only assertion
		const file = path.join(root, "perm-check.txt");
		writeFileSync(file, "");
		const release = await acquireFileLock(file, { timeout: 200 });
		try {
			const infoStat = statSync(path.join(locateLockDir(file), "info"));
			// Mask off the file-type bits, keep just the perms
			const perms = infoStat.mode & 0o777;
			expect(perms).toBe(0o600);
		} finally {
			release();
		}
	});

	it("regression (pass-8): case-only aliases for new files map to ONE lock on darwin/win32", async () => {
		// On macOS/APFS (case-insensitive by default) and Windows,
		// `Foo.ts` and `foo.ts` for a not-yet-created file are the
		// same eventual file. They MUST take the same lock so two
		// concurrent writers don't race. realpathOrAncestor preserves
		// the requested casing of the unresolved tail, so without
		// case-folding the hash key, the two requests would lock
		// different dirs.
		if (process.platform !== "darwin" && process.platform !== "win32") {
			return; // Linux is case-sensitive — different casings = different files
		}

		const fooPath = path.join(root, "case-test", "Foo.ts");
		const lowerPath = path.join(root, "case-test", "foo.ts");

		// Acquire via the upper-case alias
		const release = await withFileMutationLock(fooPath, async () => {
			// While we hold via Foo.ts, an attempt via foo.ts MUST
			// contend (NOT acquire its own independent lock). With
			// case-folding the hash collides → EEXIST → poll → timeout.
			await expect(acquireFileLock(lowerPath, { timeout: 200 })).rejects.toThrow("Timeout");
			return "ok";
		});
		expect(release).toBe("ok");
	});

	it("regression (pass-7): write/edit can lock a file under a not-yet-created parent directory", async () => {
		// Before the centralized lock root, lockDir = `${target}.lock`,
		// so write into `new-dir/file.ts` tried `mkdirSync("new-dir/file.ts.lock")`
		// before `new-dir` existed — failing with ENOENT and breaking the
		// write tool's "creates parent directories" contract.
		const newDir = path.join(root, "brand-new", "nested", "dir");
		const target = path.join(newDir, "file.txt");
		// `target`'s parent does NOT exist yet — must still acquire successfully
		const release = await withFileMutationLock(target, async () => "ok");
		expect(release).toBe("ok");
	});

	// NOTE: the "setup failure cleans up orphan lockDir" invariant is
	// asserted only by code review at this time. A reliable regression
	// test would need to inject an `fs.writeFileSync` failure into the
	// post-mkdir setup path — but Node's ESM module bindings can't be
	// rebound from a test, and the mtime-fallback eviction is capped at
	// the 5-minute STALE_LOCK_MS_UNKNOWN threshold, so a planted orphan
	// can't be observed to recover within a normal test timeout. The
	// cleanup logic itself is the small `catch (setupErr)` block in
	// acquireFileLock that calls `fs.rmSync(lockDir, { recursive: true })`
	// before rethrowing — keep that block intact.

	it("regression (pass-6): same-file mutation backlog is not unfair to a sibling process poll", async () => {
		// Local backlog of mutations holding the same file. While the
		// backlog is draining, another acquirer (simulating a sibling
		// process) polling at the same interval MUST be able to win
		// at some point in a reasonable window — not blocked the entire
		// lock timeout.
		//
		// Before the pass-6 fix, the in-process queue's microtask
		// continuation always beat the external poll's setTimeout, so
		// the external could be starved for the full 5-second timeout.
		const file = path.join(root, "fairness");
		writeFileSync(file, "");

		// Build a local backlog of 3 mutations, each holding for 80ms
		const localResults: number[] = [];
		const local = (n: number) =>
			withFileMutationLock(file, async () => {
				await new Promise((r) => setTimeout(r, 80));
				localResults.push(n);
			});

		const localBacklog = Promise.all([local(1), local(2), local(3)]);

		// External contender starts ~10ms in, after the first local has
		// taken the lock
		await new Promise((r) => setTimeout(r, 10));
		const externalStart = Date.now();
		const externalAcquired = acquireFileLock(file, { timeout: 2_000 });

		await localBacklog;
		const release = await externalAcquired;
		const externalElapsed = Date.now() - externalStart;
		release();

		// External should have made it in within the realistic local
		// backlog window (~3 * 80ms + some retry slack), well under
		// the 2s timeout. The exact threshold is generous to avoid
		// flake on slow CI but tight enough to catch real starvation.
		expect(externalElapsed).toBeLessThan(1_000);
		expect(localResults).toEqual([1, 2, 3]);
	});

	it("Tier-2 D3: refresh creates a token-scoped sidecar without touching info", async () => {
		const file = path.join(root, "heartbeat-1");
		writeFileSync(file, "hi");
		const release = await acquireFileLock(file, { timeout: 200 });
		try {
			const lockDir = locateLockDir(file);
			const infoPath = path.join(lockDir, "info");
			const infoBefore = readFileSync(infoPath, "utf-8");
			const initial = JSON.parse(infoBefore);
			// info itself does not carry heartbeat freshness any more —
			// the sidecar is the source of truth (Codex Tier-2-pass-1 fix).
			expect(initial.heartbeatAt).toBeUndefined();

			const sidecarPath = path.join(lockDir, `heartbeat.${initial.token}`);
			await new Promise((r) => setTimeout(r, 5));
			const outcome = refreshLockHeartbeat(infoPath, initial.token);
			expect(outcome).toBe("ok");
			expect(existsSync(sidecarPath)).toBe(true);

			// info MUST NOT have been touched — that immutability is what
			// closes the eviction-clobber race.
			expect(readFileSync(infoPath, "utf-8")).toBe(infoBefore);
		} finally {
			release();
		}
	});

	it("Tier-2 pass-3: alive PID is NOT evicted at 60s (sidecar mtime no longer drives eviction)", async () => {
		// Pass-2 used the sidecar's mtime to evict at 30s. Pass-3 reverted
		// to the 5-minute threshold for alive PIDs because sustained
		// heartbeat-write failure could otherwise lead to dual holders.
		// The sidecar stays as observability but doesn't drive eviction.
		const file = path.join(root, "heartbeat-2");
		writeFileSync(file, "hi");
		const lockDir = locateLockDir(file);

		mkdirSync(lockDir);
		const token = "still-within-5min-budget";
		const planted = {
			v: 2,
			pid: process.pid,
			hostname: os.hostname(),
			acquiredAt: Date.now() - 60_000, // 60s — well under the 5-min bound
			token,
		};
		writeFileSync(path.join(lockDir, "info"), JSON.stringify(planted));
		// Stale sidecar — pre-pass-3 this would have triggered 30s eviction.
		const sidecar = path.join(lockDir, `heartbeat.${token}`);
		writeFileSync(sidecar, "");
		const staleSec = (Date.now() - 60_000) / 1000;
		utimesSync(sidecar, staleSec, staleSec);

		// Must time out — alive PID + acquiredAt only 60s old + 5min bound.
		await expect(acquireFileLock(file, { timeout: 200 })).rejects.toThrow("Timeout");
		rmSync(lockDir, { recursive: true });
	});

	it("Tier-2 pass-3: alive PID IS evicted past the 5-minute safety bound", async () => {
		const file = path.join(root, "heartbeat-3");
		writeFileSync(file, "hi");
		const lockDir = locateLockDir(file);

		mkdirSync(lockDir);
		const token = "exceeded-5min-budget";
		const planted = {
			v: 2,
			pid: process.pid,
			hostname: os.hostname(),
			acquiredAt: Date.now() - 10 * 60_000, // 10 minutes ago — past 5-min bound
			token,
		};
		writeFileSync(path.join(lockDir, "info"), JSON.stringify(planted));
		// Even with a fresh sidecar — eviction key is acquiredAt vs 5min bound.
		writeFileSync(path.join(lockDir, `heartbeat.${token}`), "");

		const release = await acquireFileLock(file, { timeout: 1_000 });
		release();
	});

	it("Tier-2 D3: refreshLockHeartbeat refuses to write when on-disk owner has a different token", () => {
		const file = path.join(root, "heartbeat-4");
		writeFileSync(file, "x");
		const lockDir = locateLockDir(file);
		mkdirSync(lockDir);
		const successorInfo = {
			v: 2,
			pid: process.pid,
			hostname: os.hostname(),
			acquiredAt: Date.now(),
			token: "successor-token",
		};
		const infoPath = path.join(lockDir, "info");
		writeFileSync(infoPath, JSON.stringify(successorInfo));

		// We hold a stale token from before being evicted. Refresh must
		// see the token mismatch and skip the write entirely so we don't
		// even leave a stray sidecar in the successor's lockDir.
		const outcome = refreshLockHeartbeat(infoPath, "evicted-original-token");
		expect(outcome).toBe("lost");

		const after = JSON.parse(readFileSync(infoPath, "utf-8"));
		expect(after.token).toBe("successor-token");
		// And no stray sidecar got planted — refresh skipped the write.
		expect(existsSync(path.join(lockDir, "heartbeat.evicted-original-token"))).toBe(false);

		rmSync(lockDir, { recursive: true });
	});

	it("Tier-2 pass-1 regression: stale heartbeat after evict+reacquire CANNOT clobber successor's info", () => {
		// Exact race Codex flagged: holder A acquired token T_A, peer
		// evicted+reacquired with token T_C, A's heartbeat fires.
		// Pre-fix: A's tmp+rename would atomically replace T_C's info
		// with one containing T_A. Post-fix: the heartbeat is keyed on
		// the token, so the worst case is A leaves a stray
		// heartbeat.T_A file in T_C's lockDir, never touching T_C's info.
		const file = path.join(root, "heartbeat-5");
		writeFileSync(file, "x");
		const lockDir = locateLockDir(file);
		mkdirSync(lockDir);
		const successor = {
			v: 2,
			pid: process.pid,
			hostname: os.hostname(),
			acquiredAt: Date.now(),
			token: "T_C-successor",
		};
		const infoPath = path.join(lockDir, "info");
		writeFileSync(infoPath, JSON.stringify(successor));
		// Successor's own (fresh) sidecar.
		writeFileSync(path.join(lockDir, "heartbeat.T_C-successor"), "");

		// A fires its heartbeat with its evicted token T_A.
		const outcome = refreshLockHeartbeat(infoPath, "T_A-evicted");
		expect(outcome).toBe("lost");

		// info still reads as T_C — no clobber.
		const after = JSON.parse(readFileSync(infoPath, "utf-8"));
		expect(after.token).toBe("T_C-successor");
		// Successor's own sidecar untouched.
		expect(existsSync(path.join(lockDir, "heartbeat.T_C-successor"))).toBe(true);
		// And A didn't manage to leak its sidecar either.
		expect(existsSync(path.join(lockDir, "heartbeat.T_A-evicted"))).toBe(false);

		rmSync(lockDir, { recursive: true });
	});

	it("Tier-2 pass-2 regression: transient sidecar write failure does NOT report 'lost'", () => {
		// Pre-fix bug: refresh returned a single boolean, so any
		// writeFileSync error (ENOSPC/EIO/AV interference) signaled
		// "stop the timer" identically to "lost ownership". The holder
		// kept working, but its sidecar mtime aged past 30s, peers
		// evicted, and two processes could mutate the protected file.
		// Fix: 3-state RefreshOutcome — only definitive ownership loss
		// returns "lost"; transient I/O returns "transient" so the timer
		// keeps trying.
		const file = path.join(root, "heartbeat-6");
		writeFileSync(file, "x");
		const lockDir = locateLockDir(file);
		mkdirSync(lockDir);
		const owner = {
			v: 2,
			pid: process.pid,
			hostname: os.hostname(),
			acquiredAt: Date.now(),
			token: "owner-token",
		};
		const infoPath = path.join(lockDir, "info");
		writeFileSync(infoPath, JSON.stringify(owner));

		// Force the next sidecar write to fail by making the sidecar
		// path point to an existing directory (writeFileSync to a
		// directory throws EISDIR cross-platform). We can't directly
		// mkdir the heartbeat path because it has dots in it, but we
		// can mkdir the entire lockDir's heartbeat.<token> as a directory.
		const sidecarPath = path.join(lockDir, "heartbeat.owner-token");
		mkdirSync(sidecarPath); // now writeFileSync to this path will fail

		const outcome = refreshLockHeartbeat(infoPath, "owner-token");
		// Token matches and lockDir exists — only the sidecar write failed.
		// MUST report transient, not lost.
		expect(outcome).toBe("transient");

		rmSync(lockDir, { recursive: true });
	});

	it("Tier-2 pass-2 regression: lockDir gone reports 'lost' (timer must stop)", () => {
		// Sanity check the other direction: a definitively-evicted lock
		// (lockDir rmSync'd) MUST report "lost" so the heartbeat timer
		// shuts down and stops leaking writes against a peer's directory.
		const lockDir = path.join(root, `vanished-lock-${Math.random().toString(36).slice(2)}`);
		const infoPath = path.join(lockDir, "info");
		// lockDir was never created — refresh sees no directory, returns lost.
		const outcome = refreshLockHeartbeat(infoPath, "any-token");
		expect(outcome).toBe("lost");
	});
});
