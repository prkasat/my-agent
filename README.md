# my-agent

Private-first terminal agent for coding and task-specific workflows.

## Features

- OpenRouter API-key auth
- Anthropic OAuth auth
- OpenAI Codex / ChatGPT subscription OAuth auth
- auth-aware model registry and fallback selection
- full-screen TUI by default in interactive terminals, plus REPL fallback and JSONL RPC mode
- session persistence, branching, export, and replay
- runtime permission checks for risky tools
- trusted local extensions with tools, commands, and middleware
- prompt templates, skills, packages, and themes
- structured tracing, replay, profiling, and mock eval harness
- reusable TUI component/theme layer built on `@earendil-works/pi-tui`

## Quick start

Requirements:

- Node.js 22.19.0 or newer
- npm 10 or newer

```bash
npm install
npm run build
npm test
npm run lint
```

Start the agent (interactive TTY defaults to the TUI):

```bash
node packages/cli/dist/main.js
```

Force the plain-text REPL fallback:

```bash
node packages/cli/dist/main.js --repl
```

Authenticate with OpenRouter:

```bash
export OPENROUTER_API_KEY=...
node packages/cli/dist/main.js
```

Or log in from the TUI/REPL:

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
node packages/cli/dist/main.js --repl
node packages/cli/dist/main.js --tui
node packages/cli/dist/main.js --trace
node packages/cli/dist/main.js --profile "say hello"
node packages/cli/dist/main.js --replay <file>
node packages/cli/dist/main.js --rpc
npm run eval:mock
```

## Auth policy

- `openrouter` → API key only
- `anthropic` → OAuth only
- `openai-codex` → OAuth only

`openai-codex` is intentionally distinct from generic OpenAI Platform API usage.

## What “parity with pi-mono where it matters” means here

For this repo, parity means:

- practical daily-driver terminal UX
- coherent login and model switching
- reliable session/tree/export/replay flows
- strong interactive safety and debugging
- an extension/resource platform that can grow beyond coding-only use

## Resource model

- prompts → lightweight reusable prompt files
- skills → task-specific prompt workflows with commands/aliases
- packages → bundles of prompts, skills, extensions, and themes
- themes → TUI palette overrides
- extensions → trusted local code for tools, middleware, and deeper integrations

Examples:

- `examples/packages/research-bundle/`
- `examples/extensions/`
- `examples/extensions/starter.mjs`
- `examples/prompts/generate-extension.md`

## Docs

See `docs/README.md`.

Key docs:

- `docs/quickstart.md`
- `docs/providers.md`
- `docs/settings.md`
- `docs/migrations.md`
- `docs/sessions.md`
- `docs/extensions.md`
- `docs/extensions-api-reference.md`
- `docs/skills.md`
- `docs/packages.md`
- `docs/themes.md`
- `docs/tui.md`
- `docs/ui-state.md`
- `docs/prompt-behavior.md`
- `docs/rpc.md`
- `docs/tracing-replay.md`
- `docs/performance.md`
- `docs/evals.md`
- `docs/failure-injection.md`
- `docs/security.md`
- `docs/architecture.md`

Project docs:

- `CONTRIBUTING.md`
- `SECURITY.md`
- `CHANGELOG.md`
- `LICENSE`

## Validation

Current repo validation targets:

- `npm run build`
- `npm test`
- `npm run lint`
- `npm run eval:mock`

## Checklist

The full target state is tracked in `PRODUCTION_READINESS_CHECKLIST.md`.

## Contributing

Contributions are welcome. Start with `CONTRIBUTING.md`, then run the validation commands listed above before opening a pull request.

## License

MIT. See `LICENSE`.

## Notes

This codebase is intentionally optimized for inspectability and extension authoring, not for hiding complexity.
