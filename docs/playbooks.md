# Maintenance, Upgrade, and Extension-Authoring Playbooks

## Add a new provider

1. implement the provider stream function in `packages/ai/src/providers/`
2. register it in `packages/ai/src/providers/index.ts`
3. add model records in `packages/ai/src/models.ts`
4. if OAuth-backed, add the OAuth provider in `packages/ai/src/providers/oauth.ts`
5. update `packages/cli/src/runtime/model-registry.ts`
6. update docs + tests + capability matrix
7. validate with `--list-models`, `--doctor`, and at least one traced run

## Add a new model family

1. add model records in `packages/ai/src/models.ts`
2. keep provider identity/auth mode coherent
3. update docs/capability-matrix
4. add coverage for selection/fallback behavior
5. validate pricing/context metadata

## Change session format safely

1. update session schema/version constants
2. add forward migration logic where safe
3. keep older readable files working when possible
4. reject future unsupported versions loudly
5. add replay/resume/branch/export coverage

## Change prompt architecture safely

1. update `docs/prompt-behavior.md`
2. add or update eval tasks
3. run `npm run eval:mock`
4. capture traces/replay for representative sessions
5. compare before/after transcripts and profile summaries

## Change extension APIs safely

1. update `docs/extensions-api-reference.md`
2. decide whether the change is additive or breaking
3. bump extension API major version on breaking changes
4. keep examples/starter template aligned
5. add loader/runtime compatibility tests

## Dependency upgrades

- keep `npm ci`, `build`, `test`, and `lint` green before and after upgrades
- prefer additive upgrades with docs/test updates in the same change
- re-run RPC, auth, session, and TUI smoke tests after runtime-facing changes

## TUI dependency upgrade strategy

When upgrading `@earendil-works/pi-tui` or major UI dependencies:

1. build the repo
2. run TUI-focused component tests
3. smoke-test `--tui` manually in an interactive terminal
4. verify overlays, editor focus, tool rows, diff blocks, and footer rendering
5. update `docs/tui.md` / `docs/ui-state.md` if behavior changed

## On-the-fly extension authoring workflow

1. copy `examples/extensions/starter.mjs`
2. keep the first version command-only
3. add tools only after the command contract is useful
4. add middleware only when tool adaptation is actually needed
5. validate with `--safe-mode`, `--trace`, and a focused test
