# Evaluation and Regression Harness

The repo includes a lightweight eval layout under `evals/tasks/`.

## Task groups

- `evals/tasks/coding/`
- `evals/tasks/non-coding/`

## Goal

Use evals to regression-test:

- prompt behavior
- tool-use quality
- model/provider choices
- failure handling
- latency / cost deltas

## Suggested workflow

1. add or update tasks before a major behavior change
2. run evals in mock mode first
3. compare multiple models/providers on the same task set
4. inspect latency, tokens, and failures before landing prompt/runtime changes

## Reporting fields

Capture at least:

- correctness / pass-fail
- model used
- latency
- token usage
- estimated cost
- failure notes

See also `docs/tracing-replay.md` for post-mortem debugging.
