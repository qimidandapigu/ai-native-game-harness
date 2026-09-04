# 架构和职责边界

## 总体结构

```text
玩家
├─ 文字输入
├─ Windows / macOS 麦克风
└─ 游戏窗口画面
          ↓
DeepSeek Harness
└─ 小汤圆 Harness 插件
   ├─ Agent / 模型 / 上下文
   ├─ 单次多模态输入 / ASR / TTS Provider
   ├─ Native Media Host（Windows x64 / macOS arm64）
   ├─ 游戏安装器
   ├─ 分层记忆与自动反馈
   └─ localhost Gateway
          ↓ 33145 会话协议 + Desktop 动态 loopback Adapter Protocol
可选游戏 Adapter
├─ 游戏知识与角色规则
├─ 游戏专属工具与安装器
└─ Gateway 与游戏 Bridge 的协议翻译
          ↓ 本机桥协议
游戏 Bridge / Mod
├─ 游戏状态与事件
├─ 游戏 API 动作
└─ 游戏内 UI
```

核心规则：凡是不依赖具体游戏就能完成的能力，都归 Harness；游戏知识和专属工具进入可选 Adapter；只有必须运行在游戏进程内、调用游戏 API 的工作才进入 Bridge / Mod。

## 职责矩阵

| Harness 插件 | 可选游戏 Adapter | 游戏 Bridge / Mod |
|---|---|---|
| Agent 循环和模型调度 | 游戏角色规则和知识 | 读取准确游戏状态 |
| 通用 Prompt、上下文和记忆 | 游戏专属工具 Schema | 订阅游戏事件 |
| 通用工具注册、重试和审计 | 参数落地与协议翻译 | 调用游戏 API 执行动作 |
| 多模态、ASR、TTS Provider | 游戏 Mod 检测与安装器 | 游戏内文字与回复呈现 |
| 麦克风、窗口捕获和音频播放 | 选择并注册游戏进程 | 上报进程 ID 与动作结果 |
| 密钥、权限和日志 | 不保存 Provider Key | 不接触 Provider 与模型 SDK |

Provider 密钥不能进入游戏 Adapter、Bridge 或 `protocol/v1`。两层游戏代码都不能依赖某个模型厂商的 SDK 或专属消息结构。

## 窗口与媒体所有权

游戏 Adapter 在 `adapter.hello` 中上报真实游戏进程 ID。Harness 的通用媒体层根据该进程定位客户窗口，只截取客户区，不截取整个桌面；按住说话也只接受当前位于前台且已经连接的游戏进程。星露谷、饥荒和后续游戏复用同一套窗口、麦克风和播放能力，Adapter 不再各自实现截图或录音。

## 结构化状态与记忆隔离

```text
共同记忆            自动形成低风险玩家画像、爱好、共同游戏经历和身份设定
当前游戏记忆        内部按游戏 ID + 存档 ID 自动隔离
```

`0.8.0` 保留完整的第一版记忆闭环：共同记忆自动学习低风险玩家特征，游戏事件按 `gameId + saveId` 隔离，回答后后台提取，退出或切档时形成简短阶段总结；玩家可以通过 Harness 工具查看、纠正和删除。长期记忆仍只保留“共同记忆”和“当前游戏记忆”两个玩家概念。游玩日期、次数和时长是独立本地统计，不进入模型 Prompt。存档与当前世界状态始终归游戏所有。

内部实现不把两类数据混成一堆文本：共同记忆是一份小型结构化 Profile，游戏记忆是按当前 `gameId + saveId` 隔离的简短事件集合。回答完成后再后台提取候选记忆，避免拖慢玩家看到回复；每轮只检索少量相关事件，不发送完整历史。

记忆数据库属于小汤圆 Harness 插件的 profile 隔离数据，不进入游戏存档，也不成为 DSH 全局记忆。只有 Adapter 已连接的专属 `GameAgentSession` 会读取它；普通 Harness 对话不注入、不检索，也不承担额外 token 或模型调用。

Adapter 使用统一的 `AI-Native Game Context v1` 上报状态；Harness 负责校验、旧格式迁移、隐私过滤、数组限长与紧凑提示词渲染。字段和扩展规则见 [AI-Native Game Context v1](AI_NATIVE_GAME_CONTEXT_V1.md)，记忆边界见[结构化状态与记忆隔离设计](CONTEXT_AND_MEMORY_DESIGN.md)。

## 单次多模态调用

`0.7.0` 不再先调用视觉模型生成截图描述、再把描述交给对话模型。当前游戏会话选择一个支持图片输入的模型，并只发起一次 Agent 调用：

