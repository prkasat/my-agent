# ADR 0008: Resource Platform Split

## Status
Accepted

## Problem
Not every customization should require extension code.

## Alternatives considered

- putting every customization into extensions
- supporting prompts only and no higher-order resources
- one generic resource type with no mental-model split

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

## Why the chosen approach won

The split keeps simple things simple while reserving extensions for genuinely deeper integrations.

## Revisit when
The resource taxonomy becomes confusing in real use.
