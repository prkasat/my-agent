# Settings

Settings are merged in this order:

1. defaults
2. `~/.my-agent/settings.json`
3. `<project>/.my-agent/settings.json`

## Current shape

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

## Field guide

| Field | Meaning |
|---|---|
| `model` | configured model key |
| `provider` | normalized from model when possible |
| `thinkingLevel` | thinking intensity hint for supported providers |
| `compaction.*` | context-management policy |
| `retry.*` | transient-provider retry policy |
| `extensions` | local extension entries |
| `packages` | local package entries |
| `skills` | extra skill files/directories |
| `theme` | TUI theme name or explicit path |
| `enabledModels` | allowlist for visible models |
| `maxTurns` | runaway-loop guardrail |
| `permissionMode` | `ask`, `auto`, or `strict` |

## Important normalization behavior

The loader repairs provider/model coherence when the model is known:

```ts
function normalizeSettings(settings: Settings): Settings {
  try {
    const model = getModel(settings.model);
    return { ...settings, provider: model.provider };
  } catch {
    return settings;
  }
}
```

That means persisted settings can keep their provider/model story aligned even if the provider field was stale.

## Persisting changes from the app

- `/model <name>` persists to project settings
- `/theme <name>` persists to project settings
- `/thinking <level>` persists to project settings

## Corruption recovery

If a settings file contains invalid JSON:

- it is backed up to `settings.json.corrupt-<timestamp>`
- defaults continue to load

## Migration policy summary

Settings are currently additive-first:

- unknown keys are tolerated
- defaults fill missing fields
- future breaking structural changes should introduce an explicit settings version

See `migrations.md` for the full policy.
