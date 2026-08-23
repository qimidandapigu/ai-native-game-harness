# 结构化状态与记忆隔离设计

本文同时记录设计边界和当前实现状态。Harness 已启用持久记忆、后台自动提取、游玩统计、阶段总结、自然语言管理、`gameId + saveId` 隔离及 `AI-Native Game Context v1`。目标是让模型获得经过白名单整理的当前事实，同时确保原始世界状态留在游戏本地、不同游戏和存档的记忆不会串线。

## 设计总览

```text
游戏 Bridge / Mod
├─ full local state       完整状态，仅供本地动作与校验
└─ curated facts          读取游戏 API 后的必要事实
            ↓ 本机
游戏 Adapter
├─ 输出 AI-Native Game Context v1
└─ 生成不透明 saveId
            ↓ protocol/v1（有上限）
Harness
├─ 校验、兼容转换、限长并注入 Game Context
├─ 按 scope 读取、写入记忆
└─ 截图 + 玩家文字 + 少量事实 → 单次多模态模型
```

核心约束：模型上下文、动作校验状态和持久记忆是三种不同的数据，不能把一份完整 observation 同时用于三者。

## 一、少量结构化状态

### 1. 两份状态，各自负责一件事

Adapter 可以在本机保留完整游戏状态，供寻路、目标 ID、动作前置条件和结果校验使用。完整状态不进入模型提示词，也不被 Harness 持久化。

Adapter 另外生成 `ai-native.game-context.v1`。它只能由统一 Core 和游戏命名空间扩展组成，用来补充截图不容易准确识别、但对当前回答有帮助的事实。例如生命值、所在区域、当前工具和鼠标指向对象。完整字段见 [AI-Native Game Context v1](AI_NATIVE_GAME_CONTEXT_V1.md)。

```json
{
  "schema": "ai-native.game-context.v1",
  "meta": {
    "gameId": "stardew-valley",
    "capturedAt": "2026-08-18T12:00:00.000Z"
  },
  "scene": {
    "location": "Farm",
    "time": "08:10",
    "season": "spring",
    "weather": "sunny"
  },
  "player": {
    "health": 100,
    "stamina": 72,
    "status": ["hungry"],
    "heldItem": "Fishing Rod"
  },
  "entities": [
    { "kind": "npc", "name": "Abigail", "distance": 4 }
  ],
  "objectives": [],
  "ui": { "playerControllable": true }
}
```

除 Schema 标识、`meta.gameId`、`meta.capturedAt` 和几个 Core 容器外，业务字段均可省略。Adapter 不知道或游戏不支持的字段直接省略，不使用大段自然语言 `summary` 猜测补齐。

### 2. 硬性数据预算

Harness 在接收时执行统一限制：

- 模型提示中的结构化 JSON 硬上限 `12,000` 字符。
- JSON 最大深度 `6`；实体最多 `40` 项；目标最多 `20` 项。
- 普通字符串最多 `500` 字符，身份和名称字段使用更小上限。
- 超限时先移除游戏扩展，再把实体缩减到 `12` 项，并明确标记 `truncated`。
- 每次玩家交互最多注入一份最新状态；不传状态历史，不逐帧上报。
- `capturedAt` 超过 `5` 秒时标记为 stale；超过 `30` 秒时不注入模型。

第一版按玩家提出的问题做确定性投影。例如询问钓鱼时保留水域、鱼竿、鱼饵和体力；询问附近危险时保留生命值、状态和附近敌人。投影规则属于 Adapter，不让模型先查看完整状态再决定取什么。

### 3. 默认禁止上传的内容

以下内容既不进入 `AI-Native Game Context`，也不随模型请求发送：

- 存档文件、完整世界快照、完整背包、完整任务列表和 NPC 关系数据库。
- Windows 用户名、文件路径、Steam 或游戏平台账号 ID、进程 ID。
- 原始日志、崩溃栈、任意 Adapter 自由文本、Provider Key 或其他密钥。
- 桌面截图、后台窗口、连续视频帧；只使用当前允许游戏进程的客户区截图。
- 原始音频；语音仍在本机完成 ASR 后只把转写文本交给 Agent。

