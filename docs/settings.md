# Settings

Settings are merged in this order:

1. defaults
2. `~/.my-agent/settings.json`
3. `<project>/.my-agent/settings.json`

## Current settings shape

```json
{
  "model": "openrouter-auto",
  "provider": "openrouter",
  "thinkingLevel": "medium",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "maxDelayMs": 60000
  },
  "extensions": [],
  "packages": [],
  "skills": [],
  "theme": "default",
  "enabledModels": ["*"],
  "maxTurns": 50,
  "permissionMode": "ask"
}
```

## Notes

- `provider` is normalized from `model` when the model is known.
- `extensions`, `packages`, and `skills` accept local paths.
- `theme` is a theme name from the loaded theme registry or a path resolved explicitly.
- `permissionMode` values:
  - `ask`
  - `auto`
  - `strict`

## Persisting changes from the REPL

`/model <name>` and `/theme <name>` persist to the project settings file.
