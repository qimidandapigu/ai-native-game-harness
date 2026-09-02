# 开源仓库 Git 整理与提交

- Task ID: `git-maintenance-20260903`
- 状态：集成中
- 分支与 worktree：`feat/public-runtime-integration-20260903` / `F:\game\ai-native-game-harness`
- 目标：保留本地遗留成果，接入最新 `origin/main`，按产品模型、游戏动作和桌面测评拆分正式提交并推送 PR。
- 允许修改：现有 WIP 提交涉及的源码、测试与对应 claim；只做冲突修复、提交拆分和验证所需调整。
- 共享热点：`apps/desktop/src/main.mjs`、`integrations/xiaotangyuan/desktop.patch.yml`（本任务为用户明确授权的合并管理任务）。
- 不修改：根 `package.json`、`pnpm-lock.yaml`、安装器、Steam Mods、本机正式 DSH Profile、商业仓库源码。
- 验证：`git diff --check`、`pnpm check`、小汤圆插件检查、ONI Adapter 检查、ONI C# Release build。
- 交接：商业仓库仅完成克隆、依赖安装和自动检查；本任务不发布版本，也不声称完成真实游戏、真实语音或安装器验收。
