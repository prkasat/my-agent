import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { realpathOrAncestor } from "./path-utils.js";

/**
 * Canonical lock identity for a file path.
 *
 * Two paths that resolve to the same inode (e.g. `/repo/sub/x.ts` and
 * `/repo/good-link/x.ts` where `good-link` is a symlink to `sub`) MUST
 * map to the same lock so they serialize against each other. Lexical
 * paths or `realpathSync.native()` alone are insufficient: the latter
 * fails on a non-existent leaf, which silently falls back to the raw
 * path and breaks alias serialization for newly-created files.
 *
 * `realpathOrAncestor` walks up to an existing ancestor, resolves
 * symlinks there, and re-attaches the unresolved tail — so a write to
 * `/repo/good-link/new-file.txt` and `/repo/sub/new-file.txt` both
 * canonicalize to the same path even before the file exists.
 */
function canonicalLockKey(filePath: string): string {
	try {
		return realpathOrAncestor(filePath);
	} catch {
		return path.resolve(filePath);
	}
}

/**
 * Per-file mutation serialization.
 *
 * When tools execute in parallel, two tools might write the same file.
 * This ensures writes to the same file are serialized while writes
 * to different files proceed in parallel.
 *
 * Implementation: Map from resolved file path to a promise chain.
 * Each new operation chains onto the existing promise for that path.
 */

const queues = new Map<string, Promise<void>>();

// ============================================================================
// Cross-Process File Lock
// ============================================================================

/**
 * Stale lock timeout for unknown owners (5 minutes).
 *
 * Used when we cannot verify the owner is alive — different host, missing
 * info file, or legacy info format. Set high enough to cover legitimate
 * long-running operations (e.g., compaction LLM calls). Heartbeats only
 * help when we can read the holder's info — for cross-host or legacy
 * locks we still rely on this conservative wall-clock bound.
 */
const STALE_LOCK_MS_UNKNOWN = 5 * 60_000;

/**
 * Stale lock timeout for verified-alive owners on this host (30 s).
 *
 * Heartbeat keeps `heartbeatAt` within ~HEARTBEAT_INTERVAL_MS of `now`
 * for any holder that is actually doing work. Six missed heartbeats
 * (≈30s of unresponsiveness) is enough headroom for transient hangs
 * — GC pauses, slow disk, brief network blips — without making peers
 * wait minutes for a frozen holder.
 *
 * Legacy locks without a heartbeatAt field fall through to
 * STALE_LOCK_MS_ALIVE_LEGACY below so older holders (e.g., a peer
 * running pre-heartbeat code) don't get aggressively evicted.
 */
const STALE_LOCK_MS_ALIVE = 30_000;

/**
 * Stale-lock threshold for legacy heartbeat-less locks held by an alive
 * peer. Same as the pre-heartbeat default — gives peers running older
 * code paths the benefit of the doubt for their full original budget.
 */
const STALE_LOCK_MS_ALIVE_LEGACY = 5 * 60_000;

/**
 * Heartbeat refresh cadence (5s).
 *
 * Sized so STALE_LOCK_MS_ALIVE / HEARTBEAT_INTERVAL_MS = 6 missed
 * heartbeats before eviction. Smaller intervals churn the info file
 * needlessly; larger intervals push the eviction threshold up.
 */
const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Maximum time to wait for a lock (5 seconds).
 */
const LOCK_TIMEOUT_MS = 5_000;

/**
 * Retry interval when waiting for lock (50ms).
 */
const LOCK_RETRY_MS = 50;

const LOCK_INFO_VERSION = 2;

