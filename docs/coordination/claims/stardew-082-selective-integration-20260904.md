# 星露谷 0.8.2 选择性集成

- Task ID: `stardew-082-selective-integration-20260904`
- 状态：完成，待合并到本地 `main`
- 分支与 worktree：`integrate/stardew-0.8.2` / `C:\game\ai-native-game-harness-worktrees\integrate-stardew-0.8.2`
- 目标：将 `origin/codex/stardew-harness-port-0.8.2` 中确认需要的星露谷玩法、表现、Adapter 与语音修复合并到本地 `main`。
- 允许修改：
  - `games/stardew-valley/**`
  - `plugins/xiaotangyuan-game/src/**`
  - `plugins/xiaotangyuan-game/test/**`
  - `tests/integration/**`
  - `tests/platform/**`
  - `apps/desktop/src/main.mjs`（仅注入动态 Adapter Protocol 地址）
  - 本认领文件
- 共享热点：`apps/desktop/src/main.mjs`、`plugins/xiaotangyuan-game/**`（用户已授权本任务执行主线合并）。
- 不修改：自动安装/启动时自动写入、测试默认全解锁、macOS Media Host、语音密钥存储、打包与根脚本重写、公共网站与产品文档、其他任务的 worktree。
- 设计决定：五个固定任务只作为小汤圆技能教学与成长事件；不建立第二套主剧情状态机，主剧情继续由 Harness Story Runtime 负责。
- 验证：星露谷 C# Release 构建 0 警告/0 错误；小汤圆插件 115/115；Integration 48/48；Platform 22/22；`git diff --check`、冲突标记与敏感信息扫描通过。
- 交接：只带入确认的星露谷玩法、表现、Adapter、语音和技能成长代码；保留现有 Gateway 生命周期及回答后动作流程。未复制 Mod 到 Steam，未启动或关闭真实游戏，未构建安装包，未推送远端，没有留下后台进程。
