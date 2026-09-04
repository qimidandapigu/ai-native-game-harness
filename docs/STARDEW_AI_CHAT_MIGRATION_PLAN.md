# StardewAIChat 功能移植到最新 AI Native Game Harness

> 状态：2026-09-01 已在独立分支完成首轮源码适配；经用户明确授权，改动已同步到主目录 `main`，Desktop 启动自检、依赖修复、Mod 更新、动态动作通道和跨平台打包适配已完成，全部保持未提交。
>
> 基线：最新仓库 `main@219cb514fe32b86ebe6a69323d18e7986e77e0c3`；旧 `ai-native-game-harness-1.0` 仅作为上一轮移植结果的只读对照，`StardewAIChat` 全程只读。
>
> 证据边界：自动测试不等于真实 Stardew 存档、真实麦克风/TCC、真实 ASR/TTS Provider、安装包或 Steam Mods 验收。

## 1. 冻结约束

本次工作遵守以下边界：

1. 保留最新 monorepo、DSH、Harness Core、Adapter Protocol、Desktop、Work Orchestrator 与 Story Runtime 架构。
2. 不把 `StardewAIChat` 的 Mod 内 LLM、Provider Key、ASR/TTS、聊天历史或 Activation Code 复制进来。
3. `33145` 继续承担会话、截图、语音、流式回复和表现通知；权威观察、动作、revision 与结果继续走 Adapter Protocol，但 Desktop 的动态端口由 Gateway 自动通知游戏 Mod，不再要求用户手工同步 `33245`。
4. 游戏状态读取、世界修改和 SMAPI UI 调用只在游戏主线程发生。
5. 动作成功只由游戏返回的 `ActionResult.ok=true` 证明，模型文本不能替代 Gate。
6. 保留最新版已有的持久陪聊 Session、Work Orchestrator、语音流式播放/字幕同步与 32px 普通同伴视觉，不用旧文件整包覆盖。
7. 不写入 `StardewAIChat`，开发验证不安装 Steam Mods、不更新正式 DSH Profile；只在仓库 `.artifacts` 生成隔离开发 profile、插件包、Stardew 内置资源和 Desktop 打包目录。

## 2. 最新架构中的两条正式链路

### 2.1 会话与语音链路（33145）

```text
StardewAgentMod.GameAgentClient
  ↕ JSON-RPC / WebSocket :33145
plugins/xiaotangyuan-game.GameGateway
  → GameAgentSession（保留持久 Session、上下文裁剪、Work Orchestrator）
  → DSH Agent / Model / Memory / Skills
  → SpeechController
  → MediaHost Interface
      ├─ Windows XtyMediaHost.exe
      └─ macOS XtyMediaHost（Swift / AVFoundation / ScreenCaptureKit）
```

新增协议只扩展现有 Gateway：

- `assistant.compose { text, context, speak }`：游戏触发的一次性生成；`speak=true` 时排入现有语音队列。
- `assistant.speak { text }`：确定性本地台词只借用 Harness TTS，不创建第二套模型链。
- `assistant.speech.start / phrase / done`：继续使用最新版字幕与播放同步事件。
- `assistant.autonomous-speech`：在 `gateway.ready` 中声明自主陪伴语音能力。

### 2.2 权威动作链路（Desktop 动态端口，默认回退 33245）

```text
DSH 标准游戏 Tool
  → dsh-binding
  → HarnessCore.dispatchAgentAction()
  → game-transport / Adapter Protocol :<desktop-random-port>
  → Stardew AdapterProtocolClient
  → MainThreadDispatcher
  → StardewGameAdapter.Execute()
  → StardewActionModule + 游戏 Gate
  → ActionResult + revision + re-observe
```

没有从 `33145` 直接执行世界修改，也没有建立第三套 Agent 或 Core。

`GameGateway.gateway.ready` 会携带经过 loopback 校验的 `adapterProtocolUrl`。`GameAgentClient` 只接受 `ws/wss + loopback` 地址，随后让同一个 `AdapterProtocolClient` 原位切换目标并重连；旧配置仍以 `ws://127.0.0.1:33245/adapter` 作为非 Desktop 回退值。

## 3. 三层分离

```text
Harness 层
├─ plugins/xiaotangyuan-game/src/runtime/agent/game-role.ts
├─ GameGateway / GameAgentSession / DSH Tools
├─ MediaHost / SpeechController / Memory / Work Orchestrator
└─ Desktop Stardew Renderer

游戏接口层
├─ adapter/Harness/       33245 协议与主线程 Dispatcher
├─ adapter/Game/Actions/  十项权威动作及安全 Gate
├─ adapter/Game/Flight/   临时 Horse、起降、换图、落点与拖尾
├─ adapter/Game/Companion/体力、协助、关系、心情、愿望与仪式
├─ adapter/Game/Narrative/Quest、Ability 与奖励幂等
└─ StardewGameAdapter     hello / observe / execute / revision

用户界面层
├─ adapter/Contracts/PresentationEvent.cs
├─ adapter/Presentation/  气泡、HUD、日记、粒子、GMCM
├─ CompanionAppearanceController
└─ apps/desktop/src/game-view-models.mjs
```

