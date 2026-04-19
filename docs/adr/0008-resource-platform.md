# ADR 0008: Resource Platform Split

## Status
Accepted

## Problem
Not every customization should require extension code.

## Decision
Split adaptable resources into:
- prompts
- skills
- packages
- themes
- extensions for deeper integration

## Tradeoffs
- better mental model for users
- more loaders and docs to maintain
- some overlap between skills and command-style extensions

## Revisit when
The resource taxonomy becomes confusing in real use.
