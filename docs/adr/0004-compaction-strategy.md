# ADR 0004: Persisted Compaction Summaries

## Status
Accepted

## Problem
Long sessions need stable context reduction without silently losing history.

## Decision
Persist compaction summaries into session history and keep branch summaries explicit.

## Tradeoffs
- replayable and inspectable
- slightly more complex session semantics
- requires careful accounting tests

## Revisit when
A better deterministic summarization or retrieval-based memory layer is adopted.
