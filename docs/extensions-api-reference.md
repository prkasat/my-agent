# Extension API Reference

An extension exports a default `ExtensionDefinition`.

## Minimal shape

```js
export default {
  metadata: {
    id: "my-extension",
    name: "My Extension",
    version: "1.0.0"
  },
  activate(ctx) {
    // register handlers, commands, tools, middleware
  }
}
```

## What `ctx` exposes

### Registration

- `ctx.on(event, handler)`
- `ctx.onAny(handler)`
- `ctx.registerCommand(command)`
- `ctx.registerTool(tool)`
- `ctx.use(middleware)`

### Host surfaces

- `ctx.storage`
- `ctx.ui`
- `ctx.actions`
- `ctx.metrics`
- `ctx.recorder`
- `ctx.getAgentContext()`
- `ctx.signal`
- `ctx.log`

## High-value events

- `session_start`
- `session_end`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_end`
- `user_input`

## Tool interception

Return one of:

```js
{ action: "allow" }
{ action: "allow", modifiedArgs }
{ action: "block", reason: "..." }
```

## Command pattern

Use `ctx.actions.sendMessage(...)` when a slash command should turn into an agent prompt.

## Starter prompt

See `examples/prompts/generate-extension.md`.