动作工具仍必须使用本机完整状态二次校验。`AI-Native Game Context` 只是回答依据，不能作为执行危险动作的授权或唯一事实来源。

### 4. 当前协议形态

`chat.send.context` 和 `state.update` 只承载允许离开本地动作层的数据：

```json
{
  "observation": { "schema": "ai-native.game-context.v1" },
  "saveId": "opaque-local-id"
}
```

完整本地状态不出 Adapter 的动作层。协议层只接受标准 Context 和不透明身份键。现有三个旧 observation 保留一个兼容周期，由 Harness 转换为 `ai-native.game-context.v1`；新 Adapter 不得再创建私有顶层结构。

## 二、简化后的记忆隔离

长期记忆只有两类，玩家不需要维护角色槽、会话层或多级目录：

```text
共同记忆
  玩家的性格倾向、爱好、称呼、语言和回复偏好
  玩家与小汤圆一起玩过哪些游戏
  小汤圆跨游戏保持一致的身份设定

当前游戏记忆
  这个游戏里的角色、目标、约定和重要经历
  内部按 gameId + saveId 自动隔离
```

普通对话历史只是 Harness 当前会话的工作记忆，不作为第三种长期记忆，也不出现在管理界面中。技术上仍区分工作记忆、长期事实和长期经历，但玩家只需要理解上面的两个入口。

### 1. 存放位置

“小汤圆游戏 AI”Harness 插件在自己的隔离数据目录维护 SQLite 数据库，默认路径是 `%LOCALAPPDATA%\XiaoTangYuan\profiles\<profileId>\memory-v1.sqlite`。Adapter、游戏 Mod 和云端模型都不直接读写该文件。插件复用 Harness 的当前模型选择和 LLM 流式接口做后台提取，但不注册全局 Prompt，也不修改普通 Harness Session。

这里的“共同记忆”只在小汤圆支持的游戏之间共享，不是 DSH 的全局用户记忆。插件不能注册全局 Prompt 注入器，也不能修改普通 Harness 对话的 Session。只有已经通过 `adapter.hello` 建立的游戏连接，在创建专属 `GameAgentSession`、处理 `chat.send` 或游戏语音时，才读取并注入当前玩家的共同 Profile 和当前 `gameId + saveId` 记忆。

```text
普通 Harness 对话 ───────────────→ 原有 DSH Session（不读取小汤圆记忆）

游戏 Adapter 连接
  → 小汤圆 GameAgentSession
  → 插件隔离 MemoryStore
     ├─ 当前 DSH profile 的共同 Profile
     └─ 当前 gameId + saveId 的游戏事件
```

插件空闲时不执行记忆检索或后台模型调用。记忆提取只在一轮游戏回答完成后运行，因此不会增加普通 Harness 对话的 Prompt token 和响应时间。同一台电脑需要多人完全隔离时，应为各自的插件配置使用不同 `memory.profileId`；未来 Harness 提供稳定的 profile 数据目录接口后可改为自动映射。

DeepSeek Harness 仍处于 Developer Preview，可能发生破坏性 API 变化，因此数据库通过项目自己的 `MemoryStore` 接口访问，不绑定 DSH 内部 Session 表。数据库只有两种业务记录：

- `shared_profile`：一份很小的结构化 JSON，保存性格倾向、爱好、玩过的游戏、称呼、语言、回复风格和小汤圆身份设定。
- `game_memory`：多条简短事件，包含 `gameId`、`saveId`、类型、主体、摘要、重要度、状态和时间。

此外有两张不参与模型检索的统计表：

- `play_session`：一次游戏连接的开始、最后心跳、结束和累计活跃毫秒数。心跳间隔超过两分钟时只计两分钟，避免电脑挂起或异常退出虚增时长。
- `play_day`：按本地日期去重，用来回答“玩了几天”。同一天反复进入同一存档只算一天。

