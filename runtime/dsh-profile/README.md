# DSH game profile

This directory owns the pinned DeepSeek Harness composition used by the desktop distribution.

- `versions.json` records the compatibility baseline.
- `game.patch.yml` adds the shared game services to a DSH profile.
- Workspace packages are linked by pnpm during development. A release installs packed, checksummed artifacts instead.

The profile composes DSH; it does not replace the DSH runtime.
