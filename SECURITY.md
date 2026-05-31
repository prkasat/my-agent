# Security Policy

## Supported versions

`my-agent` is pre-1.0. Security fixes are expected to land on `main` until a release branch policy exists.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub private vulnerability reporting for `prkasat/my-agent` when available, or contact the maintainer directly through the GitHub repository.

Include:

- affected commit or version
- operating system and Node.js version
- reproduction steps
- expected impact
- whether credentials, local files, traces, sessions, or extension code are involved

## Security model summary

- Credentials are stored locally in `~/.my-agent/auth.json` with restrictive file permissions.
- Extensions are trusted local code and are not sandboxed.
- Risky tools such as shell execution and file mutation go through runtime permission checks.
- Traces and audit records redact known sensitive values where possible, but local logs should still be treated as sensitive.

See `docs/security.md` for the full trust model.
