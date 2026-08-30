# AI Native Game Harness 协作规则

本仓库可能被多个 Codex 任务同时使用。开始任何修改前，必须先阅读：

- `docs/coordination/README.md`
- `docs/coordination/STATUS.md`
- `docs/coordination/claims/` 中与当前任务对应的认领文件

## 强制规则

1. 先执行 `git status --short --branch`，把已有改动视为其他任务的成果；不得覆盖、还原或顺手整理。
2. 同一文件同一时间只能有一个写入者。新任务默认使用独立 branch + worktree；只有合并管理任务可以在共享 `main` 中整合。
3. 开始写代码前，在 `docs/coordination/claims/` 新建或更新当前任务自己的认领文件。只修改自己的认领文件，不修改其他任务的认领文件。
4. 下列文件属于共享热点，未经合并管理任务协调不得修改：
   - `package.json`、`pnpm-lock.yaml`
   - `integrations/xiaotangyuan/manifest.json`
   - `apps/desktop/electron-builder.config.mjs`
   - `apps/desktop/src/main.mjs`
   - `plugins/xiaotangyuan-game/package.json`
   - `plugins/xiaotangyuan-game/cordis.patch.yml`
   - `scripts/integrate-xiaotangyuan-plugin.ps1`
   - `scripts/prepare-desktop-runtime.ps1`
   - `README.md`、`docs/AI_GAME_ENGINE_IDEOLOGY.html`
5. 同一时间只能有一个任务执行桌面安装包构建、安装本机游戏版、更新 DSH profile 或复制文件到 Steam Mods 目录。
6. 未经用户明确要求，不得提交、推送、拉取合并、变基、发布版本或改写 Git 历史。禁止使用 `git reset --hard`、`git checkout --` 清理他人改动。
7. `distribution/`、`.artifacts/`、`dist/`、`bin/`、`obj/` 是生成结果，不是多任务交换源代码的渠道。集成以源文件和可复现命令为准。
8. 完成任务时必须报告：修改文件、未修改的共享热点、执行的验证、尚未验证的真实游戏/安装结果，以及是否留下后台进程。

## 最低验证

按改动范围选择最小充分验证；不要因为其他任务的无关失败而擅自修复其文件。

- 小汤圆插件：`pnpm --filter @qimidandapigu/dsh-xiaotangyuan-game run check`
- Work Orchestrator：`pnpm --filter @qimidandapigu/dsh-work-orchestrator run check`
- 平台：`pnpm --filter @ai-native-game-harness/platform-tests test`
- Git 文本检查：`git diff --check`

验证通过只代表相应自动测试；不得把它表述为已完成真实游戏、真实语音或安装器验收。
