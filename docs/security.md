# Security and Trust Model

## Product stance

This is a private-first agent.

## Trust boundaries

### Extensions

Extensions are trusted local code.
They are not sandboxed.
If you load one, it has host-process privileges.

### Providers

Credentials are stored in `~/.my-agent/auth.json` with file mode `0600`.

### Permissions

Risky tools are protected by the runtime permission checker.

- read-only tools can be allowed safely
- `bash`, `edit`, and `write` are treated as risky
- destructive commands and protected paths are blocked regardless of mode

### Logging and tracing

Structured traces and audit-style records redact sensitive values before persistence where possible.
Still treat local logs as sensitive.

Audit logging can be enabled in embedded/private automation contexts through the exported core audit logger helpers.

## Safe mode

Use `--safe-mode` to bypass package extension entries and extension loading when debugging startup issues.

## Helper binaries

Downloaded helper binaries use pinned versions and checksum verification where checksums are known.
Offline mode is respected through `MY_AGENT_OFFLINE=1`.
