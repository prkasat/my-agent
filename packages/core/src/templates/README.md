# Core Templates

Prompt template loading and expansion.

```mermaid
flowchart LR
    Dirs["template directories"] --> Loader["prompt-templates.ts"]
    Loader --> Match["matchTemplate"]
    Loader --> Expand["expandTemplate"]
    Loader --> Help["getTemplateHelp"]
```

| File | Purpose |
|---|---|
| [`prompt-templates.ts`](prompt-templates.ts) | Loads Markdown prompt templates, matches invocations, expands arguments, and renders help |

Templates are lightweight prompt snippets. Skills handle heavier repeatable workflows.

