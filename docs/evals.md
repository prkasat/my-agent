# Evaluation and Regression Harness

The repo includes a lightweight eval layout under `evals/tasks/`.

## Task groups

- `evals/tasks/coding/`
- `evals/tasks/non-coding/`

Task fixtures can also declare a `difficulty` such as `easy`, `medium`, or `failure-prone`.

## Goals

Use evals to regression-test:

- prompt behavior
- tool-use quality
- model/provider choices
- failure handling
- latency / cost deltas

## Current workflow

```bash
npm run eval:mock
```

The mock harness is intentionally deterministic and provider-free.

## Suggested operator loop

1. add or update tasks before a major behavior change
2. run evals in mock mode first
3. compare multiple models/providers on the same task set when doing live-provider work
4. inspect latency, tokens, and failure notes before landing prompt/runtime changes
5. pair eval results with trace/replay for any surprising regression

## Reporting fields

Capture at least:

- correctness / pass-fail
- model used
- latency
- first-token latency
- token usage
- estimated cost
- tool-call count
- failure notes

## Related docs

- `tracing-replay.md`
- `performance.md`
- `prompt-behavior.md`
