# Performance and Cost Profiling

`my-agent` now exposes runtime profiling through `--profile` and structured tracing.

## Quick usage

```bash
node packages/cli/dist/main.js --profile "summarize this repo"
MY_AGENT_TRACE=1 MY_AGENT_TRACE_SCOPES=runtime node packages/cli/dist/main.js --trace "summarize this repo"
```

## What is measured

Per run, the runtime profile records:

- CLI startup-to-ready timing via trace events (`cli.ready`)
- total duration
- first-token latency
- session load duration
- project-context discovery duration
- extension-load duration
- per-tool duration
- compaction count and timings
- cumulative token totals
- cumulative cost
- memory snapshot at the end of the run

Representative output:

```text
profile: total=182ms first-token=41ms session-load=2ms project-context=4ms extensions=0ms
usage: in=123 out=45 cache-read=0 cache-write=0 cost=$0.0123
activity: turns=1 tools=0 compactions=0 rss=82MiB heap=19MiB
```

## Budget targets

These are the current interactive budgets for local private use.

| Flow | Budget |
|---|---:|
| CLI startup to ready prompt | < 500 ms on a warm dev machine |
| session load | < 50 ms for normal sessions |
| first visible token | < 2 s for responsive providers |
| model selector / session selector open | < 100 ms |
| tool-row UI update after tool completion | < 50 ms |

## Detecting regressions

Use one of these loops:

1. `--profile` for fast manual checks
2. `--trace` for detailed JSONL timelines
3. `npm run eval:mock` for behavior + latency deltas in mock mode

Recommended operator loop:

```bash
npm run build
npm test
npm run eval:mock
node packages/cli/dist/main.js --profile "say hello"
```

## Cost visibility

Cost is derived from:

1. provider-reported `usage.cost` when available
2. model pricing metadata when only token counts are available

The runtime profile includes cumulative totals for:

- input tokens
- output tokens
- cache read tokens
- cache write tokens
- total cost

## Where the data comes from

- `packages/core/src/agent/cost-tracker.ts`
- `packages/cli/src/runtime/agent-runtime.ts`
- `packages/cli/src/runtime/trace.ts`

## Notes

- `--profile` is intentionally human-readable
- traces are machine-readable JSONL
- RPC `prompt.completed` events also include the runtime profile payload
