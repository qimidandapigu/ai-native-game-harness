# AI-Native Game Context v1

`ai-native.game-context.v1` 是小汤圆 Harness 与所有游戏 Adapter 共用、面向 AI 理解与推理的结构化观察标准。JSON Schema 位于 [`protocol/v1/schemas/ai-native-game-context-v1.schema.json`](../protocol/v1/schemas/ai-native-game-context-v1.schema.json)。

## 边界

- 游戏 Bridge / Mod 只读取必须由游戏 API 提供的事实。
- Adapter 输出统一 Context，不接触模型、Provider 或密钥。
- Harness 负责校验、旧版本转换、隐私过滤、数组限长、提示词渲染和诊断。
- 当前截图与结构化 Context 在同一次多模态请求中发送；结构化值只作为数据，不能成为模型指令。

## Core

| 字段 | 含义 |
|---|---|
| `meta` | 游戏、Adapter、采集时间、序号和不可逆存档作用域 |
| `scene` | 地点、游戏时钟、天气和其他场景事实 |
| `player` | 玩家身份、坐标、状态值、背包和货币 |
| `companion` | 小汤圆是否存在、位置、状态与成长信息 |
| `entities` | NPC、生物、物体等统一附近实体列表 |
| `objectives` | 任务、目标或当前工作项 |
| `ui` | 菜单、光标和玩家是否可操作等界面状态 |
| `extensions` | `dst`、`stardew`、`oni` 等游戏专属字段 |

坐标必须携带 `space`，例如 `world`、`tile` 或 `cell`。可归一化的状态同时提供 `current`、`max`、`ratio`；只有比例时使用 `ratio`。时间使用 RFC 3339。`saveScope` 只能使用 `sha256:<64 hex>`，不能包含路径、平台账号、玩家 ID 或原始存档标识。

## 兼容与限额

Harness 当前自动识别并转换旧版饥荒、星露谷和缺氧 observation。新 Adapter 必须直接发送 `ai-native.game-context.v1`。

- `entities` 最多 40 项，游戏 Adapter 应先按与玩家当前问题的相关性和距离排序。
- `objectives` 最多 20 项。
- 字符串、对象深度和扩展数组由 Harness 再次限制。
- 模型使用的结构化 JSON 最多 12,000 字符；超限时优先删除游戏扩展，再缩减实体。

## 事件

持续状态仍使用 JSON-RPC `state.update`。离散游戏事件后续使用 `game.event`，字段采用 CloudEvents 的核心语义：`id`、`source`、`type`、`time`、`dataschema`、`data`。状态快照和事件不能混成一个不断增长的历史数组。
