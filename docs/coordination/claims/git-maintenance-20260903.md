# 开源仓库 Git 整理与提交

- Task ID: `git-maintenance-20260903`
- 状态：完成，待推送与 PR
- 分支与 worktree：`feat/public-runtime-integration-20260903` / `F:\game\ai-native-game-harness`
- 目标：保留本地遗留成果，接入最新 `origin/main`，按产品模型、游戏动作和桌面测评拆分正式提交并推送 PR。
- 允许修改：现有 WIP 提交涉及的源码、测试与对应 claim；只做冲突修复、提交拆分和验证所需调整。
- 共享热点：`apps/desktop/src/main.mjs`、`integrations/xiaotangyuan/desktop.patch.yml`（本任务为用户明确授权的合并管理任务）。
- 不修改：根 `package.json`、`pnpm-lock.yaml`、安装器、Steam Mods、本机正式 DSH Profile、商业仓库源码。
- 验证：`git diff --check` 通过；`pnpm check` 的 Integration 37/37、Platform 22/22 通过；小汤圆插件 111/111 通过；ONI Adapter 修复 Windows 文件占用重试后连续三轮 15/15 通过；ONI C# Release build 0 error，保留 2 个既有程序集版本 warning。
- 交接：商业仓库已完成克隆、依赖安装、14 个测试和密钥扫描；开源遗留成果已按模型绑定、回复后动作、桌面自动测评和 Windows 文件桥修复拆分提交。本任务不发布版本，也不声称完成真实游戏、真实语音或安装器验收；`apps/beta-key-manager/` 仅有未提交的本地生成缓存，未纳入 Git。
