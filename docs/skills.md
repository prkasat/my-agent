# Skills

Skills are lightweight task-specific prompt resources.

They are intentionally simpler than extensions.

## What a skill is

A skill is a local file that defines:

- a command name
- a description
- a prompt body
- optional aliases

## Discovery

Skills are loaded from:

- `.my-agent/skills/`
- `~/.my-agent/skills/`
- `settings.skills`
- package-provided skill directories

## Formats

### Markdown with frontmatter

```md
---
description: Research a topic deeply
command: research
aliases: investigate, brief
---
Research this topic: $@
```

### JSON

```json
{
  "name": "Research",
  "description": "Research a topic deeply",
  "command": "research",
  "aliases": ["investigate", "brief"],
  "prompt": "Research this topic: $@"
}
```

## Arguments

Supported substitutions:

- `$1`
- `$2`
- `$@`
- `$ARGUMENTS`
- `${@:N}`
- `${@:N:L}`

## REPL commands

- `/skills`
- `/<skill-name> ...`

## Example

See `examples/packages/research-bundle/skills/research.md`.
