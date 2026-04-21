# my-agent: Complete Architecture & Code Walkthrough

This guide is a deep-dive into the my-agent codebase, designed to help you understand, customize, and extend the system.

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Package Structure](#2-package-structure)
3. [Core Data Flow](#3-core-data-flow)
4. [The Agent Loop](#4-the-agent-loop)
5. [Session Management](#5-session-management)
6. [Tools System](#6-tools-system)
7. [Permissions](#7-permissions)
8. [Extensions](#8-extensions)
9. [Context Compaction](#9-context-compaction)
10. [Providers & Models](#10-providers--models)
11. [CLI & Modes](#11-cli--modes)
12. [Key Design Patterns](#12-key-design-patterns)
13. [Capabilities & Limitations](#13-capabilities--limitations)
14. [Customization Guide](#14-customization-guide)

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INTERFACES                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │
│  │   REPL   │  │   TUI    │  │ One-shot │  │   RPC    │                     │
│  │ (main.ts)│  │ (app.ts) │  │ (main.ts)│  │ (rpc.ts) │                     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘                     │
└───────┼─────────────┼─────────────┼─────────────┼───────────────────────────┘
        │             │             │             │
        └─────────────┴──────┬──────┴─────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────────────┐
│                         RUNTIME LAYER (packages/cli)                         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                      runAgent() (agent-runtime.ts)                      │ │
│  │  • Model resolution  • Extensions loading  • Permission checking        │ │
│  │  • Session wiring    • Cost tracking       • Event streaming            │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                     │                                        │
│  ┌──────────────┐  ┌──────────────┐ │ ┌──────────────┐  ┌────────────────┐  │
│  │  Settings    │  │ Auth Storage │ │ │    Trace     │  │ Model Registry │  │
│  └──────────────┘  └──────────────┘ │ └──────────────┘  └────────────────┘  │
└─────────────────────────────────────┼───────────────────────────────────────┘
                                      │
┌─────────────────────────────────────▼───────────────────────────────────────┐
│                         CORE LAYER (packages/core)                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                        agentLoop() (agent-loop.ts)                       ││
│  │   Outer loop: follow-up messages                                        ││
│  │   Inner loop: LLM call → tool execution → steering                      ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│           │                    │                    │                        │
│  ┌────────▼────────┐  ┌────────▼────────┐  ┌───────▼─────────┐              │
│  │ Session Manager │  │  Tools System   │  │   Extensions    │              │
│  │  • JSONL logs   │  │  • read/write   │  │   • Events      │              │
│  │  • Branching    │  │  • edit/bash    │  │   • Commands    │              │
│  │  • Compaction   │  │  • grep/find    │  │   • Middleware  │              │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
┌─────────────────────────────────────▼───────────────────────────────────────┐
│                          AI LAYER (packages/ai)                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │
│  │    Anthropic    │  │  OpenAI Codex   │  │   OpenRouter    │              │
│  │    Provider     │  │    Provider     │  │   (compatible)  │              │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘              │
│                             │                                                │
│  ┌──────────────────────────▼───────────────────────────────────────────┐   │
│  │                     EventStream (event-stream.ts)                     │   │
│  │  Async iterator + promise resolution for streaming LLM responses      │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Layered architecture**: Each package has clear boundaries and responsibilities
2. **Event-driven**: LLM responses and tool executions emit events consumed by callers
3. **Session-first**: All state persists via append-only JSONL logs
4. **Private-first**: Auth credentials stored locally, never sent to third parties
5. **Extensible**: Hooks for tools, commands, middleware, and event handlers

---

## 2. Package Structure

```
packages/
├── ai/                    # Provider abstraction layer
│   └── src/
│       ├── models.ts      # Model definitions (context windows, costs)
│       ├── types.ts       # Core types: Message, Model, Usage
│       └── providers/
│           ├── anthropic.ts        # Native Anthropic API (thinking, caching)
│           ├── openai-codex.ts     # OpenAI Codex subscription
│           ├── openai-compatible.ts # Generic OpenAI-compatible
│           ├── oauth.ts            # OAuth token management
│           └── registry.ts         # Provider registration
│
├── core/                  # Agent semantics (no product concerns)
│   └── src/
│       ├── agent/
│       │   ├── agent-loop.ts    # THE HEART: LLM ↔ tool execution
│       │   ├── cost-tracker.ts  # Token/dollar accounting
│       │   ├── permissions.ts   # Permission checker
│       │   └── system-prompt.ts # Prompt construction
│       ├── session/
│       │   ├── session-manager.ts # JSONL persistence
│       │   ├── compaction.ts      # Context summarization
│       │   └── auto-compact.ts    # Automatic compaction
│       ├── tools/
│       │   ├── registry.ts   # Tool factory
│       │   ├── read.ts       # File reading
│       │   ├── write.ts      # File writing
│       │   ├── edit.ts       # Find-replace editing
│       │   ├── bash.ts       # Shell execution
│       │   ├── grep.ts       # Content search
│       │   ├── find.ts       # File search
│       │   └── ls.ts         # Directory listing
│       └── extensions/
│           ├── runner.ts     # Extension lifecycle
│           ├── loader.ts     # Discovery & import
│           └── types.ts      # Extension API types
│
└── cli/                   # Product orchestration
    └── src/
        ├── main.ts             # Entry point
        ├── config/
        │   ├── settings.ts     # Settings loading/saving
        │   └── auth-storage.ts # Credential management
        ├── runtime/
        │   ├── agent-runtime.ts # runAgent() - wires everything
        │   ├── model-registry.ts # Model resolution
        │   ├── extensions.ts    # Extension loading
        │   └── trace.ts         # Structured logging
        ├── repl/
        │   ├── repl.ts          # Interactive mode
        │   └── slash-commands.ts # /branch, /sessions, etc.
        ├── modes/
        │   └── rpc.ts           # JSONL RPC server
        └── tui/
            └── app.ts           # Full-screen TUI
```

### Single Sources of Truth

| Concern | File |
|---------|------|
| Model definitions | `packages/ai/src/models.ts` |
| Auth-aware model visibility | `packages/cli/src/runtime/model-registry.ts` |
| Persisted credentials | `packages/cli/src/config/auth-storage.ts` |
| Merged settings | `packages/cli/src/config/settings.ts` |
| Session format | `packages/core/src/session/types.ts` |
| Extension contract | `packages/core/src/extensions/types.ts` |

---

## 3. Core Data Flow

```
User Input                                              Final Response
    │                                                        ▲
    ▼                                                        │
┌───────────────────────────────────────────────────────────────────────────┐
│                           runAgent() orchestration                         │
│                                                                            │
│  1. resolveConfiguredModel(settings, authStorage)                          │
│  2. discoverProjectContext(cwd, globalDir)  ──▶  CLAUDE.md, SYSTEM.md     │
│  3. loadExtensionsForRun(...)                                              │
│  4. extensionRuntime.dispatchUserInput(prompt)  ──▶  transforms prompt    │
│  5. createAllTools(cwd) + extension tools                                  │
│  6. buildSystemPrompt({...})                                               │
│  7. session.buildSessionContext()  ──▶  messages from JSONL               │
│  8. session.appendMessage(userMessage)                                     │
│  9. agentLoop([userMessage], context, config)  ──▶  EventStream           │
│ 10. for await (event of eventStream) { ... }                               │
│ 11. session.appendMessage(assistantMessage/toolResult)                     │
│ 12. session.flush()                                                        │
└───────────────────────────────────────────────────────────────────────────┘
```

### Key Types

```typescript
// The context passed to the agent loop
interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  model: Model;
}

// Events emitted during agent execution
type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start"; turnIndex: number }
  | { type: "message_start"; message: AssistantMessage }
  | { type: "message_update"; event: TextDelta | ToolCallDelta | ... }
  | { type: "message_end"; message: AssistantMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; result: AgentToolResult; isError: boolean }
  | { type: "turn_end"; turnIndex: number; usage?: Usage }
  | { type: "agent_end"; reason: "complete" | "aborted" | "error" | "max_turns" };
```

---

## 4. The Agent Loop

**File**: `packages/core/src/agent/agent-loop.ts`

This is the heart of the system. Understanding this file is key to understanding everything.

### Structure

```
agentLoop(prompts, context, config)
    │
    ▼
runLoop(context, config, stream, signal)
    │
    ├── OUTER LOOP: follow-up messages ─────────────────────────┐
    │       │                                                    │
    │       ├── INNER LOOP: LLM + tools + steering ────────┐    │
    │       │       │                                       │    │
    │       │       ├── getSteeringMessages()              │    │
    │       │       ├── streamAssistantResponse()          │    │
    │       │       │       │                               │    │
    │       │       │       ├── transformContext() (compaction) │
    │       │       │       ├── convertToLlm()              │    │
    │       │       │       └── streamFn() → LLM API        │    │
    │       │       │                                       │    │
    │       │       ├── recordTurn() (cost tracking)        │    │
    │       │       ├── executeTools() if tool_calls        │    │
    │       │       │       │                               │    │
    │       │       │       └── executeSingleTool()         │    │
    │       │       │               │                       │    │
    │       │       │               ├── beforeToolCall hook │    │
    │       │       │               ├── tool.execute()      │    │
    │       │       │               └── afterToolCall hook  │    │
    │       │       │                                       │    │
    │       │       └── break if no tool_calls + no steering│    │
    │       │                                               │    │
    │       └── getFollowUpMessages() ──────────────────────┘    │
    │                                                            │
    └── emit agent_end ──────────────────────────────────────────┘
```

### Key Logic Points

**1. Cost Budget Enforcement** (lines 176-183, 263-291)
```typescript
// Pre-turn check: fail fast if already over budget
if (config.costTracker?.isBudgetExceeded?.()) {
  stream.push({ type: "agent_end", reason: "error", error: "Cost budget exceeded" });
  return;
}

// Post-turn check: even if tool_calls are requested, don't execute if over budget
if (config.costTracker.isBudgetExceeded()) {
  context.messages.push(...padCancelledToolResults(toolCalls, []));
  return;
}
```

**2. Retry with Exponential Backoff** (lines 203-218)
```typescript
for (let attempt = 0; attempt <= maxRetries; attempt++) {
  assistantMessage = await streamAssistantResponse(...);
  if (assistantMessage) break;
  const delayMs = 1000 * (attempt + 1);
  await abortableSleep(delayMs, signal);
}
```

**3. Structural Completeness** (lines 299-311, 688-700)
```typescript
// Every tool_call must have a matching toolResult
// If abort happens mid-batch, pad with synthetic cancelled results
const completeResults = toolResults.length < toolCalls.length 
  ? padCancelledToolResults(toolCalls, toolResults) 
  : toolResults;
```

**4. Tool Execution Modes** (lines 293-297)
```typescript
const toolResults = config.toolExecution === "parallel"
  ? await executeToolsParallel(toolCalls, context, config, stream, signal)
  : await executeToolsSequential(toolCalls, context, config, stream, signal);
```

---

## 5. Session Management

**File**: `packages/core/src/session/session-manager.ts`

Sessions use **event sourcing**: an append-only JSONL log where each entry has an `id` and `parentId` forming a tree.

### Session File Format

```jsonl
{"type":"session","version":2,"id":"019329a4b2c3-d4e5f6","cwd":"/Users/pk/project","timestamp":"2026-04-19T..."}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"...","message":{"role":"user","content":"Hello"}}
{"type":"message","id":"e5f6g7h8","parentId":"a1b2c3d4","timestamp":"...","message":{"role":"assistant","content":[...]}}
{"type":"settings_change","id":"i9j0k1l2","parentId":"e5f6g7h8","timestamp":"...","model":{...}}
{"type":"compaction","id":"m3n4o5p6","parentId":"i9j0k1l2","timestamp":"...","summary":"...","firstKeptEntryId":"..."}
{"type":"label","id":"q7r8s9t0","parentId":"m3n4o5p6","timestamp":"...","targetId":"e5f6g7h8","label":"important"}
```

### Entry Types

| Type | Purpose |
|------|---------|
| `session` | Header with version, cwd, fork info |
| `message` | User, assistant, or toolResult message |
| `settings_change` | Model or thinking level change |
| `compaction` | Summary of compacted history |
| `branch_summary` | Summary when navigating branches |
| `session_info` | Session name/metadata |
| `label` | User-defined bookmark |
| `extension` | Plugin-persisted state |

### Key Operations

```typescript
// Create or continue session
const session = SessionManager.continueRecent(cwd);

// Build context (walks tree from leaf to root)
const context = session.buildSessionContext();
// Returns: { messages: AgentMessage[], thinkingLevel: string, model: Model | null }

// Append entries
session.appendMessage(userMessage);
session.appendMessage(assistantMessage);

// Branching (point leaf at different entry)
session.branch(targetEntryId);

// Navigate with summary
session.navigateBranch(targetId, summaryText, details);

// Label entries
session.appendLabelChange(entryId, "checkpoint-1");
const entryId = session.findEntryByLabel("checkpoint-1");

// Flush to disk (called on every turn end)
session.flush();

// Fork to new file
const newPath = session.forkSession(leafId);
```

### Tree Structure

```
                                    ┌──────────────────────┐
                                    │   Session Header     │
                                    │   (parentId: null)   │
                                    └──────────┬───────────┘
                                               │
                                    ┌──────────▼───────────┐
                                    │  User Message 1      │
                                    │  id: "abc123"        │
                                    └──────────┬───────────┘
                                               │
                          ┌────────────────────┼────────────────────┐
                          │                    │                    │
               ┌──────────▼──────────┐  ┌──────▼──────────┐  ┌──────▼──────────┐
               │  Assistant (branch1) │  │  Assistant (main)│  │ Assistant (exp) │
               │  parentId: "abc123"  │  │  parentId: "abc123"│  │ parentId: "abc123"│
               └──────────┬──────────┘  └──────┬──────────┘  └─────────────────┘
                          │                    │
                     (continues)          (current leaf)
```

---

## 6. Tools System

**File**: `packages/core/src/tools/registry.ts`

### Built-in Tools

| Tool | Purpose | Key Features |
|------|---------|--------------|
| `read` | Read files | Line ranges, image/PDF support, limit param |
| `write` | Write files | Requires prior read, atomic overwrite |
| `edit` | Find-replace | Must match unique string, preserves indentation |
| `bash` | Shell commands | Sandboxed, timeout, output truncation |
| `grep` | Content search | Regex, glob filters, context lines |
| `find` | File search | Glob patterns, type filters |
| `ls` | Directory listing | Recursive, shows tree structure |

### Tool Definition Structure

```typescript
interface ToolDefinition<TParams, TResult> {
  name: string;
  description: string;
  version: number;
  parameters: TSchema;  // TypeBox schema
  prepareArguments?: (args: unknown) => TParams;
  execute: (
    toolCallId: string,
    args: TParams,
    signal: AbortSignal,
    onUpdate: (update: string) => void
  ) => Promise<AgentToolResult>;
}

interface AgentToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; ... }>;
  details?: unknown;  // Not sent to LLM, available to UI/debugging
  isError?: boolean;
}
```

### Creating Custom Tools

```typescript
import { Type } from "@sinclair/typebox";
import { wrapToolDefinition } from "@my-agent/core";

const myTool = wrapToolDefinition({
  name: "my_custom_tool",
  description: "Does something useful",
  version: 1,
  parameters: Type.Object({
    input: Type.String({ description: "The input to process" }),
    verbose: Type.Optional(Type.Boolean()),
  }),
  execute: async (toolCallId, args, signal, onUpdate) => {
    onUpdate("Processing...");
    const result = await doSomething(args.input);
    return {
      content: [{ type: "text", text: result }],
    };
  },
});
```

---

## 7. Permissions

**File**: `packages/core/src/agent/permissions.ts`

### Permission Modes

| Mode | Behavior |
|------|----------|
| `auto` | Read tools allowed, known writes blocked |
| `ask` | Read allowed, writes prompt user |
| `deny` | Only explicitly whitelisted reads allowed |

### Always Blocked (regardless of mode)

**Destructive Commands**:
- `rm -rf`, `sudo rm`, `git reset --hard`, `git push --force`
- `DROP TABLE`, `TRUNCATE`, `DELETE FROM`
- `kill -9`, `killall`, `pkill`
- `mkfs`, `dd if=`, `chmod 777`

**Protected Paths**:
- `/etc`, `/usr`, `/sys`, `/boot`
- `.ssh`, `.aws`, `.gnupg`
- `.env`, `.npmrc`, `.netrc`
- `id_rsa`, `id_ed25519`, `*.pem`, `*.key`

### Permission Flow

```
Tool Call Received
       │
       ▼
┌──────────────────────────────┐
│ Is bash + destructive cmd?   │───▶ YES ───▶ BLOCK
└──────────────┬───────────────┘
               │ NO
               ▼
┌──────────────────────────────┐
│ Does path match protected?   │───▶ YES ───▶ BLOCK
└──────────────┬───────────────┘
               │ NO
               ▼
┌──────────────────────────────┐
│ Mode = deny?                 │───▶ YES + is write ───▶ BLOCK
└──────────────┬───────────────┘
               │ NO
               ▼
┌──────────────────────────────┐
│ Mode = ask + is write?       │───▶ YES ───▶ PROMPT USER
└──────────────┬───────────────┘
               │ NO
               ▼
             ALLOW
```

---

## 8. Extensions

**File**: `packages/core/src/extensions/runner.ts`

Extensions are trusted local modules that can:
- Register tools and commands
- Handle lifecycle events
- Intercept tool execution (middleware)
- Transform user input
- Access persistent storage

### Extension Definition

```typescript
interface ExtensionDefinition {
  metadata: {
    id: string;
    name: string;
    version: string;
    apiVersion: "1.0";
    handlerTimeoutMs?: number;
    failureMode?: "continue" | "abort" | "disable";
  };
  config?: {
    schema: TSchema;
    defaults?: Record<string, unknown>;
  };
  activate: (ctx: ExtensionContext) => void | Promise<void>;
  deactivate?: (ctx: ExtensionContext) => void | Promise<void>;
  onBeforeReload?: (ctx: ExtensionContext) => unknown;
  onAfterReload?: (state: unknown, ctx: ExtensionContext) => void;
}
```

### ExtensionContext API

```typescript
interface ExtensionContext {
  id: string;
  config: unknown;
  
  // Event handlers
  on<T extends ExtensionEventType>(event: T, handler: Handler): () => void;
  onAny(handler: (event, ctx) => void): () => void;
  
  // Registration
  registerCommand(cmd: ExtensionCommand): () => void;
  registerTool(tool: AgentTool): () => void;
  use(middleware: ToolMiddleware): () => void;
  
  // Services
  storage: ExtensionStorage;
  ui: ExtensionUI;
  actions: ExtensionActions;
  
  // State
  getAgentContext(): AgentContext | null;
  signal: AbortSignal;
  log: { debug, info, warn, error };
  metrics: ExtensionMetrics;
}
```

### Event Types

```typescript
type ExtensionEventType =
  | "session_start"
  | "session_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"  // Can block or modify args
  | "tool_execution_end"    // Can modify result
  | "user_input"            // Can transform input
  | "extension_loaded"
  | "extension_unloaded"
  | "command_executed";
```

### Tool Interception

```typescript
// In activate():
ctx.on("tool_execution_start", (event, ctx) => {
  if (event.toolName === "bash" && shouldBlock(event.args)) {
    return { action: "block", reason: "Not allowed" };
  }
  if (shouldModify(event.args)) {
    return { action: "allow", modifiedArgs: modifyArgs(event.args) };
  }
  return { action: "allow" };
});

ctx.on("tool_execution_end", (event, ctx) => {
  if (event.toolName === "read") {
    return {
      content: [...event.result.content, { type: "text", text: "// Modified" }],
    };
  }
});
```

---

## 9. Context Compaction

**File**: `packages/core/src/session/compaction.ts`

When context exceeds the model's window, old messages are summarized.

### When Compaction Triggers

```typescript
function shouldCompact(messages, contextWindow, reserveTokens): boolean {
  const currentTokens = measureContextTokens(messages).tokens;
  const limit = contextWindow - effectiveReserveTokens(contextWindow, reserveTokens);
  return currentTokens > limit;
}
```

### Compaction Process

```
Full Context
┌────────────────────────────────────────────────────────────┐
│ User 1 → Assistant 1 → Tool 1 → User 2 → Assistant 2 → ...│
└────────────────────────────────────────────────────────────┘
                    │
                    ▼ findCutPoint(keepRecentTokens)
                    
┌─────────────────────────┐   ┌──────────────────────────────┐
│   Messages to Summarize │   │    Messages to Keep          │
│   (sent to LLM)         │   │    (preserved verbatim)      │
└───────────┬─────────────┘   └──────────────────────────────┘
            │
            ▼ generateCompactionSummary()
            
┌─────────────────────────┐   ┌──────────────────────────────┐
│   ## Goal               │   │    Recent messages           │
│   ## Progress           │   │    (unchanged)               │
│   ## Next Steps         │   │                              │
└─────────────────────────┘   └──────────────────────────────┘
            │
            ▼ Persisted to session
            
compaction entry: { summary, firstKeptEntryId, tokensBefore, details }
```

### Split-Turn Compaction

When a single turn is too large:

```
Turn prefix (summarized)  │  Turn suffix (kept)
─────────────────────────┼─────────────────────
Large tool output...     │  Recent work...
Early progress...        │  Current state...
```

### Summary Format

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Any constraints mentioned]

## Progress
### Done
- [x] Completed tasks

### In Progress
- [ ] Current work

## Key Decisions
- [Important decisions and reasoning]

## Next Steps
- [What needs to happen next]

<read-files>
/path/to/file1.ts
/path/to/file2.ts
</read-files>

<modified-files>
/path/to/modified.ts
</modified-files>
```

---

## 10. Providers & Models

**File**: `packages/ai/src/models.ts`

### Model Definition

```typescript
interface Model {
  id: string;            // API model ID
  name: string;          // Display name
  provider: string;      // "anthropic" | "openrouter" | "openai-codex"
  contextWindow: number; // Max tokens
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsThinking: boolean;
  cost: { inputPerMillion: number; outputPerMillion: number };
}
```

### Current Models

| Key | Provider | Context | Thinking | Cost |
|-----|----------|---------|----------|------|
| `claude-sonnet-4` | anthropic | 200K | Yes | $3/$15 |
| `claude-opus-4` | anthropic | 200K | Yes | $15/$75 |
| `claude-haiku-3.5` | anthropic | 200K | No | $0.8/$4 |
| `gpt-5.1-codex` | openai-codex | 200K | Yes | $0 (subscription) |
| `qwen3.6-plus` | openrouter | 1M | Yes | $0 (free tier) |
| `openrouter-auto` | openrouter | 200K | Yes | $0 (free tier) |

### Provider Resolution Flow

```
settings.model ("claude-sonnet-4")
        │
        ▼
┌───────────────────────────────────────────┐
│ resolveConfiguredModel(settings, auth)    │
│                                           │
│ 1. Get model from registry                │
│ 2. Check provider auth:                   │
│    - API key in environment?              │
│    - OAuth token in auth storage?         │
│ 3. If unavailable, try fallbacks          │
│ 4. Return resolved model + API key getter │
└───────────────────────────────────────────┘
        │
        ▼
{ key: "claude-sonnet-4", model: Model, availableModels: [...] }
```

### Anthropic Provider Features

- **Thinking blocks**: With signatures for replay
- **Prompt caching**: `cache_control: { type: "ephemeral" }` on system/tools/last-user
- **Native tool use**: `tool_use` / `tool_result` content blocks
- **Redacted thinking**: Encrypted reasoning preserved for continuity

---

## 11. CLI & Modes

**File**: `packages/cli/src/main.ts`

### Entry Points

| Mode | Command | Description |
|------|---------|-------------|
| REPL | `my-agent` | Interactive with slash commands |
| One-shot | `my-agent "prompt"` | Execute and exit |
| TUI | `my-agent --tui` | Full-screen interface |
| RPC | `my-agent --rpc` | JSONL server for integrations |
| Replay | `my-agent --replay file` | Replay session or trace |
| Doctor | `my-agent --doctor` | Diagnostics |

### Slash Commands (REPL)

```
/help           Show all commands
/branch [name]  Fork session
/sessions       List sessions
/tree           Show session tree
/tree switch    Change active branch
/login          OAuth login
/logout         OAuth logout
/extensions     Show extensions
/packages       Show packages
/skills         List skills
/export         Export to HTML
/settings       Show settings
/model          Show current model
/templates      List prompt templates
/quit           Exit
```

### RPC Protocol

```jsonl
// Request
{"type":"prompt","id":"1","prompt":"Hello","sessionId":"..."}

// Events
{"type":"prompt.started","id":"1"}
{"type":"prompt.text","id":"1","text":"Hi there!"}
{"type":"tool.start","id":"1","toolName":"read","toolCallId":"..."}
{"type":"tool.end","id":"1","toolCallId":"...","isError":false}
{"type":"prompt.completed","id":"1"}

// Control
{"type":"abort","id":"1"}
{"type":"getState"}
{"type":"listModels"}
```

---

## 12. Key Design Patterns

### 1. Event Sourcing (Sessions)

All state changes are appended, never mutated. Enables:
- Branching without data loss
- Crash recovery (skip malformed lines)
- Full audit trail
- Easy replay

### 2. EventStream (LLM Responses)

```typescript
class EventStream<TEvent, TResult> {
  // Implements AsyncIterable
  async *[Symbol.asyncIterator](): AsyncIterator<TEvent>;
  
  // Blocks until terminal event
  result(): Promise<TResult>;
  
  // Push from producer
  push(event: TEvent): void;
  end(): void;
}
```

### 3. Hook Chains (Permissions + Extensions)

```typescript
const loopConfig = {
  beforeToolCall: async (ctx) => {
    // Extension interception first
    const extResult = await extensions.dispatchToolStart(...);
    if (extResult.action === "block") return extResult;
    
    // Permission check second
    return permissionChecker.check(ctx);
  },
  afterToolCall: async (ctx) => {
    return extensions.dispatchToolEnd(...);
  },
};
```

### 4. Cost Tracking

```typescript
class CostTracker {
  recordTurn(model, usage, turnIndex): void;
  getSummary(): SessionCosts;
  isBudgetExceeded(): boolean;
  loadFromMessages(messages): number;  // For session resume
}
```

### 5. Abort Signal Threading

The abort signal flows through:
- `runAgent()` → `agentLoop()` → `streamAssistantResponse()` → provider
- `runAgent()` → `agentLoop()` → `executeTools()` → individual tools
- `runAgent()` → extensions → middleware

---

## 13. Capabilities & Limitations

### Capabilities

**Coding Tasks**
- Read, write, edit files
- Execute shell commands
- Search code (grep, find)
- Multi-file refactoring
- Test execution

**Session Management**
- Persistent history
- Branch and explore
- Resume from any point
- Cross-session navigation
- Labels/bookmarks

**Context Management**
- Automatic compaction
- Split-turn handling
- File operation tracking
- Cost tracking

**Extensibility**
- Custom tools
- Slash commands
- Event middleware
- Storage per extension

### Limitations

**No Real-time Collaboration**
- Single-user sessions
- No concurrent editing awareness

**Limited Multi-modal**
- Can read images (read tool)
- Cannot generate images
- No audio/video

**Security Model**
- Permission checks are heuristic (regex-based)
- Extensions are fully trusted (local code)
- No sandboxing beyond permission layer

**Context Window**
- Compaction loses detail
- Very long files need chunked reading
- No retrieval augmentation

**Provider Coupling**
- Signed thinking only replays to same provider
- Tool ID formats vary across providers

---

## 14. Customization Guide

### Adding a New Model

1. Edit `packages/ai/src/models.ts`:
```typescript
"my-new-model": {
  id: "provider-model-id",
  name: "Display Name",
  provider: "anthropic",
  contextWindow: 200_000,
  maxOutputTokens: 16_384,
  supportsTools: true,
  supportsStreaming: true,
  supportsThinking: true,
  cost: { inputPerMillion: 5, outputPerMillion: 25 },
},
```

### Adding a New Tool

1. Create `packages/core/src/tools/my-tool.ts`:
```typescript
export function createMyToolDefinition(cwd: string): ToolDefinition<...> {
  return {
    name: "my_tool",
    description: "...",
    version: 1,
    parameters: Type.Object({ ... }),
    execute: async (toolCallId, args, signal, onUpdate) => { ... },
  };
}
```

2. Register in `packages/core/src/tools/registry.ts`:
```typescript
import { createMyToolDefinition } from "./my-tool.js";

export function createAllToolDefinitions(cwd, options) {
  return {
    ...existing,
    my_tool: createMyToolDefinition(cwd),
  };
}
```

### Creating an Extension

1. Create `~/.my-agent/extensions/my-ext/index.ts`:
```typescript
import type { ExtensionDefinition } from "@my-agent/core";

const extension: ExtensionDefinition = {
  metadata: {
    id: "my-ext",
    name: "My Extension",
    version: "1.0.0",
    apiVersion: "1.0",
  },
  activate: (ctx) => {
    ctx.registerCommand({
      name: "mycommand",
      description: "Does something",
      execute: async (args, ctx) => {
        ctx.ui.toast("Hello!");
      },
    });
    
    ctx.on("tool_execution_start", (event) => {
      ctx.log.info(`Tool starting: ${event.toolName}`);
    });
  },
};

export default extension;
```

2. Add to settings:
```json
{
  "extensions": ["~/.my-agent/extensions/my-ext"]
}
```

### Modifying System Prompt

Option 1: Project-level `SYSTEM.md` (full override)
Option 2: Project-level `APPEND_SYSTEM.md` (add to base)
Option 3: Modify `packages/core/src/agent/system-prompt.ts`

### Custom Permission Rules

```typescript
const permissionChecker = createPermissionChecker("ask", {
  knownReadOnly: new Set([...BUILTIN_READ_TOOL_NAMES, "my_safe_tool"]),
  requireConfirmation: new Set(["dangerous_tool"]),
  onAsk: async (ctx) => {
    // Custom approval logic
    return "allow_once";
  },
});
```

---

## Quick Reference: File Locations

| What | Where |
|------|-------|
| User settings | `~/.my-agent/settings.json` |
| Project settings | `.my-agent/settings.json` |
| Auth tokens | `~/.my-agent/auth.json` |
| Sessions | `~/.my-agent/sessions/<encoded-cwd>/` |
| Extensions | `~/.my-agent/extensions/` |
| Prompts | `~/.my-agent/prompts/` |
| Skills | `~/.my-agent/skills/` |
| Themes | `~/.my-agent/themes/` |
| Traces | `~/.my-agent/traces/` |

---

## Debugging Tips

1. **Enable tracing**: `my-agent --trace` produces JSONL logs
2. **Profile runs**: `my-agent --profile` shows timing/cost
3. **Safe mode**: `my-agent --safe-mode` disables extensions
4. **Doctor check**: `my-agent --doctor` validates setup
5. **List models**: `my-agent --list-models` shows auth state

---

*This document reflects the codebase as of 2026-04-19. For the latest, check the `docs/` directory.*
