# Quickstart

## Install

Requirements:

- Node.js 22.19.0 or newer
- npm 11 or newer

```bash
npm ci
npm run build
npm test
npm run lint
```

## First run

```bash
node packages/cli/dist/main.js
```

In an interactive terminal this launches the TUI by default.
Use `--repl` if you want the plain-text fallback.

If no authenticated model is available, startup explains exactly what to do next.

## Happy paths

### OpenRouter bootstrap

```bash
export OPENROUTER_API_KEY=...
node packages/cli/dist/main.js
```

### Anthropic OAuth

```text
/login anthropic
```

### OpenAI Codex OAuth

```text
/login openai-codex
```

## Useful flags

```bash
node packages/cli/dist/main.js --help
node packages/cli/dist/main.js --doctor
node packages/cli/dist/main.js --list-models
node packages/cli/dist/main.js --safe-mode
node packages/cli/dist/main.js --tui
node packages/cli/dist/main.js --trace
node packages/cli/dist/main.js --profile "say hello"
```

## Important paths

- auth: `~/.my-agent/auth.json`
- user settings: `~/.my-agent/settings.json`
- project settings: `<project>/.my-agent/settings.json`
- sessions: `~/.my-agent/sessions/<encoded-cwd>/`
- user prompts: `~/.my-agent/prompts/`
- user skills: `~/.my-agent/skills/`
- user extensions: `~/.my-agent/extensions/`
- user packages: `~/.my-agent/packages/`
- user themes: `~/.my-agent/themes/`
- traces: `~/.my-agent/traces/`

## Everyday commands

- `/help`
- `/model [list|<name>]`
- `/theme [name]`
- `/sessions`
- `/tree`
- `/branch`
- `/templates`
- `/skills`
- `/packages`
- `/extensions`
- `/quit`

## TUI mode

```bash
node packages/cli/dist/main.js
# or explicitly
node packages/cli/dist/main.js --tui
```

`--tui` requires an interactive TTY.
Use `--repl` to force the plain-text fallback.

## Exit codes

- `0` successful completion
- `1` fatal or user-facing runtime error
- `130` interrupted / aborted by Ctrl+C

## Headless / integration mode

```bash
node packages/cli/dist/main.js --rpc
```
