# TUI Shell

Start it with:

```bash
node packages/cli/dist/main.js --tui
```

`--tui` requires an interactive TTY.

## Current flows

- prompt entry with a full-screen editor
- streaming assistant output
- tool execution rows
- permission approval overlay
- model selector overlay
- session selector overlay
- provider login selector overlay
- help overlay

## Slash commands inside the TUI

- `/help`
- `/login [provider]`
- `/model [name]`
- `/sessions`
- `/theme [name]`
- `/skills`
- `/packages`
- `/extensions`
- `/quit`

## Notes

- Ctrl+C aborts the active run, or exits when idle.
- Theme selection is persisted through the normal settings path.
- The TUI reuses the same runtime, auth, session, and extension machinery as the CLI.
