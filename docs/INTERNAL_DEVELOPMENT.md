# 内部开发说明

> 面向项目维护者和核心开发者。外部用户请先阅读仓库根目录 [README](../README.md)。

本文记录架构决策、代码边界、当前真实完成度、验证结果、已知问题和发布计划。它允许包含尚未完成或验证失败的内容，不作为对外功能承诺。

## 一句话内部定义

AI Native Game Harness 是基于固定版本 DeepSeek Harness（DSH）构建的游戏产品发行层：DSH 负责模型、Agent、Tool、Session、凭据和权限；本项目负责游戏状态、动作安全、Adapter Protocol、Game Pack、桌面产品界面与游戏侧 Trace。

默认原则是 **DSH-first**。只有经过可复现测试证明 DSH 无法满足的能力，才允许做最小替换。详细决策见 [ADR 0001](decisions/0001-dsh-first-reuse-policy.md)。

## 默认产品主链

```text
Desktop
  → pinned DSH Runtime
  → DSH Agent / Tools
  → dsh-binding
  → Harness Core
  → Game Adapter Protocol
  → Adapter / Native Bridge
  → Game API
  → 权威结果与新状态原路返回
```

各层职责：

- **DSH Runtime**：模型、Agent、Tool Calling、Session、配置、凭据、权限和插件生命周期。
- **Desktop**：管理固定版本 DSH、产品窗口、对话、自学习、分析和 Adapter 中心。
- **dsh-binding**：把 DSH Tool Call 交给 Harness Core，并把 ActionResult 与 Observation 返回 Agent。
- **Harness Core**：Adapter 注册、动作校验、revision、路由和游戏侧 Trace，不重造通用 Agent Runtime。
- **Game Adapter**：提供观察、动作、事件和权威结果。
- **Native Bridge / Mod**：只封装必须在游戏进程内调用的原生 API。
- **Game Pack**：组合 Harness Plugin、Adapter/Bridge、内容、资源、版本、兼容范围和校验信息。

Standalone Platform Runtime 和 Mock Agent 仅用于确定性测试，不是默认产品路径。

## 目录与依赖边界

```text
apps/desktop/                 桌面窗口、产品 IPC 和 DSH 子进程
runtime/dsh-profile/          固定 DSH 版本和发行配置
packages/harness-core/        动作校验、revision、Adapter 路由与 Trace
packages/adapter-protocol/    Adapter 线协议和 Schema
packages/adapter-websocket/   本机跨进程 Host 与参考客户端
packages/dsh-binding/         DSH Agent 与 Harness Core 接线
packages/game-pack/           Game Pack 校验和注册表
plugins/                      跨游戏 DSH 插件
games/<game>/                 每游戏 Adapter、Bridge、内容和发行脚本
examples/                     Mock Game 与第三方 Adapter Starter
tests/                        集成、平台和协议验证
distribution/                 安装包与发布清单
```

依赖保持单向：

```text
dsh-binding → harness-core → adapter-protocol → game adapter
```

归属规则：

- DSH 已提供的能力：装配，不重写。
- 跨游戏运行能力：放入 `plugins/` 或复用型 `packages/`。
- 单个游戏知识和工具：放入对应游戏 Adapter/Harness Plugin。
- 必须调用游戏原生 API：放入薄 Native Bridge。
- 跨语言消息格式：放入协议包或 `contracts/`。
- 安装、版本和校验：放入 Game Pack 或 `distribution/`。

## 自学习边界

自学习复用同一个 DSH Session，不建立第二套 Agent：

- **记忆学习**：按 `gameId + saveId` 隔离；当前 Observation 与真实 Tool 结果优先于历史记忆。
- **技能学习**：候选程序只能调用 Adapter 已声明的 action；必须在真实 Adapter 上逐步试跑，整段成功后才能保存。
- **技能源码 v2**：模型编写受限 TypeScript 风格源码；Harness 自行解析为 AST，只开放变量、条件、有限循环、回退、断言和 Adapter 原子，不执行任意 JavaScript。
- **失败尝试**：只保留诊断记录，不能伪装成已学会技能。
- **产品展示**：记忆、已验证技能和失败尝试分开显示；剧情、等级和角色成长不与技能学习混为一谈。

默认接线：

```text
DSH Session
  → game-learning-binding
  → MemoryService / SkillService
  → Harness Core
  → Adapter Protocol
```

## 当前代码能力

截至 `2026-08-27`：

