# DSH Binding

`@ai-native-game-harness/dsh-binding` 是正式产品的默认 DSH 接线，不是可选兼容层。

它在标准 DSH Tool 生命周期内完成一件事：把已连接 Game Adapter 声明的动作能力注册成模型可调用工具，并把调用交给 `HarnessCore.dispatchAgentAction()`。DSH 继续拥有模型、Agent、Session、Tool Calling、审批和持久日志；Core 只拥有游戏动作校验、revision、执行与 Trace。

```text
DSH Agent Tool Call
  → bindDshGameTools
  → HarnessCore.dispatchAgentAction
  → Game Adapter
  → ActionResult + authoritative Observation
  → DSH Tool Result
```

## Host 接入

Host 必须先把 Adapter 连接到 Core，再在 DSH 插件作用域内注册工具：

```ts
const binding = bindDshGameTools(ctx.tools, core, gameId)
ctx.effect(() => () => binding.dispose())
```

Adapter 动作应提供语言无关的对象根节点 `inputSchema`。Binding 直接使用该 Schema 生成 DSH Tool 参数；旧 Adapter 没有提供时暂按开放对象处理。

工具返回的 `result.ok` 是 AI 能否声称动作成功的唯一依据。游戏规则拒绝仍是结构化 Tool Result，不会被伪装成通信故障；结果同时携带最新权威 Observation。

## 当前完成边界

- 已完成：DSH Tool 定义、参数 Schema、Core action/action-result、成功/拒绝结果、会话和 callId 关联、生命周期卸载。
- 已验证：真实 DSH Agent 通过 Binding、Core 和 WebSocket Adapter 驱动 Mock Game 完成 `move → collect`，收到金币 `1`、revision `2` 的权威结果。
- 已完成：Desktop 产品页面共享该 DSH Session 与 Core Trace；DSH 通用耗时读取官方 `sessionStats` 投影，不在 Binding 或 Core 中重新计算。
- 待完成：真实游戏重复同一权威结果与产品页面验收。

在真实游戏与产品页验收完成前，不应把 Standalone 测试 Runtime 冒充成正式产品默认链。
