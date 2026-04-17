import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
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

    it("Codex-pass4-fix: navigateBranch under withLock truncates disk so reopen sees the original leaf", async () => {
      // Pass-3 punted on disk rollback because cross-process truncate
      // could erase peer writes. Pass-4 surfaced that the punt let a
      // thrown navigation become durable session state — reopen would
      // resume on the target branch, silently. Pass-4 fix: re-enable
      // truncate when withLock is held (no peer can be writing).
      const manager = SessionManager.create("/test/cwd", tempDir);
      manager.appendMessage({ role: "user", content: "A", timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "B" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const c = manager.appendMessage({ role: "user", content: "C", timestamp: Date.now() });
      manager.branch(manager.getEntries()[1].id);
      const d = manager.appendMessage({ role: "user", content: "D", timestamp: Date.now() });
      const sessionFile = manager.getSessionFile()!;

      // withLock reloads from disk and rebuilds leafId from the LAST
      // entry, so we must do the navigate-from-c setup INSIDE the lock
      // (not before it). The patch on persistEntry survives the reload
      // since it's an instance-method override.
      const originalPersist = (manager as any).persistEntry.bind(manager);
      let persistCallsAfterSetup = 0;
      let leafBefore: string | null = null;

      await expect(
        manager.withLock(async () => {
          manager.branch(c); // simulate user backing up to the C branch tip
          leafBefore = manager.getLeafId();
          // Patch persistEntry NOW so the navigate-time append throws.
          (manager as any).persistEntry = (entry: any) => {
            persistCallsAfterSetup++;
            if (persistCallsAfterSetup === 1) {
              originalPersist(entry);
              throw new Error("simulated post-write failure");
            }
            return originalPersist(entry);
          };
          manager.navigateBranch(d, "fail me");
        }),
      ).rejects.toThrow(/simulated/);

      (manager as any).persistEntry = originalPersist;
      expect(leafBefore).toBe(c);

      // Reopen the file: WITHOUT the under-lock truncate, the phantom
      // branch_summary on disk would survive — buildIndex would expose
      // it as a real entry and a future user navigating to it would
      // see context from a navigation that THREW. With pass-4's fix
      // the disk is back to its pre-navigation byte count and no
      // branch_summary entry exists on reopen.
      const reopened = SessionManager.open(sessionFile);
      expect(reopened.getEntries().filter((e) => e.type === "branch_summary")).toHaveLength(0);
      // And the reopened file's entry list matches what existed
      // pre-navigation (4 message entries: A, B, C, D — no extra).
      expect(reopened.getEntries()).toHaveLength(4);
    });

    it("Codex-pass5-fix: withLock is re-entrant and keeps lockHeld true across nested scopes", async () => {
      // Nested withLock used to either deadlock on the cross-process
      // file lock OR clear lockHeld inside the inner finally even
      // though the outer critical section was still active. Either
      // breaks navigateBranch's truncate-on-failure semantics.
      const manager = SessionManager.create("/test/cwd", tempDir);
      manager.appendMessage({ role: "user", content: "A", timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "B" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });

      let outerHeldBeforeInner = false;
      let innerHeld = false;
      let outerHeldAfterInner = false;

      await manager.withLock(async () => {
        outerHeldBeforeInner = (manager as any).lockHeld;
        await manager.withLock(async () => {
          innerHeld = (manager as any).lockHeld;
        });
        outerHeldAfterInner = (manager as any).lockHeld;
      });

      expect(outerHeldBeforeInner).toBe(true);
      expect(innerHeld).toBe(true);
      // CRITICAL: the outer's lockHeld must STILL be true after the
      // inner exits — without per-instance depth counting, the inner's
      // finally would have cleared it.
      expect(outerHeldAfterInner).toBe(true);
      expect((manager as any).lockHeld).toBe(false);
    });

    it("Codex-pass3-fix: navigateBranch leaves disk untouched on persist failure (in-memory rollback only)", () => {
      // Pass-2 added a truncateSync rollback to erase phantom on-disk
      // entries from a failed persist. Pass-3 found that the truncate
      // is unsafe under concurrent writers: a peer process append
      // between snapshot and truncate would be erased. The accepted
      // trade-off is "best-effort in-memory rollback only" — the
      // on-disk side gets reconciled on reload (or via lock-aware
      // higher-level retry).
      const manager = SessionManager.create("/test/cwd", tempDir);
      manager.appendMessage({ role: "user", content: "A", timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "B" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const c = manager.appendMessage({ role: "user", content: "C", timestamp: Date.now() });
      manager.branch(manager.getEntries()[1].id);
      const d = manager.appendMessage({ role: "user", content: "D", timestamp: Date.now() });
      manager.branch(c);

      const leafBefore = manager.getLeafId();
      const inMemoryEntriesBefore = manager.getEntries().length;

      // Force persistEntry to throw AFTER writing — simulates a
      // partial-write or post-write failure mode.
      const originalPersist = (manager as any).persistEntry.bind(manager);
      let persistCalls = 0;
      (manager as any).persistEntry = (entry: any) => {
        persistCalls++;
        if (persistCalls === 1) {
          originalPersist(entry);
          throw new Error("simulated post-write failure");
        }
        return originalPersist(entry);
      };

      expect(() => manager.navigateBranch(d, "fail me")).toThrow(/simulated/);

      // In-memory rollback must succeed: no phantom entry, leaf back at
      // pre-navigation position. (On-disk side may have residue; that's
      // the documented trade-off.)
      expect(manager.getLeafId()).toBe(leafBefore);
      expect(manager.getEntries().length).toBe(inMemoryEntriesBefore);
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

    it("regression (pass-12): flush() forces deferred entries to disk for stub-only sessions", () => {
      // Without flush(), a one-shot CLI invocation that only appends a
      // user message before exiting silently loses the prompt because
      // persistEntry waits for an assistant message. Callers that need
      // durability without an assistant turn use flush() to force-write.
      const manager = SessionManager.create("/test/cwd", tempDir);
      const sessionFile = manager.getSessionFile()!;

      manager.appendMessage({ role: "user", content: "lone prompt", timestamp: Date.now() });
      expect(existsSync(sessionFile)).toBe(false);

      manager.flush();
      expect(existsSync(sessionFile)).toBe(true);

      const reopened = SessionManager.open(sessionFile);
      const entries = reopened.getEntries();
      const user = entries.find(
        (e): e is MessageEntry => e.type === "message" && e.message.role === "user",
      );
      expect(user).toBeDefined();
      expect(typeof user!.message.content === "string" ? user!.message.content : "").toBe(
        "lone prompt",
      );
    });

    it("regression (pass-12): appendEntry rolls back in-memory state on persist failure", () => {
      // appendEntry mutates fileEntries/byId/leafId BEFORE persistEntry
      // attempts the disk write. Without rollback, an ENOSPC/EIO mid-append
      // would leave this process believing the entry exists, then chain
      // future appends off an ID that never hit disk — silent tree
      // corruption that surfaces as missing prior history on reopen.
      const manager = SessionManager.create("/test/cwd", tempDir);
      const sessionFile = manager.getSessionFile()!;

      // Get the session file written first (deferred-flush window passed)
      manager.appendMessage({ role: "user", content: "u1", timestamp: Date.now() });
      const a1 = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "a1" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
      expect(existsSync(sessionFile)).toBe(true);

      const goodLeaf = manager.getLeafId();
      const goodEntryCount = manager.getEntries().length;

      // Force the next persistEntry to fail by replacing the session
      // file path with a directory of the same name. appendFileSync to
      // a directory throws EISDIR cross-platform.
      rmSync(sessionFile);
      mkdirSync(sessionFile);

      let thrown: unknown = null;
      try {
        manager.appendMessage({ role: "user", content: "doomed", timestamp: Date.now() });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();

      // In-memory state must be rolled back to pre-append values.
      expect(manager.getLeafId()).toBe(goodLeaf);
      expect(manager.getLeafId()).toBe(a1);
      expect(manager.getEntries().length).toBe(goodEntryCount);
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

  describe("Tier-2: extension entries", () => {
    it("appendExtension persists a namespaced payload that round-trips through reload", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);
      const sessionFile = manager.getSessionFile()!;

      // Need an assistant turn first so the file actually flushes.
      manager.appendMessage({ role: "user", content: "u", timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "a" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });

      const id1 = manager.appendExtension("com.example.todo", { items: ["x", "y"] });
      const id2 = manager.appendExtension("com.example.todo", { items: ["x"] }, "snapshot");
      const id3 = manager.appendExtension("net.other-plugin.cache", { hits: 7 });

      const reopened = SessionManager.open(sessionFile);
      const all = reopened.getExtensionEntries();
      expect(all.map((e) => e.id)).toEqual([id1, id2, id3]);
      expect(all[0].payload).toEqual({ items: ["x", "y"] });
      expect(all[1].subtype).toBe("snapshot");
      expect(all[2].namespace).toBe("net.other-plugin.cache");

      const filtered = reopened.getExtensionEntries("com.example.todo");
      expect(filtered.map((e) => e.id)).toEqual([id1, id2]);
    });

    it("preserves unknown extension namespaces verbatim through buildIndex / migrate / reload", () => {
      // Forward-compat: a plugin we don't know about wrote entries we
      // don't understand. We must round-trip them losslessly so a
      // future install of that plugin can recover its state.
      const manager = SessionManager.create("/test/cwd", tempDir);
      const sessionFile = manager.getSessionFile()!;
      manager.appendMessage({ role: "user", content: "u", timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "a" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
      manager.appendExtension("future.unknown.namespace", {
        nested: { weird: ["data", 42, null] },
      });

      const reopened = SessionManager.open(sessionFile);
      const ext = reopened.getExtensionEntries("future.unknown.namespace");
      expect(ext.length).toBe(1);
      expect(ext[0].payload).toEqual({ nested: { weird: ["data", 42, null] } });

      // Append more after reload — extension entries must survive the
      // mid-session append + persist + future reload cycle too.
      reopened.appendMessage({ role: "user", content: "more", timestamp: Date.now() });
      reopened.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const reopened2 = SessionManager.open(sessionFile);
      expect(reopened2.getExtensionEntries("future.unknown.namespace").length).toBe(1);
    });

    it("extension entries are skipped when reconstructing LLM context", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);
      manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
      manager.appendExtension("plugin.x", { state: "should-not-leak-into-llm" });
      manager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });

      const ctx = buildSessionContext(manager.getEntries(), manager.getLeafId());
      expect(ctx.messages.length).toBe(3);
      // Verify no extension payload bled into a message
      for (const m of ctx.messages) {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        expect(text).not.toContain("should-not-leak-into-llm");
      }
    });

    it("appendExtension rejects an empty namespace", () => {
      const manager = SessionManager.inMemory("/test/cwd");
      expect(() => manager.appendExtension("", { x: 1 })).toThrow(/namespace/);
    });

    it("Tier-2 pass-15 regression: SessionManager.flush() first-flush retry does not duplicate", async () => {
      // Pre-pass-15 bug: flush() looped appendFileSync just like the
      // old persistEntry first-flush path, so a failed first flush
      // left a durable prefix on disk and retry re-appended the full
      // snapshot, duplicating user history. CLI bootstrap calls
      // flush() in one-shot and stub REPL paths so this was
      // reachable through the shipped product. Fix matches pass-14:
      // first flush goes through rewriteFile() (single overwrite).
      const fs = await import("node:fs");
      const lockedDir = join(tempDir, "locked-flush");
      mkdirSync(lockedDir, { recursive: true });
      const manager = SessionManager.create("/test/cwd", lockedDir);
      const sessionFile = manager.getSessionFile()!;

      manager.appendMessage({ role: "user", content: "u1", timestamp: Date.now() });
      manager.appendMessage({ role: "user", content: "u2", timestamp: Date.now() });

      fs.chmodSync(lockedDir, 0o500);
      try {
        expect(() => manager.flush()).toThrow();
      } finally {
        fs.chmodSync(lockedDir, 0o700);
      }

      // Retry now succeeds.
      manager.flush();

      // Reload and verify no duplicates.
      const reopened = SessionManager.open(sessionFile);
      const userMsgs = reopened.getEntries().filter((e) => e.type === "message");
      expect(userMsgs.length).toBe(2);

      const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
      const ids = new Set<string>();
      for (const line of lines) {
        const parsed = JSON.parse(line);
        if (parsed.id) {
          expect(ids.has(parsed.id)).toBe(false);
          ids.add(parsed.id);
        }
      }
    });

    it("Tier-2 pass-14 regression: forced first-flush is atomic — failed write + retry doesn't duplicate", async () => {
      // Pre-pass-14 bug: the first-flush path appended each queued
      // entry one-by-one with appendFileSync. If a later append failed
      // (ENOSPC etc.), the earlier prefix stayed on disk, in-memory
      // state was rolled back for the LAST entry only, and a retry
      // re-appended the entire queued snapshot — producing duplicates.
      // Fix: first flush now uses a single overwriting writeFileSync
      // (rewriteFile) so a failed write leaves the file in some bad
      // state that the next retry overwrites cleanly.
      const fs = await import("node:fs");
      // Use a per-test sub-directory we can lock down read-only to
      // force a write failure on the first appendExtension. ESM module
      // exports can't be monkey-patched, so we provoke the failure at
      // the filesystem layer.
      const lockedDir = join(tempDir, "locked");
      mkdirSync(lockedDir, { recursive: true });
      const manager = SessionManager.create("/test/cwd", lockedDir);
      const sessionFile = manager.getSessionFile()!;

      manager.appendMessage({ role: "user", content: "u1", timestamp: Date.now() });
      manager.appendMessage({ role: "user", content: "u2", timestamp: Date.now() });

      // Make the directory read-only — the first writeFileSync to
      // create the session file will fail with EACCES.
      fs.chmodSync(lockedDir, 0o500);
      try {
        expect(() => manager.appendExtension("plugin.x", { v: 1 })).toThrow();
      } finally {
        fs.chmodSync(lockedDir, 0o700);
      }

      // After the failure: in-memory state has the user msgs but the
      // extension entry was rolled back. Disk should NOT have a
      // partial prefix because the first-flush was a single write.
      // (We don't assert that the file doesn't exist — depends on the
      // OS behavior when writeFileSync fails on a locked dir — only
      // that retry doesn't produce duplicates.)

      // Retry succeeds now that the dir is writable.
      const id = manager.appendExtension("plugin.x", { v: 1 });
      expect(id).toBeTruthy();

      // Reload and verify no duplicates.
      const reopened = SessionManager.open(sessionFile);
      const userMsgs = reopened.getEntries().filter((e) => e.type === "message");
      const extEntries = reopened.getExtensionEntries("plugin.x");
      expect(userMsgs.length).toBe(2);
      expect(extEntries.length).toBe(1);

      // Sanity: every JSONL line has a unique id.
      const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
      const ids = new Set<string>();
      for (const line of lines) {
        const parsed = JSON.parse(line);
        if (parsed.id) {
          expect(ids.has(parsed.id)).toBe(false);
          ids.add(parsed.id);
        }
      }
    });

    it("Tier-2 pass-6 regression: extension entries persist before the first assistant turn", () => {
      // Pre-pass-6 bug: appendExtension routed through persistEntry's
      // deferred-flush gate. A plugin that wrote state during startup,
      // auth bootstrap, or any pre-assistant flow would see the entry
      // only in memory, and a process exit before the first assistant
      // turn would silently drop it on the floor. Plugins MUST be able
      // to rely on durability the moment appendExtension returns.
      const manager = SessionManager.create("/test/cwd", tempDir);
      const sessionFile = manager.getSessionFile()!;

      // No assistant turn yet — only a user message and an extension.
      manager.appendMessage({ role: "user", content: "u", timestamp: Date.now() });
      const extId = manager.appendExtension("plugin.startup", {
        bootstrapped: true,
      });

      // Reopen as if the process exited right after appendExtension.
      const reopened = SessionManager.open(sessionFile);
      const ext = reopened.getExtensionEntries("plugin.startup");
      expect(ext.length).toBe(1);
      expect(ext[0].id).toBe(extId);
      expect(ext[0].payload).toEqual({ bootstrapped: true });

      // The user message that preceded it must also survive (the force-
      // flush writes everything queued, not just the extension entry).
      const userMsgs = reopened
        .getEntries()
        .filter((e) => e.type === "message");
      expect(userMsgs.length).toBe(1);
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

  it("regression (pass-11): branch() before withLock survives the locked reload", async () => {
    // branch() only mutates leafId in memory. withLock's reload + buildIndex
    // would reset leafId to the last persisted entry, silently reverting the
    // user's branch selection. The next appendMessage would then attach to
    // the on-disk leaf instead of the user's chosen target, permanently
    // corrupting the session tree.
    const session = SessionManager.create("/test/cwd", tempDir);
    const sessionFile = session.getSessionFile()!;

    const u1 = session.appendMessage({
      role: "user",
      content: "u1",
      timestamp: Date.now(),
    });
    const a1 = session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "a1" }],
      stopReason: "stop",
      timestamp: Date.now(),
    });
    session.appendMessage({ role: "user", content: "u2", timestamp: Date.now() });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "a2" }],
      stopReason: "stop",
      timestamp: Date.now(),
    });

    // User selects an earlier branch tip (a1) — purely in memory.
    session.branch(a1);
    expect(session.getLeafId()).toBe(a1);

    // Now take the lock and append. The reload inside withLock must NOT
    // revert the leaf to the on-disk last entry (a2).
    let appendedId: string | null = null;
    await session.withLock(async () => {
      expect(session.getLeafId()).toBe(a1); // intent preserved across reload
      appendedId = session.appendMessage({
        role: "user",
        content: "branched",
        timestamp: Date.now(),
      });
    });

    // The new entry's parent must be a1 (the user's target), not a2.
    const onDisk = readFileSync(sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as SessionEntry);
    const branched = onDisk.find((e) => e.id === appendedId)!;
    expect(branched.parentId).toBe(a1);
    expect(branched.parentId).not.toBe(u1); // sanity: not random
  });

  it("regression (pass-11): navigateBranch without summary survives the locked reload", async () => {
    // navigateBranch persists nothing when summary is undefined or the
    // abandoned tail is empty. Same corruption surface as branch().
    const session = SessionManager.create("/test/cwd", tempDir);
    const sessionFile = session.getSessionFile()!;

    const u1 = session.appendMessage({
      role: "user",
      content: "u1",
      timestamp: Date.now(),
    });
    const a1 = session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "a1" }],
      stopReason: "stop",
      timestamp: Date.now(),
    });
    session.appendMessage({ role: "user", content: "u2", timestamp: Date.now() });
    const a2 = session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "a2" }],
      stopReason: "stop",
      timestamp: Date.now(),
    });

    // Navigate without summary — purely in memory, nothing written.
    session.navigateBranch(a1);
    expect(session.getLeafId()).toBe(a1);

    let appendedId: string | null = null;
    await session.withLock(async () => {
      expect(session.getLeafId()).toBe(a1);
      appendedId = session.appendMessage({
        role: "user",
        content: "branched",
        timestamp: Date.now(),
      });
    });

    const onDisk = readFileSync(sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as SessionEntry);
    const branched = onDisk.find((e) => e.id === appendedId)!;
    expect(branched.parentId).toBe(a1);
    expect(branched.parentId).not.toBe(a2);
    void u1;
  });

  describe("Tier-4: labels", () => {
    it("attaches a label to an entry and exposes it via getLabel", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);
      const id = manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });

      manager.appendLabelChange(id, "first-question");

      expect(manager.getLabel(id)).toBe("first-question");
    });

    it("trims whitespace and treats empty as a clear", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);
      const id = manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });

      manager.appendLabelChange(id, "  spaced  ");
      expect(manager.getLabel(id)).toBe("spaced");

      manager.appendLabelChange(id, "   ");
      expect(manager.getLabel(id)).toBeUndefined();
    });

    it("undefined label clears an existing label", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);
      const id = manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });

      manager.appendLabelChange(id, "marker");
      expect(manager.getLabel(id)).toBe("marker");

      manager.appendLabelChange(id, undefined);
      expect(manager.getLabel(id)).toBeUndefined();
    });

    it("relabeling overwrites the previous value", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);
      const id = manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });

      manager.appendLabelChange(id, "first");
      manager.appendLabelChange(id, "second");

      expect(manager.getLabel(id)).toBe("second");
    });

    it("rejects labeling a missing entry", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);
      expect(() => manager.appendLabelChange("does-not-exist", "x")).toThrow(/not found/);
    });

    it("findEntryByLabel returns the latest target for a name", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);
      const a = manager.appendMessage({ role: "user", content: "a", timestamp: Date.now() });
      const b = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "b" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });

      manager.appendLabelChange(a, "important");
      expect(manager.findEntryByLabel("important")).toBe(a);

      // Reassigning the label moves it to a new target by clearing + setting.
      manager.appendLabelChange(a, undefined);
      manager.appendLabelChange(b, "important");
      expect(manager.findEntryByLabel("important")).toBe(b);
      expect(manager.getLabel(a)).toBeUndefined();
    });

    it("getLabels returns a snapshot copy", () => {
      const manager = SessionManager.create("/test/cwd", tempDir);
      const id = manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
      manager.appendLabelChange(id, "x");

      const snap = manager.getLabels();
      snap.delete(id);

      expect(manager.getLabel(id)).toBe("x");
    });

    it("persists across reload (last-write-wins replay)", async () => {
      const manager = SessionManager.create("/test/cwd", tempDir);
      // Force a flush to disk by appending something that triggers
      // persistence; appendLabelChange uses force=true so it writes
      // through immediately.
      const id = manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
      manager.appendLabelChange(id, "first");
      manager.appendLabelChange(id, "second");
      manager.appendLabelChange(id, undefined);
      manager.appendLabelChange(id, "final");

      const sessionFile = manager.getSessionFile()!;
      const reopened = SessionManager.open(sessionFile);

      expect(reopened.getLabel(id)).toBe("final");
      // History is preserved on disk: 4 LabelEntry rows.
      const onDisk = readFileSync(sessionFile, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as SessionEntry);
      const labelEntries = onDisk.filter((e) => e.type === "label");
      expect(labelEntries).toHaveLength(4);
    });
  });
});
