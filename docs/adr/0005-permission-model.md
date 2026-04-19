# ADR 0005: Runtime Permission Gate

## Status
Accepted

## Problem
Tool safety must be enforced in runtime, not just implied in prompts.

## Alternatives considered

- prompt-only safety with no runtime enforcement
- allow-all by default
- a heavier sandbox before shipping v1

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

## Why the chosen approach won

It gives a practical safety floor now while preserving a path to future policy engines or sandboxing.

## Revisit when
A richer sandbox or policy engine replaces the current checker.
