# ADR 0007: CLI-First App Shell with Reusable TUI Components

## Status
Accepted

## Problem
We need a reliable daily-driver CLI while preserving a path to richer TUI work.

## Decision
Keep the app CLI-first:
- one-shot mode
- REPL mode
- RPC mode
- reusable TUI component/theme layer in the CLI package

## Tradeoffs
- stable headless workflows now
- easier testing and debugging
- full-screen TUI product work can evolve separately

## Revisit when
A full TUI shell becomes the default interaction path.
