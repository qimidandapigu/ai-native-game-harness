# AI Native Game Harness

AI Native Game Harness 是一个面向 AI 原生与 AI 连接型游戏的 **DeepSeek Harness 游戏发行版**。

它复用 DeepSeek Harness（DSH）已经提供的模型、Agent、工具、会话、权限、配置和插件生命周期，不重新实现一套通用 Agent 运行时；本项目专注于游戏领域插件、桌面产品、游戏接入协议和可独立安装的 Game Pack。

## 产品边界

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

## 为什么基于 DSH

我们需要的模型、Agent、工具、会话、设置、凭据、授权、日志和插件生命周期，与 DeepSeek Harness 已解决的问题相同。重写这些基础设施不会形成游戏产品的独特价值，也更难达到上游的兼容性和稳定性。

因此本项目遵循三个原则：

1. 复用并固定经过验证的 DSH 运行时版本，包括其命名空间下的 Cordis 依赖。
2. 游戏能力尽量实现为标准 DSH 插件，不塞进 Electron Main，也不复制到每个 Mod。
3. 上游升级作为独立变更执行，通过 Fake Game、协议兼容和真实游戏闭环测试后再合入，而不是自动追随最新版。

这不是给 DSH 增加一个“游戏模式”，也不是要求用户先安装另一个 DSH 应用。最终用户安装的是一个完整的 AI Native Game Harness 桌面应用，其中已经打包了所需的 DSH Runtime 和官方游戏插件。

## 当前仓库结构

```text
AI Native Game Harness/
├─ apps/
│  └─ desktop/                 # 最小 Electron 启动、窗口和 Windows 打包
├─ runtime/                     # 固定版本的 DSH 发行配置与启动入口
├─ plugins/                     # 跨游戏复用的标准 DSH 插件
│  ├─ game-core/                # 游戏上下文、状态与统一领域服务
│  ├─ game-transport/           # Bridge 连接、请求、事件、取消和健康检查
│  ├─ adapter-manager/          # 游戏发现、连接、权限和能力管理
│  ├─ game-memory/              # 按 gameId + saveId 隔离的游戏记忆
│  ├─ game-media/               # 语音、视觉与媒体通道
│  ├─ game-ui/                  # 对话、分析和连接诊断界面
│  ├─ game-installer/           # 游戏与 Mod 安装定位
│  ├─ game-bundle/              # Game Pack 安装、校验与更新
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
| `apps/desktop` | Electron 必须在 DSH 启动前存在，但它只管理进程、窗口和系统集成，不拥有游戏业务。 |
| `runtime/dsh-profile` | 集中固定 DSH 版本与插件装配；这是发行配置，不是另一套自研 Runtime。 |
| `plugins` | 所有游戏都能复用的运行能力只实现一次，并遵循 DSH 插件生命周期。 |
| `contracts` | Harness 与 C#、Lua、C++ 等 Mod 都依赖同一份线协议，契约不能反向依赖某个 TypeScript 插件。 |
| `games/<game>` | 同一游戏的 Harness Plugin、Native Bridge 与 Pack 必须一起测试、定版和发行。 |
| `tests` | 把协议正确、插件可装配和真实状态改变分别验证，避免把构建成功当成游戏接入成功。 |
| `distribution` | 源代码包和用户安装包具有不同组合方式、版本与校验规则。 |

依赖方向必须保持单向：

```text
Desktop → DSH Profile → Shared Plugins → Game Harness Plugin
                                           ↓
                                    Bridge Contract
                                           ↓
                                   Native Bridge → Game API
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
state → Agent → semantic tool call → permission/schema validation
      → transport → native API wrapper → authoritative result
      → new state → trace/replay
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
- `dsh-xiaotangyuan-game` 的本地 `0.7.7` Harness Plugin 已能打包、安装到隔离 DSH Profile、合并配置并真实启动 WebSocket Gateway；
- 源码基线仍固定 DSH `0.1.0-rc.6`；桌面发行 Runtime 固定为已验证的 `0.1.1-rc.2`；桌面应用和三个游戏 Adapter 统一使用游戏版专用地址 `127.0.0.1:33145`，避免占用普通 DSH 实例的 `32145`；
- Electron 桌面壳会管理内置 DSH 进程、隔离用户 Profile、启动状态页和 DSH Web 窗口；
- 当前桌面游戏版会同时装配通用小汤圆插件和独立 ONI Adapter；两者仍是两个 DSH Bundle，独立插件安装场景不会被强制绑定；
- 桌面游戏版使用独立运行配置：星露谷和饥荒默认按住 `V` 语音；缺氧因游戏内 `V` 已占用，由 Mod 用 `Q` 发送 `voice.start` / `voice.stop`；通用插件源码默认键仍为 `F8`；
- 流式 ASR 的中间转写和最终转写只在 Harness 内部送入 Agent，不再把玩家原话重复显示到游戏气泡；
- 可在 Windows 本地构建 `.exe` 安装包，但尚未创建签名和正式 GitHub Release，因此 GitHub 暂无公开下载按钮。

| 能力 | 当前状态 |
| --- | --- |
| Fake Game 权威闭环 | 已实现并有自动化测试 |
| `game-core` / `game-transport` / Bridge v1 | 已实现 |
| 小汤圆 `0.7.7` 插件打包、隔离安装和 Gateway 启动 | 已验证 |
| 内置 DSH + 小汤圆 + ONI Adapter + 本地模拟模型的状态/对话冒烟闭环 | 已验证 |
| Electron 启动内置 DSH、隔离 Profile、显示状态 | 已实现 |
| 游戏版统一使用 `33145`；星露谷/饥荒按 `V`，缺氧按 `Q` | 已实现 |
| 缺氧 C# Bridge `0.6.7` | 源码已构建，尚未发布 Release |
| Windows NSIS `.exe` | 本地已构建，未签名、未发布 |
| 产品专属分析页与游戏连接中心 | 尚未实现 |
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

产物写入 `distribution/desktop/`，安装后的应用和桌面快捷方式显示为 **AI Native Game Harness 游戏版**，并使用游戏手柄与 AI 核心组合图标。桌面运行使用 `integrations/xiaotangyuan/desktop.patch.yml`，并把通用小汤圆插件与独立 ONI Adapter 一起装入发行 Runtime；装配测试继续使用 `smoke.patch.yml` 和本地模拟模型。开发时运行 `pnpm desktop:start`，不要求另行安装 DSH，但仓库开发命令本身需要 Node.js 和 pnpm。未来正式发布的 `.exe` 才面向无需开发环境的普通玩家。

接下来按产品闭环继续：

1. 在至少一个真实游戏存档中完成状态、文字、语音和动作闭环验收；
2. 补代码签名、升级清单和崩溃诊断；
3. 生成校验和并发布 GitHub Release。

DSH 不自动追新，但可以受控升级。运行 `pnpm dsh:update:check` 查看候选版本，升级规则见 [UPGRADING_DSH.md](docs/UPGRADING_DSH.md)。

更完整的产品定位与架构说明见 [AI_GAME_ENGINE_IDEOLOGY.html](docs/AI_GAME_ENGINE_IDEOLOGY.html)。
