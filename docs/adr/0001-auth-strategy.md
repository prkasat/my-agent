# ADR 0001: Provider Auth Strategy

## Status
Accepted

## Problem
The agent needs coherent auth UX without provider sprawl or mixed metaphors.

## Alternatives considered

- generic API-key auth for every provider
- OAuth-only for every provider
- mixing multiple auth styles per provider

## Decision
- OpenRouter uses API-key auth.
- Anthropic uses OAuth.
- OpenAI Codex uses OAuth.
- No generic API-key path for Anthropic/OpenAI Codex in the product contract.

## Tradeoffs
- clearer UX and settings
- narrower provider surface
- less flexibility for generic platform API experimentation

## Why the chosen approach won

It keeps auth UX understandable, keeps model visibility coherent, and matches the private daily-driver product contract.

## Revisit when
A new provider/auth path becomes essential for private daily use.
