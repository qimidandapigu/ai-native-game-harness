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
| `game-pack` | 剧情、角色、玩法、资源、权限与 Adapter 入口清单 | 运行时权威状态、通用 Agent 实现 |

## 剧情与玩法放哪里

- 可分发的剧情、角色、玩法数据、资源与本地化放进 Game Pack。
- 需要知识、工具或算法的游戏能力优先做成标准 DSH 游戏插件。
- 需要读取或改变权威游戏状态的代码放进该游戏 Adapter / Native Bridge。
- 跨游戏的动作安全、revision、Adapter 路由与 Trace 放进 Harness Core。
- DSH 与游戏内核之间的映射放进 `dsh-binding`。

## 当前实现与目标默认的区别

当前仓库有两条可运行切片：

- DSH 切片：小汤圆插件已经验证真实模型选择、Agent 会话、Tool Calling、流式回复、记忆、多模态和内置 DSH Desktop 路径。
- Standalone 切片：Mock Agent、Harness Core、WebSocket Adapter Host 和外置 Mock Adapter 已验证 `action → execute → action-result`、错误反馈、动作上限和重连。
- Binding 切片：Adapter `inputSchema` 已注册成真实 DSH Agent 可见的标准 Tool；模型已通过 WebSocket 驱动 Mock Game 完成 `move → collect`，并收到金币 `1`、revision `2` 的权威结果。
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

Binding 已装入实际 DSH Agent 作用域并通过 Mock Game 真实模型冒烟。Desktop 产品页也已经共享 DSH Session 与 Core Trace：公开回答通过流式 IPC 到对话页，DSH Session 历史和官方 `sessionStats` 投影提供通用 Agent 事实与耗时，Core 只补充 action-result、Adapter 和游戏侧事实，Core Snapshot 驱动 Adapter 中心。游戏动作 Trace 分开记录 `coreValidationMs`、`adapterRoundTripMs`、`bridgeRoundTripMs` 和 `gameExecutionMs`，动作后的 Observation 用同一 `requestId` 关联；没有测量来源的分段保持“未提供”。`reasoning-delta` / `analysis` 在产品边界被过滤，不会作为可审计事实展示。产品页当前位于 DSH Web Client 组合之外，因此保留的是薄传输与展示 Bridge，不把它扩展成第二套 Session、日志或统计系统。当前剩余工作是让真实游戏重复同一验收，并完成安装包内的端到端 UI 验收。直接 OpenAI-compatible Driver 暂不进入路线，除非满足 ADR 0001 的替换门槛。

验证命令：

```powershell
pnpm check
pnpm platform:test
pnpm smoke:dsh-product
pnpm mock:start
pnpm desktop:dsh
```
