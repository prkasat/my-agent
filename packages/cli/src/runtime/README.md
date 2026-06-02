# CLI Runtime

Runtime composition layer. It wires settings, auth, resources, tools, extensions, sessions, tracing, and provider streams into one `runAgent(...)` call.

```mermaid
sequenceDiagram
    participant Main as main.ts
    participant Runtime as agent-runtime.ts
    participant Model as model-registry.ts
    participant Ext as extensions.ts
    participant Trace as trace.ts
    participant Core as @my-agent/core

    Main->>Runtime: runAgent(prompt, config)
    Runtime->>Model: resolveConfiguredModel(settings, auth)
    Runtime->>Ext: loadExtensionsForRun(...)
    Runtime->>Trace: write hashed/structured events
    Runtime->>Core: agentLoop(context, config)
    Core-->>Runtime: AgentEvent stream
```

| File | Purpose |
|---|---|
| [`agent-runtime.ts`](agent-runtime.ts) | Main runtime orchestration and profiling |
| [`model-registry.ts`](model-registry.ts) | Auth-aware model availability and resolution |
| [`extensions.ts`](extensions.ts) | CLI-side extension discovery and UI adapter wiring |
| [`trace.ts`](trace.ts) | Structured JSONL tracing with redaction |

