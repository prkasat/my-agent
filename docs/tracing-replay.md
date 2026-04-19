# Tracing, Replay, and Profiling

## Structured tracing

Enable tracing with:

```bash
node packages/cli/dist/main.js --trace
```

Or with env:

```bash
MY_AGENT_TRACE=1 node packages/cli/dist/main.js
```

Optional scope filter:

```bash
MY_AGENT_TRACE=1 MY_AGENT_TRACE_SCOPES=runtime,auth,rpc node packages/cli/dist/main.js
```

Trace files are written to:

```text
~/.my-agent/traces/
```

## Trace scopes

- `runtime`
- `auth`
- `permissions`
- `extensions`
- `rpc`
- `resources`

## What is traced today

### Runtime

- CLI start
- session load timing
- model resolution
- project-context discovery timing
- system prompt build summary
- first-token latency
- retries
- compactions
- tool start/end with durations
- turn-end cost/token totals
- agent-end runtime profile

### Auth

- storage load/recovery
- login start/success
- logout
- API-key resolution
- OAuth refresh success/miss

### Extensions

- extension load ids + warnings
- transformed user input

### RPC

- server creation
- command receipt
- prompt start/completion/error

## Safety

Trace data is redacted before persistence.

Still treat local trace files as sensitive.

## Runtime profiling

For quick human-readable profiling, use:

```bash
node packages/cli/dist/main.js --profile "summarize this repo"
```

That summary is also included in RPC `prompt.completed` events.

## Replay

Replay either a trace file or a session file:

```bash
node packages/cli/dist/main.js --replay ~/.my-agent/traces/<file>.jsonl
node packages/cli/dist/main.js --replay ~/.my-agent/sessions/<project>/<session>.jsonl
```

Replay is:

- read-only
- fixture-friendly
- safe for post-mortem debugging
- provider-free

## Recommended debugging loop

1. reproduce with `--trace`
2. inspect the JSONL timeline
3. replay the session or trace
4. compare runtime profile data before/after the fix
