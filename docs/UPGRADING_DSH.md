# Updating DeepSeek Harness

AI Native Game Harness pins one tested DSH version in `runtime/dsh-profile/versions.json` and the root `package.json`.

Check the npm registry without changing the workspace:

```powershell
pnpm dsh:update:check
```

An update is intentionally not applied automatically. For each candidate version:

1. Create a dedicated upgrade change.
2. Update the exact `@deepseek-ai/dsh` version and all directly consumed `@deepseek-ai/dsh-*` package versions together.
3. Run `pnpm install` and `pnpm check`.
4. Run `pnpm integration:xiaotangyuan` against the current XiaoTangYuan source package.
5. Run the real Stardew Valley, Don't Starve Together, and Oxygen Not Included smoke tests.
6. Merge only after compatibility passes, then build a new desktop release.

The installed application should update only to a signed AI Native Game Harness release. It must not independently replace its embedded DSH runtime from npm.

## Current compatibility evidence

- Pinned release baseline: `0.1.0-rc.6`.
- Registry candidate checked on 2026-08-23: `0.1.1-rc.2`.
- XiaoTangYuan Harness Plugin `0.7.7` compiles and starts its WebSocket Gateway under both versions with optional media, memory and feedback features disabled for the smoke run.
- The plugin still declares the `0.1.0-rc.6` peer family. Before changing the product pin, update those peer declarations together and repeat the full workspace plus real-game matrix.

This evidence means the candidate is upgradeable; it does not make npm latest an automatic production update.
