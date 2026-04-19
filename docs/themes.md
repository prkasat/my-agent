# Themes

Themes customize the TUI component palette.

## Built-in themes

- `default`
- `dark`
- `light`

## Discovery

Themes are loaded from:

- `.my-agent/themes/`
- `~/.my-agent/themes/`
- package-provided theme entries

## Supported formats

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

### JS / MJS / CJS

You can also export theme overrides programmatically.

## Theme sections

Common high-value sections:

- `footer`
- `assistantMessage`
- `userMessage`
- `toolExecution`
- `diffViewer`
- `selectList`

## Style token format

Values use Chalk-style tokens such as:

- `bold`
- `cyan`
- `yellow`
- `bgBlue`
- `bgGray`

## Usage

- `/theme`
- `/theme <name>`
- `node packages/cli/dist/main.js --tui`

## Example

See `examples/packages/research-bundle/themes/research-dark.json`.