- 已实现 Harness Core、Adapter Protocol、WebSocket Host、dsh-binding 和 Game Pack 注册表。
- 已提供 Mock Game、第三方 Adapter Starter 和 Adapter conformance 检查。
- Desktop 已有对话页、自学习页、分析页和 Adapter 中心。
- Desktop 默认进入通用 Harness 页面，可通过按钮、菜单、快捷键和游戏页返回按钮在通用页与游戏专属页之间切换。
- 桌面窗口、启动页和游戏页统一使用 AI Native Game Harness 品牌与小汤圆 Logo；上游 Runtime 名称不出现在玩家提示中。
- 分析页可关联 `Session → turn → step → callId → requestId`，显示动作和语音分段耗时。
- 诊断导出限制为最近 500 条 Trace，不包含聊天正文、语音转写或隐藏思维。
- 未知 Adapter 使用受限额、敏感字段过滤的通用 Observation 查看器。
- 游戏 Agent Session 使用 `gameId + saveId` 的脱敏稳定标识；同一存档重连后恢复会话，不同存档保持隔离。
- `xiaotangyuan-skill-v2` 支持变量、条件、最多 10 次循环、`try/catch` 回退、断言和显式失败；旧 `skills-v1.json` 会迁移到 `skills-v2.json` 并保留原文件。
- Harness Core 会在自动 revision 模式下执行前刷新状态，并对一次安全的 `REVISION_CONFLICT` 重新观察后重试；调用者显式指定 revision 时不自动重试。
- 流式 TTS 在已经播放部分音频后失败时不再整段重播；首个音频分片前失败仍允许完整回复兼容回退。
- ONI Adapter 使用 Bridge heartbeat 排除 Windows PID 复用产生的陈旧目录，并验证吸水、喷水动作使用当前光标格。
- ONI Adapter 已接入动态 Adapter Protocol Host，源码版本为 `0.1.6`。
- 小汤圆 Harness Plugin 源码版本为 `0.7.7`；缺氧 Bridge 源码版本为 `0.6.7`。
- 桌面发行 Runtime 固定为 DSH `0.1.1-rc.2`。
- 游戏版 Gateway 使用 `33145`；星露谷和饥荒按 `V`，缺氧按 `Q`。

## 当前验证证据

已通过：

- `pnpm install --frozen-lockfile`
- `pnpm check`
- 28 项集成测试
- 20 项平台测试
- `pnpm check:xiaotangyuan`：饥荒 25 项、反馈服务 4 项、ONI Adapter 14 项、小汤圆插件 84 项测试
- `pnpm desktop:prepare`：构建媒体 Host、插件与 ONI Adapter，完成 Adapter、状态、两轮对话和同存档 Session 恢复冒烟，并准备桌面 Runtime
- 35 个 Markdown 文件的本地链接检查
- HTML V8 浏览器检查：无控制台错误、横向溢出或失效页内链接

未通过或未完成：

- `pnpm smoke:dsh-product`：隔离 Web Runtime 在 ready 前缺少部分 `@deepseek-ai/dsh-client-ui-*` 和 `dsh-agent-presets` 包。
- `pnpm smoke:dsh-adapter`：当前 headless 环境没有完成权威金币 `1`、revision `2` 的成功输出。
- 最新代码拉取后尚未完成真实星露谷、饥荒或缺氧存档验收。
- 主仓库已有 `v1.0.0` 稳定源码 Release，但仍没有正式签名的一键安装包。

因此，自动测试通过只能证明代码和确定性契约，不代表桌面发行 Runtime 或真实游戏已经验收。

## 常用开发命令

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm platform:test
pnpm mock:start
pnpm desktop:demo
```

环境级冒烟：

```powershell
pnpm smoke:dsh-adapter
pnpm smoke:dsh-product
```

两条冒烟不包含在 `pnpm check` 中，必须看到脚本定义的成功结果才算通过。详细排错见 [常见问题与排错](xiaotangyuan/TROUBLESHOOTING.md)。

桌面开发与打包：

```powershell
pnpm desktop:dsh
pnpm desktop:prepare
pnpm desktop:dist
```

## 发布与版本边界

- 唯一源码仓库：`ai-native-game-harness`。
- 旧仓库 `dsh-xiaotangyuan-game` 只保留历史和旧 Release，不再维护第二套源码。
- `1.0` 分支与 `v1.0.0` 标签固定在提交 `a6921ef`，只保存 1.0 稳定源码；后续开发只进入 `main`，不能移动该标签或用开发提交覆盖稳定分支。
- `main` 根工作区版本为 `1.1.0-dev.0`，用来明确区分稳定源码快照和后续开发线；各插件、Adapter 与 Bridge 继续独立版本。
- 主仓库 `v1.0.0` Release 目前只提供 GitHub 自动生成的源码归档，不包含签名安装包。
- 旧仓库公开稳定包仍为 Harness Plugin `0.5.1`、ONI Adapter `0.1.3`。
- `main` 中的 Harness Plugin `0.7.7`、ONI Adapter `0.1.6` 与 Bridge `0.6.7` 仍属于后续开发内容，不能写成 `v1.0.0` 已包含的独立公开安装包。
- 本地构建、代码提交、Git 推送、Git 标签和 GitHub Release 是五个不同状态，必须分别报告。

## 下一步

1. 修复干净环境下的 DSH Product/Adapter Profile 初始化与 hoisted 依赖装配。
2. 按 [真实游戏端到端验收清单](REAL_GAME_ACCEPTANCE.md) 完成至少一个真实存档闭环。
3. 验证安装、状态、文字、语音、Action、失败、重连和诊断关联。
4. 完成第三方 Game Pack 权限授权、可信启动和签名验证。
5. 生成校验和与签名安装包，作为后续主仓库 Release 的可下载资产。

## 相关内部资料

- [独立平台设计](INDEPENDENT_PLATFORM.md)
- [DSH 升级策略](UPGRADING_DSH.md)
- [真实游戏验收清单](REAL_GAME_ACCEPTANCE.md)
- [小汤圆开发说明](xiaotangyuan/DEVELOPMENT.md)
- [安装与升级](xiaotangyuan/INSTALLATION.md)
- [更新记录](xiaotangyuan/CHANGELOG.md)
