# ADR 0006: Trusted Local Extensions

## Status
Accepted

## Problem
The project needs extensibility now, without building a marketplace or sandbox first.

## Alternatives considered

- no extension platform until a public marketplace exists
- sandboxed plugins from day one
- remote-only hosted extensions

## Decision
Ship a trusted-local extension platform:
- in-process
- private-first
- local discovery
- documented trust boundary

## Tradeoffs
- fast and flexible
- not safe for untrusted code
- requires explicit docs and safe-mode recovery

## Why the chosen approach won

Trusted local extensions unblock real customization immediately without overbuilding marketplace or isolation infrastructure first.

## Revisit when
Public distribution or stronger isolation becomes necessary.
