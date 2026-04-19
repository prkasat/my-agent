# CLI / TUI State Model

This document makes the app shell understandable without reading the whole implementation.

## CLI execution modes

```mermaid
stateDiagram-v2
    [*] --> ParseArgs
    ParseArgs --> Help
    ParseArgs --> Doctor
    ParseArgs --> ListModels
    ParseArgs --> Replay
    ParseArgs --> Rpc
    ParseArgs --> Tui
    ParseArgs --> OneShot
    ParseArgs --> Repl
```

## REPL input lifecycle

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> ReadLine
    ReadLine --> SlashDispatch
    ReadLine --> PromptRun
    SlashDispatch --> Idle
    SlashDispatch --> PromptRun
    SlashDispatch --> SwitchSession
    SlashDispatch --> Quit
    PromptRun --> Streaming
    Streaming --> Idle
    Streaming --> Aborted
    Aborted --> Idle
```

Implementation sketch:

```ts
const result = await handleSlashCommand(line, ctx);
if (!result) {
  await runPrompt(line, abortSignal);
  return;
}
```

## One-shot lifecycle

```mermaid
stateDiagram-v2
    [*] --> Start
    Start --> RunPrompt
    RunPrompt --> StreamStdout
    StreamStdout --> Completed
    RunPrompt --> Aborted
    RunPrompt --> Failed
```

Behavioral notes:

- assistant text goes to `stdout`
- tool progress and errors go to `stderr`
- `--profile` prints timing/cost summary to `stderr`
- Ctrl+C aborts with exit code `130`

## RPC lifecycle

```mermaid
stateDiagram-v2
    [*] --> Ready
    Ready --> PromptActive
    PromptActive --> PromptCompleted
    PromptActive --> PromptAborted
    Ready --> StateQuery
    Ready --> ModelQuery
    PromptCompleted --> Ready
    PromptAborted --> Ready
    StateQuery --> Ready
    ModelQuery --> Ready
```

## TUI top-level state

```mermaid
stateDiagram-v2
    [*] --> EditorFocused
    EditorFocused --> Running : submit prompt
    EditorFocused --> OverlayOpen : open selector/help/login/permission
    Running --> EditorFocused : prompt complete
    Running --> Running : stream updates
    Running --> Aborted : Ctrl+C
    Aborted --> EditorFocused
    OverlayOpen --> EditorFocused : select / cancel / dismiss
    EditorFocused --> Quit : /quit or idle Ctrl+C
```

## TUI component tree

```mermaid
flowchart TB
    Root[TUI root]
    Messages[message container]
    Editor[editor]
    Footer[footer]
    Overlay[overlay layer]

    Root --> Messages
    Root --> Editor
    Root --> Footer
    Root --> Overlay
```

## Overlay / modal lifecycle

All overlays in the current TUI follow the same pattern:

1. build overlay component
2. call `tui.showOverlay(...)`
3. move focus into the overlay
4. on select/cancel:
   - hide overlay
   - restore focus to editor
   - apply the result or dismiss

Representative snippet:

```ts
const list = new SelectList(items, items.length, theme.selectList);
const handle = tui.showOverlay(list, { anchor: "center", width: "70%", maxHeight: 18 });
list.onCancel = () => {
  handle.hide();
  tui.setFocus(editor);
};
```

## Login-flow UI states

```mermaid
stateDiagram-v2
    [*] --> ProviderSelector
    ProviderSelector --> BrowserAuth
    BrowserAuth --> CallbackSuccess
    BrowserAuth --> ManualPaste
    ManualPaste --> CallbackSuccess
    BrowserAuth --> Failed
    ManualPaste --> Failed
    CallbackSuccess --> [*]
    Failed --> [*]
```

## Permission-prompt UI states

```mermaid
stateDiagram-v2
    [*] --> PermissionOverlay
    PermissionOverlay --> AllowOnce
    PermissionOverlay --> AllowSession
    PermissionOverlay --> Deny
    AllowOnce --> [*]
    AllowSession --> [*]
    Deny --> [*]
```

## Tool-execution UI states

```mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Running
    Running --> Success
    Running --> Error
    Success --> DiffAttached
    Error --> DiffAttached
```

Notes:

- tool rows now capture args, durations, and textual output
- edit-like tool results can attach a diff viewer below the tool row
- footer token/cost totals update on turn end

## Session / branch-switch UI states

```mermaid
stateDiagram-v2
    [*] --> SessionSelector
    SessionSelector --> ExistingSession
    SessionSelector --> NewSession
    ExistingSession --> [*]
    NewSession --> [*]

    [*] --> TreeSelector
    TreeSelector --> BranchContextUpdated
    BranchContextUpdated --> [*]
```

## Abort behavior

- REPL one-shot: Ctrl+C aborts the active run, then returns to prompt or exits if idle
- TUI: Ctrl+C aborts the active run; when idle it exits the app
- RPC: `abort` cancels the active controller for the request id

## Learning checklist for maintainers

If you understand the items below, you understand the app shell:

- how a line becomes a slash command vs a model prompt
- where overlays are created and dismissed
- how runtime callbacks update messages/footer state
- how session switching differs from branch-context switching
- how `--trace` and `--profile` expose app behavior
