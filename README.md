# AI Native Game Harness

AI Native Game Harness 是一个面向 AI 原生与 AI 连接型游戏、基于 DeepSeek Harness（DSH）构建的游戏产品运行层与 Adapter 框架。

它复用 DSH 的模型、Agent、Tool、Session、凭据、权限和插件生命周期，在模型/Agent 与游戏之间补充稳定的游戏状态、动作安全、Game Pack、跨进程协议和可观测性接口。

**架构决策：产品默认优先使用 DSH；只有经过可复现测试证明 DSH 不匹配的能力，才允许由本项目最小化替换。** `harness-core` 不依赖 DSH 类型是为了边界清晰和独立测试，不代表产品默认抛开 DSH。详见 [ADR 0001](docs/decisions/0001-dsh-first-reuse-policy.md)。

## 产品层与可测试核心

```text
apps/
  desktop/          对话页、自学习页、分析页、Adapter 中心

packages/
  harness-core/     Adapter 路由、动作校验、revision 与游戏侧 Trace
  adapter-protocol/ 游戏通信协议与 JSON Schema
  adapter-websocket/本机跨进程 Host 与可重连参考客户端
  game-pack/        剧情、角色、玩法和资源清单
  dsh-binding/      默认产品接线：DSH Agent 会话 ↔ 游戏 Harness Core

examples/
  mock-game/        不依赖真实游戏与 DSH 的参考 Adapter
```

游戏内核的依赖方向是 `dsh-binding → harness-core → adapter-protocol → 游戏 Adapter`。DSH 负责通用 AI Runtime，Harness Core 负责 Adapter 路由、动作校验、revision 与游戏侧 Trace；核心包不反向依赖 DSH，默认产品仍由固定版本 DSH 驱动。

运行独立 Mock 闭环和产品界面：

```powershell
pnpm install
pnpm platform:test
pnpm mock:start
pnpm desktop:demo
```

`mock:start` 和 `desktop:demo` 是不依赖真实游戏的协议一致性测试夹具。`desktop:start` 与 `desktop:dsh` 现在都启动固定版本 DSH 和产品专属页面；Standalone Platform Runtime 不再是默认产品路径。

## 默认产品边界（DSH-first）

- **DSH Runtime**：默认提供模型、Agent、Tool Calling、Session、配置、凭据、权限、日志与插件生命周期。
- **Desktop**：打包并管理固定版本 DSH、产品窗口、对话页、分析页和 Adapter 中心。
- **DSH Binding**：把 DSH Agent 的游戏 Tool Call 接到 Harness Core，并把动作结果返回 DSH Agent。
- **Harness Core**：统一 Adapter 注册、游戏动作校验、revision、能力路由和 Trace；不重造通用 Agent Runtime。
- **Game Adapter**：运行在游戏侧或独立进程，提供观察、动作、事件和权威结果。
- **Game Pack**：分发剧情、角色、玩法数据、资源和 Adapter 入口清单。
- **Standalone Agent Driver**：仅用于 Mock 测试或经过 ADR 替换门槛确认的具体缺口。

## 自学习边界

自学习不是另一套 Agent，也不是角色等级系统。默认产品继续使用同一个 DSH Session，只增加两条相互独立的闭环：

- **记忆学习**：每轮由 DSH Tool 按 `gameId + saveId` 召回；回复完成后使用当前 DSH 默认模型在后台提取少量长期事实。当前 Observation 和真实 Tool 结果永远优先于旧记忆。
- **技能学习**：候选 `xiaotangyuan-skill-v1` 程序只能调用当前 Adapter 已声明的 action capability，并通过 Harness Core 在真实游戏中逐步试跑；整段成功才保存，失败只保留诊断记录。
- **产品可见性**：Desktop“自学习”页分开展示当前存档记忆、该游戏已学技能和最近失败尝试。剧情、角色成长、等级与 Bug 技能不属于本阶段。

默认接线是 `DSH Session → game-learning-binding → 小汤圆现有 MemoryService / SkillService → Harness Core → Adapter Protocol`。它复用已验证的存储和门禁，不复制第二份学习数据库。

## DSH-first 主路径

