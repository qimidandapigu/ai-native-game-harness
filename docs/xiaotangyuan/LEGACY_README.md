# dsh-xiaotangyuan-game

小汤圆游戏 AI 的单仓库。DeepSeek Harness 插件承载通用 Agent、模型、多模态、语音、媒体和安装能力；每个游戏只保留必须调用游戏 API 的薄 Bridge，游戏知识与专属工具放进可选 Adapter。

```text
玩家文字 / 麦克风 / 游戏窗口
              ↓
DeepSeek Harness + 小汤圆插件
Agent、视觉、ASR、TTS、工具、安装器、媒体 Host
              ↓ protocol/v1
可选游戏 Adapter
游戏知识、专属工具、协议翻译与安装器
              ↓ 本机桥协议
游戏 Bridge / Mod
读取状态、调用游戏 API、呈现回复
```

## 当前版本

| 组件 | 版本 | 状态与说明 |
|---|---:|---|
| Harness 插件 | `0.7.7` | 当前源码版本；统一游戏 Context、隔离长期记忆、真实文字流和流式语音 |
| 最新公开 Harness Release | `0.5.1` | 已发布稳定版，只包含此前的星露谷链路 |
| 星露谷适配器 | `0.6.1` | 统一 Context、三分支成长、存档隔离与小汤圆外观包 |
| 饥荒联机版 Mod | `0.2.23` | 统一 Context、可执行技能、游玩心跳与 Jingling 动画 |
| 缺氧 Adapter | `0.1.5` | 可选 Harness 插件；游戏专属动作、知识与安装器不进入通用包 |
| 缺氧 C# Bridge | `0.6.6` | 统一 Context、水团术、动作执行与固定复制人跟随精灵 UI |
| Content Patcher | `2.9.1` | 官方第三方资源加载组件 |
| TrinketTinker | `1.9.0` | 官方第三方宠物跟随与渲染组件 |

Harness 插件和游戏包独立发版，所以版本号不要求完全相同。仓库版本不等于已公开 Release；发布前不要把尚未存在的 Release URL 当成安装入口。

## 多模态能力路由

小汤圆依赖的是能力，不绑定某一家模型厂商：

```text
vision.observe       看当前游戏窗口
speech.transcribe    把玩家语音转成文字
speech.synthesize    把 Agent 回复合成为语音
```

游戏 Agent、视觉、ASR 和 TTS 可以由不同实现提供。插件通过能力注册表自动选择已经就绪的实现，也允许分别指定语音识别和语音合成 Provider；新增 Provider 不需要修改任何游戏 Adapter 或 Bridge。

云端凭据统一由 DeepSeek Harness 管理。小汤圆配置只保存 `credentialRef` 等凭据名称，在每次调用开始时向 DSH 解析，不在插件配置、游戏目录或协议消息中保存真实 Key。视觉模型必须在 DSH 中声明支持图片输入；当前内置语音实现仍是火山引擎，但能力接口本身不依赖火山、智谱或其他特定厂商。

## 快速开始

公开稳定版目前使用：

```powershell
dsh plugin --profile web add "https://github.com/qimidandapigu/dsh-xiaotangyuan-game/releases/download/plugin-v0.5.1/qimidandapigu-dsh-xiaotangyuan-game-0.5.1.tgz"
```

上面的公开稳定版可以使用星露谷安装指令：

```text
小汤圆，帮我检测并安装星露谷物语的 AI MOD
```

当前 `0.7.7` 开发版需要从本仓库构建并安装生成的 `.tgz`；完成对应 Release 后再切换为公开下载地址。安装 `0.6.1` 或更新版本后才可以使用饥荒安装指令：

```text
检测并安装《饥荒联机版》的小汤圆 AI Mod
```

安装或升级插件后，都要重启 DeepSeek Harness、刷新页面并新建对话。

缺氧还需要独立安装 ONI Adapter，然后可直接让 Harness 安装 C# Bridge：

```powershell
dsh plugin --profile web add "https://github.com/qimidandapigu/dsh-xiaotangyuan-game/releases/download/oni-v0.6.1/qimidandapigu-oni-adapter-0.1.3.tgz"
```

```text
检测并安装《缺氧》的 AI 精灵 Mod
```

星露谷安装完成后通过 SMAPI 启动游戏；饥荒安装完成后，把 Harness 返回的一行内容复制到 Steam 启动选项，再从 Steam 启动游戏。

