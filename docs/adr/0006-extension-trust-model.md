# ADR 0006: Trusted Local Extensions

## Status
Accepted

## Problem
The project needs extensibility now, without building a marketplace or sandbox first.

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

## Revisit when
Public distribution or stronger isolation becomes necessary.
