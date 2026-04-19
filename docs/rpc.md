# RPC Protocol

RPC mode is JSONL over stdin/stdout.

Start it with:

```bash
node packages/cli/dist/main.js --rpc
```

## Ready event

```json
{"event":"ready","data":{"protocolVersion":"1.0","methods":["prompt","abort","getState","listModels"]}}
```

## Commands

### `prompt`

```json
{"id":"1","method":"prompt","params":{"prompt":"summarize this repo"}}
```

Initial response:

```json
{"id":"1","result":{"status":"started","requestId":"1"}}
```

Prompt events:

- `prompt.started`
- `prompt.text`
- `prompt.thinking`
- `tool.start`
- `tool.end`
- `prompt.completed`

### `abort`

```json
{"id":"2","method":"abort","params":{"requestId":"1"}}
```

### `getState`

Returns:

- cwd
- session id/path
- configured/resolved model
- active prompt ids
- resource counts
- safe-mode flag
- protocol version

### `listModels`

Returns auth-aware model availability.

## Profiling data

`prompt.completed` includes runtime profile data:

- total duration
- first-token latency
- cost/token totals
- tool durations
- compaction counts
- memory snapshot

## Permission behavior

RPC is headless. In `ask` mode, risky actions are denied because there is no interactive approval UI in the JSONL transport.
Use `permissionMode: "auto"` only in trusted local automation contexts.

## Versioning strategy

- protocol is explicit via `protocolVersion`
- additive fields are preferred
- breaking changes should bump the protocol version
- host integrations should ignore unknown fields to stay forward-compatible
