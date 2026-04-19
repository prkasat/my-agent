# Packages

Packages bundle reusable resources together.

A package can provide:

- prompts
- skills
- extensions
- themes

## Manifest

Use `my-agent.package.json`:

```json
{
  "name": "research-bundle",
  "description": "Example non-coding workflow bundle",
  "prompts": ["prompts"],
  "skills": ["skills"],
  "extensions": ["extensions/research-capture.mjs"],
  "themes": ["themes/research-dark.json"]
}
```

## Discovery

Packages are discovered from:

- `settings.packages`
- `.my-agent/packages/`
- `~/.my-agent/packages/`

## REPL commands

- `/packages`

## Failure handling

Package load failures are downgraded into warnings where possible.
Broken packages should not prevent the whole CLI from starting.

## Example

See `examples/packages/research-bundle/`.
