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

    it("Tier-1: navigateBranch records summary on the new branch and returns the abandoned tail", () => {
      // Build:
      //          root
      //           |
      //           A (user)
      //           |
      //           B (assistant)   <-- common ancestor
      //          / \
      //         /   \
      //        C     D            <-- siblings; we'll abandon C->E for D
      //        |
      //        E
      //
      // Then navigate from leaf E to D, with a summary of "C/E branch".
      // Expectations:
      // - abandonedEntries = [C, E] (chronological)
      // - commonAncestorId = B
      // - leaf is now D AFTER the appended summary entry
      // - the branch_summary entry's parentId is D (it lives on the new branch)
      const manager = SessionManager.create("/test/cwd", tempDir);
      const a = manager.appendMessage({ role: "user", content: "A", timestamp: Date.now() });
      const b = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "B" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const c = manager.appendMessage({ role: "user", content: "C", timestamp: Date.now() });
      const e = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "E" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });

      // Branch off B and create sibling D
      manager.branch(b);
      const d = manager.appendMessage({ role: "user", content: "D", timestamp: Date.now() });

      // Move back to E so we can simulate "user is on the C/E branch and now jumps back to D"
      manager.branch(e);

      const result = manager.navigateBranch(d, "Abandoned C/E branch");

      expect(result.commonAncestorId).toBe(b);
      expect(result.abandonedEntries.map((x) => x.id)).toEqual([c, e]);
      expect(result.summaryEntryId).toBeTruthy();

      // The summary's parentId must be D (lives on the new branch).
      const summary = manager.getEntry(result.summaryEntryId!);
      expect(summary?.type).toBe("branch_summary");
      expect(summary?.parentId).toBe(d);
      expect((summary as any).fromId).toBe(e);

      // Leaf is now the summary entry — next append continues from there.
      expect(manager.getLeafId()).toBe(result.summaryEntryId);
    });

    it("Tier-1: navigateBranch with no summary just moves the leaf and returns the abandoned tail", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);
      const a = manager.appendMessage({ role: "user", content: "A", timestamp: Date.now() });
      const b = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "B" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const c = manager.appendMessage({ role: "user", content: "C", timestamp: Date.now() });

      manager.branch(b);
      const d = manager.appendMessage({ role: "user", content: "D", timestamp: Date.now() });
      manager.branch(c);

      const result = manager.navigateBranch(d);
      expect(result.summaryEntryId).toBeUndefined();
      expect(result.commonAncestorId).toBe(b);
      expect(result.abandonedEntries.map((x) => x.id)).toEqual([c]);
      expect(manager.getLeafId()).toBe(d);
    });

    it("Tier-1: navigateBranch is a no-op when target equals current leaf", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);
      const a = manager.appendMessage({ role: "user", content: "A", timestamp: Date.now() });
      const result = manager.navigateBranch(a, "would be ignored");
      expect(result.summaryEntryId).toBeUndefined();
      expect(result.abandonedEntries).toHaveLength(0);
      expect(result.commonAncestorId).toBe(a);
      // No branch_summary should have been written.
      expect(manager.getEntries().filter((e) => e.type === "branch_summary")).toHaveLength(0);
    });

    it("Tier-1: navigateBranch rolls leaf back when summary persistence throws", () => {
      // Exercises the atomicity guard: appendBranchSummary failing must
      // NOT leave the leaf pointing at the new target with no summary
      // recorded. Otherwise the next user action commits to the new branch
      // and the abandoned tail's context is silently lost.
      const manager = SessionManager.create("/test/cwd", tempDir);
      const a = manager.appendMessage({ role: "user", content: "A", timestamp: Date.now() });
      const b = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "B" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const c = manager.appendMessage({ role: "user", content: "C", timestamp: Date.now() });
      manager.branch(b);
      const d = manager.appendMessage({ role: "user", content: "D", timestamp: Date.now() });
      manager.branch(c);

      const originalLeaf = manager.getLeafId();
      // Force appendBranchSummary to throw.
      const original = manager.appendBranchSummary.bind(manager);
      manager.appendBranchSummary = () => {
        throw new Error("simulated fs failure");
      };

      expect(() => manager.navigateBranch(d, "Should fail")).toThrow(
        /simulated fs failure/,
      );

      // Leaf MUST still be at the original position (c), not d.
      expect(manager.getLeafId()).toBe(originalLeaf);
      expect(manager.getEntries().filter((e) => e.type === "branch_summary")).toHaveLength(0);

      // Restore so the manager can be cleaned up properly.
      manager.appendBranchSummary = original;
    });

    it("Codex-fix: navigateBranch summary failure leaves zero half-done state in fileEntries/byId", () => {
      // The earlier rollback only reset leafId. appendEntry mutates
      // fileEntries / byId BEFORE persistEntry runs, so a fs failure
      // would leave a phantom branch_summary entry in memory even
      // though the navigation was reported as failed. This test forces
      // persistEntry to throw and asserts NO phantom state survives.
      const manager = SessionManager.create("/test/cwd", tempDir);
      const a = manager.appendMessage({ role: "user", content: "A", timestamp: Date.now() });
      const b = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "B" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const c = manager.appendMessage({ role: "user", content: "C", timestamp: Date.now() });
      manager.branch(b);
      const d = manager.appendMessage({ role: "user", content: "D", timestamp: Date.now() });
      manager.branch(c);

      const entriesBefore = manager.getEntries().length;
      const idsBefore = manager.getEntries().map((e) => e.id);
      const leafBefore = manager.getLeafId();

      // Patch the private persistEntry to throw on the next call.
      const original = (manager as any).persistEntry.bind(manager);
      let calls = 0;
      (manager as any).persistEntry = (entry: any) => {
        calls++;
        if (calls === 1) throw new Error("simulated fs failure");
        return original(entry);
      };

      expect(() => manager.navigateBranch(d, "Should fail")).toThrow(
        /simulated fs failure/,
      );

      // No phantom entry, no shifted leaf, no orphan id in the byId index.
      expect(manager.getEntries().length).toBe(entriesBefore);
      expect(manager.getEntries().map((e) => e.id)).toEqual(idsBefore);
      expect(manager.getLeafId()).toBe(leafBefore);
      // Restore so cleanup works
      (manager as any).persistEntry = original;
    });

    it("Codex-pass2-fix: navigateBranch suppresses summary when abandonedEntries is empty", () => {
      // Navigating "deeper" along the same line: oldLeaf=A, target=C.
      // collectEntriesForBranchSummary returns abandonedEntries=[].
      // navigateBranch MUST NOT write a branch_summary in that case
      // (it would anchor a phantom entry to oldLeaf with nothing to
      // describe).
      const manager = SessionManager.create("/test/cwd", tempDir);
      const a = manager.appendMessage({ role: "user", content: "A", timestamp: Date.now() });
      const b = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "B" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const c = manager.appendMessage({ role: "user", content: "C", timestamp: Date.now() });
      manager.branch(a);

      const result = manager.navigateBranch(c, "should be ignored");
      expect(result.summaryEntryId).toBeUndefined();
      expect(manager.getEntries().filter((e) => e.type === "branch_summary")).toHaveLength(0);
    });

    it("Codex-pass2-fix: navigateBranch truncates session file when summary persistence fails", () => {
      // Drives the disk-rollback path: when persistEntry has already
      // written bytes (incremental append branch) and a later step
      // throws, the in-memory rollback must also truncate the file
      // back to its pre-navigation byte count. Otherwise reloading the
      // session would resurrect the rolled-back branch_summary entry.
      const manager = SessionManager.create("/test/cwd", tempDir);
      // Need an assistant message so flushed=true (incremental append).
      manager.appendMessage({ role: "user", content: "A", timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "B" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const c = manager.appendMessage({ role: "user", content: "C", timestamp: Date.now() });
      manager.branch(manager.getEntries()[1].id); // back to assistant
      const d = manager.appendMessage({ role: "user", content: "D", timestamp: Date.now() });
      manager.branch(c);

      const sessionFile = manager.getSessionFile()!;
      const bytesBefore = readFileSync(sessionFile).length;

      // Force the SECOND persistEntry call (the branch_summary) to
      // throw AFTER it would have written. We simulate by patching
      // appendFileSync via the persistEntry method itself.
      const originalPersist = (manager as any).persistEntry.bind(manager);
      let persistCalls = 0;
      (manager as any).persistEntry = (entry: any) => {
        persistCalls++;
        if (persistCalls === 1) {
          // Let the file actually receive bytes for this call so we
          // can assert truncation rolls them back.
          originalPersist(entry);
          throw new Error("simulated post-write failure");
        }
        return originalPersist(entry);
      };

      expect(() => manager.navigateBranch(d, "fail me")).toThrow(/simulated/);

      // File MUST be back to its original byte count — no phantom
      // branch_summary line on disk for the next reload to resurrect.
      expect(readFileSync(sessionFile).length).toBe(bytesBefore);
      (manager as any).persistEntry = originalPersist;
    });

    it("Tier-1: navigateBranch deeper along the same line abandons nothing", () => {
      // root -> A -> B -> C
      // Leaf is at A. Navigating to C is moving FORWARD along the same line.
      // No entries are abandoned.
      const manager = SessionManager.create("/test/cwd", tempDir);
      const a = manager.appendMessage({ role: "user", content: "A", timestamp: Date.now() });
      const b = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "B" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const c = manager.appendMessage({ role: "user", content: "C", timestamp: Date.now() });

      manager.branch(a);
      const result = manager.navigateBranch(c);
      expect(result.abandonedEntries).toHaveLength(0);
      expect(result.commonAncestorId).toBe(a);
      expect(manager.getLeafId()).toBe(c);
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
