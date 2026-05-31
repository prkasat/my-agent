# Versioning, Changelog, and Release Checklist

## Versioning policy

- use semver for the CLI package version
- bump minor for additive user-facing features
- bump major for breaking CLI/RPC/session contract changes

## Changelog policy

Track at least:

- user-facing features
- provider/model changes
- auth changes
- session format changes
- extension API changes
- RPC protocol changes

## Release checklist

1. `npm ci`
2. `npm run lint`
3. `npm run build`
4. `npm test`
5. `npm run eval:mock`
6. `npm audit --audit-level=moderate`
7. run `--doctor`
8. run `--list-models`
9. smoke-test one-shot, REPL, and RPC mode
10. update docs when behavior changed
11. review security/trust-model impact
