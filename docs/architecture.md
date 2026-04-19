# Architecture

## Layers

### 1. AI / provider layer (`packages/ai`)

- provider registry
- model definitions
- streaming abstractions
- OAuth provider helpers

### 2. Core agent / session / tool layer (`packages/core`)

- agent loop
- permission model
- tool definitions and execution
- sessions / compaction / branching
- prompt templates
- extension runtime
- resource loaders for skills and packages

### 3. CLI app layer (`packages/cli`)

- settings and auth storage
- one-shot mode
- REPL mode
- RPC mode
- runtime orchestration
- theme loading and TUI component library

## Single sources of truth

- credentials: `AuthStorage`
- settings: `loadSettings()` + `saveSettings()`
- models: `packages/ai/src/models.ts`
- auth-aware visibility: `packages/cli/src/runtime/model-registry.ts`

## Request path

1. CLI receives user input
2. settings/auth/resources are loaded
3. model is resolved against auth state
4. project context and system prompt are built
5. extensions may transform input / tools
6. agent loop streams assistant output
7. tool calls go through permission checks and execution
8. results are appended to session state
9. session is flushed to disk
