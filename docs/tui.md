# TUI Shell

Start it with:

```bash
node packages/cli/dist/main.js
# or explicitly
node packages/cli/dist/main.js --tui
```

Interactive TTY runs now default to the TUI.
Use `--repl` to force the plain-text fallback.

`--tui` requires an interactive TTY.

## Screen layout

```mermaid
flowchart TB
    Messages[streaming messages]
    Editor[prompt editor]
    Footer[model / tokens / cost / status]
    Overlay[overlay layer]

    Messages --> Editor --> Footer
    Overlay -. overlays above .-> Messages
```

## Current flows

- prompt entry with a full-screen editor
- slash-command autocomplete with `Tab`
- prompt history with Up/Down
- turn markers for each model/tool cycle
- streaming assistant output
- collapsible thinking blocks
- tool execution rows with args, durations, summaries, and output
- diff viewer blocks for edit-like tool results
- permission approval overlay
- model selector overlay
- session selector overlay
- tree selector overlay for branch-context switching
- provider login selector overlay
- help overlay

## Slash commands inside the TUI

- `/help`
- `/login [provider]`
- `/model [name]`
- `/sessions`
- `/tree`
- `/theme [name]`
- `/thinking [level]`
- `/skills`
- `/packages`
- `/extensions`
- `/quit`

## State transitions

```mermaid
stateDiagram-v2
    [*] --> EditorFocused
    EditorFocused --> Running : submit prompt
    EditorFocused --> OverlayOpen : selector/help/login
    Running --> EditorFocused : prompt complete
    Running --> Aborted : Ctrl+C
    Aborted --> EditorFocused
    OverlayOpen --> EditorFocused : dismiss/select
```

## Runtime wiring

The TUI reuses the same underlying runtime as the CLI/REPL:

```ts
const result = await runAgent(prompt, {
  cwd,
  settings,
  authStorage,
  session,
  askPermission,
  resourceExtensionEntries,
}, {
  onText,
  onToolStart,
  onToolEnd,
  onTurnEnd,
});
```

That means the TUI inherits:

- the same model registry
- the same auth storage
- the same session persistence
- the same extension loading rules
- the same permission checks

## Footer metrics

The footer updates from runtime profile data:

- input tokens
- output tokens
- total cost
- current model
- safe-mode / thinking status

## Notes

- interactive TTY launches the TUI by default
- Ctrl+C aborts the active run, cancels an in-flight login, or exits when idle
- F1 opens help, F2 model selector, F3 session selector, F4 tree selector, F5 login selector, F6 thinking selector
- Shift+Tab cycles thinking levels
- Ctrl+O expands/collapses tool output blocks
- Ctrl+T expands/collapses thinking blocks
- login progress is streamed into the message pane during OAuth flows
- runtime and provider errors are surfaced inline instead of dumping raw stack traces into the terminal UI
- fatal TUI failures restore terminal state before exiting so the shell is usable immediately afterward
- theme selection persists through the normal settings path
- diff blocks are rendered inline for edit-like tool results
- branch context can be switched from the tree selector without leaving the TUI

## Related docs

- `ui-state.md`
- `architecture.md`
- `lifecycle.md`
