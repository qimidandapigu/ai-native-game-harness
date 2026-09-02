# 双仓库商业稳定性收口

- Task ID: `release-readiness-20260903`
- 状态：集成与自动化验证完成，待提交推送
- 分支与 worktree：`task/release-readiness-20260903` / `F:\game\ai-native-game-harness-worktrees\release-readiness-20260903`
- 目标：集成 Desktop Gateway 生命周期、Windows 安全自动更新和轻量真实游戏稳定性采集，并同步更新公开文档与 GitHub Pages HTML。
- 允许修改：上述任务已声明文件、`README.md`、`site/index.html`、`site/developers.html`、`site/ideology.html`、`docs/INTERNAL_DEVELOPMENT.md` 与本 claim。
- 共享热点：`apps/desktop/src/main.mjs` 已在本集成分支解决生命周期与更新器重叠；不再并行修改。
- 不修改：`apps/beta-key-manager/`、游戏安装目录、真实存档、正式 DSH Profile、商业账号/支付源码。
- 验证结果：仓库集成测试 45 项、平台测试 22 项、小汤圆插件 113 项、饥荒 25 项、ONI Adapter 15 项、Work Orchestrator 7 项均通过；Desktop 单实例隔离烟测通过且残留进程为 0；稳定性 4 秒短采样、HTML 链接/资源/锚点与 `git diff --check` 通过。
- 边界：Windows 更新发布工作流只上传手动触发的 Release 资产，本次代码合并不触发更新源发布；macOS 仍是明确路线图，不声明已完成。
