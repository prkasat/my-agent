import { describe, it, expect } from "vitest";
import {
  createAllToolDefinitions,
  createAllTools,
  createCodingToolDefinitions,
  createReadOnlyToolDefinitions,
  getToolVersions,
} from "../../src/tools/registry.js";
import {
  createToolDefinitionFromAgentTool,
  wrapToolDefinition,
} from "../../src/tools/tool-definition.js";
import type { AgentTool } from "../../src/agent/types.js";
import { Type } from "@sinclair/typebox";

describe("schema-versioned tool registry", () => {
  it("every shipped tool definition declares a numeric version", () => {
    const defs = createAllToolDefinitions("/tmp/test");
    for (const [name, def] of Object.entries(defs)) {
      expect(typeof def.version, `${name}.version`).toBe("number");
      expect(def.version, `${name}.version`).toBeGreaterThanOrEqual(1);
    }
  });

  it("wrapToolDefinition propagates the version into AgentTool", () => {
    const defs = createAllToolDefinitions("/tmp/test");
    for (const def of Object.values(defs)) {
      const tool = wrapToolDefinition(def);
      expect(tool.version, `${def.name}`).toBe(def.version);
    }
  });

  it("createToolDefinitionFromAgentTool defaults version to 1 when undefined", () => {
    const tool: AgentTool = {
      name: "no-version-tool",
      description: "x",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const def = createToolDefinitionFromAgentTool(tool);
    expect(def.version).toBe(1);
  });

  it("createToolDefinitionFromAgentTool preserves an explicit version", () => {
    const tool: AgentTool = {
      name: "v3-tool",
      description: "x",
      parameters: Type.Object({}),
      version: 3,
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const def = createToolDefinitionFromAgentTool(tool);
    expect(def.version).toBe(3);
  });

  it("getToolVersions returns the same versions as createAllToolDefinitions", () => {
    const defs = createAllToolDefinitions("/tmp/test");
    const versions = getToolVersions();
    for (const [name, def] of Object.entries(defs)) {
      expect(versions[name as keyof typeof versions]).toBe(def.version);
    }
  });

  it("getToolVersions covers every tool in createAllToolDefinitions", () => {
    const defs = createAllToolDefinitions("/tmp/test");
    const versions = getToolVersions();
    expect(Object.keys(versions).sort()).toEqual(Object.keys(defs).sort());
  });

  it("createCodingToolDefinitions and createReadOnlyToolDefinitions also carry versions", () => {
    for (const def of createCodingToolDefinitions("/tmp/test")) {
      expect(typeof def.version, `${def.name}.version`).toBe("number");
    }
    for (const def of createReadOnlyToolDefinitions("/tmp/test")) {
      expect(typeof def.version, `${def.name}.version`).toBe("number");
    }
  });

  it("createAllTools yields AgentTools whose versions match the definition versions", () => {
    const defs = createAllToolDefinitions("/tmp/test");
    const tools = createAllTools("/tmp/test");
    for (const [name, def] of Object.entries(defs)) {
      const tool = tools[name as keyof typeof tools];
      expect(tool.version, `${name}`).toBe(def.version);
    }
  });

  it("wrapToolDefinition normalizes a missing version to 1 (public API non-breaking)", () => {
    // External consumers built ToolDefinitions before `version` existed.
    // The type now allows omission and the wrapper fills in 1, so an
    // unmodified downstream definition still produces a valid AgentTool.
    // Codex tool-registry pass-1 finding (medium).
    const def = {
      name: "external-tool",
      label: "External",
      description: "x",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const tool = wrapToolDefinition(def as Parameters<typeof wrapToolDefinition>[0]);
    expect(tool.version).toBe(1);
  });
});
