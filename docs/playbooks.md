# Maintenance and Upgrade Playbooks

## Add a new provider

1. implement the provider stream function in `packages/ai/src/providers/`
2. register it in `packages/ai/src/providers/index.ts`
3. add models in `packages/ai/src/models.ts`
4. if OAuth-backed, add an OAuth provider in `packages/ai/src/providers/oauth.ts`
5. update `packages/cli/src/runtime/model-registry.ts`
6. add docs + tests

## Add a new model family

1. add model records in `packages/ai/src/models.ts`
2. keep provider identity/auth mode coherent
3. update docs/capability matrix
4. add coverage for selection/fallback behavior

## Change session format safely

1. add a schema/versioned migration in the session layer
2. keep older compatible files readable when possible
3. fail loudly on future-version files
4. add tests for migration and replay behavior

## Change prompt architecture safely

1. document the new composition order
2. add or update eval tasks
3. run trace/replay on representative sessions
4. compare before/after transcripts

## Change extension APIs safely

1. update docs/extensions-api-reference.md
2. preserve backward compatibility when possible
3. add example updates
4. add loader/runtime tests

## Dependency upgrades

- keep `build`, `test`, and `lint` green before and after upgrades
- prefer additive upgrades with docs/test updates in the same change
- re-run RPC, auth, and session smoke tests after TUI/runtime dependency changes
