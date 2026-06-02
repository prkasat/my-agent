# CLI TUI

Full-screen terminal app orchestration.

```mermaid
flowchart TD
    App["app.ts"] --> Runtime["../runtime/agent-runtime.ts"]
    App --> UI["../ui"]
    App --> Settings["../config/settings.ts"]
    App --> Auth["../config/auth-storage.ts"]
    App --> Session["@my-agent/core SessionManager"]
```

| File | Purpose |
|---|---|
| [`app.ts`](app.ts) | TUI state machine, overlays, permission prompts, model/session/theme/resource workflows |

Reusable visual components live in [`../ui/`](../ui/README.md).

