# ADR 0007: CLI-First App Shell with Reusable TUI Components

## Status
Accepted

## Problem
We need a reliable daily-driver CLI while preserving a path to richer TUI work.

## Alternatives considered

- full-screen TUI first with CLI as a thin compatibility wrapper
- headless-only CLI with no richer interactive shell path
- separate repos for CLI and TUI products

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

## Why the chosen approach won

The CLI-first shell keeps core workflows testable and scriptable while still allowing richer TUI work on top of the same runtime and components.

## Revisit when
A full TUI shell becomes the default interaction path.
