# Troubleshooting

## No model is available

Run:

```bash
node packages/cli/dist/main.js --list-models
node packages/cli/dist/main.js --doctor
```

Common fixes:

- set `OPENROUTER_API_KEY`
- run `/login anthropic`
- run `/login openai-codex`

## Broken settings file

Move the file aside and retry:

```bash
mv ~/.my-agent/settings.json ~/.my-agent/settings.json.bak
```

## Broken auth file

Move the file aside and log in again:

```bash
mv ~/.my-agent/auth.json ~/.my-agent/auth.json.bak
```

## Expired or invalid OAuth login

The runtime now treats unrecoverable refresh failures as stale credentials:

- the stored provider login is dropped
- the current command surfaces an actionable re-login message
- you can run `/login anthropic` or `/login openai-codex` immediately without restarting

If a provider returns `401` or `403`, re-authenticate and retry.

## Broken extension or package

Start in safe mode:

```bash
node packages/cli/dist/main.js --safe-mode
```

Then inspect:

- `settings.extensions`
- `settings.packages`
- `.my-agent/extensions/`
- `.my-agent/packages/`

## Session corruption

If a session header is invalid, the CLI surfaces a corruption error instead of silently replacing the file.
For interrupted writes, malformed trailing JSONL lines are skipped automatically.
Use `--replay` to inspect what is still recoverable.

## External helper tools

If helper binaries are missing or offline mode is enabled, tool discovery may fall back to system binaries or fail with a clear error.

## Login cancellation

In REPL and TUI flows, `Ctrl+C` cancels an in-flight login instead of forcing a full restart.

## Debugging loop

```bash
node packages/cli/dist/main.js --doctor
node packages/cli/dist/main.js --trace "say hello"
node packages/cli/dist/main.js --profile "say hello"
```
