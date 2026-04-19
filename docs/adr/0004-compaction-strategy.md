# ADR 0004: Persisted Compaction Summaries

## Status
Accepted

## Problem
Long sessions need stable context reduction without silently losing history.

## Alternatives considered

- non-persisted in-memory summaries only
- destructive transcript rewriting
- retrieval-only memory without explicit durable summaries

## Decision
Persist compaction summaries into session history and keep branch summaries explicit.

## Tradeoffs
- replayable and inspectable
- slightly more complex session semantics
- requires careful accounting tests

## Why the chosen approach won

Persisted summaries keep long-session behavior replayable and debuggable instead of hiding context reduction in ephemeral runtime state.

## Revisit when
A better deterministic summarization or retrieval-based memory layer is adopted.
