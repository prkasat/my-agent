import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, buildSessionContext } from "../../src/session/session-manager.js";
import type { AgentMessage } from "../../src/agent/types.js";
import type { SessionEntry, MessageEntry, SettingsChangeEntry } from "../../src/session/types.js";

describe("SessionManager", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "session-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("create and basic operations", () => {
    it("should create a new session", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);

      expect(manager.getSessionId()).toBeTruthy();
      expect(manager.getCwd()).toBe("/test/cwd");
      expect(manager.getLeafId()).toBeNull();
      expect(manager.getEntries()).toHaveLength(0);
    });

    it("should append messages and update leaf", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);

      const userMsg: AgentMessage = { role: "user", content: "Hello", timestamp: Date.now() };
      const id1 = manager.appendMessage(userMsg);

      expect(id1).toBeTruthy();
      expect(manager.getLeafId()).toBe(id1);
      expect(manager.getEntries()).toHaveLength(1);

      const assistantMsg: AgentMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const id2 = manager.appendMessage(assistantMsg);

      expect(manager.getLeafId()).toBe(id2);
      expect(manager.getEntries()).toHaveLength(2);

      // Check parent relationship
      const entry2 = manager.getEntry(id2) as MessageEntry;
      expect(entry2.parentId).toBe(id1);
    });

    it("should build session context from messages", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);

      manager.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Hi!" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });

      const context = manager.buildSessionContext();

      expect(context.messages).toHaveLength(2);
      expect(context.messages[0].role).toBe("user");
      expect(context.messages[1].role).toBe("assistant");
      expect(context.thinkingLevel).toBe("off");
      expect(context.model).toBeNull();
    });
  });

  describe("settings changes", () => {
    it("should track model changes", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);

      manager.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
      manager.appendSettingsChange({
        model: { provider: "anthropic", modelId: "claude-3-opus" },
      });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Hi!" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });

      const context = manager.buildSessionContext();

      expect(context.model).toEqual({ provider: "anthropic", modelId: "claude-3-opus" });
    });

    it("should track thinking level changes", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);

      manager.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
      manager.appendSettingsChange({ thinkingLevel: "high" });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Hi!" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });

      const context = manager.buildSessionContext();

      expect(context.thinkingLevel).toBe("high");
    });
  });

  describe("branching", () => {
    it("should create branches by moving leaf", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);

      const id1 = manager.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
      const id2 = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Hi!" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const id3 = manager.appendMessage({ role: "user", content: "Follow up", timestamp: Date.now() });

      // Branch from id2
      manager.branch(id2);
      expect(manager.getLeafId()).toBe(id2);

      // New message creates a sibling of id3
      const id4 = manager.appendMessage({ role: "user", content: "Different follow up", timestamp: Date.now() });

      // Check parent relationships
      const entry3 = manager.getEntry(id3) as MessageEntry;
      const entry4 = manager.getEntry(id4) as MessageEntry;

      expect(entry3.parentId).toBe(id2);
      expect(entry4.parentId).toBe(id2); // Sibling of id3

      // Context should include the new branch
      const context = manager.buildSessionContext();
      expect(context.messages).toHaveLength(3);
      expect((context.messages[2] as any).content).toBe("Different follow up");
    });

    it("should get entries between two points", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);

      const id1 = manager.appendMessage({ role: "user", content: "1", timestamp: Date.now() });
      const id2 = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "2" }], stopReason: "stop", timestamp: Date.now() });
      const id3 = manager.appendMessage({ role: "user", content: "3", timestamp: Date.now() });
      const id4 = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "4" }], stopReason: "stop", timestamp: Date.now() });

      const between = manager.getEntriesBetween(id1, id4);

      expect(between).toHaveLength(3); // id2, id3, id4
      expect(between[0].id).toBe(id2);
      expect(between[2].id).toBe(id4);
    });
  });

  describe("tree structure", () => {
    it("should build correct tree", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);

      const id1 = manager.appendMessage({ role: "user", content: "Root", timestamp: Date.now() });
      const id2 = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "R1" }], stopReason: "stop", timestamp: Date.now() });

      // Create two branches from id2
      const id3 = manager.appendMessage({ role: "user", content: "Branch A", timestamp: Date.now() });

      manager.branch(id2);
      const id4 = manager.appendMessage({ role: "user", content: "Branch B", timestamp: Date.now() });

      const tree = manager.getTree();

      expect(tree).toHaveLength(1); // One root
      expect(tree[0].entry.id).toBe(id1);
      expect(tree[0].children).toHaveLength(1); // id2
      expect(tree[0].children[0].children).toHaveLength(2); // id3 and id4
    });

    it("should find all leaves", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);

      const id1 = manager.appendMessage({ role: "user", content: "Root", timestamp: Date.now() });
      const id2 = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "R1" }], stopReason: "stop", timestamp: Date.now() });
      const id3 = manager.appendMessage({ role: "user", content: "Branch A", timestamp: Date.now() });

      manager.branch(id2);
      const id4 = manager.appendMessage({ role: "user", content: "Branch B", timestamp: Date.now() });

      const leaves = manager.getLeaves();

      expect(leaves).toHaveLength(2);
      expect(leaves.map(l => l.id).sort()).toEqual([id3, id4].sort());
    });
  });

  describe("session info", () => {
    it("should store and retrieve session name", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);

      expect(manager.getSessionName()).toBeUndefined();

      manager.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
      manager.appendSessionInfo("My Session");

      expect(manager.getSessionName()).toBe("My Session");

      // Updating name
      manager.appendSessionInfo("Updated Name");
      expect(manager.getSessionName()).toBe("Updated Name");

      // Clearing name
      manager.appendSessionInfo(undefined);
      expect(manager.getSessionName()).toBeUndefined();
    });
  });

  describe("persistence", () => {
    it("should defer flush until first assistant message", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);
      const sessionFile = manager.getSessionFile()!;

      manager.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });

      // File should not exist yet
      expect(existsSync(sessionFile)).toBe(false);

      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Hi!" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });

      // Now file should exist
      expect(existsSync(sessionFile)).toBe(true);

      // Verify content
      const content = readFileSync(sessionFile, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(3); // header + 2 messages
    });

    it("should load existing session", () => {
      const manager1 = SessionManager.create("/test/cwd", tempDir);

      manager1.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
      manager1.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Hi!" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });

      const sessionFile = manager1.getSessionFile()!;

      // Load the session
      const manager2 = SessionManager.open(sessionFile);

      expect(manager2.getSessionId()).toBe(manager1.getSessionId());
      expect(manager2.getEntries()).toHaveLength(2);
    });
  });

  describe("session forking", () => {
    it("should fork session to new file", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);

      manager.appendMessage({ role: "user", content: "Root", timestamp: Date.now() });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "R1" }], stopReason: "stop", timestamp: Date.now() });
      const id3 = manager.appendMessage({ role: "user", content: "Continue", timestamp: Date.now() });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "R2" }], stopReason: "stop", timestamp: Date.now() });

      // Create branch
      manager.branch(manager.getEntries()[1].id); // Branch from first assistant
      manager.appendMessage({ role: "user", content: "Different path", timestamp: Date.now() });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "R3" }], stopReason: "stop", timestamp: Date.now() });

      const originalFile = manager.getSessionFile();
      const originalId = manager.getSessionId();

      // Fork current branch
      const newFile = manager.forkSession();

      expect(newFile).toBeTruthy();
      expect(newFile).not.toBe(originalFile);
      expect(manager.getSessionId()).not.toBe(originalId);

      // New session should have linear path
      const entries = manager.getEntries();
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i].parentId).toBe(entries[i - 1].id);
      }

      // Check header has parent reference
      const header = manager.getHeader();
      expect(header?.parentSession).toBe(originalFile);
    });
  });

  describe("buildMessageToEntryMapping", () => {
    it("regression (pass-4): branch_summary entries map to their entry id, not null", () => {
      // The auto-compactor's persistence wrapper anchors `firstKeptEntryId`
      // on the first non-null mapping slot at or after cutIndex. If a kept
      // tail begins with a branch_summary and that slot is null, the
      // anchor jumps past the branch_summary to the next real message —
      // and on reload the branch summary is silently dropped.
      //
      // Branch summaries ARE persisted entries with valid ids. The
      // mapping must surface those ids so compaction can anchor on them
      // and replay reproduces the same kept tail.
      const manager = SessionManager.create("/test/cwd", tempDir);

      const userId = manager.appendMessage({
        role: "user",
        content: "first",
        timestamp: Date.now(),
      });
      const summaryId = manager.appendBranchSummary(userId, "branch context");
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "after summary" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });

      const mapping = manager.buildMessageToEntryMapping();
      // user, branch_summary, assistant
      expect(mapping).toHaveLength(3);
      expect(mapping[0]).toBe(userId);
      // The fix: branch_summary index now carries its real entry id
      expect(mapping[1]).toBe(summaryId);
      expect(mapping[1]).not.toBeNull();
      expect(mapping[2]).toBeTruthy();
    });
  });

  describe("in-memory mode", () => {
    it("should work without persistence", () => {
      const manager = SessionManager.inMemory("/test/cwd");

      expect(manager.isPersisted()).toBe(false);
      expect(manager.getSessionFile()).toBeUndefined();

      manager.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Hi!" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });

      expect(manager.getEntries()).toHaveLength(2);
    });
  });
});

