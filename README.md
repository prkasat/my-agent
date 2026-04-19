# my-agent

Private-first terminal agent for coding and task-specific workflows.

## Features

- OpenRouter API-key auth
- Anthropic OAuth auth
- OpenAI Codex / ChatGPT subscription OAuth auth
- auth-aware model registry and fallback selection
- one-shot CLI, REPL, and JSONL RPC mode
- session persistence, branching, export, and replay
- runtime permission checks for risky tools
- trusted local extensions with tools, commands, and middleware
- prompt templates, skills, packages, and themes
- structured tracing and mock eval harness
- reusable TUI component/theme layer built on `@mariozechner/pi-tui`

## Quick start

```bash
npm install
npm run build
npm test
```

Start the agent:

```bash
node packages/cli/dist/main.js
```

Authenticate with OpenRouter:

```bash
export OPENROUTER_API_KEY=...
node packages/cli/dist/main.js
```

Or log in from the REPL:

```text
/login anthropic
/login openai-codex
```

## Useful commands

```bash
node packages/cli/dist/main.js --help
node packages/cli/dist/main.js --doctor
node packages/cli/dist/main.js --list-models
node packages/cli/dist/main.js --safe-mode
node packages/cli/dist/main.js --trace
node packages/cli/dist/main.js --replay <file>
node packages/cli/dist/main.js --rpc
npm run eval:mock
```

## Auth policy

- `openrouter` → API key only
- `anthropic` → OAuth only
- `openai-codex` → OAuth only

`openai-codex` is intentionally distinct from generic OpenAI Platform API usage.

## Resource model

- prompts → lightweight reusable prompt files
- skills → task-specific prompt workflows with commands/aliases
- packages → bundles of prompts, skills, extensions, and themes
- themes → TUI palette overrides
- extensions → trusted local code for tools, middleware, and deeper integrations

Examples:

- `examples/packages/research-bundle/`
- `examples/extensions/`
- `examples/prompts/generate-extension.md`

## Docs

See `docs/README.md`.

Key docs:

- `docs/quickstart.md`
- `docs/providers.md`
- `docs/settings.md`
- `docs/sessions.md`
- `docs/extensions.md`
- `docs/skills.md`
- `docs/packages.md`
- `docs/themes.md`
- `docs/rpc.md`
- `docs/tracing-replay.md`
- `docs/security.md`
- `docs/architecture.md`

## Validation

Current repo validation targets:

- `npm run build`
- `npm test`
- `npm run lint`
- `npm run eval:mock`

## Checklist

The full target state is tracked in `PRODUCTION_READINESS_CHECKLIST.md`.

## Notes

This codebase is intentionally optimized for inspectability and extension authoring, not for hiding complexity.