- **DSH Runtime**：提供通用 AI 运行能力和 Cordis 插件容器。
- **我们的 DSH 插件**：提供游戏状态、语义工具、记忆、语音、视觉、UI、安装和跨进程连接等游戏能力。
- **每游戏 Harness Plugin**：把某个游戏的知识、状态和原生 API 组合成 Agent 能理解的高层工具。
- **Game Mod / Native Bridge**：运行在游戏进程中，只封装并暴露安全的原生游戏 API，返回权威状态和执行结果。
- **游戏本体**：拥有存档、物品、金钱、任务、胜负、移动、战斗和逐帧逻辑等真实世界状态。

Mod 不是另一个 Agent，也不负责规划、记忆或调用模型。Harness 才是调用方：

```text
玩家
  → DSH Agent
  → 每游戏 Harness Plugin（高层语义工具、编排与校验）
  → Game Transport Plugin（连接、请求、事件、取消与健康检查）
  → Native Bridge / Mod（薄 API 封装和游戏侧最终校验）
  → 真实游戏 API
  → 权威结果与新状态原路返回
```

我们需要的模型、Agent、工具、会话、设置、凭据、授权、日志和插件生命周期，与 DeepSeek Harness 已解决的问题相同。重写这些基础设施不会形成游戏产品的独特价值，也更难达到上游的兼容性和稳定性。

这一条现有发行路径遵循三个原则：

1. 复用并固定经过验证的 DSH 运行时版本，包括其命名空间下的 Cordis 依赖。
2. 游戏能力尽量实现为标准 DSH 插件，不塞进 Electron Main，也不复制到每个 Mod。
3. 上游升级作为独立变更执行，通过 Fake Game、协议兼容和真实游戏闭环测试后再合入，而不是自动追随最新版。

这不是要求用户先安装另一个 DSH 应用。正式发行版会内置固定版本 DSH Runtime；我们的产品在其上装配游戏插件、Harness Core 和 Game Adapter 能力。其他 Agent Host 可以作为经过验证的扩展接入，但不改变 DSH-first 默认策略。

## 当前仓库结构

```text
AI Native Game Harness/
├─ apps/
│  └─ desktop/                 # 最小 Electron 启动、窗口和 Windows 打包
├─ runtime/                     # 固定版本的 DSH 发行配置与启动入口
├─ plugins/                     # 跨游戏复用的标准 DSH 插件
│  ├─ game-core/                # 游戏上下文、状态与统一领域服务
│  ├─ game-transport/           # Bridge 连接、请求、事件、取消和健康检查
│  ├─ game-learning-binding/    # 默认 DSH Session 与现有记忆/技能服务接线
│  └─ xiaotangyuan-game/        # 已迁入的多游戏 DSH 插件与当前产品能力
├─ contracts/                   # 跨进程线协议与 Schema；它是契约，不是插件
├─ games/
│  ├─ fake-game/               # 确定性的端到端测试游戏
│  ├─ stardew-valley/          # 星露谷 C# Bridge、外观包与发行脚本
│  ├─ dont-starve-together/    # 饥荒 Lua Mod、Adapter 与发行脚本
│  └─ oxygen-not-included/     # 缺氧 Harness Adapter、C# Bridge 与发行脚本
└─ tests/
   ├─ fake-game/                # 快速、确定性的完整闭环
   ├─ protocol/                 # 跨版本契约测试
   └─ integration/              # DSH 插件装配与桌面启动测试
```

`Adapter` 在产品界面中仍可作为“游戏接入”的通俗名称；在代码所有权上，它主要由 **每游戏 Harness Plugin + 薄 Native Bridge + 两者之间的线协议** 组成，不再是一个把 AI 逻辑放进游戏进程的粗粒度模块。

## 为什么这样分目录

目录同时表达四种边界：运行进程、复用范围、依赖方向和发行单元。