`ModEntry` 仍是 SMAPI Composition Root，只负责装配和事件接线。游戏 Domain 通过 `IPresentationSink` 发出表现事件；表现组件不执行网络请求或世界修改。

### 3.1 Desktop 自动维护 seam

```text
Desktop main（触发、状态、容错）
  → stardew-bootstrap.mjs（读取内置资源、映射 UI 状态）
  → xiaotangyuan-game/stardew-installer（检测、校验、事务、回滚）
  → Steam Stardew/Mods（唯一文件写入边界）

Product UI
  ← preload IPC
  ← checking / ready / attention / error
```

Desktop 不复制安装算法；它只向现有安装深模块提供“客户端内置第一方 Mod 源”。第三方依赖继续使用现有固定官方 URL、大小与 SHA-256 校验。

## 4. Desktop 启动自检与自动修复

每次本地游戏版客户端启动时按以下顺序执行：

1. 自动查找 Steam 的 Stardew Valley；也可用 `STARDEW_GAME_PATH` 指定路径。
2. 检查 SMAPI。SMAPI 缺失时只提示，不静默运行第三方安装脚本。
3. 检查 Content Patcher `2.9.1` 和 TrinketTinker `1.9.0`；缺失或低于固定版本时，从官方来源下载并完成大小、SHA-256、目录、UniqueID 与版本复验。
4. 检查客户端内置的 `StardewAgentMod` 与 `XiaoTangYuanCompanion`；缺失或旧版时统一更新到内置 `0.8.1`，高于内置版本时不降级。
5. 写入前把受管旧目录移动到游戏根目录 `.xiaotangyuan-backups`；保留 `StardewAgentMod/config.json`；任一组件失败时逆序回滚本次改动。
6. 自动修复失败不会阻止 AI Runtime 启动。启动页显示进度，游戏版“管理游戏连接”页保留结果和“重新检查”入口。

如果游戏已经运行，文件可以完成更新，但需要重启 Stardew/SMAPI 才会加载新版本。

## 5. 已移植功能

### 5.1 权威动作

| Capability | 游戏侧事实与 Gate |
| --- | --- |
| `stardew.plant_seeds_all` | 玩家当前种子、可种地块、背包扣减与实际数量 |
| `stardew.water_all` | 当前地图干燥耕地与花盆；空目标返回 `NO_TARGETS` |
| `stardew.harvest_all` | 成熟作物、背包/箱子/地面安全收纳 |
| `stardew.speed_grow` | 未成熟作物推进与补水 |
| `stardew.clear_debris` | 玩家周围八格；保护作物、设施、果树、茶树和挂采集器的树 |
| `stardew.flight_takeoff` | 室外主地图、临时坐骑、转换状态与体力 |
| `stardew.flight_land` | 安全落点、缓降、地图与坐骑生命周期 |
| `stardew.fish_help` | 能力解锁、体力与下一杆一次性协助 |
| `stardew.mine_combat` | 矿洞场景、能力、持续时间与主线程战斗协助 |
| `stardew.rescue_home` | 凌晨/低状态条件、回家与原版睡眠链 |

所有动作使用 requestId 幂等缓存和 revision 检查；成功且真实改变状态后才递增 revision。炸鱼保留为本地手动玩法，不注册 Agent Tool。

### 5.2 陪伴生活与表现

- 三分支成长继续保留，并进入权威 Observation。
- 关系、心情、怪癖、每日愿望、早晚/天气/地点仪式、Quest/Ability、日记和社交短评。
- 剧情结束、NPC 对话、骷髅洞、低生命/低体力、单日收入跃升和 30 秒空闲等游戏侧确定性触发。
- 本地戳/打互动、HUD、日记菜单、动作施法效果、心情/思考效果和 GMCM 游戏配置。
- 唱歌与飞行坐骑外观；普通同伴沿用最新版造型，按无插值 2× 适配旧飞行代码要求的 64px 帧，屏幕显示尺寸不变。
- 主动生成使用 `assistant.compose`；生成失败才对本地 fallback 调用 `assistant.speak`，避免重复朗读；日记 `speak=false`。

### 5.3 Harness 角色路由

- Stardew 专属角色约束只对 `gameId=stardew-valley` 生效。
- 播种、浇水、收割、催熟、清障/砍树、起飞、落地、钓鱼协助、打怪和救援具有中英文确定性别名。
- 否定句和历史陈述不会触发当前动作。
- 命中只生成“必须调用标准游戏 Tool”的路由提示，不绕过 Harness Core。
- Desktop 直接对话路径也只在 Stardew 游戏连接时注入同一类权威结果规则；最新版 Work/Story 提示保持不变。

## 6. macOS 语音与视觉链路

`MediaHost` 是 Speech 与 Multimodal 的平台中立接口。`NativeMediaHost` 根据 `process.platform` 选择 Windows 或 macOS helper，保留最新版的：

- PCM 流式播放与 phrase 播放位置等待；
- `playback.finished` 完成事件和超时兜底；
- barge-in / cancel；
- 录音分块、完整 WAV 与窗口截图。

