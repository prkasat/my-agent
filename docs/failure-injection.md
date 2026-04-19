# Failure Injection and Recovery Guide

This repo already carries a meaningful amount of failure-path test coverage. This guide maps the major failure classes to recovery expectations and the relevant tests.

## Failure matrix

| Failure | Expected behavior | Coverage |
|---|---|---|
| broken settings file | back up file, fall back to defaults | `packages/cli/test/config/settings.test.ts` |
| broken auth file | back up file, recover with empty store | `packages/cli/test/config/auth-storage.test.ts` |
| expired OAuth credential | refresh under lock when resolving API key | `packages/cli/test/config/auth-storage.test.ts` |
| retryable provider errors | retry with backoff | `packages/ai/test/retry.test.ts` |
| aborted run | abort cleanly without corrupting session structure | `packages/core/test/agent-loop.test.ts`, `packages/cli/test/rpc.test.ts` |
| session write failure / disk full | roll back in-memory/on-disk state where possible | `packages/core/test/session/session-manager.test.ts`, `packages/core/test/session/auto-compact.test.ts` |
| corrupt session lines | skip malformed trailing lines, reject invalid headers | `packages/core/src/session/session-manager.ts` + session tests |
| broken extension | skip with warning instead of crashing the run | `packages/cli/test/runtime/extensions.test.ts` |
| incompatible extension API | skip with warning | `packages/core/test/extensions/api-version.test.ts`, `packages/cli/test/runtime/extensions.test.ts` |
| missing helper in offline mode | return clear error instead of hanging | `packages/core/test/tools/tools-manager.test.ts` |

## Provider failure recipes

### Retryable provider failure

See:

- `packages/ai/test/retry.test.ts`

The shared retry helper covers:

- 429
- 500
- 502
- 503

### Abort / interrupted stream

See:

- `packages/ai/test/anthropic.test.ts`
- `packages/core/test/agent-loop.test.ts`
- `packages/cli/test/rpc.test.ts`

## Session / disk failure recipes

### Corrupt settings or auth file

Manual recovery path:

```bash
mv ~/.my-agent/settings.json ~/.my-agent/settings.json.bak
mv ~/.my-agent/auth.json ~/.my-agent/auth.json.bak
```

Automatic runtime behavior:

- corrupted files are backed up to `*.corrupt-<timestamp>`
- the app starts from a safe empty/default state

### Simulated disk-full / persist failure

See:

- `packages/core/test/session/session-manager.test.ts`
- `packages/core/test/session/auto-compact.test.ts`

Those tests intentionally force write failures to verify rollback and recovery behavior.

## Extension failure recipes

### Broken extension activation

Expected behavior:

- skip the extension
- warn clearly
- continue startup / continue the run

### Incompatible extension API version

Expected behavior:

- skip the extension
- include the declared `apiVersion` and host version in the warning

## Operator playbook

When validating a risky change, run this set:

```bash
npm run build
npm test
npm run lint
npm run eval:mock
node packages/cli/dist/main.js --doctor
```

Then specifically exercise:

- safe mode: `node packages/cli/dist/main.js --safe-mode`
- model diagnostics: `node packages/cli/dist/main.js --list-models`
- trace + replay: `--trace`, then `--replay`

## Remaining future work

The repo now documents and covers the main local failure modes, but the following are still worth expanding over time:

- provider 5xx and malformed stream fixtures per provider path
- explicit network interruption fixtures
- more systematic extension crash matrices across startup/dispatch/shutdown
- live-provider chaos runs during long dogfooding sessions
