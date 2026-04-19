# Providers and Auth Policy

This repo follows a deliberately narrow provider/auth policy.

## Supported provider identities

- `openrouter`
- `anthropic`
- `openai-codex`

## Supported auth modes

- `openrouter` → API key only
- `anthropic` → OAuth only
- `openai-codex` → OAuth only

There is intentionally **no generic API-key auth path** for Anthropic or OpenAI Codex in the product contract.

## Why `openai-codex` is separate

`openai-codex` means the ChatGPT subscription / Codex OAuth-backed path.
It is **not** the same thing as generic OpenAI Platform API-key usage.
That separation keeps auth UX, model visibility, and provider behavior coherent.

## Model visibility

Visible/selectable models come from the model registry and are filtered by auth state.

Examples:

- no OpenRouter key → OpenRouter models are unavailable with a clear reason
- no Anthropic OAuth session → Claude models are unavailable with a clear reason
- no OpenAI Codex OAuth session → Codex models are unavailable with a clear reason

## Login flows

### OpenRouter

Use:

- `OPENROUTER_API_KEY`
- or an `auth.json` entry with `type: "api_key"`

### Anthropic

Use `/login anthropic`.
The CLI opens the browser, handles the callback server, and stores refreshable OAuth credentials.

### OpenAI Codex

Use `/login openai-codex`.
The CLI supports browser callback flow and manual paste fallback.

## Logout

```text
/logout anthropic
/logout openai-codex
```

## Diagnostics

```bash
node packages/cli/dist/main.js --doctor
node packages/cli/dist/main.js --list-models
```
