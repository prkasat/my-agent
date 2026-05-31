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

Structured traces and audit records redact known sensitive value shapes before persistence.
Trace and audit redaction covers provider-style API keys, bearer/basic/token authorization headers, JWTs, and sensitive `KEY=value` assignments.
Still treat local traces, audit logs, and session files as sensitive because user prompts and tool output can contain private project data.

Audit logging can be enabled in embedded/private automation contexts through the exported core audit logger helpers.
Audit redaction is always enabled for file logging and custom handlers.

## Safe mode

Use `--safe-mode` to bypass package extension entries and extension loading when debugging startup issues.

## Helper binaries

Downloaded helper binaries use pinned versions and checksum verification where checksums are known.
Offline mode is respected through `MY_AGENT_OFFLINE=1`.
