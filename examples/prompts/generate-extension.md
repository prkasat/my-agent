---
description: Generate a local my-agent extension starter from a workflow description
---
Create a local my-agent extension for this workflow: $@

Requirements:
- output one file exporting a valid ExtensionDefinition
- include metadata with id/name/version
- keep the extension private-first and trusted-local
- if a slash command is useful, register one
- if tool interception is useful, use ctx.on("tool_execution_start", ...)
- explain how to save and load it from .my-agent/extensions or settings.json