进入存档后：

- 星露谷按 `T` 输入文字并发送给小汤圆。
- 支持的游戏保持前台时，按住配置的 Push-to-Talk 键录音，松开后进行 ASR、单次多模态 Agent 回复和 TTS 播放。
- 饥荒按 `Shift+V` 可重新生成上一条回答。

通用源码默认键是 `F8`（Virtual-Key `119`）。当前版本每个 Harness profile 只有一个全局语音键；可将 `media.pushToTalkVirtualKey` 设为 `81` 使用 `Q`，或设为 `86` 使用 `V`。按前台游戏自动切换 Q/V 尚未实现，文档不会把它描述成现有能力。

完整前置条件、凭据配置和升级说明见[安装指南](docs/INSTALLATION.md)。

## 仓库目录

```text
apps/
  harness-plugin/            DeepSeek Harness 插件
    src/gateway/             游戏连接与请求路由
    src/runtime/             Agent、多模态、语音、媒体能力
    src/installation/        游戏检测、下载、校验、安装与备份
    src/tools/               暴露给模型的安装工具
    test/                    插件测试
  windows-media-host/        Windows 麦克风与音频播放 Host
  feedback-receiver/         官方 Harness 签名校验与私有 GitHub Issue 接收端
protocol/
  v1/                        与语言无关的 JSON-RPC 协议
games/
  stardew-valley/
    adapter/                 轻量 SMAPI AI 桥接
    content-pack/            小汤圆外观与 TrinketTinker 配置
  dont-starve-together/      饥荒 Lua Mod、Python Adapter、Jingling 动画与构建脚本
  oxygen-not-included/
    adapter/                 可选 ONI Harness Adapter
    bridge/                  缺氧 C# 游戏桥接
distribution/
  stardew-valley-v2.json     星露谷固定来源与校验值
  dont-starve-together-v1.json  饥荒安装包固定来源与校验值
  oxygen-not-included-v1.json  缺氧安装包固定来源与校验值
docs/                        中文安装、排错、架构与开发文档
tools/                       跨游戏小汤圆素材生成工具
```

星露谷、饥荒和缺氧源码都在本仓库统一维护；游戏发布包仍与 Harness 插件独立发版。以后新增游戏不重复开发模型调用、语音、记忆或媒体基础设施；只有真正依赖游戏 API 的知识和动作进入可选 Adapter。

## 文档

- [安装与升级](docs/INSTALLATION.md)
- [常见问题与排错](docs/TROUBLESHOOTING.md)
- [架构和职责边界](docs/ARCHITECTURE.md)
- [结构化状态与记忆隔离设计](docs/CONTEXT_AND_MEMORY_DESIGN.md)
- [开发与发布](docs/DEVELOPMENT.md)
- [更新记录](CHANGELOG.md)
- [星露谷适配器](games/stardew-valley/README.md)
- [饥荒联机版 Mod 与 Adapter](games/dont-starve-together/README.md)
- [缺氧 Adapter 与 Bridge](games/oxygen-not-included/README.md)
- [自动反馈接收端](apps/feedback-receiver/README.md)
- [Harness 插件配置](apps/harness-plugin/README.md)
- [游戏协议 v1](protocol/v1/README.md)

## 安装与安全原则

- 插件包和游戏包分开发布；游戏专属适配器不塞进通用 Harness 插件。
- 第一方星露谷包只包含 `StardewAgentMod` 和 `XiaoTangYuanCompanion`。
- Content Patcher 与 TrinketTinker 从各自官方来源下载，不重新打包进本仓库 Release。
- 下载前校验来源、版本、文件大小和 SHA-256。
- 覆盖升级使用事务安装；失败时恢复旧版本。
- 备份保存在游戏根目录 `.xiaotangyuan-backups`，绝不放进 `Mods`。
- Provider 密钥由 DSH 凭据管理器保存；插件只保存凭据名称，不保存 Key 内容。
- 玩家反馈只接受官方 Harness 的 HMAC 签名；模型和玩家都不接触 GitHub Token。

## 开发命令

```powershell
pnpm install
pnpm check
pnpm check:dst
pnpm build:stardew
pnpm build:dst
pnpm build:media
pnpm pack:plugin
```

更多构建、测试和发版约束见[开发与发布](docs/DEVELOPMENT.md)。

## 许可证

MIT。第三方组件遵循各自许可证，本仓库不改变或重新授权它们。
