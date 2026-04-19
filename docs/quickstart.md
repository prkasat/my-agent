# Quickstart

## Install

```bash
npm install
npm run build
npm test
```

## Start the agent

```bash
node packages/cli/dist/main.js
```

Useful flags:

```bash
node packages/cli/dist/main.js --help
node packages/cli/dist/main.js --doctor
node packages/cli/dist/main.js --list-models
node packages/cli/dist/main.js --safe-mode
node packages/cli/dist/main.js --tui
node packages/cli/dist/main.js --trace
```

## Authenticate

### OpenRouter

```bash
export OPENROUTER_API_KEY=...
```

### Anthropic

Start the REPL and run:

```text
/login anthropic
```

### OpenAI Codex / ChatGPT subscription

Start the REPL and run:

```text
/login openai-codex
```

## First-run paths

- sessions: `~/.my-agent/sessions/<encoded-cwd>/`
- auth: `~/.my-agent/auth.json`
- user settings: `~/.my-agent/settings.json`
- user prompts: `~/.my-agent/prompts/`
- user skills: `~/.my-agent/skills/`
- user extensions: `~/.my-agent/extensions/`
- user packages: `~/.my-agent/packages/`
- user themes: `~/.my-agent/themes/`

Project-local resources live under `.my-agent/` inside your repo.

## Core REPL commands

- `/help`
- `/login <provider>`
- `/logout <provider>`
- `/model [list|<name>]`
- `/theme [name]`
- `/sessions`
- `/branch`
- `/templates`
- `/skills`
- `/packages`
- `/extensions`
- `/export [path]`

## TUI mode

```bash
node packages/cli/dist/main.js --tui
```

`--tui` requires an interactive TTY.

## Headless / integration mode

```bash
node packages/cli/dist/main.js --rpc
```

See `docs/rpc.md`.