macOS helper 使用：

- `AVAudioEngine`：麦克风转 16kHz mono PCM16，并生成 WAV；
- `AVAudioPlayer` / `AVAudioPlayerNode`：整段 WAV 与流式 PCM 播放；
- `NSEvent` 全局监听：仅当前台进程属于已连接游戏时响应 `pushToTalkKey`；
- `ScreenCaptureKit`：按游戏 PID 捕获最大窗口；
- 内嵌 `Info.plist`：麦克风、屏幕录制与输入监控用途说明。

自动测试会在临时目录现场编译 arm64 helper、禁用权限弹窗后验证 ready/shutdown 协议；不会把测试二进制留在源码目录。

本地 Desktop 准备流程会自动选择当前平台的 helper。macOS 构建产物进入插件 `.tgz` 后普通资源权限会被规范化为只读，因此 `NativeMediaHost` 会在首次启动时把它原子复制到稳定的 `~/.xiaotangyuan/media/macos-arm64/XtyMediaHost`，赋予 `0755` 后再启动；内置资源保持只读。macOS 的麦克风、屏幕录制和输入监控权限仍必须由用户在系统弹窗或系统设置中授权，应用不会绕过 TCC。

## 7. 最新版保留项

本次没有回退以下最新版能力：

- `GameAgentSession` 的持久 save-scoped Session、上下文窗口裁剪和空回复兜底；
- Work Orchestrator 的非游戏工作识别、进度查询和异步回传；
- Story Runtime 的 Desktop turn 规则；
- `assistant.speech-sync` 的完整字幕、播放起止和语音打断；
- 最新普通同伴贴图和气泡偏移迁移（旧 `220` → 当前 `56`）。

## 8. 自动验证记录

| 范围 | 命令/方式 | 当前结果 |
| --- | --- | --- |
| Stardew C# | `dotnet build -c Release` | 通过，0 warning / 0 error |
| Work Orchestrator | 本地 TypeScript build + Vitest | 7 tests 通过 |
| 小汤圆插件 | 本地 TypeScript build + Vitest | TypeScript 通过，125 tests 通过 |
| macOS helper | Vitest 内临时 `swiftc` + JSON-lines smoke | 通过 |
| 平台 | platform-tests | 22 tests 通过 |
| 集成 | integration-tests | 41 tests 通过 |
| 官方依赖安装 | Content Patcher / TrinketTinker 真实发布包 + 隔离游戏目录 | 大小、SHA-256、manifest 与四包事务安装通过 |
| Desktop | 隔离 profile + 不存在的游戏路径启动 Electron | preload、Stardew IPC/状态卡、DSH Web、Gateway、退出清理通过，残留进程 0 |
| Desktop 资源准备 | `prepare-desktop-dev.mjs` + `prepare-desktop-runtime.mjs` | 插件 `.tgz`、Stardew Adapter 与内容包 `0.8.1`、macOS helper 与打包输入目录生成通过 |

项目指定的 `pnpm ... check` 命令在最终复跑时被本机 pnpm 包管理器的在线签名检查拦截；仓库内已安装的同一 `tsc` 与 `vitest` 随后直接执行并取得上表结果。`git diff --check`、新增文本冲突标记/尾随空白检查、共享热点状态检查和源代码本机路径检查均已通过。最终 C# 修正后再次执行 Release build，仍为 0 warning / 0 error。

## 9. 共享热点与集成交接

用户明确要求把自动维护能力直接整合到本地主目录后，本任务作为该范围的主目录集成管理任务，按认领文件登记后修改了根 Desktop 命令、Integration development version、Desktop main/builder 和插件 package 清单。`pnpm-lock.yaml`、插件 `cordis.patch.yml`、根 `README.md`、产品理念文档和其他任务认领文件仍未修改。

插件 development version 已同步为 `0.8.1`，导出 `./stardew-installer`，并在平台包清单中加入 macOS MediaHost。`scripts/prepare-desktop-dev.mjs` 与 `scripts/prepare-desktop-runtime.mjs` 复用同一批源文件生成开发和打包资源，不以 `distribution/` 生成物作为源码交换渠道。

## 10. 尚未完成的真实验收

仍需在重启后的真实 Stardew 1.6 存档中验证：

1. SMAPI、Content Patcher、TrinketTinker 与可选 GMCM 的实际兼容。
2. 十项动作的成功、拒绝、空目标、revision 冲突与换图生命周期。
3. 唱歌、骑乘、气泡、日记、HUD、粒子和普通同伴视觉。
4. macOS 为实际宿主授予麦克风、输入监控/辅助功能和屏幕录制权限。
5. 真实 `V` 按住说话 → ASR → Agent/Tool → TTS → 扬声器 → 字幕结束的完整链路。
6. 使用真实 Provider 凭据的 ASR/TTS 延迟、打断和长时间稳定性。
7. 从最终签名/分发的 macOS 与 Windows 客户端完成真实 Steam Mods 装配；当前只验证了本地插件包、Desktop Runtime 目录和临时游戏目录。