```text
[
  角色与安全指令 + 玩家文字,
  当前游戏窗口截图
]
              ↓
同一个多模态模型直接理解并回答
```

当前请求会同时携带游戏窗口截图和经过 Harness 限长的 `ai-native.game-context.v1` JSON。截图负责视觉语义，结构化状态负责血量、背包、坐标、任务等精确事实；动作白名单和结果校验仍必须由游戏 API 完成，不能依赖视觉或模型猜测。如果默认模型不支持图片，Harness 会从已配置 Provider 中选择支持图片输入的模型作为本次游戏 Agent，而不是额外调用第二个模型。

## 星露谷三层适配

```text
Harness 层
  GameAgentSession / Stardew role / DSH Tool / ASR / TTS / Memory / Work
        │ 33145 会话、语音、流式文字、Presentation
        │ 动态 loopback hello、observe、action、result、revision
        ↓
游戏接口层（StardewAgentMod/Game + Harness）
  SMAPI 主线程 Dispatcher / Action Gate / Save Data / Quest / Companion Life
        ↓ IPresentationSink
用户界面层（StardewAgentMod/Presentation + Desktop Renderer）
  气泡 / HUD / 日记 / 光环 / 粒子 / 唱歌与骑乘外观 / 状态卡
```

`ModEntry` 保持为 Composition Root，不承载 Provider 或专属 Agent。游戏接口层拥有世界状态与动作结果，UI 只消费 `PresentationEvent` 与只读 `PresentationEffect`；关闭 UI 不改变动作结果。农事施法动画在动作成功提交后播放，不参与物品、体力或世界写入；收获动作只交出 `ActionItemFlight` 的物品 ID/世界坐标，契约层转换为 `HarvestWhirlwindEffect`，再由 `Presentation/HarvestWhirlwindAnimation` 绘制作物旋转汇入玩家。基础宠物跟随继续复用 Content Patcher 与 TrinketTinker，唱歌、骑乘和交互演出通过可替换外观与独立 Presentation 组件叠加。

Desktop 的随机 Adapter Protocol 地址由小汤圆 `GameGateway.gateway.ready` 下发。游戏端只接受 `ws/wss` 回环地址，并让既有 `AdapterProtocolClient` 原位切换目标；这是一条配置发现链，不是第三套协议或第二个游戏 Adapter。

陪伴生活的时间、地图、剧情、NPC 对话、低生命/体力、收入和空闲条件由 SMAPI 主线程检测。需要生成的台词调用一次性 `assistant.compose(speak=true)`，本地 Quest/互动台词调用 `assistant.speak`；两者都复用 Harness TTS 与 Native Media Host。日记明确使用 `speak=false`，主动台词不会计入玩家主动聊天次数。

## 语音链路

```text
StardewAgentMod adapter.hello(processId)
          ↓
Gateway 将允许的游戏进程交给媒体 Host
          ↓
前台游戏按住配置键 → 每 100ms 发送 PCM16 分片
          ↓
流式 ASR → 截图 + 玩家文字 → 单次多模态 GameAgentSession
          ↓
正文 token → 游戏气泡；成句文本 → 流式 TTS → PCM 边到边播
```

媒体 Host 不接受任意后台进程触发热键。Windows Host 使用全局 Virtual-Key；macOS Host 使用 AppKit 前台进程检查、AVAudioEngine、AVAudioPlayer 与 ScreenCaptureKit。原始音频不进入游戏 JSON-RPC 协议；它只在 Harness 的本机媒体链路中处理。macOS 麦克风、辅助功能/输入监控和屏幕录制权限属于桌面 App/Helper 的系统授权，不下沉到 SMAPI Mod。

火山语音凭据也停留在 Harness 层。Electron 主进程通过 `voice-credentials.mjs` 读写 DSH 官方版本化凭据文档，使用文件锁、原子替换和 `0600` 权限；preload 只向 Product UI 暴露“是否配置”和“写入新值”两个动作，不把旧值或新值回传给 renderer。`SpeechController` 在每次交互开始时重新解析凭据，因此用户保存后不需要重装 Mod 或重启游戏。

## 回复速度与真实流式呈现

协议 `1.1` 使用 `assistant.text.start / delta / done / cancel`。模型产生正文 token 后，Harness 立即发出真实增量，并以短间隔合并后续 token；游戏用累计 `text` 替换临时气泡。协议 `1.0` Adapter 继续收到兼容通知 `assistant.delta`。推理内容、工具参数和内部思考不会传给游戏。