`saveId` 由 Adapter 在本机根据稳定存档特征生成不透明值，不保存存档路径、Windows 用户名或平台账号。数据库带简单 schema 版本，以后可以迁移或完整导出。

### 2. 自动归类规则

- 低风险且明显属于玩家本人的长期特征可以自动更新共同记忆，例如爱好、交流风格、经常选择的玩法，以及由 Harness 确认玩过的游戏；玩家不需要说“所有游戏都记住”。
- 游戏人物、地点、目标、关系变化、约定和重要经历写入当前游戏事件集合。
- 只在当前游戏成立的偏好或经历默认写当前游戏，避免串到别的游戏。例如“这个存档要走钓鱼路线”属于游戏记忆，“我一直喜欢钓鱼玩法”属于共同记忆。
- 切换游戏或存档时，Harness 自动切换对应 `gameId + saveId`，玩家不用选择目录。
- Provider、密钥、路径、账号、原始截图、音频和完整世界状态永不写入记忆。

共同记忆自动形成，但必须可见、可修改、可删除，并提供“自动形成共同记忆”总开关。敏感信息、可能只是角色扮演的话、对玩家性格的负面推断，以及置信度不足的结论不能自动保存；这些内容要么忽略，要么向玩家确认。

写入不阻塞玩家回复。完整回答显示后，Harness 在后台从“本轮玩家文字 + 最终回答”中最多提取一项共同记忆变更和两项游戏事件。模型只能提出候选项，Harness 负责 schema 校验、作用域判断、去重和落库。当前第一版只接受提取提示中明确限制的低风险事实，不保存置信度；以后若允许模型推断性格倾向，必须先增加多次证据和玩家确认机制。

游戏连接结束或检测到同一连接切换了 `saveId` 时，Harness 在已有后台队列末尾做一次阶段总结。总结只读取本次最多十二轮“玩家文字 + 小汤圆最终回复”，最多生成两条未完成目标、明确决定、承诺、关系变化或里程碑；少于两轮对话时不额外调用模型，没有对话时只保留统计，绝不根据运行时长臆造经历。

共同 Profile 使用严格字段更新，不能让模型重写整份文件。游戏事件每条摘要最多 `160` 字；同一主体和类型出现新事实时原位更新摘要和时间，不让冲突事实同时进入提示词。

### 3. 每轮只取少量相关记忆

不能把整个数据库塞进 Prompt。每轮固定使用：

- 共同 Profile：始终读取，最多约 `300 tokens`。
- 当前存档的活动目标：最多 `2` 条。
- 与玩家问题、画面焦点或附近实体相关的事件：最多 `4` 条。
- 最近且重要的补充事件：最多 `2` 条。
- 全部长期记忆合计当前按 `1,200` 字符硬裁剪，目标约为几百 tokens；后续可接入统一 tokenizer 做更精确预算。

游戏事件按“相关性 + 最近使用时间 + 重要度”排序。当前第一版使用轻量词项匹配和结构化过滤，不引入向量数据库；检索永远限定在当前 `gameId + saveId`，共同 Profile 也不会参与跨库相似度搜索。数据量增长后可透明升级到 SQLite FTS5/BM25。

低价值的每帧观察、普通闲聊和可以从当前结构化状态重新得到的信息不保存。每个存档设置软上限，例如 `300` 条；超过后只在后台合并已结束的低重要度事件，活动目标和玩家明确要求记住的内容不自动删除。

### 4. 玩家只需要两个管理入口

- `共同记忆`：查看、修改、删除、全部清空，以及关闭自动形成。
- `当前游戏记忆`：查看、删除、清空当前游戏或当前存档。

共同记忆按字段显示；游戏记忆只显示摘要、所属游戏/存档、状态和保存时间。删除 Harness 记忆不会删除游戏存档；删除游戏存档也不会自动操作 Harness 数据，玩家可在当前游戏记忆中手动清理。

