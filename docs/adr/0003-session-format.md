# ADR 0003: Append-Only JSONL Sessions

## Status
Accepted

## Problem
We need durable, branchable session storage that is easy to inspect and repair.

## Decision
Use append-only JSONL session logs with explicit schema versioning.

## Tradeoffs
- easy to inspect and replay
- good crash recovery for malformed trailing writes
- larger on-disk history over time

## Revisit when
Session size, indexing, or multi-user workflows require a stronger storage engine.
