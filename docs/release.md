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

1. `npm run lint`
2. `npm run build`
3. `npm test`
4. run `--doctor`
5. run `--list-models`
6. smoke-test one-shot, REPL, and RPC mode
7. update docs when behavior changed
8. review security/trust-model impact
