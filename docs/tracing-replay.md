# Tracing and Replay

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

## Current trace coverage

- CLI startup
- auth storage load/login/logout/refresh
- model resolution
- project context discovery
- extension loading and prompt transformation
- permission checks
- tool start/end
- RPC command lifecycle
- agent start/end

## Replay

Replay either a trace file or a session file:

```bash
node packages/cli/dist/main.js --replay ~/.my-agent/traces/<file>.jsonl
node packages/cli/dist/main.js --replay ~/.my-agent/sessions/<project>/<session>.jsonl
```

Replay is read-only and fixture-friendly. It does not call providers.