// ============================================================================
// Threat-model scope (file-mutation lock)
// ============================================================================
//
// This primitive defends against:
//   * UNRELATED LOCAL USERS on a shared host (different uid) — they
//     cannot read our lock metadata (per-uid LOCK_ROOT mode 0700, info
//     mode 0600), cannot redirect our token-bearing writes (O_NOFOLLOW
//     on POSIX), and cannot pre-stage a hostile LOCK_ROOT we'd
//     silently trust (lstat verification on first use, see
//     verifyLockRoot).
//   * COOPERATIVE-BUT-CRASHING peers (well-behaved until SIGKILL or
//     power loss) — PID liveness + 5-minute eviction keeps the
//     system live without losing data.
//   * SIBLING AGENT PROCESSES racing on the same target file — the
//     mkdir-EEXIST + token-checked release primitive serializes them.
//
// EXPLICITLY OUT OF SCOPE: hostile same-uid peers. A directory-based
// lock cannot defend against an attacker who already runs code as our
// user — they could rewrite `info`, rmdir the lockDir, or otherwise
// subvert any in-process integrity check. Defending against same-uid
// adversaries requires a kernel-enforced primitive (flock/fcntl) and
// would conflict with the cross-platform, cross-process design here.
// This tool is a single-user developer CLI; peer agent processes that
// share the user's uid are TRUSTED-COOPERATIVE by design (they're
// either other instances of this same tool or its own subprocesses).
//
// Do NOT use this primitive for multi-tenant server contexts where
// "same uid but mutually untrusted" is a real threat — switch to
// `proper-lockfile` / `fcntl` there.

/**
 * Verify that an existing LOCK_ROOT is safe to use.
 *
 * Rejects:
 *   - symlinks (could redirect the lock tree to attacker-controlled
 *     storage);
 *   - non-directory entries;
 *   - directories owned by a different uid (the per-uid path was
 *     pre-staged hostilely before our first use).
 *
 * On rejection we throw rather than silently switch to an insecure
 * fallback — operators should investigate, then rerun.
 *
 * Exported for tests; production callers don't need to invoke this
 * directly — `acquireFileLock` runs it both before AND after the
 * `mkdirSync` to close the check-then-create race.
 */
export function verifyLockRoot(rootPath: string): void {
	let st: fs.Stats;
	try {
		st = fs.lstatSync(rootPath);
	} catch {
		// Doesn't exist yet — caller will mkdir with mode 0700.
		return;
	}
	if (st.isSymbolicLink()) {
		throw new Error(
			`Lock root ${rootPath} is a symlink; refusing to follow. Remove or relocate it (or set MY_AGENT_LOCK_NAMESPACE).`,
		);
	}
	if (!st.isDirectory()) {
		throw new Error(
			`Lock root ${rootPath} exists but is not a directory; refusing to use.`,
		);
	}
	// Owner check (POSIX only — Windows doesn't expose Unix uids here)
	if (typeof process.getuid === "function") {
		const ourUid = process.getuid();
		if (st.uid !== ourUid) {
			throw new Error(
				`Lock root ${rootPath} is owned by uid ${st.uid}, not our uid ${ourUid}; refusing to use.`,
			);
		}
	}
}

/**
 * Lock-storage root, scoped per (uid + hostname + optional namespace).
 *
 * `os.tmpdir()` is shared across local users, so we segment by:
 *   - `process.getuid()` so different local users don't collide and we
 *     can lock down the dir to mode 0700 without breaking peers,
 *   - `os.hostname()` so two containers that happen to reuse the same
 *     uid but have distinct container IDs / hostnames don't contend
 *     on the same lock tree,
 *   - `$MY_AGENT_LOCK_NAMESPACE` so operators in unusual deployments
 *     (multi-tenant runtimes, shared-uid + shared-hostname containers,
 *     etc.) can force isolation explicitly.
 *
 * Hostname is sanitized to alphanumerics + dashes to avoid path-
 * separator surprises if some platform reports an exotic value.
 *
 * `recursive: true` on the mkdir is idempotent so concurrent first-uses
 * within the same scope don't race; `tmpdir()` is guaranteed-writable
 * on every platform we target.
 */
const LOCK_ROOT = (() => {
	const uid =
		typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
	const host = os.hostname().replace(/[^a-zA-Z0-9-]/g, "_") || "unknown";
	const ns = process.env.MY_AGENT_LOCK_NAMESPACE
		? `-${process.env.MY_AGENT_LOCK_NAMESPACE.replace(/[^a-zA-Z0-9-]/g, "_")}`
		: "";
	return path.join(os.tmpdir(), `my-agent-locks-${host}-${uid}${ns}`);
})();

