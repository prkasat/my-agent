import { describe, expect, it } from "vitest";
import { Readable, Writable } from "node:stream";
import { runRepl } from "../src/repl/repl.js";
import type { SlashSessionManager } from "../src/repl/slash-commands.js";

function makeSession(
  overrides: Partial<SlashSessionManager> = {},
): SlashSessionManager {
  return {
    getSessionId: () => "session-id",
    getCwd: () => "/test/cwd",
    forkSession: () => "/sessions/forked.jsonl",
    getSessionFile: () => "/sessions/current.jsonl",
    listSessionsForCwd: async () => [],
    ...overrides,
  };
}

function captureStreams(input: string[]): {
  input: Readable;
  output: Writable;
  read: () => string;
} {
  const lines = input.map((l) => `${l}\n`).join("");
  const inStream = Readable.from(lines);
  const chunks: Buffer[] = [];
  const outStream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return {
    input: inStream,
    output: outStream,
    read: () => Buffer.concat(chunks).toString("utf8"),
  };
}

describe("runRepl", () => {
  it("dispatches slash commands without invoking runPrompt", async () => {
    const promptCalls: string[] = [];
    const { input, output, read } = captureStreams(["/help", "/quit"]);

    let session = makeSession();
    await runRepl({
      getSession: () => session,
      switchSession: async () => {},
      runPrompt: async (p) => {
        promptCalls.push(p);
      },
      input,
      output,
    });

    expect(promptCalls).toHaveLength(0);
    expect(read()).toMatch(/\/branch/);
    expect(read()).toMatch(/bye\./);
  });

  it("forwards non-slash input to runPrompt", async () => {
    const promptCalls: string[] = [];
    const { input, output } = captureStreams([
      "tell me about quicksort",
      "/quit",
    ]);

    let session = makeSession();
    await runRepl({
      getSession: () => session,
      switchSession: async () => {},
      runPrompt: async (p) => {
        promptCalls.push(p);
      },
      input,
      output,
    });

    expect(promptCalls).toEqual(["tell me about quicksort"]);
  });

  it("calls switchSession after /branch and the next /sessions sees the new manager", async () => {
    const switchCalls: string[] = [];
    const { input, output, read } = captureStreams([
      "/branch",
      "/sessions",
      "/quit",
    ]);

    // Two distinct fake managers — the REPL must read the active one
    // through getSession() each iteration, NOT cache it at startup.
    const before = makeSession({
      forkSession: () => "/sessions/new.jsonl",
      listSessionsForCwd: async () => [],
    });
    const after = makeSession({
      getSessionId: () => "after",
      getSessionFile: () => "/sessions/new.jsonl",
      listSessionsForCwd: async () => [
        {
          path: "/sessions/new.jsonl",
          id: "after",
          cwd: "/test/cwd",
          created: new Date(),
          modified: new Date(),
          messageCount: 0,
          firstMessage: "",
        },
      ],
    });
    let session: SlashSessionManager = before;

    await runRepl({
      getSession: () => session,
      switchSession: async (path) => {
        switchCalls.push(path);
        session = after;
      },
      runPrompt: async () => {},
      input,
      output,
    });

    expect(switchCalls).toEqual(["/sessions/new.jsonl"]);
    // /sessions output must show the AFTER session (if it didn't, the
    // REPL would be capturing the manager reference at startup).
    expect(read()).toMatch(/after \(0 msgs\) <- current/);
  });

  it("surfaces exceptions from runPrompt without exiting", async () => {
    const { input, output, read } = captureStreams(["boom", "/quit"]);
    let session = makeSession();
    await runRepl({
      getSession: () => session,
      switchSession: async () => {},
      runPrompt: async () => {
        throw new Error("provider down");
      },
      input,
      output,
    });
    expect(read()).toMatch(/error: provider down/);
    expect(read()).toMatch(/bye\./);
  });
});
