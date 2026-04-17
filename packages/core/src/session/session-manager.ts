/**
 * SessionManager - Core session persistence using JSONL event sourcing.
 *
 * Sessions are stored as append-only logs where each entry has an id and parentId
 * forming a tree structure. This enables:
 * - Branching: navigate to any entry and start a new branch
 * - Full history: nothing is ever deleted
 * - Crash safety: incomplete writes just result in skipped lines
 *
 * Inspired by Pi-Mono's session management with improvements:
 * - Unified settings_change entry (vs separate model/thinking entries)
 * - Cleaner API surface
 * - Deferred flush (don't write until first assistant message)
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { withCrossProcessLock } from "../tools/file-mutation-queue.js";

import type { AgentMessage } from "../agent/types.js";
import type {
  BranchSummaryDetails,
  BranchSummaryEntry,
  CompactionDetails,
  CompactionEntry,
  ExtensionEntry,
  FileEntry,
  LabelEntry,
  MessageEntry,
  SessionContext,
  SessionEntry,
  SessionEntryBase,
  SessionHeader,
  SessionInfo,
  SessionInfoEntry,
  SessionTreeNode,
  SettingsChangeEntry,
} from "./types.js";
import { CURRENT_SESSION_VERSION } from "./types.js";
import { collectEntriesForBranchSummary } from "./branch-summary.js";

// ============================================================================
// ID Generation
// ============================================================================

/**
 * Generate a unique 8-character hex ID.
 * Collision-checked against existing IDs.
 */
function generateId(existingIds: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!existingIds.has(id)) return id;
  }
  // Fallback to full UUID if somehow we have collisions
  return randomUUID();
}

/**
 * Generate a UUIDv7-like ID for session IDs (time-ordered).
 * Uses timestamp prefix + random suffix for natural sorting.
 */
function generateSessionId(): string {
  const timestamp = Date.now().toString(16).padStart(12, "0");
  const random = randomUUID().slice(0, 12);
  return `${timestamp}-${random}`;
}

// ============================================================================
// File Parsing
// ============================================================================

/**
 * Parse session entries from JSONL content.
 * Skips malformed lines for crash recovery.
 */
function parseSessionFile(content: string): FileEntry[] {
  const entries: FileEntry[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as FileEntry);
    } catch {
      // Skip malformed lines (crash recovery)
    }
  }

  return entries;
}

/**
 * Result of loading a session file.
 */
type LoadSessionResult =
  | { status: "ok"; entries: FileEntry[] }
  | { status: "not_found" }
  | { status: "corrupted"; error: string };

/**
 * Load and parse a session file.
 * Distinguishes between missing and corrupted files.
 */
function loadSessionFile(filePath: string): LoadSessionResult {
  if (!existsSync(filePath)) {
    return { status: "not_found" };
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const entries = parseSessionFile(content);

    // Validate header
    if (entries.length === 0) {
      return { status: "corrupted", error: "Empty session file" };
    }
    const header = entries[0];
    if (header.type !== "session" || typeof header.id !== "string") {
      return { status: "corrupted", error: "Invalid session header" };
    }

    // Forward-compat guard: refuse files written by a newer schema.
    // Without this, an older binary would happily load a v2 file
    // and silently mishandle entry types it doesn't understand
    // (e.g. v1 forkSession would copy a label.targetId verbatim
    // and durably corrupt the child file). Better to fail loudly
    // and let the user upgrade. Codex labels pass-5 finding.
    const headerVersion = (header as SessionHeader).version ?? 1;
    if (headerVersion > CURRENT_SESSION_VERSION) {
      return {
        status: "corrupted",
        error: `Session file schema version ${headerVersion} is newer than supported (${CURRENT_SESSION_VERSION}); upgrade required`,
      };
    }

    return { status: "ok", entries };
  } catch (err) {
    return { status: "corrupted", error: String(err) };
  }
}

/**
 * Quick validation that a file is a valid session file.
 * Only reads the first line (header).
 */
function isValidSessionFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf-8");
    const firstLine = content.split("\n")[0]?.trim();
    if (!firstLine) return false;
    const header = JSON.parse(firstLine);
    return header.type === "session" && typeof header.id === "string";
  } catch {
    return false;
  }
}

// ============================================================================
// Migration
// ============================================================================

/**
 * Run migrations to bring entries to current version.
 * Returns true if any migration was applied.
 *
 * IMPORTANT: This does NOT promote the header version when there is
 * no actual data transform to perform. v1->v2 added LabelEntry but
 * leaves all v1 entries unchanged on disk; bumping the header on
 * read would lock out a v1 binary from a session that never used a
 * v2-only feature. The header gets promoted lazily by `appendEntry`
 * the first time a v2-only entry type is actually written.
 * Codex labels pass-6 finding.
 */
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
  const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
  const version = header?.version ?? 1;

  if (version >= CURRENT_SESSION_VERSION) return false;

  // Future data-transform migrations go here. Example shape:
  //   if (version < 3) migrateV2ToV3(entries);
  // Only bump the header inside a branch that actually rewrites
  // entries. v1 -> v2 has no transform, so we leave the header alone
  // and let lazy promotion handle it.

  // Returning false signals no rewrite needed.
  return false;
}

/**
 * True for entry types introduced in schema v2 (LabelEntry).
 * Used to lazily promote the header when a v2-only entry is first
 * persisted into a v1 file, so unlabeled v1 sessions remain readable
 * by v1 binaries.
 */
function isV2OnlyEntry(entry: FileEntry): boolean {
  return entry.type === "label";
}

// ============================================================================
// Context Building
// ============================================================================

/**
 * Build session context by walking from leaf to root.
 * Handles compaction summaries along the path.
 */
export function buildSessionContext(
  entries: SessionEntry[],
  leafId: string | null,
  byId?: Map<string, SessionEntry>
): SessionContext {
  // Build index if not provided
  if (!byId) {
    byId = new Map();
    for (const entry of entries) {
      byId.set(entry.id, entry);
    }
  }

  // Handle null leaf (before first entry)
  if (leafId === null) {
    return { messages: [], thinkingLevel: "off", model: null };
  }

  // Find leaf
  const leaf = byId.get(leafId);
  if (!leaf) {
    return { messages: [], thinkingLevel: "off", model: null };
  }

  // Walk from leaf to root, collecting path
  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  // Extract settings and find latest compaction
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string; name?: string } | null = null;
  let compaction: CompactionEntry | null = null;
  let compactionIndex = -1;

  for (let i = 0; i < path.length; i++) {
    const entry = path[i];
    if (entry.type === "settings_change") {
      if (entry.model) model = entry.model;
      if (entry.thinkingLevel) thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "compaction") {
      compaction = entry;
      compactionIndex = i;
    }
  }

  // Build messages
  const messages: AgentMessage[] = [];

  if (compaction) {
    // Add compaction summary as custom message (internal, converted by customMessageToLlm)
    messages.push({
      role: "custom",
      type: "compaction_summary",
      summary: compaction.summary,
      tokensBefore: compaction.tokensBefore,
      tokensAfter: compaction.details.tokensAfter,
      timestamp: new Date(compaction.timestamp).getTime(),
    });

    // Find start index (firstKeptEntryId or after compaction)
    let startIndex = compactionIndex + 1;
    const keptIndex = path.findIndex((e) => e.id === compaction!.firstKeptEntryId);
    if (keptIndex >= 0 && keptIndex < compactionIndex) {
      startIndex = keptIndex;
    }

    // Add messages from kept entries (excluding compaction itself)
    for (let i = startIndex; i < path.length; i++) {
      const entry = path[i];
      if (entry.type === "message") {
        messages.push(entry.message);
      } else if (entry.type === "branch_summary") {
        // Use custom message type for branch summaries
        messages.push({
          role: "custom",
          type: "branch_summary",
          summary: entry.summary,
          sourceSessionId: entry.fromId,
          timestamp: new Date(entry.timestamp).getTime(),
        });
      }
    }
  } else {
    // No compaction - add all messages
    for (const entry of path) {
      if (entry.type === "message") {
        messages.push(entry.message);
      } else if (entry.type === "branch_summary") {
        // Use custom message type for branch summaries
        messages.push({
          role: "custom",
          type: "branch_summary",
          summary: entry.summary,
          sourceSessionId: entry.fromId,
          timestamp: new Date(entry.timestamp).getTime(),
        });
      }
    }
  }

  return { messages, thinkingLevel, model };
}

