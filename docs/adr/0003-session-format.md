# ADR 0003: Append-Only JSONL Sessions

## Status
Accepted

## Problem
We need durable, branchable session storage that is easy to inspect and repair.

## Alternatives considered

- rewriting a single mutable JSON file
- sqlite or another embedded database from day one
- opaque binary session snapshots

## Decision
Use append-only JSONL session logs with explicit schema versioning.

## Tradeoffs
- easy to inspect and replay
- good crash recovery for malformed trailing writes
- larger on-disk history over time

## Why the chosen approach won

Append-only JSONL maximizes inspectability, replayability, and crash recovery while staying simple enough for a private-first tool.

## Revisit when
Session size, indexing, or multi-user workflows require a stronger storage engine.
