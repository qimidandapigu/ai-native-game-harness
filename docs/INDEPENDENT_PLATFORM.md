# Product Runtime and Independent Game Boundary

## “独立”的准确含义

AI Native Game Harness 是独立品牌、独立桌面产品和独立游戏接入协议，但它的默认通用 AI Runtime 是 DeepSeek Harness（DSH）。独立边界用于防止游戏协议、游戏状态和 Game Pack 被某个 Agent 内部类型锁死，不代表重复实现 DSH 已经提供的模型、Agent、Tool、Session、凭据或插件生命周期。

正式决策见 [ADR 0001: DSH-first reuse policy](decisions/0001-dsh-first-reuse-policy.md)。

```text
玩家
  ↓
Desktop（对话 / 分析 / Adapter 中心）
  ↓
固定版本 DSH Runtime（模型 / Agent / Tool / Session / Credentials）
  ↓
dsh-binding（默认产品接线）
  ↓
Harness Core（游戏动作校验 / revision / Adapter 路由 / Trace）
  ↓
Game Adapter Protocol（hello / observe / execute / events）
  ↓
每游戏 Adapter → 游戏 API 与权威状态
```

## DSH-first 复用规则

1. DSH 已经提供的能力首先通过 DSH Profile、标准插件或 Binding 复用。
2. 游戏领域新增能力放入 Harness Core、Game Pack、游戏插件或 Adapter。
3. 只有具体 DSH 版本经过检查并由可复现测试证明不匹配时，才建立最小替代实现。
4. Standalone Agent Driver 和 Platform Runtime 是协议测试夹具，不自动升级为产品默认路线。

“接口可替换”只表示依赖方向正确，不表示应该主动替换 DSH。

## 模块边界

| 模块 | 拥有什么 | 不拥有什么 |
| --- | --- | --- |
| DSH Runtime | 模型、Provider、Agent、Tool Calling、Session、Settings、Credentials、Approval、通用日志、插件生命周期 | 游戏权威状态和具体游戏规则 |
| `dsh-binding` | DSH Agent Tool Call 与 Harness `action/action-result` 的双向映射 | 自建模型 Provider 与另一套 Session Runtime |
| `harness-core` | Adapter 注册、动作校验、revision、动作结果回传、Trace | DSH/Cordis 类型、模型 Provider、某个游戏规则 |
| `adapter-protocol` | 跨游戏 hello、观察、动作、结果与事件契约 | AI 推理、剧情和厂商消息格式 |
| `adapter-websocket` | 本机 JSON-RPC Host、远程 Adapter 包装和重连参考客户端 | 核心语义、游戏规则、DSH 类型 |
| `game-pack` | 世界观、角色、动态叙事边界、玩法、资源、权限与 Adapter 入口清单 | 已生成剧情状态、运行时权威状态、通用 Agent 实现 |
| `story-runtime` | StoryBeat-v1 校验、滚动计划、分支、结局、历史与按存档持久化 | 模型调用、固定剧情内容、游戏事实权威 |
| `adapter-conformance` | 可复用的 hello、observe、action/result 与 revision 一致性检查 | 真实存档验收、权限与签名信任 |
| `game-learning-binding` | 把默认 DSH Session 接到现有记忆与已验证技能服务 | 第二套 Agent、剧情成长或绕过 Core 的动作执行 |
| `dsh-story-generator` | 把同一个 DSH Session 接到动态 StoryBeat 上下文、提案和玩家选择 Tool | 第二套剧情 Agent、替代 Session、擅自宣布游戏目标完成 |

## 自学习的当前实现

- 记忆和技能是两套独立数据：记忆按 `gameId + saveId` 隔离，技能按 `gameId` 复用。
- Desktop 每个正式游戏回合要求 DSH 先调用记忆召回 Tool；回合完成后再异步提取长期记忆，不阻塞当轮公开回答。
- 技能候选只能引用当前 Adapter 声明的 action capability，所有步骤都通过 Harness Core 和 Adapter Protocol 真实执行。
- 失败候选不会进入技能库；成功候选按版本保存，可以再次执行。产品“自学习”页只显示经过脱敏和限长的学习摘要。
- 自学习不与剧情状态、角色升级、成长属性或 Bug 技能混成一个数据库；各系统通过公开上下文协作。

## 动态剧情与玩法放哪里

- 世界观、角色、主题、允许目标、禁止编造事项、玩法说明、资源与本地化放进 Game Pack；新 Pack 使用 `content.narrative`，不是写死完整剧情树。
- 模型生成的 1–3 个近期 `StoryBeat-v1` 进入 `story-runtime`，按 `gameId + saveId` 保存并保留不可回写历史。
- `dsh-story-generator` 是标准 DSH 插件，只给当前 DSH Session 提供上下文、提案和玩家选择 Tool，不启动第二个 Agent。
- 需要其他知识、工具或算法的游戏能力仍优先做成标准 DSH 游戏插件。
- 需要读取或改变权威游戏状态的代码放进该游戏 Adapter / Native Bridge。
- 跨游戏的动作安全、revision、Adapter 路由与 Trace 放进 Harness Core。
- DSH 与游戏内核之间的映射放进 `dsh-binding`。

