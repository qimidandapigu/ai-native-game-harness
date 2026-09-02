# 开源核心与产品化边界文档

- Task ID: `docs-product-boundary-20260902`
- 状态：完成
- 分支与 worktree：`task/docs-product-boundary-20260902` / `C:\game\ai-native-game-harness-worktrees\automated-acceptance`
- 目标：更新公共文档与官网 HTML，解释开源本地核心和可选产品服务的边界，不引入私有仓库依赖或源码。
- 允许修改：
  - `README.md`
  - `docs/INTERNAL_DEVELOPMENT.md`
  - `site/index.html`
  - `site/developers.html`
  - 本 claim
- 共享热点：`README.md`（用户明确要求本轮更新并提交；独立 worktree 隔离修改）
- 不修改：商业登录、计费、支付、部署、Provider 路由源码；公共 Runtime、协议、插件与游戏 Adapter。
- 验证：玩家页与开发者页本地浏览器检查均无横向溢出、无控制台错误；页面未出现私有仓库名，玩家 Work 区未出现 Worker/Session 内部术语；`git diff --check` 待提交前执行。
- 交接：文档与 HTML 已完成并通过本地浏览器检查；由本分支独立提交并推送公共仓库。
