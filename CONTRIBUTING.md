# Contributing

Thanks for helping improve `my-agent`.

## Development setup

Requirements:

- Node.js 22.19.0 or newer
- npm 10 or newer

Install and validate from the repository root:

```bash
npm install
npm run build
npm test
npm run lint
npm run eval:mock
```

## Project map

- `packages/ai` owns provider adapters, model metadata, streaming helpers, and OAuth helper types.
- `packages/core` owns the agent loop, tools, sessions, permissions, compaction, resources, and extension runtime contracts.
- `packages/cli` owns the command line product shell, auth storage, settings, tracing, replay, REPL, RPC mode, and TUI.
- `docs/architecture.md` and `docs/lifecycle.md` are the best starting points for system flow diagrams.

## Pull request expectations

- Keep changes narrowly scoped to the issue or feature being addressed.
- Match the existing TypeScript and documentation style.
- Add or update tests for behavior changes.
- Update docs when commands, settings, provider behavior, session format, extension APIs, or security posture changes.
- Run `npm run lint`, `npm run build`, `npm test`, and `npm run eval:mock` before opening a pull request.

## Dependency changes

Dependency updates should be intentional and verified with:

```bash
npm outdated --workspaces --include-workspace-root
npm audit --audit-level=moderate
npm run build
npm test
npm run lint
```

If a dependency update changes user-visible behavior, mention it in `CHANGELOG.md`.
