# Capability Matrix

| Model | Provider | Auth | Tools | Streaming | Thinking | Context | Notes |
|---|---|---|---|---|---|---:|---|
| openrouter-auto | openrouter | api_key | yes | yes | yes | 200k | default bootstrap model |
| qwen3.6-plus | openrouter | api_key | yes | yes | yes | 1M | large context |
| trinity-large | openrouter | api_key | yes | yes | no | 131k | no thinking support |
| claude-sonnet-4 | anthropic | oauth | yes | yes | yes | 200k | balanced Claude option |
| claude-opus-4 | anthropic | oauth | yes | yes | yes | 200k | highest-cost Claude option |
| claude-haiku-3.5 | anthropic | oauth | yes | yes | no | 200k | lower-cost Claude option |
| gpt-5.1-codex | openai-codex | oauth | yes | yes | yes | 200k | ChatGPT subscription path |
| gpt-5.1-codex-mini | openai-codex | oauth | yes | yes | yes | 200k | smaller Codex option |

## Fallback policy

- use the configured model when authenticated
- otherwise choose the best authenticated fallback from the registry
- if nothing is authenticated, surface clear next steps instead of crashing