/**
 * Compute the on-disk lock directory for a given canonical file path.
 *
 * The hash key is case-folded on case-insensitive platforms (darwin,
 * win32) so that case-only aliases for not-yet-created files (e.g.
 * `Foo.ts` and `foo.ts` requested before either exists) collapse to
 * the same lock. Without that, two concurrent writers could take
 * different locks and race on the same physical file. On Linux (case-
 * sensitive by default) the key is left as-is so legitimately-different
 * files stay independently lockable. The trade-off on case-sensitive
 * APFS volumes (rare) is harmless extra serialization.
 *
 * Exported primarily for tests / introspection — production callers
 * should not need to know where the lock physically lives.
 */
export function lockDirFor(canonicalPath: string): string {
	const key =
		process.platform === "darwin" || process.platform === "win32"
			? canonicalPath.toLowerCase()
			: canonicalPath;
	const hash = crypto.createHash("sha256").update(key).digest("hex");
	return path.join(LOCK_ROOT, `${hash}.lock`);
}

interface LockInfo {
	v: number;
	pid: number;
	hostname: string;
	acquiredAt: number;
	/**
	 * Per-acquisition nonce. Used by `release()` to confirm the lock on
	 * disk is still ours before deleting it. Without this, a long-running
	 * holder evicted by `tryEvictStale` would still tear down the
	 * successor's lock when its release closure eventually fires.
	 *
	 * Empty string for legacy v1 locks (before the token was added).
	 */
	token: string;
	/**
	 * @deprecated Tier-2 pass-1 review found that rewriting `info` to
	 * refresh this field allowed an evicted holder to clobber a
	 * successor's `info` after the lockDir was rmSync'd and recreated.
	 * Heartbeats now live in a token-scoped sidecar (`heartbeat.<token>`)
	 * inside lockDir so the rewrite path can never collide with a new
	 * generation. This field is kept on the type only so a transitional
	 * peer running pre-fix code can still parse — eviction logic ignores
	 * it in favor of the sidecar's mtime.
	 */
	heartbeatAt?: number;
}

/**
 * Path of the token-scoped heartbeat sidecar.
 *
 * Why per-token: if we ever rewrote a shared file (`info`) for
 * heartbeats, an evicted-but-still-running holder could clobber the
 * successor's metadata after the lockDir was rmSync'd and recreated by
 * a peer (Codex Tier-2-pass-1 finding). Using `heartbeat.<token>`
 * means an evicted holder's writeFileSync at most creates a stray file
 * that the new owner ignores (different token), and never overwrites
 * the new holder's own heartbeat sidecar.
 */
function heartbeatSidecarPath(lockDir: string, token: string): string {
	return path.join(lockDir, `heartbeat.${token}`);
}

