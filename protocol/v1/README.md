# 小汤圆游戏协议 v1.1

本目录定义 Harness 插件和轻量游戏适配器之间与编程语言无关的通信契约。TypeScript、C#、Lua 等实现都必须遵守这里的协议，不能直接引入某个 Provider 的专属类型。

## 传输方式

- 使用本机回环地址上的 WebSocket。
- 消息格式为 JSON-RPC 2.0。
- 适配器必须先发送一次 `adapter.hello`，然后才能发送其他请求。
- Windows 语音适配器应在 `adapter.hello` 中提供正整数 `processId`，让媒体 Host 只响应已连接且位于前台的游戏进程。
- 支持存档隔离的适配器应在 `adapter.hello.saveId` 或每次 `chat.send.context.saveId` 中提供稳定、不透明的本地标识。只允许 1–128 个字母、数字、点、下划线、冒号或连字符；不得发送存档路径、平台账号或用户名。
- 需要记录无对话游玩统计的适配器可在 `state.update.saveId` 重复携带同一个不透明标识。Harness 只用它切换本地统计与记忆作用域，不把该标识或完整 observation 写进长期记忆。

## 当前方法

| 方法 | 方向 | 用途 |
|---|---|---|
| `adapter.hello` | 适配器 → Harness | 声明适配器、游戏、版本和协议版本 |
| `gateway.ping` | 适配器 → Harness | 检查 Gateway 是否正常 |
| `chat.send` | 适配器 → Harness | 发送玩家文本和 `AI-Native Game Context v1` |
| `state.update` | 适配器 → Harness | 上报最新 `ai-native.game-context.v1` 状态，不包含音频和密钥 |
| `voice.start` | 适配器 → Harness | 让 Harness 为当前 Adapter 声明的游戏进程开始录音 |
| `voice.stop` | 适配器 → Harness | 停止同一游戏进程发起的录音并进入 ASR、Agent 与 TTS 链路 |
| `assistant.status` | Harness → 适配器 | 显示录音、转写或思考状态 |
| `assistant.text.start` | Harness → 适配器 | 一次正文流开始 |
| `assistant.text.delta` | Harness → 适配器 | 模型正文的真实流式增量；同时携带当前步骤的累计正文 |
| `assistant.text.done` | Harness → 适配器 | 最终正文确认 |
| `assistant.text.cancel` | Harness → 适配器 | 玩家打断或请求取消 |
| `assistant.delta` | Harness → 旧适配器 | `1.0` 兼容通知 |
| `assistant.present` | Harness → 适配器 | 显示最终回复文本 |
| `assistant.error` | Harness → 适配器 | 显示本次交互的可恢复错误 |

## 语音状态

Harness 通过 `assistant.status` 发送：

| `status` | 含义 |
|---|---|
| `recording` | 媒体 Host 已开始录制前台游戏的按住说话输入 |
| `thinking` | ASR 已结束，Agent 正在处理；可附带 `transcript` |

最终文本使用 `assistant.text.done` 与 RPC 结果确认；`assistant.present` 继续用于主动回复和兼容呈现，可恢复失败使用 `assistant.error`。麦克风 PCM 分片只在 Harness 与本机媒体 Host 之间传输，不通过本协议发送给游戏适配器。

声明 `capabilities: ["assistant.text-stream"]` 的适配器接收 `assistant.text.delta`；未声明能力的旧适配器继续接收 `assistant.delta`。增量通知可忽略，不改变最终结果语义：

```json
{
  "interactionId": "...",
  "source": "chat",
  "delta": "你好",
  "text": "你好，我是小汤圆",
  "elapsedMs": 1260
}
```

Adapter 应使用 `text` 替换正在显示的临时气泡，而不是自行拼接；模型进入工具调用后的新步骤时，累计正文可能从头开始。只有 RPC 最终结果或 `assistant.present` 才表示完整回复。`reasoning-delta`、工具参数和内部思考不会通过该通知发送。

## 后续扩展

当前统一状态格式见 [AI-Native Game Context v1](../../docs/AI_NATIVE_GAME_CONTEXT_V1.md)。Harness 会兼容转换三个游戏的旧 observation，新 Adapter 必须直接发送 `ai-native.game-context.v1`。后续协议将增加：

- 游戏事件上报。
- 游戏工具发现。
- 动作执行及执行结果。
- 最终文本和游戏内呈现事件。

协议只传递有语义的游戏数据。麦克风原始数据、Provider 密钥和厂商配置都由 Harness 管理，不进入游戏适配器协议。当前协议的单条 WebSocket 消息上限为 1 MiB，不能用它承载持续媒体流。
