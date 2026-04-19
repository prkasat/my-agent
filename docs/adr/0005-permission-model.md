# ADR 0005: Runtime Permission Gate

## Status
Accepted

## Problem
Tool safety must be enforced in runtime, not just implied in prompts.

## Decision
Route risky tools through a permission checker with:
- `auto`
- `ask`
- `deny` / strict behavior

Protected paths and destructive commands remain blocked regardless of mode.

## Tradeoffs
- safer default behavior
- more runtime complexity
- headless RPC requires explicit behavior for ask-mode prompts

## Revisit when
A richer sandbox or policy engine replaces the current checker.
