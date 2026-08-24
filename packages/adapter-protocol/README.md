# Game Adapter Protocol 1.0

Game Adapter Protocol 是 Harness Core 与游戏 Adapter 之间的语言无关契约。核心语义不绑定传输；`@ai-native-game-harness/adapter-websocket` 是当前本机跨进程参考实现。

## 连接方向与安全边界

```text
游戏 Adapter（Client）
        ⇅ JSON-RPC 2.0 / WebSocket
Adapter Host（Server，仅监听本机回环地址）
        ⇅ GameAdapter
Harness Core
```

默认路径为 `/adapter`，单条消息上限 1 MiB。第一版只用于同一台电脑上的游戏进程，不应暴露到局域网或公网；截图、音频、模型密钥和文件不进入本协议。

## 生命周期

1. Adapter 建立 WebSocket。
2. Adapter 必须在 5 秒内发送有 `id` 的 `adapter.hello` 请求。
3. Host 校验协议版本、Adapter、游戏、版本和能力，返回 `accepted`。
4. Host 使用 `game.observe` 拉取一份完整权威状态。
5. 连接期间双方可发送请求、结果与 `game.event` 通知。
6. 连接断开时，Harness Core 把 Adapter 标记为 `disconnected`；未完成的调用以 `adapterDisconnected` 失败。
7. 客户端按指数退避自动重连。相同 `gameId + adapterId + adapterVersion` 会重新绑定原逻辑 Adapter，Host 随后重新观察状态。

事件不做离线补发；重连后的完整 Observation 是恢复权威状态的依据。Adapter 版本发生变化时要求重启 Harness，避免在一个会话中热换契约。

## 握手

Adapter → Host：

```json
{
  "jsonrpc": "2.0",
  "id": "7b1a...",
  "method": "adapter.hello",
  "params": {
    "protocolVersion": "1.0",
    "adapterId": "mock-game.adapter",
    "gameId": "mock-game",
    "displayName": "Mock Coin Garden",
    "adapterVersion": "0.1.0",
    "capabilities": [
      {
        "name": "game.move",
        "kind": "action",
        "description": "Move the player."
      }
    ]
  }
}
```

Host → Adapter：

```json
{
  "jsonrpc": "2.0",
  "id": "7b1a...",
  "result": {
    "accepted": true,
    "protocolVersion": "1.0",
    "connectionId": "24db..."
  }
}
```

## 方法

| 方法 | 方向 | 类型 | 用途 |
| --- | --- | --- | --- |
| `adapter.hello` | Adapter → Host | 请求 | 首条消息，声明身份、版本与能力 |
| `game.observe` | Host → Adapter | 请求 | 获取完整权威状态 |
| `game.execute` | Host → Adapter | 请求 | 执行已声明的动作能力 |
| `game.event` | Adapter → Host | 通知 | 推送状态变化或游戏事件 |
| `system.ping` | Host → Adapter | 请求 | 检查连接是否仍能处理请求 |

`game.execute` 必须携带唯一 `requestId`。可选 `expectedRevision` 用于拒绝基于旧状态生成的动作。Adapter 必须原样返回 `requestId` 和执行后的 `revision`。

## 两类错误

协议/传输错误使用 JSON-RPC `error`：

| 数值 | 名称 | 含义 |
| ---: | --- | --- |
| -32700 | `parseError` | JSON 无法解析 |
| -32600 | `invalidRequest` | 消息不是合法 JSON-RPC |
| -32601 | `methodNotFound` | 接收方不支持该方法 |
| -32602 | `invalidParams` | 参数格式错误 |
| -32603 | `internalError` | 接收方内部失败 |
| -32001 | `protocolVersionUnsupported` | 协议版本不兼容 |
| -32002 | `handshakeRequired` | 握手前发送了其他请求 |
| -32003 | `duplicateGame` | 该 `gameId` 已被另一 Adapter 占用 |
| -32004 | `adapterDisconnected` | Adapter 已断开 |
| -32005 | `capabilityUnavailable` | 未声明或不可用的能力 |
| -32006 | `revisionConflict` | 动作基于过期状态 |
| -32007 | `actionRejected` | 动作被 Adapter 拒绝 |
| -32008 | `requestTimeout` | 请求超时 |

游戏规则失败使用正常 `ActionResult`，例如：

```json
{
  "requestId": "action-1",
  "ok": false,
  "revision": 8,
  "error": {
    "code": "NO_ENERGY",
    "message": "The player has no energy"
  }
}
```

这能区分“通信坏了”和“通信正常，但游戏不允许这个动作”。

## 参考实现

- Host：`WebSocketAdapterHost`，把远程连接包装成 `RemoteGameAdapter`。
- Client：`ReconnectingAdapterClient`，把任意本地 `GameAdapter` 暴露给 Host。
- 双进程示例：`examples/mock-game/src/server.ts` 与 `client.ts`。

其他语言只需实现本文 JSON 消息，不需要导入 TypeScript 包、DSH 或 Cordis。
