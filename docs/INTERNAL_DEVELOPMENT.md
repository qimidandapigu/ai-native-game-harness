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
- **Work Orchestrator**：回答结束后识别通用工作，关联独立 Worker DSH Session，并把公开更新交回原陪伴 Session；它不属于小汤圆、游戏 Adapter 或 Desktop UI。
- **Desktop**：管理固定版本 DSH、产品窗口、对话、动态剧情、自学习、分析和 Adapter 中心。
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
packages/story-runtime/       StoryBeat 校验、推进与按存档持久化
plugins/                      跨游戏 DSH 插件
  dsh-work-orchestrator/      通用回答后工作识别与 Worker DSH Session 编排
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

## 通用工作编排边界

`@qimidandapigu/dsh-work-orchestrator` 是独立标准 DSH 插件，不是小汤圆内部模块：

```text
陪伴角色 DSH Session 完成本轮回答
  → Work Orchestrator 后台识别 start / continue / inspect
  → 创建或恢复独立 Worker DSH Session
  → Worker 复用当前 DSH 插件、技能和工具执行
  → 公开更新回到原陪伴 Session 自然转述
```

- 不增加 `work_task_create` 工具，不要求玩家操作任务中心。
- 调用者只提供角色名称、Worker 补充规则、汇报规则和可选通知出口。
- Worker 对话内容由 DSH Session 持久化；插件只保存来源 Session 到 Worker Session 的稳定关联。
- 新关联使用 `dsh-work-*`，并迁移已有 `xiaotangyuan-work-*` 关联。
- 小汤圆与 Desktop Learning Binding 都只注入 `workOrchestrator` 服务，不反向拥有其生命周期。

## 动态剧情边界

剧情生成复用默认 DSH Session，不建立“剧情 Agent”或第二套模型链：

```text
当前 DSH Session
  → game_story_context 读取世界观、历史、玩家选择、Adapter 能力和 Observation
  → 模型滚动提出 1–3 个 StoryBeat-v1
  → game_story_propose
  → story-runtime 校验并按 gameId + saveId 保存
  → 新 Observation 证明完成或失败
```

- **Game Pack** 的 `content.narrative` 只保存世界观、主题、允许目标、禁止编造事项和节奏约束，不保存必须按顺序执行的固定剧情树。
- **`story-runtime`** 是不依赖 DSH 的纯状态机：限制滚动计划规模、校验事实路径与 Adapter action、保存不可回写的历史，并处理选择与结局。
- **`dsh-story-generator`** 是标准 DSH 插件：向同一个 Session 暴露 `game_story_context`、`game_story_propose`、`game_story_choose`。
- **Adapter Observation** 是完成条件的唯一权威；模型只能提出叙事，不能自己宣布游戏事实已经发生。
- 第一版不把角色等级、自学习技能或长期记忆合并进 Story State，它们通过清晰接口协作。

## 当前代码能力

截至 `2026-08-29`：

- 已实现 Harness Core、Adapter Protocol、WebSocket Host、dsh-binding 和 Game Pack 注册表。
- 已将回答后的通用工作能力拆为独立 Work Orchestrator DSH 插件；小汤圆和 Desktop Binding 通过服务注入复用。
- 已提供 Mock Game、第三方 Adapter Starter 和 Adapter conformance 检查。
- Desktop 已有对话页、动态剧情页、自学习页、分析页和 Adapter 中心。
- 已实现 `StoryBeat-v1`、滚动生成校验、按 `gameId + saveId` 持久化、Adapter Observation 自动推进和 DSH 三个剧情 Tool；Mock Game 已覆盖虚构事实拒绝与“移动 → 拾取金币 → 剧情完成”。
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
- Work Orchestrator 插件源码版本为 `0.1.2`；小汤圆 Harness Plugin 源码版本为 `0.7.9`；缺氧 Bridge 源码版本为 `0.6.7`。
- 桌面发行 Runtime 固定为 DSH `0.1.1-rc.2`。
- 游戏版 Gateway 使用 `33145`；星露谷和饥荒按 `V`，缺氧按 `Q`。

## 真实游戏开发截图

以下画面来自项目开发验证记录，用于说明 AI 伙伴在《星露谷物语》《缺氧》和《饥荒联机版》中的角色呈现、环境回应、能力成长和玩法参与方向。截图本身不代替当前 `main` 的真实存档端到端验收，也不表示与游戏官方存在合作关系；游戏名称、画面与原始素材权利归各自权利方所有。

| 农场成长 | 玩法互动 | 环境回应 |
| --- | --- | --- |
| ![小汤圆与玩家观察巨大作物](../site/games/stardew-valley-giant-crop.jpg) | ![小汤圆在向日葵田参与互动玩法](../site/games/stardew-valley-sunflower-flight.jpg) | ![小汤圆在雨天场景回应玩家](../site/games/stardew-valley-rainy-companion.jpg) |