| 目录 | 拆分原因 |
| --- | --- |
| `apps/desktop` | 管理窗口、内置 DSH 子进程、产品 IPC 和系统集成；不拥有具体游戏规则。 |
| `runtime/dsh-profile` | 集中固定 DSH 版本与插件装配；这是发行配置，不是另一套自研 Runtime。 |
| `plugins` | 所有游戏都能复用的运行能力只实现一次，并遵循 DSH 插件生命周期。 |
| `contracts` | Harness 与 C#、Lua、C++ 等 Mod 都依赖同一份线协议，契约不能反向依赖某个 TypeScript 插件。 |
| `games/<game>` | 同一游戏的 Harness Plugin、Native Bridge 与 Pack 必须一起测试、定版和发行。 |
| `tests` | 把协议正确、插件可装配和真实状态改变分别验证，避免把构建成功当成游戏接入成功。 |
| `distribution` | 源代码包和用户安装包具有不同组合方式、版本与校验规则。 |

依赖方向必须保持单向：

```text
Desktop → pinned DSH Runtime → DSH Agent / Tools
                                ↓
                           dsh-binding
                                ↓
Harness Core → Adapter Protocol → Game Adapter → Game API
```

新增能力时的归属规则：

- DSH 已经提供：在 Profile 中装配，不重写；
- 跨游戏且需要运行：放进 `plugins/`；
- 某游戏的知识、工具或编排：放进该游戏的 `harness-plugin/`；
- 必须进入游戏进程调用原生 API：放进 `native-bridge/`；
- 只是跨语言数据格式：放进 `contracts/`；
- 只负责安装、版本和校验：放进 `pack/` 或 `distribution/`。

## Game Pack

一个游戏的可独立安装包同时包含：

- Harness Plugin：安装到本产品的 DSH Profile；
- Native Bridge / Mod：安装到游戏的 Mods 目录；
- 内容与配置：知识、角色、玩法参数和本地化；
- Manifest、版本、兼容范围、校验和和卸载信息。

Game Pack 可以一键安装，但两部分运行在不同进程、承担不同职责。核心业务与 AI 语义位于 Harness Plugin；Mod 只保留必须贴近游戏 API 的最薄实现。

## 第一条验证闭环

第一版先用 Fake Game 验证：

```text
state → DSH Agent → semantic tool call → permission/schema validation
      → transport → native API wrapper → authoritative result
      → new state → DSH durable log + correlated game trace
```

随后再用一个真实游戏验证同一条链路。构建成功不等于接入成功；必须能观察到状态变化、调用参数、游戏侧执行结果和最终状态。

当前仓库已经实现第一条 Fake Game 纵向切片：

- `game-core` 和 `game-transport` 是可由 Cordis 装载、可卸载的 DSH 插件；
- `fake-game-harness` 注册真实 DSH Tool：`fake_collect_coin`；
- Harness Plugin 依次调用 `game.observe → game.move → game.collect → game.observe`；
- Fake Native Bridge 执行权威状态变更；
- 集成测试验证位置、体力、金币、revision、Trace 与插件卸载清理。

运行验证：

```powershell
pnpm install
pnpm check
```

## 当前可用程度

目前已进入“可构建桌面安装包”的开发预览阶段：

