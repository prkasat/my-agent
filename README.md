# my-agent

Private-first terminal agent for coding and task-specific workflows.

## Current shape

- OpenRouter API-key support
- Anthropic OAuth support
- OpenAI Codex / ChatGPT subscription OAuth support
- auth-aware model selection
- session persistence and branching
- permissions for risky tools
- local trusted extension loading
- prompt templates
- CLI REPL, one-shot mode, RPC stub entrypoint, and reusable TUI components

## Quick start

```bash
npm install
npm run build
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

## Usage

```bash
my-agent
my-agent "explain this repo"
my-agent --list-models
my-agent --doctor
my-agent --safe-mode
my-agent --version
```

## Auth model

- `openrouter`: API key only
- `anthropic`: OAuth
- `openai-codex`: OAuth

OpenRouter can use `OPENROUTER_API_KEY` or an `auth.json` entry.
Anthropic and OpenAI Codex are intended to be used through `/login`.

## Extensions

Extensions are trusted local JavaScript modules that export an `ExtensionDefinition`.

Discovered from:

- paths listed in `.my-agent/settings.json` under `extensions`
- `.my-agent/extensions/`
- `~/.my-agent/extensions/`

Current runtime integration includes:

- extension tools
- tool interception / argument rewriting
- extension event dispatch during agent runs
- extension storage via the core extension runner

## Repo checklist

The full target state is tracked in:

- `PRODUCTION_READINESS_CHECKLIST.md`

## Notes

This repo is being used both as:

- a practical private agent shell
- a learning vehicle for understanding real agent internals end to end

That means the codebase intentionally favors inspectability and explicit structure over hiding complexity.