语音是低延迟三段流水线：麦克风 PCM 在按键仍按住时已经送入流式 ASR；最终转写进入 Agent；Agent 正文达到句号或安全长度边界后立刻排入 TTS，TTS 返回的 PCM 分片直接追加到当前平台的 Native 播放缓冲区。再次按下语音键会取消当前 Agent、TTS 和播放，实现打断。流式 ASR 未开通时自动降级到极速单请求识别；极速资源也未开通时才使用标准 submit/query 兼容路径。

Harness 分别记录模型选择、窗口截取、附件保存、Agent 准备、首段正文和模型总耗时；语音链路另记录 ASR、Agent、TTS 和端到端耗时。这样可以根据真实瓶颈继续优化，而不是只看总等待时间。

## 安装与供应链

```text
Harness 对话 / Desktop 启动自检
  → 按游戏选择远端 Release 源 / Desktop 内置第一方源
  → 星露谷 v2、内置 bundle 或饥荒 v1 静态清单
  → 官方来源下载
  → 大小 + SHA-256
  → manifest / UniqueID / 版本
  → 事务替换
```

第一方与第三方发布物保持分离：

- 小汤圆星露谷 Release：适配器 + 外观包。
- 小汤圆饥荒 Release：Lua Mod + Harness Adapter 启动器。
- Content Patcher：官方 CurseForge 下载。
- TrinketTinker：官方 GitHub Release 下载。

安装失败时回滚本轮已经替换的组件。备份统一放在 `Mods` 同级的 `.xiaotangyuan-backups`，避免 SMAPI 扫描到旧副本；macOS 因此使用 `.app/Contents/MacOS/.xiaotangyuan-backups`，不会把 `.app` 根目录误判为安全写入区。自插件 `0.5.1` 起还会迁移旧安装器遗留在 `Mods` 中的小汤圆相关备份。

Desktop main 只负责触发与状态，`stardew-bootstrap.mjs` 适配内置资源，所有检测、版本比较、依赖下载、备份、配置保留与回滚继续由 `installation/stardew-valley.ts` 这一深模块拥有。Product UI 只通过 preload IPC 读取状态，不接触文件系统。

开发态插件包先由 `plugin-archive-cache.mjs` 复制为带 SHA-256 的不可变安装路径，再交给 DSH profile；这样即使版本号不变、规范 `.tgz` 被重新构建，pnpm/DSH 也不会继续复用旧路径对应的缓存内容。正式打包仍使用发行包内固定资源路径，不改变部署架构。

## 能力与 Provider

产品要求的是能力，不是固定厂商：

1. `vision.observe`
2. `speech.transcribe`
3. `speech.synthesize`
4. 麦克风录制
5. 音频播放

接口允许为不同能力选择不同 Provider。当前实现状态必须与架构目标区分：游戏 Agent 必须选择 DSH 中支持图片输入的模型，并由该模型直接回答；语音接口已抽象，但插件 `0.7.0` 当前只注册火山引擎实现。

## 协议边界

`protocol/v1` 使用本机 WebSocket 与 JSON-RPC 2.0。协议传递语义化文本、状态、事件和结果，不传 Provider Key，也不把原始 RGBA、Base64 截图或持续音频帧塞进 JSON。

实时寻路、战斗和动画等低延迟确定性逻辑应留在游戏或成熟游戏组件中，不能交给远程模型逐帧控制。

## 自动反馈边界

```text
玩家自然语言建议
  → Agent 判断是否为明确产品反馈
  → game_feedback_submit 整理结构化内容
  → 官方 Harness 使用 HMAC-SHA256 签名
  → Cloudflare Worker 验签、限流、防重放
  → Worker Secret 中的 GitHub Token 创建私有 Issue
```

玩家不需要 Git、GitHub 账号或手工问卷。GitHub Token 只存在接收端 Secret，Harness 保存的是反馈签名凭据引用，模型只能调用受限工具，不能读取任一密钥。接收端应限制目标仓库、请求体大小、时间窗口和 nonce，并为不同发行批次规划密钥轮换。

## 可选游戏 Adapter

通用 Harness 插件只提供跨游戏能力和安装入口。必须携带大量游戏知识或动作工具的 Adapter（例如缺氧）仍是独立 DSH Bundle，可以单独安装、升级和选择性加载。当前 Desktop Game Edition 为了开箱支持三款官方游戏，会把 ONI Adapter 一起打入桌面发行包；这不会把 ONI 代码合并进通用插件，也不改变其他发行版按需组合 Adapter 的边界。
