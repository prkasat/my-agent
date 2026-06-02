# CLI Modes

Non-default CLI modes.

```mermaid
flowchart LR
    Host["host process"] --> RPC["rpc.ts"]
    RPC --> Runtime["runtime/agent-runtime.ts"]
    RPC --> Stdout["JSONL responses"]
```

| File | Purpose |
|---|---|
| [`rpc.ts`](rpc.ts) | JSONL stdin/stdout server for host-process integrations |

The default interactive modes live in [`../tui/`](../tui/README.md) and [`../repl/`](../repl/README.md).

