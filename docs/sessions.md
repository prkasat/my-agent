# Sessions, Branching, and Export

Sessions are append-only JSONL logs.

## Where they live

Per-project sessions live under:

```text
~/.my-agent/sessions/<encoded-cwd>/
```

## Key properties

- durable append-only format
- resumable across restarts
- branching without destructive history rewrites
- export to standalone HTML
- tolerant of malformed trailing lines from interrupted writes

## REPL flows

### Continue recent session

Default behavior when starting the CLI in a repo.

### List sessions

```text
/sessions
```

### Branch

```text
/branch
```

This forks the current leaf into a new session file.

### Export

```text
/export
/export my-session.html
```

## Recovery model

- malformed trailing JSONL lines are skipped during load
- invalid headers are treated as corruption and surfaced clearly
- future-version session files are rejected loudly instead of being misread

## Replay

You can inspect a session timeline with:

```bash
node packages/cli/dist/main.js --replay path/to/session.jsonl
```