- Fake Game 已完成 `state → tool → Bridge → authoritative state` 自动化闭环；
- 《缺氧》Adapter 已可在不启动游戏时用假文件 Bridge 自动验证协议握手、能力、revision、动作、错误、超时、事件和断线重连；
- 独立 Platform Runtime 原型已能托管 Harness Core 和 WebSocket Adapter Host，并通过安全 IPC 驱动对话页、分析页和 Adapter 中心；它是测试夹具，不是目标默认 AI Runtime；
- Agent Driver 已改为双向动作循环：Agent 只提出动作，Core 统一校验、执行并把结果和新状态回传；
- `game-core + game-transport + dsh-binding` 已装入真实 DSH Agent 进程：模型能调用 Adapter 动作，Core 会把 `ActionResult` 与最新权威 Observation 返回 Agent；
- Desktop 产品窗口现在常驻：对话页直接消费 DSH Session 的公开文本流，分析页保留 DSH 原生 `SessionId`、`turn`、`step` 和 `callId`，再用 Binding 原样复用的 `callId/requestId` 合并 Core 游戏侧 Trace；页面可沿 `Session → 回合 → 步骤 → Tool callId → 游戏 requestId` 定位一次动作，并分开显示 Core 校验、Adapter 往返、Bridge 往返、游戏内执行和动作后状态刷新；Adapter 中心显示连接、能力、协议版本和重连状态；
- 对话页的游戏状态区已改为展示器注册表：未知游戏自动使用通用 observation 查看器，《缺氧》显示殖民地摘要，只有 Mock Game 保留金币地图；多个 Adapter 连接时可在 Adapter 中心切换当前游戏；
- 分析页已加入失败、超时、重连、语音与动作筛选，能够搜索关联 id；语音链路记录 ASR、模型首字、Agent、TTS 和总耗时，诊断导出会脱敏并限制为最近 500 条 Trace，不包含聊天正文、语音转写或隐藏思维；
- Desktop 已能从目录校验、安装、登记、替换和卸载 Game Pack；第三方可复制 `examples/adapter-starter`，并用 `adapter-conformance` 在 CI 中验证 hello、observe、action/result 与 revision；
- 安装 Game Pack 当前不会自动执行未知第三方入口：Pack 启动、权限授权和签名策略在安全层落地前保持显式；
- 模型 `reasoning-delta` 与 Standalone Driver 的 `analysis` 不进入产品 IPC 或 Core Trace；页面只记录事件类型、调用参数、结果、错误码、revision 和耗时；
- `dsh-xiaotangyuan-game` 的本地 `0.7.7` Harness Plugin 已能打包、安装到隔离 DSH Profile、合并配置并真实启动 WebSocket Gateway；
- 源码基线与桌面发行 Runtime 已统一固定为 DSH `0.1.1-rc.2`，端口使用 `33145`，不占用日常实例的 `32145`；
- Electron 已恢复内置 DSH 为默认产品路径；`desktop:demo` 继续保留为不依赖模型的 Standalone 测试夹具；
- 当前桌面游戏版会同时装配通用小汤圆插件和独立 ONI Adapter；两者仍是两个 DSH Bundle，独立插件安装场景不会被强制绑定；
- 桌面产品会把动态 `adapterProtocolUrl` 注入 ONI Adapter；缺氧动作由 Adapter Protocol 进入 Harness Core 后再注册为 DSH Tools，不再绕过 Core 直接执行；
- 桌面游戏版使用独立运行配置：星露谷和饥荒默认按住 `V` 语音；缺氧因游戏内 `V` 已占用，由 Mod 用 `Q` 发送 `voice.start` / `voice.stop`；通用插件源码默认键仍为 `F8`；
- 流式 ASR 的中间转写和最终转写只在 Harness 内部送入 Agent，不再把玩家原话重复显示到游戏气泡；
- 可在 Windows 本地构建 `.exe` 安装包，但尚未创建签名和正式 GitHub Release，因此 GitHub 暂无公开下载按钮。

| 能力 | 当前状态 |
| --- | --- |
| Fake Game 权威闭环 | 已实现并有自动化测试 |
| 《缺氧》无游戏 Adapter 协议测试 | 已实现；不启动 ONI 即覆盖成功、拒绝、revision 冲突、超时、事件与重连 |
| `game-core` / `game-transport` / Bridge v1 | 已实现 |
| 小汤圆 `0.7.7` 插件打包、隔离安装和 Gateway 启动 | 已验证 |
| 独立 Core + Adapter Host 测试夹具 | 已实现并有自动化测试，不是目标默认 Runtime |
| Agent action → Core execute → action-result 循环 | 已实现，含拒绝和动作上限测试 |
| DSH Agent → Tool → Core → WebSocket Adapter → 权威状态 | 已实现；真实 DSH Agent + Mock Game 冒烟通过（金币 1，revision 2） |
| Electron 内置 DSH 主路径 | 已恢复为默认；产品页不再跳转到 DSH Web |
| 内置 DSH + 小汤圆 + ONI Adapter + 本地模拟模型的状态/对话冒烟闭环 | 已验证 |
| 游戏版统一使用 `33145`；星露谷/饥荒按 `V`，缺氧按 `Q` | 已实现 |
| 缺氧 C# Bridge `0.6.7` | 源码已构建，尚未发布 Release |
| Windows NSIS `.exe` | 本地已构建，未签名、未发布 |
| 产品专属对话页、分析页与 Adapter 中心 | 已接入 DSH Session + Core Snapshot；`Session → turn → step → callId → requestId` 与游戏动作四段耗时已进入分析页；任意新 Adapter 可先用通用状态查看器 |
| 脱敏诊断、筛选与语音分段耗时 | 已实现；导出最近最多 500 条 Trace，不导出聊天正文、转写和隐藏思维 |
| Game Pack 安装注册表 | 已实现目录校验、事务安装、替换、发现和版本安全卸载；暂不自动执行第三方入口 |
| 第三方 Adapter Starter 与协议体检 | 已实现；可复制模板，并以 conformance report 接入 CI |
| 首个真实游戏 Game Pack 的最终游戏内验收 | 尚未完成 |
| GitHub Release 与自动升级 | 尚未完成 |

