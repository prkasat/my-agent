# Extensions

Extensions are trusted local modules that run in-process.

## Trust model

- private-first
- local and trusted
- no marketplace assumptions in v1
- no sandbox boundary today

If you load an extension, it has the same process-level access as the host.

## Discovery

Extensions are loaded from:

- `settings.extensions`
- `.my-agent/extensions/`
- `~/.my-agent/extensions/`
- package-provided extension entries

## Supported extension capabilities

- register tools
- register slash commands
- intercept / modify tool arguments
- block tool calls
- observe session / turn / message / tool lifecycle events
- use session/global extension storage
- participate in hot reload through the core loader API

## Examples

See:

- `examples/extensions/command-only.mjs`
- `examples/extensions/tool-only.mjs`
- `examples/extensions/middleware-example.mjs`
- `examples/extensions/non-coding-workflow.mjs`
- `examples/packages/research-bundle/extensions/research-capture.mjs`

## Safe mode

```bash
node packages/cli/dist/main.js --safe-mode
```

This bypasses package extension entries and extension loading for the current run.

## API reference

See `docs/extensions-api-reference.md`.
