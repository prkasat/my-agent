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
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  truncateSync,
  writeFileSync,
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
  FileEntry,
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
 */
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
  const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
  const version = header?.version ?? 1;

  if (version >= CURRENT_SESSION_VERSION) return false;

  // Future migrations go here:
  // if (version < 2) migrateV1ToV2(entries);

  // Update header version
  if (header) {
    header.version = CURRENT_SESSION_VERSION;
  }

  return true;
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
  private fileEntries: FileEntry[] = [];
  private byId: Map<string, SessionEntry> = new Map();
  private leafId: string | null = null;

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
        break;
    }
  }

  /**
   * Build the in-memory index from file entries.
   */
  private buildIndex(): void {
    this.byId.clear();
    this.leafId = null;

    for (const entry of this.fileEntries) {
      if (entry.type === "session") continue;
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
    }
  }

  /**
   * Rewrite the entire session file.
   */
  private rewriteFile(): void {
    if (!this.persist || !this.sessionFile) return;
    const content = this.fileEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(this.sessionFile, content);
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

  /**
   * Truncate the session file back to a snapshot byte count.
   *
   * No-op when the snapshot is -1 (no file existed pre-navigation) or
   * when persistence is disabled. Throws on any other fs failure so
   * callers can surface a "rollback failed" condition.
   */
  private truncateSessionFile(snapshot: number): void {
    if (!this.persist || !this.sessionFile) return;
    if (snapshot < 0) return;
    truncateSync(this.sessionFile, snapshot);
  }

  private persistEntry(entry: SessionEntry): void {
    if (!this.persist || !this.sessionFile) return;

    const hasAssistant = this.fileEntries.some(
      (e) => e.type === "message" && (e as MessageEntry).message.role === "assistant"
    );

    if (!hasAssistant) {
      // Don't write yet - wait for assistant message
      this.flushed = false;
      return;
    }

    if (!this.flushed) {
      // First flush - write all entries
      for (const e of this.fileEntries) {
        appendFileSync(this.sessionFile, JSON.stringify(e) + "\n");
      }
      this.flushed = true;
    } else {
      // Incremental append
      appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
    }
  }

  /**
   * Append an entry as child of current leaf.
   */
  private appendEntry(entry: SessionEntry): void {
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this.persistEntry(entry);
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

    // Move to the target FIRST so the summary's parentId chains onto the
    // new branch (not the abandoned one).
    this.leafId = targetId;

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
        // Roll back ALL state appendEntry could have mutated, not just
        // the leaf pointer. Otherwise a transient fs / id-collision
        // failure leaves a phantom branch_summary entry visible to
        // readers and to a retry — duplicating summaries, or worse,
        // surfacing a summary the file on disk never received.
        this.leafId = oldLeafId;
        if (this.fileEntries.length > fileEntriesLen) {
          for (let i = this.fileEntries.length - 1; i >= fileEntriesLen; i--) {
            const stale = this.fileEntries[i];
            if (stale.type !== "session") this.byId.delete(stale.id);
          }
          this.fileEntries.length = fileEntriesLen;
        }
        this.flushed = flushedSnapshot;
        // appendFileSync may have written partial bytes BEFORE throwing,
        // OR the persist may have succeeded entirely and a later step
        // threw. Either way, truncate the session file back to the byte
        // count it had before the navigation started so a reload can't
        // resurrect the rolled-back entry. Truncation failures are
        // re-thrown alongside the original — both errors are signal.
        try {
          this.truncateSessionFile(sessionFileSnapshot);
        } catch (truncErr) {
          // Surface the original error, but annotate with the truncation
          // failure so the caller knows on-disk state may be inconsistent.
          (err as Error).message += ` (and rollback truncation failed: ${(truncErr as Error).message})`;
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
    const remapEntry = (entry: SessionEntry, newId: string, newParentId: string | null): SessionEntry => {
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

      return base as SessionEntry;
    };

    // Second pass: create new entries with remapped IDs
    const newEntries: SessionEntry[] = [];
    let prevId: string | null = null;
    for (const entry of path) {
      const newId = idMap.get(entry.id)!;
      const newEntry = remapEntry(entry, newId, prevId);
      newEntries.push(newEntry);
      prevId = newId;
    }

    if (!this.persist) {
      // In-memory mode - just replace current session with the path
      const header: SessionHeader = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
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
      version: CURRENT_SESSION_VERSION,
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
    if (!this.sessionFile) {
      // In-memory session - no locking needed
      return fn();
    }
    const sessionFile = this.sessionFile;
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
      }
      return fn();
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
