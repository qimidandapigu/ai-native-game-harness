# 轻量真实游戏稳定性验收

- Task ID: `stability-lite-20260903`
- 状态：待集成
- 分支与 worktree：`task/stability-lite` / `F:\game\ai-native-game-harness-worktrees\stability-lite`
- 目标：复用现有诊断、重连和超时能力，增加一个无需服务器的本地稳定性采集与安全故障检查入口。
- 允许修改：
  - `scripts/real-game-stability-lite.ps1`
  - `tests/stability/**`
  - `docs/testing/LIGHTWEIGHT_GAME_STABILITY.md`
  - `docs/coordination/claims/stability-lite-20260903.md`
- 共享热点：无。
- 不修改：`package.json`、锁文件、Desktop 主进程、插件配置、游戏 Mod 和安装目录。
- 验证：PowerShell 语法通过；4 秒本地采样通过；现有平台断线重连 1/1、诊断 4/4、缺氧故障用例 2/2 通过；无 Gateway/游戏时能返回失败；`git diff --check` 通过。
- 交接：新增一个本地脚本和一份使用说明；不构建安装包，不启动或修改真实游戏，不变更正式 DSH Profile。真实一小时游戏运行仍需在 Desktop 与游戏已启动后执行。