## 当前实现与目标默认的区别

当前仓库有两条可运行切片：

- DSH 切片：小汤圆插件已经验证真实模型选择、Agent 会话、Tool Calling、流式回复、记忆、多模态和内置 DSH Desktop 路径。
- Standalone 切片：Mock Agent、Harness Core、WebSocket Adapter Host 和外置 Mock Adapter 已验证 `action → execute → action-result`、错误反馈、动作上限和重连。
- Binding 切片：Adapter `inputSchema` 已注册成真实 DSH Agent 可见的标准 Tool；模型已通过 WebSocket 驱动 Mock Game 完成 `move → collect`，并收到金币 `1`、revision `2` 的权威结果。
- 自学习切片：现有 `MemoryService` 与 `SkillService` 已作为单一服务暴露；`game-learning-binding` 将它们接入默认 DSH Session，并把学习摘要回传 Desktop 自学习页。
- 动态剧情切片：`dsh-story-generator` 让同一个 DSH Session 滚动提出 StoryBeat；纯 Runtime 拒绝不存在的 Observation 路径和未声明 action，只有 Adapter 新状态能推进历史，Desktop 动态剧情页展示当前目标、选择、待续线索和证据。
- 真实 Adapter 测试切片：《缺氧》通过假文件 Bridge 在不启动游戏时验证握手、观察、动作、revision 冲突、拒绝、超时、事件和重连；同一 DSH `callId` 会作为 Adapter `requestId` 原样进入 C# Bridge。

Standalone 切片的存在是为了确定性测试公开游戏边界。它不是重新开发通用 AI Runtime 的授权，也不是目标产品默认。

## 下一条正式闭环

```text
DSH Agent
  → 游戏 Tool Call
  → dsh-binding
  → Harness Core action
  → Game Adapter execute
  → ActionResult + Observation
  → dsh-binding
  → DSH Agent 继续决策或回复
```

Binding 已装入实际 DSH Agent 作用域并通过 Mock Game 真实模型冒烟。Desktop 产品页也已经共享 DSH Session 与 Core Trace：公开回答通过流式 IPC 到对话页，DSH Session 历史和官方 `sessionStats` 投影提供通用 Agent 事实与耗时，Core 只补充 action-result、Adapter 和游戏侧事实，Core Snapshot 驱动 Adapter 中心。DSH 原生事件里的 `SessionId`、`turn`、`step` 和 `callId` 会被保真投影；Binding 把同一个 `callId` 用作 Adapter `requestId`，因此分析页按 `Session → 回合 → 步骤 → Tool callId → 游戏 requestId` 精确关联，而不是按时间猜测。游戏动作 Trace 分开记录 `coreValidationMs`、`adapterRoundTripMs`、`bridgeRoundTripMs` 和 `gameExecutionMs`，动作后的 Observation 继续使用同一 `requestId`；语音诊断按 interactionId 记录 ASR、首字、Agent、TTS、总耗时和失败阶段。分析页可以筛选失败、超时、重连、语音与动作，并导出脱敏后的最近 500 条 Trace；聊天正文、语音转写和隐藏思维不进入诊断文件。游戏状态区不再假设金币、体力或坐标必然存在：未知 Adapter 自动获得受限额与敏感字段过滤的通用 observation 查看器，已知游戏可使用专属展示器。

平台扩展入口也已从清单走到可执行的开发流程：`GamePackRegistry` 校验并事务安装 Pack，`examples/adapter-starter` 提供可复制 Adapter 与动态叙事策略，`adapter-conformance` 提供 CI 体检。安装成功只代表 Pack 可发现；Desktop 在权限授权、可信启动和签名策略完成前不会自动执行未知第三方入口。产品页当前位于 DSH Web Client 组合之外，因此只保留薄传输、学习/剧情状态与展示 Bridge，不把它扩展成第二套 Session、日志或统计系统。Windows NSIS 本地产物已经完成无系统 Node/pnpm 的安装、内置 DSH 页面启动、媒体 Host 运行和短路径完整卸载验收；它仍是未签名、未上传 Release 的开发产物。当前剩余工作是先建立长剧情自动质量验收，再用真实模型与真实游戏存档验证完整产品闭环，并按 [真实游戏验收清单](REAL_GAME_ACCEPTANCE.md) 补齐实际语音分段耗时。直接 OpenAI-compatible Driver 暂不进入路线，除非满足 ADR 0001 的替换门槛。

验证命令：

```powershell
pnpm check
pnpm platform:test
pnpm smoke:dsh-product
pnpm smoke:dsh-story
pnpm mock:start
pnpm desktop:dsh
```

`pnpm check` 覆盖工作区和确定性平台测试；`smoke:dsh-product`、`smoke:dsh-adapter`、`smoke:dsh-story` 属于额外的环境级验收。剧情冒烟依赖配置了可用模型凭据的 headless Profile，会执行两次真实 DSH Agent：第一次生成并完成 StoryBeat，第二次验证持久历史恢复。冒烟必须看到命令定义的成功结果才算通过；DSH ready 前出现 `ERR_MODULE_NOT_FOUND` 应按 Profile/Runtime 装配问题处理，不能用 `pnpm check` 的结果代替。