本地复现小汤圆插件接入：

```powershell
pnpm integration:xiaotangyuan
```

这条命令会在当前仓库内构建 `apps/windows-media-host` 和 `plugins/xiaotangyuan-game`，打包插件并安装到仓库内忽略的隔离 Profile。随后它会启动与桌面应用同版本的内置 DSH，等待 Web 页面和 Gateway 就绪，用测试 Adapter 发送一次游戏状态与对话请求，验证响应后自动关闭全部测试进程。测试使用本地模拟模型，不读取 API Key，不修改用户的日常 DSH Profile，也不会占用正在运行的正式 Gateway 端口。

原 `dsh-xiaotangyuan-game` 的插件、三个游戏的 Mod/Bridge、发行清单、协议与测试源码已经迁入本仓库。旧仓库可以作为历史快照保留；现有旧 Release 链接暂时继续承载已经发布的游戏包，后续新版本和新 Release 统一从本仓库发布。

### 仓库维护策略

- **唯一源码仓库**：今后的插件、桌面应用、游戏 Mod/Bridge、协议、测试和文档修改都提交到 `ai-native-game-harness`。
- **旧仓库不再开发**：`dsh-xiaotangyuan-game` 不再接收同一套源码的重复修改，也不参与本地构建。
- **旧 Release 暂时保留**：已经发布的游戏包仍使用旧仓库下载地址；这只是静态文件托管，不代表需要维护两套代码。
- **后续彻底收口**：新版本改由主仓库发布；等旧下载入口全部替换后，可将旧仓库设为 Archive，但不要直接删除。

构建桌面安装包：

```powershell
pnpm desktop:dist
```

真实 DSH Agent 到 Mock Game 的第一阶段冒烟：

```powershell
pnpm smoke:dsh-adapter
```

DSH Session API、官方 `sessionStats` 投影与 Desktop 薄 Bridge 冒烟：

```powershell
pnpm smoke:dsh-product
```

产物写入 `distribution/desktop/`，安装后的应用和桌面快捷方式显示为 **AI Native Game Harness 游戏版**，并使用游戏手柄与 AI 核心组合图标。`pnpm desktop:start` / `pnpm desktop:dsh` 使用内置 DSH 产品链和 `integrations/xiaotangyuan/desktop.patch.yml`，把通用小汤圆插件与独立 ONI Adapter 一起装入发行 Runtime，并启用视觉、语音与媒体；`pnpm desktop:demo` 用于独立 Mock 测试，装配冒烟使用 `smoke.patch.yml` 和本地模拟模型。仓库开发命令需要 Node.js 和 pnpm，未来正式发布的 `.exe` 才面向无需开发环境的普通玩家。

接下来按产品闭环继续：

1. 按 [真实游戏端到端验收清单](docs/REAL_GAME_ACCEPTANCE.md) 在至少一个真实存档完成状态、文字、语音、动作、失败和重连闭环；
2. 为第三方 Game Pack 增加权限授权、可信启动策略和签名验证，再允许 Desktop 启动其 Adapter 入口；
3. 生成校验和并发布签名 GitHub Release。

DSH 不自动追新，但可以受控升级。运行 `pnpm dsh:update:check` 查看候选版本，升级规则见 [UPGRADING_DSH.md](docs/UPGRADING_DSH.md)。

更完整的产品定位与架构说明见 [AI_GAME_ENGINE_IDEOLOGY.html](docs/AI_GAME_ENGINE_IDEOLOGY.html)。