当前通过三个 Harness 工具完成自然语言管理：

- `xiaotangyuan_memory_view`：只读查看共同记忆、各存档记忆和游玩统计。
- `xiaotangyuan_memory_correct_shared`：只在玩家明确纠正时整体替换一个共同记忆字段。
- `xiaotangyuan_memory_forget`：删除单条、当前存档、共同记忆或全部长期记忆；必须带明确确认，默认不删除游玩统计。

普通 Harness 对话可以调用这些管理工具，但不会自动注入小汤圆记忆。也就是说“管理入口可见”和“日常聊天被记忆影响”是两件分开的事。

## 三、实施顺序

1. 已完成：Adapter 上报稳定 `gameId + saveId`，Harness 使用独立 `MemoryStore` 和 SQLite schema。
2. 已完成：共同 Profile、游戏事件检索、跨游戏/跨存档隔离测试。
3. 已完成：回答后后台提取、去重、容量限制、游玩统计和退出阶段总结。
4. 已完成：共同记忆/当前游戏记忆的自然语言查看、纠正和删除工具。
5. 已完成：接入 `AI-Native Game Context v1`、旧格式转换、统一限长和模型提示词注入。
6. 后续：增加人类可读存档名称，并用长期固定测试集持续衡量错误记忆、Prompt token 和响应延迟。

验收底线：切换游戏或存档后，上一游戏或上一存档的人物、地点和经历不能出现在新上下文；稳定的玩家画像、爱好和一起玩过的游戏可以作为共同记忆继续使用，同时必须允许玩家查看和纠正。

## 四、三款游戏、每款两个存档的验收案例

玩家连续玩三天星露谷、两天饥荒、两天缺氧，每个游戏各有两个存档时，数据库应该形成一份共同 Profile 和六个独立作用域：

```text
共同记忆
├─ stardew-valley / farm-a
├─ stardew-valley / farm-b
├─ dont-starve-together / world-a
├─ dont-starve-together / world-b
├─ oxygen-not-included / colony-a
└─ oxygen-not-included / colony-b
```

共同 Profile 可以包含“喜欢探索和长期经营”“偏好简短中文回复”“一起玩过三款游戏”，但不能包含某个农场、世界或殖民地的人物与计划。进入 `farm-a` 时只注入共同 Profile 与 `farm-a` 的目标；`farm-b`、饥荒和缺氧事件不可见。

统计报告按存档分别显示天数、进入次数、活跃时长和最近游玩时间，同时提供按游戏去重后的汇总，由此可得到“星露谷 3 天、饥荒 2 天、缺氧 2 天”。同一天玩两个星露谷存档时，两个存档各记一天，但游戏级汇总按日期集合去重，不能错误显示成两天。

玩家完全不与小汤圆说话时，只增加统计，不产生任何剧情记忆。发生两轮以上对话并退出存档时，阶段总结最多保留两条真正耐久的目标、决定或承诺。玩家随后可以说“你记得我什么”“删掉 farm-a 的社区中心计划”或“我其实更喜欢自动化，把共同爱好改一下”完成查看、删除和纠正。

## 五、设计依据

- LangGraph 把当前线程历史与跨线程长期记忆分开，并建议用 namespace 隔离长期记忆；它也区分结构化 Profile 和事件集合，两者各有不同维护成本。
- Generative Agents 的游戏式研究表明，经历不应全部塞进上下文，而应按相关性、近期性和重要度检索少量记录。
- MemGPT 把当前上下文和外部长期存储分开，说明长会话直接无限累加既浪费上下文，也会降低有效利用率。
- DeepSeek Harness 官方仓库明确标注当前处于 Developer Preview，因此持久数据不应耦合其内部 Session schema。

参考：[LangGraph Memory](https://docs.langchain.com/oss/python/concepts/memory)、[Generative Agents](https://arxiv.org/abs/2304.03442)、[MemGPT](https://arxiv.org/abs/2310.08560)、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。
