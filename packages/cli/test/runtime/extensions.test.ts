import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventStream, registerProvider, type AssistantMessage, type AssistantMessageEvent } from "@my-agent/ai";
import { SessionManager } from "@my-agent/core";
import { runAgent } from "../../src/runtime/agent-runtime.js";
import { AuthStorage } from "../../src/config/auth-storage.js";
import { getDefaultSettings } from "../../src/config/settings.js";

function createFauxLLM(responses: AssistantMessage[]) {
  let callIndex = 0;

  return function fauxStream() {
    const response = responses[callIndex++];
    if (!response) throw new Error("no more responses");

    const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
      (event) => event.type === "done",
      (event) => {
        if (event.type === "done") return event.message;
        throw new Error("unexpected");
      },
    );

    queueMicrotask(() => {
      stream.push({ type: "start", message: { role: "assistant", content: [] } });
      for (const block of response.content) {
        if (block.type === "text") {
          stream.push({ type: "text_delta", text: block.text });
        } else if (block.type === "tool_call") {
          stream.push({ type: "tool_call_start", id: block.id, name: block.name });
          stream.push({ type: "tool_call_delta", id: block.id, arguments: block.arguments });
          stream.push({ type: "tool_call_end", id: block.id });
        }
      }
      stream.push({ type: "done", message: response });
    });

    return stream;
  };
}

describe("extension runtime", () => {
  let tmpDir: string;
  let originalOpenRouterKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "extension-runtime-test-"));
    originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  });

  afterEach(async () => {
    if (originalOpenRouterKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads local extensions and executes extension tools", async () => {
    const extensionPath = path.join(tmpDir, "echo-extension.mjs");
    await fs.writeFile(
      extensionPath,
      `import { Type } from "@sinclair/typebox";
       export default {
         metadata: { id: "echo-ext", name: "Echo", version: "1.0.0" },
         activate(ctx) {
           ctx.registerTool({
             name: "echo_ext",
             description: "Echo a value",
             parameters: Type.Object({ value: Type.String() }),
             async execute(_id, params) {
               return { content: [{ type: "text", text: params.value }] };
             },
           });
           ctx.on("tool_execution_start", (event) => {
             if (event.toolName === "echo_ext") {
               return { action: "allow", modifiedArgs: { value: "modified by extension" } };
             }
           });
         },
       };
      `,
      "utf-8",
    );

    registerProvider(
      "openrouter",
      async () =>
        createFauxLLM([
          {
            role: "assistant",
            content: [
              {
                type: "tool_call",
                id: "tc1",
                name: "echo_ext",
                arguments: JSON.stringify({ value: "from llm" }),
              },
            ],
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            timestamp: Date.now(),
          },
        ]),
    );

    const authStorage = new AuthStorage(path.join(tmpDir, "auth.json"));
    const settings = getDefaultSettings();
    settings.extensions = [extensionPath];
    settings.permissionMode = "auto";

    const session = SessionManager.continueRecent(tmpDir);
    const result = await runAgent(
      "run the extension",
      { cwd: tmpDir, settings, authStorage, session },
      {},
    );

    const toolResult = result.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toBeDefined();
    expect(
      toolResult && "content" in toolResult ? toolResult.content[0] : undefined,
    ).toEqual({
      type: "text",
      text: "modified by extension",
    });
  });
});
