# ADR 0002: Auth-Aware Model Registry

## Status
Accepted

## Problem
Settings, UI, and runtime must agree about what models are visible and usable.

## Alternatives considered

- letting settings, UI, and runtime each maintain their own model lists
- provider-specific ad-hoc checks spread across the CLI
- dynamic discovery without a curated registry

## Decision
Use a dedicated auth-aware model registry in the CLI runtime that derives availability from:
- static model definitions
- provider auth mode
- current credentials

## Tradeoffs
- one place to explain unavailability
- simpler fallback behavior
- requires model metadata discipline

## Why the chosen approach won

A single auth-aware registry makes model availability explainable and keeps selection/fallback logic coherent.

## Revisit when
Provider capability metadata outgrows the current static record shape.
