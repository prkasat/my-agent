# Migration Policies

This document defines how durable formats evolve without surprising users.

## 1. Session format migration policy

Source of truth:

- `packages/core/src/session/types.ts`
- `packages/core/src/session/session-manager.ts`

Policy:

1. sessions are versioned explicitly
2. older readable formats should be migrated forward when safe
3. future unsupported versions are rejected loudly
4. malformed trailing lines are treated as crash residue, not silently normalized history
5. every migration must ship with replay / resume / branch / compaction coverage

## 2. Settings migration policy

Source of truth:

- `packages/cli/src/config/settings.ts`

Current model:

- settings are merged from defaults, user settings, then project settings
- unknown keys are preserved unless a future migration explicitly removes them
- corrupted JSON is backed up to `settings.json.corrupt-*` and defaults are used

Policy:

1. additive fields are preferred
2. changed defaults must keep first-run behavior coherent
3. if a stored model becomes invalid, normalization must repair or reject it cleanly
4. breaking structural changes should introduce an explicit `version` field before rollout
5. migration behavior must be documented in `settings.md` and tested in `packages/cli/test/config/settings.test.ts`

## 3. Auth storage migration policy

Source of truth:

- `packages/cli/src/config/auth-storage.ts`

Current compatibility:

- supports wrapped `{"credentials": {...}}` shape
- supports legacy raw record shape for backwards compatibility
- backs up corrupted files to `auth.json.corrupt-*`

Policy:

1. keep raw-record compatibility until a deliberate breaking release removes it
2. never silently reinterpret one provider's credential type as another
3. secure permissions (`0600`) are required after every save
4. concurrent refresh/write behavior must remain lock-protected
5. auth migrations must preserve provider ids and refreshability semantics

## 4. Extension API compatibility policy

Source of truth:

- `packages/core/src/extensions/types.ts`
- `packages/core/src/extensions/version.ts`

Current host API version:

```text
1.0.0
```

Policy:

1. additive host changes should keep the same major API version
2. breaking host changes must bump the extension API major version
3. extensions may declare `metadata.apiVersion`
4. incompatible extensions are skipped with warnings by default instead of crashing the app
5. docs/examples must be updated together with breaking extension API changes

## 5. Release discipline for migrations

Every durable-format or compatibility change must do all of the following:

- update docs
- add or update tests
- add an ADR when the change affects long-term structure
- validate replay/export/recovery paths
- update `docs/release.md` checklist if operator workflow changes