// ============================================================================
// Session Info Building
// ============================================================================

/**
 * Extract session info from a file (for listing).
 */
async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const entries = parseSessionFile(content);

    if (entries.length === 0) return null;
    const header = entries[0];
    if (header.type !== "session") return null;

    const stats = await stat(filePath);
    let messageCount = 0;
    let firstMessage = "";
    let name: string | undefined;
    let lastTimestamp = new Date(header.timestamp).getTime();

    for (const entry of entries) {
      if (entry.type === "session") continue;

      // Track latest timestamp
      const entryTime = new Date((entry as SessionEntryBase).timestamp).getTime();
      if (!isNaN(entryTime) && entryTime > lastTimestamp) {
        lastTimestamp = entryTime;
      }

      // Extract session name (use latest)
      if (entry.type === "session_info") {
        name = (entry as SessionInfoEntry).name?.trim() || undefined;
      }

      // Count messages and get first user message
      if (entry.type === "message") {
        messageCount++;
        const msg = (entry as MessageEntry).message;
        if (!firstMessage && "role" in msg && msg.role === "user") {
          const content = typeof msg.content === "string"
            ? msg.content
            : msg.content
                .filter((c): c is { type: "text"; text: string } => c.type === "text")
                .map((c) => c.text)
                .join(" ");
          firstMessage = content.slice(0, 200);
        }
      }
    }

    return {
      path: filePath,
      id: header.id,
      cwd: header.cwd || "",
      name,
      parentSessionPath: header.parentSession,
      created: new Date(header.timestamp),
      modified: new Date(lastTimestamp),
      messageCount,
      firstMessage: firstMessage || "(no messages)",
    };
  } catch {
    return null;
  }
}

// ============================================================================
// SessionManager Class
// ============================================================================

/**
 * Manages session persistence using JSONL event sourcing.
 */
export class SessionManager {
  private sessionId: string = "";
  private sessionFile: string | undefined;
  private sessionDir: string;
  private cwd: string;
  private persist: boolean;
  private flushed: boolean = false;
  /**
   * Re-entrant depth counter for withLock.
   *
   * navigateBranch's rollback truncate is only safe under exclusive
   * access — without the lock, a peer process appending to the file
   * between our snapshot and our truncate would have its bytes erased.
   * We treat depth > 0 as "lock is held" and re-entry as cheap (skip
   * the cross-process lock acquisition because this process already
   * owns it). Without re-entry, an inner withLock from a callback
   * would wait on the file lock this process already holds and time
   * out, AND a non-counted boolean would let an inner finally clear
   * the flag mid-outer-critical-section.
   */
  private lockDepth: number = 0;
  private get lockHeld(): boolean {
    return this.lockDepth > 0;
  }
  private fileEntries: FileEntry[] = [];
  /**
   * Mtime (in ms) the session file had the last time we successfully
   * read its full state. Used by appendLabelChange to detect external
   * mutation between this manager's last load and a label write that
   * would derive `displaces` from possibly-stale ownership state.
   * `null` means we have not loaded a real on-disk snapshot yet
   * (in-memory session, or before first flush).
   */
  private lastLoadedMtimeMs: number | null = null;
  private byId: Map<string, SessionEntry> = new Map();
  /**
   * Latest label per target entry, derived from LabelEntry history.
   * A LabelEntry with `label: undefined` (or empty after trim) deletes
   * the entry. Rebuilt from scratch on every buildIndex() so the
   * append-only history is the single source of truth.
   */
  private labelsByTargetId: Map<string, string> = new Map();
  /**
   * Reverse index: label string → target entry ID. Labels are
   * single-owner; assigning a label that already exists on another
   * target moves it (the old target loses its label). This makes
   * findEntryByLabel an O(1) lookup with last-write-wins semantics
   * that match the user expectation of `/goto important`.
   */
  private labelsByName: Map<string, string> = new Map();
  private leafId: string | null = null;
  // True when the caller explicitly chose the current leaf via branch(),
  // navigateBranch(), or resetLeaf(). withLock's reload uses this to know
  // whether to preserve the user's selection across the reload (true) or
  // accept the new on-disk leaf as the current cursor (false). Reset to
  // false whenever buildIndex/appendEntry naturally advances the leaf.
  private leafSelectedByUser: boolean = false;

  private constructor(
    cwd: string,
    sessionDir: string,
    sessionFile: string | undefined,
    persist: boolean
  ) {
    this.cwd = cwd;
    this.sessionDir = sessionDir;
    this.persist = persist;

    if (persist && sessionDir && !existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    if (sessionFile) {
      this.initFromFile(sessionFile);
    } else {
      this.newSession();
    }
  }

  // ==========================================================================
  // Static Factory Methods
  // ==========================================================================

  /**
   * Create a new session.
   */
  static create(cwd: string, sessionDir?: string): SessionManager {
    const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd);
    return new SessionManager(cwd, dir, undefined, true);
  }

  /**
   * Open an existing session file.
   * @throws Error if file is corrupted
   */
  static open(filePath: string, sessionDir?: string, cwdOverride?: string): SessionManager {
    const result = loadSessionFile(filePath);
    if (result.status === "corrupted") {
      throw new Error(`Session file corrupted: ${filePath} - ${result.error}`);
    }
    const header = result.status === "ok"
      ? result.entries.find((e) => e.type === "session") as SessionHeader | undefined
      : undefined;
    const cwd = cwdOverride ?? header?.cwd ?? process.cwd();
    const dir = sessionDir ?? resolve(filePath, "..");
    return new SessionManager(cwd, dir, filePath, true);
  }

