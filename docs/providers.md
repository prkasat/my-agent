# Providers and Auth Policy

This repo intentionally follows a narrow, coherent provider strategy.

## Product contract

| Provider | Identity | Auth mode | Why |
|---|---|---|---|
| OpenRouter | `openrouter` | API key | simplest bootstrap + broad model coverage |
| Anthropic | `anthropic` | OAuth | subscription-style private daily-driver path |
| OpenAI Codex | `openai-codex` | OAuth | ChatGPT subscription / Codex path |

There is intentionally **no generic API-key auth path** for Anthropic or OpenAI Codex in the v1 product contract.

## Why `openai-codex` is separate

`openai-codex` means the ChatGPT subscription / Codex OAuth-backed path.
It is **not** the same thing as generic OpenAI Platform API usage.

That separation keeps:

- login UX coherent
- model visibility coherent
- auth failure messages actionable
- provider behavior easy to reason about

## Auth-aware model visibility

Visible models come from the model registry and are filtered by current auth state.

```ts
const availability = await listModelAvailability(authStorage);
const { key, model } = await resolveConfiguredModel(settings, authStorage);
```

If a model is unavailable, the registry explains why:

- missing OpenRouter key
- missing Anthropic OAuth session
- missing OpenAI Codex OAuth session

## Login flows

### OpenRouter

Use either:

- `OPENROUTER_API_KEY`
- or an `auth.json` credential with `type: "api_key"`

### Anthropic

```text
/login anthropic
```

Behavior:

- browser callback flow
- manual paste fallback
- refreshable OAuth credentials
- stored in unified auth storage

### OpenAI Codex

```text
/login openai-codex
```

Behavior:

- browser callback flow
- manual paste fallback
- token refresh
- account-linked metadata is persisted for backend use

## Logout

```text
/logout anthropic
/logout openai-codex
```

## Unified auth storage

Credentials live in:

```text
~/.my-agent/auth.json
```

Supported credential shapes:

```json
{
  "credentials": {
    "openrouter": { "type": "api_key", "key": "..." },
    "anthropic": {
      "type": "oauth",
      "accessToken": "...",
      "refreshToken": "...",
      "expiresAt": 1760000000000
    }
  }
}
```

Compatibility notes:

- legacy raw-record auth files are still read
- corrupted files are backed up and recovered empty
- writes re-apply secure file permissions
- OAuth refresh is lock-protected

## Diagnostics

```bash
node packages/cli/dist/main.js --doctor
node packages/cli/dist/main.js --list-models
```

## Related docs

- `settings.md`
- `migrations.md`
- `capability-matrix.md`
- `troubleshooting.md`