function writeLockInfo(infoPath: string, token: string): void {
	const now = Date.now();
	const info: LockInfo = {
		v: LOCK_INFO_VERSION,
		pid: process.pid,
		hostname: os.hostname(),
		acquiredAt: now,
		token,
	};
	// Open with O_CREAT|O_EXCL|O_WRONLY (+ O_NOFOLLOW on POSIX) so:
	//  - O_EXCL: fails if `info` already exists (a peer pre-created
	//    it inside our lockDir between our mkdirSync and this write —
	//    refuse to trust their content).
	//  - O_NOFOLLOW (POSIX): fails if `info` is a symlink (a peer
	//    planted a symlink to redirect our write to an arbitrary
	//    path they control — symlink-poisoning attack).
	//  - mode 0600: owner-only readable; only WE wrote it, only WE
	//    should read it (the per-acquisition token is sensitive).
	//
	// On Windows, O_NOFOLLOW is not part of the supported open flags
	// and is ignored by libuv. NTFS reparse-point semantics differ
	// enough that a faithful equivalent would require a different API
	// (CreateFile with FILE_FLAG_OPEN_REPARSE_POINT). For our threat
	// model — single-user developer CLI, same-uid peers trusted-
	// cooperative — the O_EXCL guard already covers the realistic
	// race; the symlink-poisoning add-on is a POSIX-only hardening.
	//
	// If either guard fires, the surrounding catch in `acquireFileLock`
	// rmSync's the lockDir we just created and rethrows — so a poisoned
	// `info` doesn't strand the lock either.
	const flags =
		fs.constants.O_CREAT |
		fs.constants.O_EXCL |
		fs.constants.O_WRONLY |
		(process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number"
			? fs.constants.O_NOFOLLOW
			: 0);
	const fd = fs.openSync(infoPath, flags, 0o600);
	try {
		fs.writeSync(fd, JSON.stringify(info));
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Parse the lock info file. Returns null if unreadable or unparseable.
 * Accepts both the new JSON format and the legacy "pid\ntimestamp" format
 * for back-compat with locks acquired by older versions still running.
 */
function readLockInfo(infoPath: string): LockInfo | null {
	let raw: string;
	try {
		raw = fs.readFileSync(infoPath, "utf-8");
	} catch {
		return null;
	}
	// Try new JSON format first
	try {
		const parsed = JSON.parse(raw) as Partial<LockInfo>;
		if (
			typeof parsed.pid === "number" &&
			typeof parsed.hostname === "string" &&
			typeof parsed.acquiredAt === "number"
		) {
			return {
				v: typeof parsed.v === "number" ? parsed.v : 0,
				pid: parsed.pid,
				hostname: parsed.hostname,
				acquiredAt: parsed.acquiredAt,
				token: typeof parsed.token === "string" ? parsed.token : "",
				heartbeatAt:
					typeof parsed.heartbeatAt === "number" ? parsed.heartbeatAt : undefined,
			};
		}
	} catch {
		// Not JSON — fall through to legacy parser
	}
	// Legacy "pid\ntimestamp" format from earlier versions
	const [pidStr, tsStr] = raw.split("\n");
	const pid = Number.parseInt(pidStr, 10);
	const acquiredAt = Number.parseInt(tsStr, 10);
	if (!Number.isNaN(pid) && !Number.isNaN(acquiredAt)) {
		return { v: 0, pid, hostname: "", acquiredAt, token: "" };
	}
	return null;
}

/**
 * Test whether a PID corresponds to a running process.
 *
 * Uses signal 0 — sends no signal, just performs the permission check.
 * - Returns true if the process exists (or exists but isn't signalable).
 * - Returns false if ESRCH (no such process).
 *
 * Only meaningful for PIDs on the local host.
 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// EPERM means the process exists but we lack permission to signal it
		return code === "EPERM";
	}
}

/**
 * Read the heartbeat sidecar's mtime for this lock generation, if any.
 *
 * Returns null if the sidecar is missing or unstatable (legacy lock
 * without a heartbeat, or a generation we evicted before the holder
 * managed a single refresh). Caller falls back to acquiredAt + the
 * legacy threshold in that case.
 *
 * The sidecar is keyed by the holder's token so a stale write from an
 * evicted predecessor cannot overwrite the current generation's
 * freshness signal.
 */
function readHeartbeatSidecarMtime(lockDir: string, token: string): number | null {
	if (!token) return null;
	try {
		return fs.statSync(heartbeatSidecarPath(lockDir, token)).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * Decide whether a lock can be safely evicted.
 *
 * Rules:
 * - If the owner is on a different host (or hostname unknown), we cannot
 *   verify liveness — fall back to a long age-based threshold.
 * - If the owner PID is dead on this host, evict immediately. The
 *   previous holder crashed without releasing.
 * - If the owner PID is alive on this host:
 *     * heartbeat sidecar present — use its mtime as the freshness
 *       signal, evict after STALE_LOCK_MS_ALIVE (~6 missed heartbeats).
 *     * no sidecar (legacy lock or just-acquired before first refresh) —
 *       use the older 5-minute threshold against acquiredAt so we don't
 *       aggressively evict peers running pre-heartbeat code or holders
 *       in their first 5 seconds of execution.
 */
function shouldEvictLock(info: LockInfo, now: number, lockDir: string): boolean {
	const sameHost = info.hostname && info.hostname === os.hostname();

	if (!sameHost) {
		return now - info.acquiredAt > STALE_LOCK_MS_UNKNOWN;
	}

	if (!isProcessAlive(info.pid)) {
		// Holder crashed — safe to evict at any age
		return true;
	}

	const sidecarMtime = readHeartbeatSidecarMtime(lockDir, info.token);
	if (sidecarMtime !== null) {
		return now - sidecarMtime > STALE_LOCK_MS_ALIVE;
	}
	// No sidecar yet (legacy or pre-first-heartbeat) — use the
	// conservative legacy threshold so we don't evict a freshly-acquired
	// lock before its first heartbeat tick fires.
	return now - info.acquiredAt > STALE_LOCK_MS_ALIVE_LEGACY;
}

/**
 * Refresh the heartbeat sidecar for an owned lock.
 *
 * Touches `lockDir/heartbeat.<token>` so peers reading the sidecar's
 * mtime see fresh proof of life. The sidecar's path is token-scoped so
 * a write firing AFTER eviction can never clobber a successor's
 * metadata — at worst it deposits a stray file in the successor's
 * lockDir that the new owner ignores (token mismatch) and which gets
 * cleaned up when the successor releases (rmSync recursive).
 *
 * Returns true if the sidecar was touched, false if we discovered we
 * no longer own the lock (info missing or token mismatch — caller
 * should stop the heartbeat timer to avoid leaking stray sidecars in
 * peers' lockDirs).
 *
 * Exported for tests; production callers don't invoke this directly.
 */
export function refreshLockHeartbeat(infoPath: string, ourToken: string): boolean {
	let current: LockInfo | null;
	try {
		current = readLockInfo(infoPath);
	} catch {
		return false;
	}
	// Two failure modes both mean "stop heartbeating":
	//  - info missing → lockDir was evicted (rmSync recursive removed it)
	//  - token mismatch → lockDir was evicted AND a successor took over
	if (!current || current.token !== ourToken) return false;

	const lockDir = path.dirname(infoPath);
	const sidecar = heartbeatSidecarPath(lockDir, ourToken);
	try {
		// Empty content + truncate; the value carrier is the file's mtime.
		// writeFileSync sets mtime to "now" as a side effect on every
		// platform we target, so we don't need a follow-up utimesSync.
		fs.writeFileSync(sidecar, "", { mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Try to evict a lock by reading its info and applying eviction rules.
 * Returns true if the lock was removed (or had already disappeared),
 * false if we should keep waiting.
 */
function tryEvictStale(lockDir: string, infoPath: string, fallbackStaleMs: number): boolean {
	const info = readLockInfo(infoPath);
	const now = Date.now();

	if (info) {
		if (!shouldEvictLock(info, now, lockDir)) return false;
		try {
			fs.rmSync(lockDir, { recursive: true });
			return true;
		} catch {
			// Lock vanished concurrently — that's fine, retry will succeed
			return true;
		}
	}

	// No readable info — fall back to mtime-based age check using the
	// caller's threshold. Use the max of caller threshold and unknown-owner
	// threshold so we don't accidentally evict legitimate long-running locks
	// from older code paths.
	try {
		const stat = fs.statSync(lockDir);
		const age = now - stat.mtimeMs;
		const threshold = Math.max(fallbackStaleMs, STALE_LOCK_MS_UNKNOWN);
		if (age > threshold) {
			fs.rmSync(lockDir, { recursive: true });
			return true;
		}
		return false;
	} catch {
		// Lock vanished concurrently
		return true;
	}
}

/**
 * Acquire a cross-process file lock using atomic mkdir.
 * Returns a release function.
 *
 * Stale-lock handling uses PID liveness on the local host plus a safety
 * upper bound on wall-clock age. Locks held by dead processes are evicted
 * immediately; locks held by live processes are evicted only after
 * STALE_LOCK_MS_ALIVE (assumes the process is stuck). Locks from other
 * hosts (NFS / shared filesystems) cannot be liveness-checked and use
 * STALE_LOCK_MS_UNKNOWN as a conservative threshold.
 *
 * `options.staleMs` is preserved for callers that want a tighter mtime
 * fallback when the info file is missing/corrupt; it cannot relax the
 * built-in conservative thresholds.
 */
export async function acquireFileLock(
	filePath: string,
	options?: { timeout?: number; staleMs?: number; signal?: AbortSignal },
): Promise<() => void> {
	const timeout = options?.timeout ?? LOCK_TIMEOUT_MS;
	const fallbackStaleMs = options?.staleMs ?? STALE_LOCK_MS_UNKNOWN;
	const signal = options?.signal;
	// Canonicalize HERE so every caller (file mutation tools, session
	// manager, future helpers) gets symlink-alias safety automatically.
	// Two paths that resolve to the same inode through different aliases
	// MUST acquire the same lockDir or they will not serialize.
	const canonical = canonicalLockKey(filePath);
	const lockDir = lockDirFor(canonical);
	const infoPath = path.join(lockDir, "info");
	const startTime = Date.now();

	if (signal?.aborted) throw new Error("Aborted");

	// Verify the LOCK_ROOT BEFORE creating it so a hostile pre-staged
	// path (symlink, foreign-owned dir, regular file) is rejected
	// loudly instead of silently trusted. After this returns, either
	// the path doesn't exist (we'll mkdir it ourselves with 0700) or
	// it's a directory we own.
	verifyLockRoot(LOCK_ROOT);

	// Lazily ensure the centralized lock root exists. `recursive: true`
	// makes this idempotent and safe under concurrent first-use.
	// Mode 0700: directory readable/writable by owner only, so other
	// local users cannot list our active locks.
	fs.mkdirSync(LOCK_ROOT, { recursive: true, mode: 0o700 });

	// Re-verify AFTER mkdir to close the check-then-create race: a
	// different local user could have raced in between the pre-check
	// and our mkdir to create LOCK_ROOT (recursive mkdir treats an
	// existing path as success). Without this re-check, we'd then run
	// the rest of the lock protocol inside attacker-owned storage.
	verifyLockRoot(LOCK_ROOT);

	while (true) {
		try {
			// Atomic mkdir - fails if directory already exists.
			// Mode 0700 for symmetry with LOCK_ROOT (defence in depth);
			// the parent already restricts visibility so this is mostly
			// a belt-and-braces measure.
			fs.mkdirSync(lockDir, { mode: 0o700 });
		} catch (err) {
			// Check if it's because the directory already exists
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
				throw err;
			}

			// Lock exists — decide whether to evict it
			const evicted = tryEvictStale(lockDir, infoPath, fallbackStaleMs);
			if (evicted) {
				continue; // try acquiring again
			}

			// Check timeout
			if (Date.now() - startTime > timeout) {
				throw new Error(`Timeout waiting for file lock: ${filePath}`);
			}

			// Wait and retry — abortable so cancellation isn't deferred
			// to the lock timeout (up to 5s) when something else holds
			// the lock.
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				}, LOCK_RETRY_MS);
				const onAbort = () => {
					clearTimeout(timer);
					reject(new Error("Aborted"));
				};
				if (signal) signal.addEventListener("abort", onAbort, { once: true });
			});
			continue;
		}

		// We own lockDir. Everything below MUST clean up the directory if
		// it throws — otherwise a transient ENOSPC/EIO during info-file
		// setup would strand the lock until the 5-minute stale threshold.
		try {
			// Generate a per-acquisition nonce so the release closure can
			// confirm WE still own the lock before tearing it down. This
			// closes the race where a long-running holder gets evicted by
			// `tryEvictStale`, a successor takes over, and then the original
			// release fires and deletes the successor's lockDir.
			const ourToken = crypto.randomUUID();
			writeLockInfo(infoPath, ourToken);

			// Post-acquire abort check: a signal may have fired between the
			// last retry-loop check and `mkdirSync` returning. If we don't
			// catch that here, downstream callers run a critical section
			// they explicitly asked to cancel.
			if (signal?.aborted) {
				throw new Error("Aborted");
			}

			// Start heartbeat. Lets us hold the lock for arbitrarily long
			// operations (compaction LLM call, large bash) while peers
			// still see proof-of-life every ~5s, so the eviction threshold
			// can drop to 30s without false positives. unref() so the timer
			// alone never keeps a process alive past its natural exit.
			const heartbeatTimer: NodeJS.Timeout = setInterval(() => {
				const ok = refreshLockHeartbeat(infoPath, ourToken);
				if (!ok) {
					// We no longer own the lock (evicted, info corrupted,
					// or fs error). Stop heartbeating so we don't keep
					// firing forever.
					clearInterval(heartbeatTimer);
				}
			}, HEARTBEAT_INTERVAL_MS);
			heartbeatTimer.unref?.();

			return () => {
				clearInterval(heartbeatTimer);
				try {
					// Read current on-disk owner. If the token differs (or
					// info is unreadable but the directory still exists), our
					// lock has been replaced — leave the successor's lock
					// alone. Only tear down when we can prove ownership.
					const current = readLockInfo(infoPath);
					if (current && current.token === ourToken) {
						fs.rmSync(lockDir, { recursive: true });
					}
					// If `current` is null, the lockDir's info file is gone.
					// That happens when an evictor removed the whole dir
					// already — nothing for us to clean up. Don't blindly
					// delete here, because a successor may have re-acquired
					// the dir without rewriting info atomically.
				} catch {
					// Lock already released or cleanup failed - ignore
				}
			};
		} catch (setupErr) {
			// Setup-after-mkdir failed (info write, abort during setup,
			// etc.). The lockDir is ours — tear it down so we don't
			// strand a lock that future acquirers will treat as stale
			// and have to wait out the 5-minute eviction threshold.
			try {
				fs.rmSync(lockDir, { recursive: true });
			} catch {
				/* best-effort cleanup */
			}
			throw setupErr;
		}
	}
}

/**
 * Execute a function with cross-process file locking.
 * This prevents multiple processes from corrupting shared files.
 */
export async function withCrossProcessLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options?: { timeout?: number; staleMs?: number; signal?: AbortSignal },
): Promise<T> {
	const release = await acquireFileLock(filePath, options);
	// Re-check abort BEFORE invoking fn(): the signal may have fired in
	// the microtask gap between acquireFileLock returning and the await
	// resuming this function. Without this, a cancelled run would still
	// execute one critical section.
	if (options?.signal?.aborted) {
		release();
		throw new Error("Aborted");
	}
	try {
		return await fn();
	} finally {
		release();
	}
}

/**
 * Execute a function with cross-process file locking on the mutation path.
 *
 * Use this for tools that modify a file (write, edit). The cross-process
 * lock prevents lost writes / interleaved edits from sibling agent
 * processes targeting the same file.
 *
 * Why no in-process queue layer: composing the in-process queue with the
 * cross-process lock created a fairness problem. When a local backlog
 * drained, microtask continuations always beat external `setTimeout`
 * polls — so a process with many queued same-file mutations would starve
 * any sibling process out for the entire 5-second lock timeout.
 * Cross-process polling on BOTH sides is symmetric: whichever poll timer
 * fires first wins, regardless of which process is running it.
 *
 * The cost is one filesystem `mkdir`/`rmdir` per mutation even when
 * there's no contention. That's a sub-millisecond op in the common case
 * — negligible compared to the actual write/edit IO.
 *
 * `acquireFileLock` canonicalizes the path internally, so symlink
 * aliases of the same file collapse to one lock automatically.
 */
export async function withFileMutationLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options?: { timeout?: number; staleMs?: number; signal?: AbortSignal },
): Promise<T> {
	return withCrossProcessLock(filePath, fn, options);
}

export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	// Canonicalize through realpathOrAncestor so symlink aliases collapse
	// to the same queue key even when the leaf doesn't exist yet.
	const resolvedPath = canonicalLockKey(filePath);

	// Chain onto existing queue for this path
	const existing = queues.get(resolvedPath) || Promise.resolve();
	let result: T;

	const newPromise = existing.then(async () => {
		result = await fn();
	});

	// Don't propagate errors to future operations
	queues.set(
		resolvedPath,
		newPromise.catch(() => {}),
	);

	// Cleanup when queue is empty
	newPromise.finally(() => {
		if (queues.get(resolvedPath) === newPromise) {
			queues.delete(resolvedPath);
		}
	});

	await newPromise;
	return result!;
}
