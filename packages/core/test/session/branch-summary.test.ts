import { describe, expect, it } from "vitest";
import {
  collectEntriesForBranchSummary,
  type BranchTreeReader,
} from "../../src/session/branch-summary.js";
import type { SessionEntry } from "../../src/session/types.js";

function msg(id: string, parentId: string | null, content: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content, timestamp: Date.now() },
  } as SessionEntry;
}

/**
 * Build a BranchTreeReader from a flat list of entries.
 *
 * getBranch walks parent links upward, returning root-first — exactly the
 * shape collectEntriesForBranchSummary expects.
 */
function makeReader(entries: SessionEntry[]): BranchTreeReader {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    getEntry: (id) => byId.get(id),
    getBranch: (fromId) => {
      const path: SessionEntry[] = [];
      let current = fromId ? byId.get(fromId) : undefined;
      while (current) {
        path.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return path;
    },
  };
}

describe("collectEntriesForBranchSummary", () => {
  it("returns the abandoned tail and the deepest common ancestor", () => {
    // root -> A -> B -> C   (oldLeaf = C)
    //              \-> D    (target  = D)
    // common ancestor = B; abandoned = [C]
    const entries = [
      msg("a", null, "A"),
      msg("b", "a", "B"),
      msg("c", "b", "C"),
      msg("d", "b", "D"),
    ];
    const result = collectEntriesForBranchSummary(makeReader(entries), "c", "d");
    expect(result.commonAncestorId).toBe("b");
    expect(result.entries.map((e) => e.id)).toEqual(["c"]);
  });

  it("Codex-fix: disconnected branches return empty + null ancestor", () => {
    // Two unrelated trees:
    //   tree-1: x -> y       (oldLeaf)
    //   tree-2: a -> b       (target)
    // Without the disconnected-branch guard, the function would return
    // [y, x] as "abandoned" and the navigateBranch flow would write a
    // bogus branch_summary onto the unrelated target. We MUST surface
    // this as nothing-to-summarize.
    const entries = [
      msg("x", null, "x"),
      msg("y", "x", "y"),
      msg("a", null, "a"),
      msg("b", "a", "b"),
    ];
    const result = collectEntriesForBranchSummary(makeReader(entries), "y", "b");
    expect(result.commonAncestorId).toBeNull();
    expect(result.entries).toEqual([]);
  });

  it("returns empty when oldLeaf is null (first navigation)", () => {
    const result = collectEntriesForBranchSummary(makeReader([]), null, "anything");
    expect(result.entries).toEqual([]);
    expect(result.commonAncestorId).toBeNull();
  });

  it("returns empty when oldLeaf equals target", () => {
    const entries = [msg("a", null, "A"), msg("b", "a", "B")];
    const result = collectEntriesForBranchSummary(makeReader(entries), "b", "b");
    expect(result.entries).toEqual([]);
    expect(result.commonAncestorId).toBeNull();
  });

  it("navigating forward along the same line abandons nothing", () => {
    // root -> A -> B -> C ; oldLeaf=A, target=C — A is on C's ancestor
    // chain. Nothing is being abandoned.
    const entries = [
      msg("a", null, "A"),
      msg("b", "a", "B"),
      msg("c", "b", "C"),
    ];
    const result = collectEntriesForBranchSummary(makeReader(entries), "a", "c");
    expect(result.commonAncestorId).toBe("a");
    expect(result.entries).toEqual([]);
  });

  it("returns chronological order (oldest first)", () => {
    // root -> A -> B -> C -> D -> E ; branch off B to T
    // Abandon path C..E should be returned as [C, D, E].
    const entries = [
      msg("a", null, "A"),
      msg("b", "a", "B"),
      msg("c", "b", "C"),
      msg("d", "c", "D"),
      msg("e", "d", "E"),
      msg("t", "b", "T"),
    ];
    const result = collectEntriesForBranchSummary(makeReader(entries), "e", "t");
    expect(result.entries.map((x) => x.id)).toEqual(["c", "d", "e"]);
    expect(result.commonAncestorId).toBe("b");
  });
});