describe("buildSessionContext", () => {
  it("should handle compaction entries", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "a",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "First", timestamp: Date.now() },
      },
      {
        type: "message",
        id: "b",
        parentId: "a",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "Response 1" }], stopReason: "stop", timestamp: Date.now() },
      },
      {
        type: "compaction",
        id: "c",
        parentId: "b",
        timestamp: new Date().toISOString(),
        summary: "Previous conversation discussed X",
        firstKeptEntryId: "d",
        tokensBefore: 10000,
        details: { readFiles: [], modifiedFiles: [], tokensAfter: 1000 },
      },
      {
        type: "message",
        id: "d",
        parentId: "c",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Continue", timestamp: Date.now() },
      },
      {
        type: "message",
        id: "e",
        parentId: "d",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "Response 2" }], stopReason: "stop", timestamp: Date.now() },
      },
    ];

    const context = buildSessionContext(entries, "e");

    // Should have: summary (custom message) + d + e
    expect(context.messages).toHaveLength(3);
    // First message is a compaction_summary custom message with .summary field
    expect((context.messages[0] as any).role).toBe("custom");
    expect((context.messages[0] as any).type).toBe("compaction_summary");
    expect((context.messages[0] as any).summary).toContain("Previous conversation discussed X");
    expect((context.messages[1] as any).content).toBe("Continue");
  });

  it("should handle branch summary entries", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "a",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Start", timestamp: Date.now() },
      },
      {
        type: "branch_summary",
        id: "b",
        parentId: "a",
        timestamp: new Date().toISOString(),
        fromId: "x",
        summary: "Tried approach X, failed",
      },
      {
        type: "message",
        id: "c",
        parentId: "b",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Try approach Y", timestamp: Date.now() },
      },
    ];

    const context = buildSessionContext(entries, "c");

    expect(context.messages).toHaveLength(3);
    // Second message is a branch_summary custom message with .summary field
    expect((context.messages[1] as any).role).toBe("custom");
    expect((context.messages[1] as any).type).toBe("branch_summary");
    expect((context.messages[1] as any).summary).toContain("Tried approach X, failed");
  });
});

