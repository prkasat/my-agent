# Themes

Themes customize the TUI component palette.

## Discovery

Themes are loaded from:

- `.my-agent/themes/`
- `~/.my-agent/themes/`
- package-provided theme entries

## Formats

### Declarative JSON

```json
{
  "name": "night",
  "footer": {
    "background": "bgBlue",
    "model": "bold white"
  },
  "assistantMessage": {
    "label": "bold green"
  }
}
```

Values use Chalk style tokens such as:

- `bold`
- `cyan`
- `yellow`
- `bgBlue`
- `bgGray`

### JS / MJS / CJS

You can also export theme overrides programmatically.

## REPL command

- `/theme`
- `/theme <name>`

## Example

See `examples/packages/research-bundle/themes/research-dark.json`.
