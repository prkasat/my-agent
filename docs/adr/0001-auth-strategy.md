# ADR 0001: Provider Auth Strategy

## Status
Accepted

## Problem
The agent needs coherent auth UX without provider sprawl or mixed metaphors.

## Decision
- OpenRouter uses API-key auth.
- Anthropic uses OAuth.
- OpenAI Codex uses OAuth.
- No generic API-key path for Anthropic/OpenAI Codex in the product contract.

## Tradeoffs
- clearer UX and settings
- narrower provider surface
- less flexibility for generic platform API experimentation

## Revisit when
A new provider/auth path becomes essential for private daily use.
