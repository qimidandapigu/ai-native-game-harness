# Desktop Gateway 生命周期稳定性修复

- Task ID: `gateway-lifecycle-20260903`
- 状态：已集成并通过自动化验证
- 分支与 worktree：`task/gateway-lifecycle-20260903` / `F:\game\ai-native-game-harness-worktrees\gateway-lifecycle-20260903`
- 目标：系统解决 Desktop 快速重启或重复启动时 `33145` 端口冲突导致星露谷按 V 静默失效的问题。
- 允许修改：
  - `apps/desktop/src/main.mjs`
  - `plugins/xiaotangyuan-game/src/gateway/game-gateway.ts`
  - `plugins/xiaotangyuan-game/src/index.ts`
  - `plugins/xiaotangyuan-game/test/**`
  - `scripts/smoke-desktop-startup.mjs`
  - `tests/integration/**gateway**`
  - 本 claim 文件
- 共享热点：`apps/desktop/src/main.mjs`、`plugins/xiaotangyuan-game/**`；当前相关历史任务已提交或停止新增写入，本任务使用独立 worktree。
- 不修改：根 `package.json`、锁文件、版本号、游戏 Mod、公开网站和其他任务 claim。
- 验证：小汤圆插件 check、Desktop 隔离启动/退出/端口冲突回归、Integration、Platform、`git diff --check`，以及本机安装版与真实星露谷的分层验收。
- 验证结果：仓库 `pnpm check` 通过，集成测试 14 个文件、40 项通过，平台测试 22 项通过；新增 Gateway 生命周期回归测试 3 项通过。
- 交接：尚未修改本机安装目录，也未启动或关闭真实游戏；真实星露谷和安装版仍需在集成后单独验收。