  /**
   * Continue the most recent session, or create new if none exists.
   */
  static continueRecent(cwd: string, sessionDir?: string): SessionManager {
    const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd);
    const mostRecent = SessionManager.findMostRecentSession(dir);
    if (mostRecent) {
      return new SessionManager(cwd, dir, mostRecent, true);
    }
    return new SessionManager(cwd, dir, undefined, true);
  }

  /**
   * Create an in-memory session (no file persistence).
   */
  static inMemory(cwd: string = process.cwd()): SessionManager {
    return new SessionManager(cwd, "", undefined, false);
  }

  /**
   * Get the default session directory for a cwd.
   * Uses base64url encoding of the path to avoid collisions from simple character replacement.
   */
  static getDefaultSessionDir(cwd: string, baseDir?: string): string {
    const base = baseDir ?? join(process.env.HOME ?? "~", ".my-agent");
    // Use base64url encoding to create a unique, collision-free directory name
    // This avoids issues where paths like /repo/a-b/c and /repo/a/b-c collide
    const encoded = Buffer.from(cwd).toString("base64url");
    return join(base, "sessions", encoded);
  }

  /**
   * Find the most recent session file in a directory.
   */
  static findMostRecentSession(sessionDir: string): string | null {
    try {
      const files = readdirSync(sessionDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(sessionDir, f))
        .filter(isValidSessionFile)
        .map((path) => ({ path, mtime: statSync(path).mtime }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      return files[0]?.path ?? null;
    } catch {
      return null;
    }
  }

  /**
   * List all sessions for a directory.
   */
  static async listSessions(cwd: string, sessionDir?: string): Promise<SessionInfo[]> {
    const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd);
    if (!existsSync(dir)) return [];

    try {
      const files = (await readdir(dir))
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(dir, f));

      const sessions: SessionInfo[] = [];
      for (const file of files) {
        const info = await buildSessionInfo(file);
        if (info) sessions.push(info);
      }

      return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    } catch {
      return [];
    }
  }

  /**
   * List all sessions across all project directories.
   */
  static async listAllSessions(baseDir?: string): Promise<SessionInfo[]> {
    const base = baseDir ?? join(process.env.HOME ?? "~", ".my-agent", "sessions");
    if (!existsSync(base)) return [];

    try {
      const dirs = (await readdir(base, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => join(base, d.name));

      const sessions: SessionInfo[] = [];
      for (const dir of dirs) {
        const files = (await readdir(dir))
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => join(dir, f));

        for (const file of files) {
          const info = await buildSessionInfo(file);
          if (info) sessions.push(info);
        }
      }

      return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    } catch {
      return [];
    }
  }

  // ==========================================================================
  // Session Management
  // ==========================================================================

  /**
   * Start a new session.
   */
  newSession(parentSession?: string, forkPoint?: string): string | undefined {
    this.sessionId = generateSessionId();
    const timestamp = new Date().toISOString();

    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      cwd: this.cwd,
      timestamp,
      parentSession,
      forkPoint,
    };

    this.fileEntries = [header];
    this.byId.clear();
    this.leafId = null;
    this.flushed = false;

    if (this.persist) {
      const fileTimestamp = timestamp.replace(/[:.]/g, "-");
      this.sessionFile = join(this.sessionDir, `${fileTimestamp}_${this.sessionId}.jsonl`);
    }

    return this.sessionFile;
  }

  /**
   * Load an existing session file.
   * @throws Error if file is corrupted
   */
  private initFromFile(filePath: string): void {
    this.sessionFile = resolve(filePath);
    const result = loadSessionFile(this.sessionFile);

    switch (result.status) {
      case "not_found":
        // File doesn't exist - create new session at this path
        this.newSession();
        this.sessionFile = filePath;
        break;

      case "corrupted":
        // File exists but is corrupted - throw error instead of silently replacing
        throw new Error(`Session file corrupted: ${filePath} - ${result.error}`);

      case "ok":
        this.fileEntries = result.entries;
        const header = this.fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
        this.sessionId = header?.id ?? generateSessionId();

        // Run migrations
        if (migrateToCurrentVersion(this.fileEntries)) {
          this.rewriteFile();
        }

        this.buildIndex();
        this.flushed = true;
        this.recordFreshMtime();
        break;
    }
  }

  /**
   * Build the in-memory index from file entries.
   */
  private buildIndex(): void {
    this.byId.clear();
    this.labelsByTargetId.clear();
    this.labelsByName.clear();
    this.leafId = null;
    this.leafSelectedByUser = false;

    for (const entry of this.fileEntries) {
      if (entry.type === "session") continue;
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
      if (entry.type === "label") {
        // Process implicit displacements first so the new assignment
        // wins when the same target is in both lists (defensive
        // against bad data; producers don't generate that combination).
        if (entry.displaces) {
          for (const displacedId of entry.displaces) {
            this.applyLabelChange(displacedId, undefined);
          }
        }
        this.applyLabelChange(entry.targetId, entry.label);
      }
    }
  }

  /**
   * Apply a label change to both indexes with single-owner semantics:
   * if the new label is already attached to a different target, that
   * target loses its label (the new write wins). Used by both
   * buildIndex replay and appendLabelChange.
   */
  private applyLabelChange(targetId: string, rawLabel: string | undefined): void {
    const trimmed = rawLabel?.trim();
    // Always clear whatever this target previously had — both for the
    // clear case (no new label) and to keep labelsByName consistent
    // when the label string changes.
    const prev = this.labelsByTargetId.get(targetId);
    if (prev !== undefined && this.labelsByName.get(prev) === targetId) {
      this.labelsByName.delete(prev);
    }
    this.labelsByTargetId.delete(targetId);

    if (!trimmed) return;

    // Single-owner: if some other target already owns this label,
    // displace it. The displaced entry simply loses its label; we
    // don't write a separate clearing LabelEntry to disk because
    // replay arrives at the same state by following the same rule.
    const existingOwner = this.labelsByName.get(trimmed);
    if (existingOwner !== undefined && existingOwner !== targetId) {
      this.labelsByTargetId.delete(existingOwner);
    }
    this.labelsByTargetId.set(targetId, trimmed);
    this.labelsByName.set(trimmed, targetId);
  }

  /**
   * Rewrite the entire session file atomically AND durably.
   *
   * The pattern: write content to a sibling temp file, fsync the
   * temp file's bytes to disk, rename atomically into place, then
   * fsync the parent directory so the new directory entry survives
   * a crash. Without fsync, the OS may buffer writes for several
   * seconds; a power loss in that window can lose the new bytes
   * even though writeFileSync has returned. The rename gives
   * atomicity (the live file is never partially overwritten); the
   * fsyncs give durability (the change is flushed to stable
   * storage before we report success).
   *
   * Used by first-flush, navigation rollback, label-promotion
   * rewrite, and any other path that snapshots full state.
   * Codex labels pass-7 + pass-8 findings.
   */
  private rewriteFile(): void {
    if (!this.persist || !this.sessionFile) return;
    const content = this.fileEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const tmpPath = `${this.sessionFile}.tmp.${process.pid}.${Date.now()}`;
    let fd = -1;
    try {
      fd = openSync(tmpPath, "w");
      // writeSync may write fewer bytes than requested under disk
      // pressure or for large payloads. Loop until the full buffer
      // is committed before fsync/rename — otherwise the rename
      // would atomically publish a TRUNCATED snapshot, which is
      // worse than not-renaming-at-all.
      // Codex labels pass-10 finding.
      const buf = Buffer.from(content, "utf8");
      let written = 0;
      while (written < buf.length) {
        const n = writeSync(fd, buf, written, buf.length - written);
        if (n <= 0) {
          throw new Error(`rewriteFile: writeSync stalled at ${written}/${buf.length} bytes`);
        }
        written += n;
      }
      // Flush this file's contents+metadata to stable storage
      // before the rename, so the new bytes are durable even if
      // the system crashes immediately after the rename returns.
      fsyncSync(fd);
      closeSync(fd);
      fd = -1;
      renameSync(tmpPath, this.sessionFile);
      // Fsync the parent directory so the new directory entry
      // (the rename) survives a crash. Without this, the rename
      // can be undone by a crash even though the file's bytes are
      // safely on disk. Some filesystems (e.g. tmpfs) don't
      // support directory fsync; treat EINVAL/ENOTSUP as a no-op.
      try {
        const dirFd = openSync(this.sessionFile.substring(0, this.sessionFile.lastIndexOf("/")) || ".", "r");
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
      } catch (dirErr) {
        const code = (dirErr as NodeJS.ErrnoException).code;
        if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
          throw dirErr;
        }
      }
    } catch (err) {
      // Best-effort cleanup of the temp file on failure.
      if (fd !== -1) {
        try {
          closeSync(fd);
        } catch {}
      }
      try {
        unlinkSync(tmpPath);
      } catch {}
      throw err;
    }
  }

  /**
   * Persist an entry to the session file.
   * Implements deferred flush - doesn't write until first assistant message.
   *
   * NOTE: Uses appendFileSync which is atomic for small writes on most systems.
   * For multi-process scenarios, use withSessionLock() at a higher level.
   */
  /**
   * Snapshot the current on-disk size of the session file.
   *
   * Used by `navigateBranch` to roll the JSONL file back to its
   * pre-navigation state when an in-flight append fails. Returns -1
   * for in-memory sessions and for sessions whose file has not yet
   * been created on disk.
   */
  private sessionFileBytes(): number {
    if (!this.persist || !this.sessionFile || !existsSync(this.sessionFile)) {
      return -1;
    }
    try {
      return statSync(this.sessionFile).size;
    } catch {
      return -1;
    }
  }

  private persistEntry(entry: SessionEntry, force = false): void {
    if (!this.persist || !this.sessionFile) return;

    const hasAssistant = this.fileEntries.some(
      (e) => e.type === "message" && (e as MessageEntry).message.role === "assistant"
    );

    if (!hasAssistant && !force) {
      // Don't write yet - wait for assistant message
      this.flushed = false;
      return;
    }

    if (!this.flushed) {
      // First flush — write all queued entries in ONE atomic
      // writeFileSync rather than looping appendFileSync. The loop
      // could leave a durable prefix on disk if a later write failed
      // (ENOSPC mid-flush), and a retry would then re-append the same
      // prefix, duplicating entries (Codex Tier-2 pass-14). A single
      // overwriting write keeps first-flush idempotent: failure
      // leaves the file in some bad state, but the next retry
      // overwrites it cleanly with the current snapshot.
      this.rewriteFile();
      this.flushed = true;
    } else {
      // Incremental append. When the caller asked for forced
      // persistence (e.g. extension entries, label writes), fsync
      // before returning so the API only acknowledges after the
      // bytes hit stable storage. Without fsync a power loss right
      // after the call could lose a label move and resurrect the
      // previous owner. Codex labels pass-10 finding.
      const line = JSON.stringify(entry) + "\n";
      if (force) {
        const fd = openSync(this.sessionFile, "a");
        try {
          const buf = Buffer.from(line, "utf8");
          let written = 0;
          while (written < buf.length) {
            const n = writeSync(fd, buf, written, buf.length - written);
            if (n <= 0) {
              throw new Error(`persistEntry: writeSync stalled at ${written}/${buf.length} bytes`);
            }
            written += n;
          }
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } else {
        appendFileSync(this.sessionFile, line);
      }
    }
    this.recordFreshMtime();
  }

  /**
   * Snapshot the live file's mtime as of "we are in sync with disk".
   * Called after every load and every successful persist so the
   * external-mutation check in appendLabelChange has a reliable
   * baseline. Safe to call when the file doesn't exist (no-op).
   */
  private recordFreshMtime(): void {
    if (!this.persist || !this.sessionFile) return;
    try {
      this.lastLoadedMtimeMs = statSync(this.sessionFile).mtimeMs;
    } catch {
      this.lastLoadedMtimeMs = null;
    }
  }

  /**
   * Force any deferred entries to disk now.
   *
   * `persistEntry` defers the first write until an assistant message
   * arrives, so a session that only has user-side entries (e.g., a
   * one-shot prompt that exits before any assistant turn) never reaches
   * disk and is lost on process exit. Callers that know they want
   * durability without an assistant turn (CLI bootstrap, tests, host
   * integrations) call this to flush immediately.
   *
   * No-op for in-memory or non-persistent sessions, and no-op when
   * everything is already on disk.
   */
  flush(): void {
    if (!this.persist || !this.sessionFile) return;
    if (this.flushed) return;
    if (this.fileEntries.length === 0) return;
    // Single overwriting write so a failed first-flush leaves the file
    // in a state that the next retry overwrites cleanly. Looping
    // appendFileSync would leave a durable prefix on partial failure,
    // and retry would duplicate it (Codex Tier-2 pass-15: same bug
    // class as the pass-14 fix for persistEntry's forced first-flush).
    this.rewriteFile();
    this.flushed = true;
    this.recordFreshMtime();
  }

  /**
   * Append an entry as child of current leaf.
   *
   * Transactional: any persist failure (ENOSPC/EIO/etc.) rolls the
   * in-memory tree back to its pre-append state and rethrows. Without
   * this, a process whose disk fills mid-write would keep building a
   * tree in memory whose parent IDs never hit disk — and on reopen,
   * `getBranch()` would stop at the missing parent and silently lose
   * everything appended after the failure.
   *
   * On-disk rollback (truncateSync) is only safe when we hold the
   * cross-process lock, otherwise we could erase a peer's bytes. Without
   * the lock we still revert in-memory state so this process stays
   * consistent with whatever partial disk state remains.
   */
  private appendEntry(entry: SessionEntry, force = false): void {
    const fileEntriesLen = this.fileEntries.length;
    const prevLeafId = this.leafId;
    const prevLeafSelected = this.leafSelectedByUser;
    const prevFlushed = this.flushed;
    const sessionFileSnapshot = this.sessionFileBytes();

    // Lazily promote header version when persisting a v2-only entry
    // for the first time. Bumping eagerly on read would lock out v1
    // binaries from sessions that never used a v2 feature; bumping
    // lazily means unlabeled v1 sessions stay readable by v1
    // binaries until a label is actually written.
    // Codex labels pass-6 finding.
    let prevHeaderVersion = 0;
    let promotedHeader: SessionHeader | undefined;
    if (isV2OnlyEntry(entry)) {
      const header = this.fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
      if (header && header.version < CURRENT_SESSION_VERSION) {
        prevHeaderVersion = header.version;
        promotedHeader = header;
        header.version = CURRENT_SESSION_VERSION;
        // The header lives at the top of the file. To get the new
        // version on disk, the next persist must do a full rewrite
        // rather than an incremental append — clearing flushed
        // forces persistEntry to take the rewriteFile path.
        this.flushed = false;
      }
    }

    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    // Natural progression — the new leaf is the just-appended entry, not a
    // user-selected branch tip. Future locked reloads should accept whatever
    // the new on-disk state is rather than try to restore this id.
    this.leafSelectedByUser = false;
    try {
      this.persistEntry(entry, force);
    } catch (err) {
      this.fileEntries.length = fileEntriesLen;
      this.byId.delete(entry.id);
      this.leafId = prevLeafId;
      this.leafSelectedByUser = prevLeafSelected;
      this.flushed = prevFlushed;
      // Roll back the header-version promotion if we performed one
      // and the persist failed. Otherwise the in-memory header would
      // claim v2 but disk would still be v1, and the next successful
      // append would write a v2 header without the entry that
      // motivated the bump.
      if (promotedHeader) {
        promotedHeader.version = prevHeaderVersion;
      }
      if (
        this.lockHeld &&
        sessionFileSnapshot >= 0 &&
        this.persist &&
        this.sessionFile
      ) {
        try {
          truncateSync(this.sessionFile, sessionFileSnapshot);
        } catch (truncErr) {
          (err as Error).message += ` (and disk rollback failed: ${
            (truncErr as Error).message
          })`;
        }
      }
      throw err;
    }
  }

  // ==========================================================================
  // Accessors
  // ==========================================================================

  getCwd(): string {
    return this.cwd;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  isPersisted(): boolean {
    return this.persist;
  }

  /**
   * Convenience: list every session for THIS manager's cwd.
   *
   * Equivalent to `SessionManager.listSessions(this.getCwd(), this.sessionDir)`,
   * exposed as an instance method so callers (notably the CLI's `/sessions`
   * slash command) don't have to know how to derive the per-cwd session
   * directory themselves.
   */
  listSessionsForCwd(): Promise<SessionInfo[]> {
    return SessionManager.listSessions(this.cwd, this.sessionDir);
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.leafId ? this.byId.get(this.leafId) : undefined;
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  getHeader(): SessionHeader | null {
    const header = this.fileEntries.find((e) => e.type === "session");
    return header ? (header as SessionHeader) : null;
  }

  /**
   * Get all session entries (excludes header).
   */
  getEntries(): SessionEntry[] {
    return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
  }

  // ==========================================================================
  // Append Methods
  // ==========================================================================

  /**
   * Append a message entry.
   */
  appendMessage(message: AgentMessage): string {
    const entry: MessageEntry = {
      type: "message",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  /**
   * Append a settings change entry.
   */
  appendSettingsChange(settings: {
    model?: { provider: string; modelId: string; name?: string };
    thinkingLevel?: string;
  }): string {
    const entry: SettingsChangeEntry = {
      type: "settings_change",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      ...settings,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  /**
   * Append a compaction entry.
   */
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details: CompactionDetails
  ): string {
    const entry: CompactionEntry = {
      type: "compaction",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  /**
   * Append a branch summary entry.
   */
  appendBranchSummary(
    fromId: string,
    summary: string,
    details?: BranchSummaryDetails
  ): string {
    const entry: BranchSummaryEntry = {
      type: "branch_summary",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      fromId,
      summary,
      details,
    };
    this.appendEntry(entry);
    return entry.id;
  }

  /**
   * Append a session info entry (e.g., set name).
   */
  appendSessionInfo(name: string | undefined): string {
    const entry: SessionInfoEntry = {
      type: "session_info",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      name: name?.trim(),
    };
    this.appendEntry(entry);
    return entry.id;
  }

  /**
   * Set or clear a label on an existing entry.
   *
   * Labels are user-defined bookmarks that name a specific point in
   * the session graph (a turn, a compaction, a branch summary). They
   * support navigation by name rather than scrolling history. Labels
   * are stored as their own append-only entry type, so the full
   * change history is recoverable on replay; the in-memory index
   * exposes only the latest value per target.
   *
   * Pass `undefined` or an empty string to clear an existing label.
   *
   * Persistence: written through immediately (force=true), matching
   * appendExtension. The user expectation is that "I named that
   * turn" survives a crash or process exit before the next
   * assistant message.
   */
  appendLabelChange(targetId: string, label: string | undefined): string {
    // Refuse to write when the file changed externally since our
    // last sync, OR when the file disappeared. The `displaces` field
    // we encode below derives from in-memory ownership; a stale
    // snapshot would name the wrong (possibly-already-cleared)
    // target and lose the displacement edge forkSession relies on.
    // For full safety against TOCTOU between this preflight and the
    // commit, the caller should wrap label writes in withLock(),
    // which both serializes against peer processes and reloads
    // from disk on entry. The preflight here catches the common
    // single-process and "user forgot the lock" cases.
    // Codex labels pass-7 + pass-8 findings.
    if (this.persist && this.sessionFile && this.lastLoadedMtimeMs !== null) {
      let onDiskMtime: number | undefined;
      try {
        onDiskMtime = statSync(this.sessionFile).mtimeMs;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new Error(
            "Session file disappeared since last load; cannot safely write labels (reload or recreate the session)",
          );
        }
        throw err;
      }
      if (onDiskMtime > this.lastLoadedMtimeMs) {
        throw new Error(
          "Session file changed externally since last load; reload or wrap appendLabelChange in withLock before writing labels",
        );
      }
    }

    const target = this.byId.get(targetId);
    if (!target) {
      throw new Error(`Cannot label entry ${targetId}: entry not found`);
    }
    // Disallow labeling a LabelEntry. Labels-on-labels create a
    // dangling-target hazard: forkSession drops all LabelEntries
    // from the path and re-synthesizes only the current label
    // state, so a label whose target is itself a LabelEntry would
    // be remapped to an ID that the fork never emits, leaving the
    // forked file with a label pointing at nothing. Codex labels
    // pass-4 finding.
    if (target.type === "label") {
      throw new Error(`Cannot label entry ${targetId}: cannot label a label entry`);
    }
    const trimmed = label?.trim();

    // If the new label already belongs to a different target, encode
    // the displacement in the SAME LabelEntry via `displaces`. The
    // alternative — emit a separate clearing entry first — would
    // make the move two appends, and a crash between them would
    // permanently lose the label (clear lands, assign doesn't).
    // Codex labels pass-3 finding.
    let displaces: string[] | undefined;
    if (trimmed) {
      const displacedOwner = this.labelsByName.get(trimmed);
      if (displacedOwner !== undefined && displacedOwner !== targetId) {
        displaces = [displacedOwner];
      }
    }

    const entry: LabelEntry = {
      type: "label",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      targetId,
      ...(trimmed ? { label: trimmed } : {}),
      ...(displaces ? { displaces } : {}),
    };
    this.appendEntry(entry, /* force */ true);
    if (displaces) {
      for (const displacedId of displaces) {
        this.applyLabelChange(displacedId, undefined);
      }
    }
    this.applyLabelChange(targetId, trimmed);
    return entry.id;
  }

  /**
   * Get the current label for an entry, or undefined if unlabeled.
   */
  getLabel(entryId: string): string | undefined {
    return this.labelsByTargetId.get(entryId);
  }

  /**
   * Snapshot of all currently-labeled entries (latest label per
   * target). The returned Map is a copy and safe to mutate.
   */
  getLabels(): Map<string, string> {
    return new Map(this.labelsByTargetId);
  }

  /**
   * Resolve a label string to the entry it currently owns it, or
   * undefined when no entry carries that label. Labels are single-
   * owner (the latest assignment wins), so this is deterministic.
   */
  findEntryByLabel(label: string): string | undefined {
    const target = label.trim();
    if (!target) return undefined;
    return this.labelsByName.get(target);
  }

  /**
   * Append a plugin-defined extension entry.
   *
   * Plugins use this to persist arbitrary state into the session file
   * without colliding with core entry types. The `namespace` MUST be
   * unique to the plugin (reverse-DNS, package name, or short slug).
   * Core never reads the payload — it only round-trips it through
   * reads, writes, and migrations.
   *
   * Persistence: written through immediately, bypassing the deferred-
   * flush window that exists for message entries. Plugins commonly call
   * this during startup, auth bootstrap, or other pre-assistant flows;
   * deferring those writes would silently drop the state if the process
   * exits before the first assistant turn. This is the durability
   * contract for the plugin-persistence surface — it is part of the
   * extension API, not an implementation detail.
   */
  appendExtension(
    namespace: string,
    payload: unknown,
    subtype?: string,
  ): string {
    if (!namespace || typeof namespace !== "string") {
      throw new Error("appendExtension: namespace is required");
    }
    const entry: ExtensionEntry = {
      type: "extension",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      namespace,
      payload,
      ...(subtype !== undefined ? { subtype } : {}),
    };
    this.appendEntry(entry, /* force */ true);
    return entry.id;
  }

  /**
   * Read all extension entries, optionally filtered by namespace.
   *
   * Returns entries in append order so plugins can replay their own
   * payload history (settings, snapshots, etc.) on session reload.
   */
  getExtensionEntries(namespace?: string): ExtensionEntry[] {
    const out: ExtensionEntry[] = [];
    for (const entry of this.fileEntries) {
      if (entry.type !== "extension") continue;
      if (namespace !== undefined && entry.namespace !== namespace) continue;
      out.push(entry);
    }
    return out;
  }

  // ==========================================================================
  // Session Info
  // ==========================================================================

  /**
   * Get the current session name.
   */
  getSessionName(): string | undefined {
    const entries = this.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "session_info") {
        return (entries[i] as SessionInfoEntry).name?.trim() || undefined;
      }
    }
    return undefined;
  }

  // ==========================================================================
  // Tree Operations
  // ==========================================================================

  /**
   * Get entries from root to specified entry (or current leaf).
   */
  getBranch(fromId?: string): SessionEntry[] {
    const path: SessionEntry[] = [];
    const startId = fromId ?? this.leafId;
    let current = startId ? this.byId.get(startId) : undefined;

    while (current) {
      path.unshift(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }

    return path;
  }

  /**
   * Get all children of an entry.
   */
  getChildren(parentId: string): SessionEntry[] {
    const children: SessionEntry[] = [];
    for (const entry of this.byId.values()) {
      if (entry.parentId === parentId) {
        children.push(entry);
      }
    }
    return children;
  }

  /**
   * Get the session as a tree structure.
   */
  getTree(): SessionTreeNode[] {
    const entries = this.getEntries();
    const nodeMap = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];

    // Create nodes
    for (const entry of entries) {
      nodeMap.set(entry.id, { entry, children: [] });
    }

    // Build tree
    for (const entry of entries) {
      const node = nodeMap.get(entry.id)!;
      if (entry.parentId === null || entry.parentId === entry.id) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(entry.parentId);
        if (parent) {
          parent.children.push(node);
        } else {
          // Orphan - treat as root
          roots.push(node);
        }
      }
    }

    // Sort children by timestamp
    const sortChildren = (nodes: SessionTreeNode[]): void => {
      nodes.sort(
        (a, b) =>
          new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
      );
      for (const node of nodes) {
        sortChildren(node.children);
      }
    };
    sortChildren(roots);

    return roots;
  }

  /**
   * Find all leaf nodes (entries with no children).
   */
  getLeaves(): SessionEntry[] {
    const hasChildren = new Set<string>();
    for (const entry of this.byId.values()) {
      if (entry.parentId) {
        hasChildren.add(entry.parentId);
      }
    }

    const leaves: SessionEntry[] = [];
    for (const entry of this.byId.values()) {
      if (!hasChildren.has(entry.id)) {
        leaves.push(entry);
      }
    }

    return leaves;
  }

  /**
   * Build session context from current leaf.
   */
  buildSessionContext(): SessionContext {
    return buildSessionContext(this.getEntries(), this.leafId, this.byId);
  }

  /**
   * Get message entry IDs for current branch path, in order from root to leaf.
   * Returns ONLY message entries on the current path, not branches or other entry types.
   * Used by auto-compactor to map message indices to entry IDs.
   */
  getPathMessageEntryIds(): string[] {
    const path = this.getBranch();
    return path.filter((e) => e.type === "message").map((e) => e.id);
  }

  /**
   * Build a mapping from message indices to entry IDs for the current context.
   * Returns an array where result[i] is the entry ID for messages[i],
   * or null only when there is no persisted entry to point at (specifically,
   * the synthetic compaction-summary message that gets prepended in memory
   * when a compaction exists on the path).
   *
   * Branch-summary entries ARE persisted entries — although they replay as
   * synthetic `custom` messages, their entry id is a valid anchor for
   * compaction's `firstKeptEntryId`. Including them here lets the
   * auto-compactor anchor a kept tail on a branch_summary without losing
   * that branch context after reload.
   */
  buildMessageToEntryMapping(): (string | null)[] {
    const entries = this.getEntries();
    const path = this.getBranch();

    // Find latest compaction on the path (same logic as buildSessionContext)
    let compaction: CompactionEntry | null = null;
    let compactionIndex = -1;
    for (let i = 0; i < path.length; i++) {
      if (path[i].type === "compaction") {
        compaction = path[i] as CompactionEntry;
        compactionIndex = i;
      }
    }

    const mapping: (string | null)[] = [];

    if (compaction) {
      // Compaction summary is a synthetic message at index 0
      mapping.push(null);

      // Find start index for kept entries
      let startIndex = compactionIndex + 1;
      const keptIndex = path.findIndex((e) => e.id === compaction!.firstKeptEntryId);
      if (keptIndex >= 0 && keptIndex < compactionIndex) {
        startIndex = keptIndex;
      }

      // Map kept entries
      for (let i = startIndex; i < path.length; i++) {
        const entry = path[i];
        if (entry.type === "message") {
          mapping.push(entry.id);
        } else if (entry.type === "branch_summary") {
          // Branch summary is synthetic at replay BUT has a real persisted
          // entry id. Use that id so compaction can anchor on it without
          // losing the branch summary in the kept tail.
          mapping.push(entry.id);
        }
        // Skip other entry types (settings_change, compaction, session_info)
      }
    } else {
      // No compaction - map all messages and branch summaries
      for (const entry of path) {
        if (entry.type === "message") {
          mapping.push(entry.id);
        } else if (entry.type === "branch_summary") {
          // See note above — anchor on the persisted entry id.
          mapping.push(entry.id);
        }
        // Skip other entry types
      }
    }

    return mapping;
  }

  // ==========================================================================
  // Branching
  // ==========================================================================

  /**
   * Move leaf pointer to a different entry.
   * The next append will create a child of this entry.
   */
  branch(toEntryId: string): void {
    if (!this.byId.has(toEntryId)) {
      throw new Error(`Entry ${toEntryId} not found`);
    }
    this.leafId = toEntryId;
    this.leafSelectedByUser = true;
  }

  /**
   * Navigate to another branch, optionally summarizing the abandoned tail.
   *
   * Computes the deepest common ancestor with the current leaf, gathers the
   * entries that exist on the OLD branch but not on the target's ancestor
   * chain, and (if the caller provides a summary) records a `branch_summary`
   * entry on the TARGET path that captures what was abandoned. The summary
   * is anchored at `fromId = oldLeafId` so future readers can trace which
   * branch tip was summarized.
   *
   * The summary is appended BEFORE the leaf moves so it lives on the new
   * branch as a child of the target — i.e., the next append after navigation
   * sees both the target's history and the abandoned-branch summary.
   *
   * Returns the abandoned entries plus the common ancestor id so callers can
   * decide whether the gap is interesting enough to summarize before calling.
   * Pass `summary` as `undefined` to navigate without recording anything.
   */
  navigateBranch(
    targetId: string,
    summary?: string,
    summaryDetails?: BranchSummaryDetails,
  ): {
    abandonedEntries: SessionEntry[];
    commonAncestorId: string | null;
    summaryEntryId?: string;
  } {
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }

    // Same-position navigation is a no-op — there is nothing to abandon
    // and nothing to summarize.
    if (targetId === this.leafId) {
      return { abandonedEntries: [], commonAncestorId: this.leafId };
    }

    const oldLeafId = this.leafId;
    const { entries: abandonedEntries, commonAncestorId } =
      collectEntriesForBranchSummary(this, oldLeafId, targetId);

    // Snapshot mutable state BEFORE either the leaf swap or the summary
    // append so we can restore atomically on any failure. appendEntry
    // mutates fileEntries / byId / leafId BEFORE calling persistEntry,
    // which means a fs error during persistence leaves the in-memory
    // state half-done unless we undo it explicitly.
    const fileEntriesLen = this.fileEntries.length;
    const flushedSnapshot = this.flushed;
    const sessionFileSnapshot = this.sessionFileBytes();
    const leafSelectedSnapshot = this.leafSelectedByUser;

    // Move to the target FIRST so the summary's parentId chains onto the
    // new branch (not the abandoned one).
    this.leafId = targetId;
    this.leafSelectedByUser = true;

    // Suppress summary writes when the abandoned tail is empty or the
    // two leaves share no common ancestor (disconnected trees, orphaned
    // branches, navigating "deeper" along the same line). Writing a
    // summary anchored to oldLeafId in those cases recreates the bogus
    // cross-branch contamination that collectEntriesForBranchSummary
    // explicitly returns `null`/`[]` to flag.
    const shouldWriteSummary =
      summary &&
      !!oldLeafId &&
      commonAncestorId !== null &&
      abandonedEntries.length > 0;

    let summaryEntryId: string | undefined;
    if (shouldWriteSummary && oldLeafId) {
      try {
        summaryEntryId = this.appendBranchSummary(oldLeafId, summary, summaryDetails);
      } catch (err) {
        // Roll back ALL in-memory state appendEntry could have mutated,
        // not just the leaf pointer. Otherwise a transient fs /
        // id-collision failure leaves a phantom branch_summary entry
        // visible in this process — duplicating on retry, or surfacing
        // a summary the file on disk never received.
        this.leafId = oldLeafId;
        this.leafSelectedByUser = leafSelectedSnapshot;
        if (this.fileEntries.length > fileEntriesLen) {
          for (let i = this.fileEntries.length - 1; i >= fileEntriesLen; i--) {
            const stale = this.fileEntries[i];
            if (stale.type !== "session") this.byId.delete(stale.id);
          }
          this.fileEntries.length = fileEntriesLen;
        }
        this.flushed = flushedSnapshot;
        // Disk-side rollback is conditional on holding the cross-process
        // lock. WITHOUT the lock, truncate-to-snapshot could erase a
        // peer process's bytes appended between the snapshot and the
        // failure. WITH the lock, no peer can have written, so truncate
        // is safe and prevents a thrown navigation from becoming durable
        // session state on reopen (loadSessionFile + buildIndex resume
        // from the last entry on disk, so a phantom branch_summary
        // would silently teleport the user to the target branch on next
        // launch).
        if (this.lockHeld && sessionFileSnapshot >= 0 && this.persist && this.sessionFile) {
          try {
            truncateSync(this.sessionFile, sessionFileSnapshot);
          } catch (truncErr) {
            (err as Error).message += ` (and disk rollback failed: ${(truncErr as Error).message})`;
          }
        }
        throw err;
      }
    }

    return { abandonedEntries, commonAncestorId, summaryEntryId };
  }

  /**
   * Reset leaf to null (before first entry).
   */
  resetLeaf(): void {
    this.leafId = null;
    this.leafSelectedByUser = true;
  }

  /**
   * Get entries between two points in the tree.
   * Returns entries from afterId (exclusive) to toId (inclusive).
   */
  getEntriesBetween(afterId: string | null, toId: string): SessionEntry[] {
    const toPath = this.getBranch(toId);
    if (afterId === null) return toPath;

    const afterIndex = toPath.findIndex((e) => e.id === afterId);
    if (afterIndex === -1) {
      // afterId not in path to toId - return entries unique to toId's path
      const afterPath = this.getBranch(afterId);
      const afterIds = new Set(afterPath.map((e) => e.id));
      return toPath.filter((e) => !afterIds.has(e.id));
    }

    return toPath.slice(afterIndex + 1);
  }

  // ==========================================================================
  // Session Forking
  // ==========================================================================

  /**
   * Create a new session file containing only the path to specified leaf.
   * Returns the new session file path.
   */
  forkSession(leafId?: string): string | undefined {
    const targetLeafId = leafId ?? this.leafId;
    if (!targetLeafId) {
      throw new Error("No leaf to fork from");
    }

    const path = this.getBranch(targetLeafId);
    if (path.length === 0) {
      throw new Error(`Entry ${targetLeafId} not found`);
    }

    const previousSessionFile = this.sessionFile;
    const newSessionId = generateSessionId();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");

    // Build ID mapping (old -> new) and create new entries with remapped IDs
    const idMap = new Map<string, string>();
    const usedIds = new Set<string>();

    // First pass: generate new IDs and build mapping
    for (const entry of path) {
      const newId = generateId(usedIds);
      usedIds.add(newId);
      idMap.set(entry.id, newId);
    }

    // Helper to remap embedded ID references
    const remapEntry = (entry: SessionEntry, newId: string, newParentId: string | null): SessionEntry | null => {
      const base = { ...entry, id: newId, parentId: newParentId };

      // Remap embedded ID references for specific entry types
      if (entry.type === "compaction") {
        const mappedFirstKeptId = idMap.get(entry.firstKeptEntryId);
        return {
          ...base,
          type: "compaction",
          summary: entry.summary,
          firstKeptEntryId: mappedFirstKeptId ?? entry.firstKeptEntryId,
          tokensBefore: entry.tokensBefore,
          details: entry.details,
        };
      }

      if (entry.type === "branch_summary") {
        const mappedFromId = idMap.get(entry.fromId);
        return {
          ...base,
          type: "branch_summary",
          fromId: mappedFromId ?? entry.fromId,
          summary: entry.summary,
          details: entry.details,
        };
      }

      if (entry.type === "label") {
        // Drop ALL existing label entries from the forked path. The
        // path-replay model can't reproduce label state correctly
        // when a displacing reassignment happened on a sibling
        // branch we didn't copy — replaying just the path entries
        // would resurrect a label the user already moved away.
        // Instead, the fork synthesizes fresh LabelEntries below
        // that capture the parent session's CURRENT label state
        // filtered to entries present in the fork. Codex labels
        // pass-3 finding.
        return null;
      }

      return base as SessionEntry;
    };

    // Second pass: create new entries with remapped IDs. Skip
    // entries that remapEntry refused (e.g. label entries — fork
    // synthesizes fresh ones from current state below); preserve
    // the parent chain so following entries still point at a real
    // previous ID. Track which old IDs actually survived emission so
    // label synthesis can filter by emitted-ness, not just by
    // idMap membership (every path entry gets a remapping, but
    // dropped entries don't end up in the output file).
    const newEntries: SessionEntry[] = [];
    const emittedOldIds = new Set<string>();
    let prevId: string | null = null;
    for (const entry of path) {
      const newId = idMap.get(entry.id)!;
      const newEntry = remapEntry(entry, newId, prevId);
      if (!newEntry) continue;
      newEntries.push(newEntry);
      emittedOldIds.add(entry.id);
      prevId = newId;
    }

    // Synthesize fresh LabelEntries for the parent's CURRENT label
    // state, filtered to targets that survived the fork. This avoids
    // resurrecting a label whose displacing reassignment lived on a
    // sibling branch we didn't copy. Each synthesized entry gets a
    // new ID, parented at the previous tip — building a small
    // appendix that establishes ground-truth label state.
    let labelTimestampOffset = 0;
    for (const [origTargetId, label] of this.labelsByTargetId) {
      // Filter by actually-emitted IDs, not just idMap membership.
      // appendLabelChange already rejects labeling a LabelEntry, but
      // belt-and-suspenders: any other case where remapEntry drops
      // an entry must not cause us to write a dangling label.
      if (!emittedOldIds.has(origTargetId)) continue;
      const newTargetId = idMap.get(origTargetId);
      if (!newTargetId) continue;
      const labelId = generateId(usedIds);
      usedIds.add(labelId);
      const labelEntry: LabelEntry = {
        type: "label",
        id: labelId,
        parentId: prevId,
        // Stagger timestamps so on-disk order is stable even at
        // sub-millisecond resolution.
        timestamp: new Date(Date.now() + labelTimestampOffset++).toISOString(),
        targetId: newTargetId,
        label,
      };
      newEntries.push(labelEntry);
      prevId = labelId;
    }

    // Mirror the lazy-promotion rule: the fork header keeps the
    // parent's schema version unless the fork itself emits a v2-only
    // entry. Prevents pass-9-style needless upgrades that would
    // lock a v1 binary out of an unlabeled forked session.
    // Codex labels pass-10 finding.
    const parentHeader = this.fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
    const parentVersion = parentHeader?.version ?? CURRENT_SESSION_VERSION;
    const hasV2Entry = newEntries.some((e) => isV2OnlyEntry(e));
    const forkVersion = hasV2Entry ? Math.max(parentVersion, CURRENT_SESSION_VERSION) : parentVersion;

    if (!this.persist) {
      // In-memory mode - just replace current session with the path
      const header: SessionHeader = {
        type: "session",
        version: forkVersion,
        id: newSessionId,
        cwd: this.cwd,
        timestamp,
        parentSession: previousSessionFile,
        forkPoint: targetLeafId,
      };

      this.fileEntries = [header, ...newEntries];
      this.sessionId = newSessionId;
      this.buildIndex();
      return undefined;
    }

    // Create new session file
    const newSessionFile = join(this.sessionDir, `${fileTimestamp}_${newSessionId}.jsonl`);

    const header: SessionHeader = {
      type: "session",
      version: forkVersion,
      id: newSessionId,
      cwd: this.cwd,
      timestamp,
      parentSession: previousSessionFile,
      forkPoint: targetLeafId,
    };

    // Write new file
    const content = [header, ...newEntries].map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(newSessionFile, content);

    // Update this manager to use new session
    this.sessionFile = newSessionFile;
    this.sessionId = newSessionId;
    this.fileEntries = [header, ...newEntries];
    this.buildIndex();
    this.flushed = true;
    // Refresh the freshness baseline for the NEW file. Without
    // this, the next appendLabelChange would compare the fork's
    // mtime against the parent file's older snapshot and falsely
    // throw "changed externally". Codex labels pass-9 finding.
    this.recordFreshMtime();

    return newSessionFile;
  }

  // ==========================================================================
  // Cross-Process Locking
  // ==========================================================================

  /**
   * Execute an operation with cross-process locking on this session file.
   * Use this when multiple processes may access the same session.
   *
   * @example
   * ```typescript
   * await session.withLock(async () => {
   *   session.appendMessage(userMessage);
   *   session.appendMessage(assistantMessage);
   * });
   * ```
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    // Re-entrant short-circuit: if THIS manager already holds the
    // lock (somewhere up the call stack), skip the cross-process
    // acquire — we already have exclusive access. Without this an
    // inner withLock would deadlock against the outer's file lock.
    if (this.lockDepth > 0) {
      this.lockDepth++;
      try {
        return await fn();
      } finally {
        this.lockDepth--;
      }
    }

    if (!this.sessionFile) {
      // In-memory session - no cross-process locking needed, but we
      // still want lockDepth tracking so navigateBranch's truncate
      // path knows it can roll back safely.
      this.lockDepth++;
      try {
        return await fn();
      } finally {
        this.lockDepth--;
      }
    }
    const sessionFile = this.sessionFile;
    // Preserve a caller-selected leaf across the locked reload below.
    // branch(), navigateBranch(), and resetLeaf() change `leafId` in
    // memory only when there is nothing to persist (no summary, or empty
    // abandoned tail). Without this snapshot+restore, buildIndex() resets
    // `leafId` to the last persisted entry and the caller's branch
    // selection is silently reverted — the next appendMessage attaches to
    // the wrong parent and permanently corrupts the session tree.
    //
    // The flag distinguishes user intent from natural progression: if the
    // current leaf is just whatever appendEntry/buildIndex last set, we
    // accept the new on-disk leaf (so peers' appends are picked up). If
    // the caller explicitly chose this leaf, we restore it.
    const intendedLeafId = this.leafId;
    const intendedLeafSelected = this.leafSelectedByUser;
    return withCrossProcessLock(sessionFile, async () => {
      // Reload state from disk so the callback sees writes from any other
      // process that completed between our last read and acquiring this
      // lock. Without this, a second writer would chain off its own stale
      // leaf and silently create a sibling branch — defeating the whole
      // point of advertising multi-process safety.
      //
      // Caveat: any in-memory state we hadn't yet flushed (rare; only
      // during the deferred-flush window before the first assistant
      // message) is overwritten. Multi-process callers should take the
      // lock before mutating, which avoids that case entirely.
      const result = loadSessionFile(sessionFile);
      if (result.status === "ok") {
        this.fileEntries = result.entries;
        if (migrateToCurrentVersion(this.fileEntries)) {
          this.rewriteFile();
        }
        this.buildIndex();
        this.flushed = true;
        this.recordFreshMtime();
        // Restore the caller's selected leaf if it was an explicit choice.
        // A peer's writes since our snapshot become a sibling branch off
        // the same parent, which is the correct multi-branch model.
        if (
          intendedLeafSelected &&
          intendedLeafId !== null &&
          this.byId.has(intendedLeafId)
        ) {
          this.leafId = intendedLeafId;
          this.leafSelectedByUser = true;
        } else if (intendedLeafSelected && intendedLeafId === null) {
          // resetLeaf() was called — preserve the explicit reset.
          this.leafId = null;
          this.leafSelectedByUser = true;
        }
      }
      this.lockDepth++;
      try {
        return await fn();
      } finally {
        this.lockDepth--;
      }
    });
  }

  /**
   * Static helper to execute an operation with cross-process locking.
   * Use when you need to lock before opening a session.
   */
  static async withSessionLock<T>(
    sessionFile: string,
    fn: () => Promise<T>
  ): Promise<T> {
    return withCrossProcessLock(sessionFile, fn);
  }
}