describe("SessionManager.withLock cross-process behavior", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "session-lock-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("regression: reloads disk state at lock acquisition so concurrent writers see each other", async () => {
    // Simulate two processes opening the same session file. Without
    // reload-inside-lock, the second writer would chain off its stale
    // leafId and silently create a sibling branch.
    const a = SessionManager.create("/test/cwd", tempDir);
    const sessionFile = a.getSessionFile()!;
    a.appendMessage({ role: "user", content: "from A", timestamp: Date.now() });
    a.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "A's reply" }],
      stopReason: "stop",
      timestamp: Date.now(),
    });

    // "Process B" opens the same file
    const b = SessionManager.open(sessionFile, tempDir);
    const bLeafBefore = b.getLeafId();

    // Process A appends more (outside any shared lock — simulating
    // the writes that happened between B's open and B's lock)
    a.appendMessage({ role: "user", content: "A continues", timestamp: Date.now() });
    a.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "A again" }],
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const aLeafAfter = a.getLeafId();

    // Now B takes the lock and runs a callback. Inside the callback,
    // B's leaf should have caught up to A's latest because the lock
    // re-reads disk state.
    let leafSeenInsideLock: string | null = null;
    await b.withLock(async () => {
      leafSeenInsideLock = b.getLeafId();
    });

    expect(bLeafBefore).not.toBe(aLeafAfter);
    expect(leafSeenInsideLock).toBe(aLeafAfter);
  });
});