| 缺氧角色陪伴 | 缺氧环境技能 | 饥荒行动学习 |
| --- | --- | --- |
| ![缺氧殖民地中小汤圆陪伴复制人](../site/games/oxygen-not-included-companion.png) | ![缺氧中小汤圆解锁吸水与喷水能力](../site/games/oxygen-not-included-water-skill.png) | ![饥荒联机版中小汤圆回应捕捉蝴蝶目标](../site/games/dont-starve-together-skill-learning.png) |

## 当前验证证据

已通过：

- `pnpm install --frozen-lockfile`
- `pnpm check`
- 30 项集成测试
- 21 项平台测试
- 独立 Work Orchestrator：5 项测试
- 小汤圆插件：103 项测试
- 饥荒、反馈服务和 ONI Adapter 另有各自的自动检查
- `pnpm desktop:prepare`：构建媒体 Host、插件与 ONI Adapter，完成 Adapter、状态、两轮对话和同存档 Session 恢复冒烟，并准备桌面 Runtime
- `pnpm desktop:dist`：已生成 284,176,643 字节的 Windows NSIS 安装包，包含 DSH `0.1.1-rc.2`、小汤圆插件 `0.7.7`、ONI Adapter `0.1.6` 和自包含媒体 Host
- 安装器隔离验收：在不提供系统 Node/pnpm 的 PATH 下启动安装后应用，Electron Renderer、内置 DSH NodeService 与 `XtyMediaHost.exe` 正常运行，本地 DSH 页面返回 HTTP 200；短路径静默卸载返回 0 并完整删除安装目录
- 安装包敏感信息检查：未命中本机用户路径、维护者邮箱、VibeCafé 浏览器标识和常见私密 Token 模式；已生成 SHA256 校验文件
- 35 个 Markdown 文件的本地链接检查
- HTML V8 浏览器检查：无控制台错误、横向溢出或失效页内链接

环境级冒烟当前基线：

- `pnpm smoke:dsh-product`：已通过隔离 Web Runtime 启动与产品 Session 验证。
- `pnpm smoke:dsh-adapter`：已通过真实 DSH Tool → WebSocket Mock Adapter，并得到权威金币 `1`、revision `2`。
- `pnpm smoke:dsh-story`：当前 headless DSH 模型会读取 narrative policy，自行生成 StoryBeat 文本，提交并通过 Runtime 校验，驱动 Mock Adapter 完成金币目标；第二次 DSH 启动能读回同一条 `completed` 历史和 revision `2` 证据。

未完成：

- 动态剧情已通过确定性 ToolRuntime 测试和单次真实 DSH 模型冒烟，但尚未用真实游戏存档、长时间多轮生成和多次模型样本验收剧情质量、连续性、重复率与玩家选择体验。
- 最新代码拉取后尚未完成真实星露谷、饥荒或缺氧存档验收。
- 主仓库已有 `v1.0.0` 稳定源码 Release，`main` 已有经过本机安装—启动—卸载验收的未签名 NSIS 产物，但仍没有正式签名并上传 Release 的一键安装包。
- 安装包当前约 271 MiB、解压约 684 MiB；完整 DSH 依赖树使首次安装偏慢。极长自定义安装目录还可能触发传统 Windows `MAX_PATH`，短路径安装与卸载已验证无残留。

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
pnpm smoke:dsh-story
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
- `main` 中的 Work Orchestrator `0.1.2`、Harness Plugin `0.7.9`、ONI Adapter `0.1.6` 与 Bridge `0.6.7` 仍属于后续开发内容，不能写成 `v1.0.0` 已包含的独立公开安装包。
- 本地构建、代码提交、Git 推送、Git 标签和 GitHub Release 是五个不同状态，必须分别报告。

## 下一步

1. 建立长剧情自动验收：连续运行 20–50 个 StoryBeat，量化 grounding、连续性、重复率、玩家选择、拒绝修复和重启恢复。
2. 在方便真实测试时，用实际语音交互记录区分 ASR、模型首字、Agent、TTS、游戏动作和总耗时，不凭主观感受调优。
3. 按 [真实游戏端到端验收清单](REAL_GAME_ACCEPTANCE.md) 完成至少一个真实存档闭环，覆盖状态、文字、语音、Action、剧情推进、失败、重连和诊断关联。
4. 裁剪安装包中的非 Windows 平台依赖、类型声明和 Source Map，降低体积与首次安装时间，并对过长自定义安装路径给出限制或提示。
5. 完成第三方 Game Pack 权限授权、可信启动和代码签名，之后再把带 SHA256 的签名安装包作为主仓库 Release 资产公开。

## 相关内部资料

- [独立平台设计](INDEPENDENT_PLATFORM.md)
- [DSH 升级策略](UPGRADING_DSH.md)
- [真实游戏验收清单](REAL_GAME_ACCEPTANCE.md)
- [小汤圆开发说明](xiaotangyuan/DEVELOPMENT.md)
- [安装与升级](xiaotangyuan/INSTALLATION.md)
- [更新记录](xiaotangyuan/CHANGELOG.md)
