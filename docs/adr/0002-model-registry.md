# ADR 0002: Auth-Aware Model Registry

## Status
Accepted

## Problem
Settings, UI, and runtime must agree about what models are visible and usable.

## Decision
Use a dedicated auth-aware model registry in the CLI runtime that derives availability from:
- static model definitions
- provider auth mode
- current credentials

## Tradeoffs
- one place to explain unavailability
- simpler fallback behavior
- requires model metadata discipline

## Revisit when
Provider capability metadata outgrows the current static record shape.
