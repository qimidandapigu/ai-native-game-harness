# 开发与发布

## 开发环境

- Node.js `22.19` 或更高。
- pnpm `10`。
- .NET SDK `8`，星露谷适配器目标为 `net6.0`。
- Windows x64 用于构建和验证 `XtyMediaHost.exe`。
- Apple Silicon macOS 14 或更高、Xcode Command Line Tools，用于构建和验证 Swift `XtyMediaHost`。
- 本机安装 Stardew Valley 与 SMAPI 时，可进行真实游戏验证；普通 TypeScript 测试不依赖游戏启动。

## 职责边界

```text
plugins/xiaotangyuan-game
  通用 Agent、模型、视觉、ASR/TTS、媒体、安装器

apps/windows-media-host
  Windows 麦克风录制、前台进程限制、可配置热键、WAV 播放

plugins/xiaotangyuan-game/media/macos-arm64
  macOS 麦克风、前台热键、ScreenCaptureKit、WAV/PCM 播放与嵌入式权限说明

apps/feedback-receiver
  官方 Harness 签名校验、重放保护、私有 GitHub Issue 写入

games/stardew-valley/adapter
  SMAPI 状态、T 文字输入、Gateway、游戏内气泡

games/stardew-valley/content-pack
  小汤圆图片和 TrinketTinker 数据

games/dont-starve-together
  饥荒 Lua Mod、轻量 Python Adapter、Jingling 动画和玩家包构建

games/oxygen-not-included/adapter
  可选 ONI Harness 插件和游戏专属工具

games/oxygen-not-included/bridge
  缺氧原生状态、动作和游戏内 UI
```

不要把 Provider SDK、API Key、Prompt、长期记忆、麦克风或扬声器逻辑放回游戏适配器。

## 常用命令

```powershell
pnpm install
pnpm check
pnpm check:xiaotangyuan
pnpm desktop:dev
pnpm desktop:dev:prepare
pnpm desktop:dev:sync
pnpm integration:xiaotangyuan
pnpm desktop:dist
dotnet build games/stardew-valley/adapter/StardewAgentMod.csproj -c Release
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-dont-starve-release.ps1
dotnet build games/oxygen-not-included/bridge/DoubaoAI.ONI.csproj -c Release
```

命令含义：

| 命令 | 输出或验证 |
|---|---|
| `pnpm check` | Game Core、Transport、Fake Game 的构建与集成测试 |
| `pnpm check:xiaotangyuan` | 饥荒、反馈接收端、ONI Adapter 和小汤圆插件的完整检查 |
| `pnpm desktop:dev` | 跨平台准备当前 MediaHost、Stardew 内置资源、插件包和独立开发 DSH_HOME，然后运行 Electron 源码 |
| `pnpm desktop:dev:prepare` | 只执行上述准备，不打开客户端；写入 `.artifacts`，不安装 Steam Mods |
| `pnpm desktop:dev:sync` | 与 prepare 使用同一可复现入口；插件代码变化后重新构建、打包并刷新开发 profile |
| `pnpm integration:xiaotangyuan` | 构建媒体 Host、小汤圆与 ONI Adapter 包，启动桌面同版本 DSH，并用本地模拟模型验证 Web、Gateway、状态和对话闭环 |
| `pnpm desktop:dist` | 准备内置 DSH Runtime、小汤圆插件和桌面配置，生成 Windows NSIS 安装包 |
| `dotnet build games/stardew-valley/adapter/StardewAgentMod.csproj -c Release` | 编译星露谷 `StardewAgentMod.dll` |
| `scripts/build-dont-starve-release.ps1` | 生成饥荒玩家包，并刷新同仓库 distribution 清单的大小与 SHA-256 |
| `dotnet build games/oxygen-not-included/bridge/DoubaoAI.ONI.csproj -c Release` | 编译缺氧 C# Bridge |

## 发布物边界

Harness Release：

```text
qimidandapigu-dsh-xiaotangyuan-game-<plugin-version>.tgz
```

饥荒 Release：

```text
dsh-xiaotangyuan-game-dont-starve-<version>.zip
```

缺氧 Release：

```text
dsh-xiaotangyuan-game-oni-<version>.zip   C# Bridge
qimidandapigu-oni-adapter-<version>.tgz   可选 Harness Adapter
```

星露谷 Release：

```text
dsh-xiaotangyuan-game-stardew-<adapter-version>.zip
├─ StardewAgentMod/
└─ XiaoTangYuanCompanion/
```

禁止把 Content Patcher 或 TrinketTinker 二进制复制进第一方 Release。安装器只能使用经过审核的官方 URL、固定大小和 SHA-256。

## 版本规则

- Harness 插件修改：递增 `plugins/xiaotangyuan-game/package.json`，并同步 `integrations/xiaotangyuan/manifest.json` 的开发版本。
- 饥荒 Mod 修改：递增 `games/dont-starve-together` 中的三个版本来源，再运行 `scripts/build-dont-starve-release.ps1` 刷新发布清单。
- 尚未创建远端 tag/Release 的版本必须标记为“源码版本”或“未发布”，不能在安装文档中给出失效 URL。
- 星露谷 DLL 或内容包修改：同时递增适配器清单、内容包清单、第一方 zip、Release tag 和 distribution 清单。
- 协议发生不兼容变化：新增协议版本，不能静默改变 `protocol/v1` 语义。
- 文档必须列出插件版本和适配器版本，不能假设二者相同。

## 安装器变更检查表

安装器相关改动至少验证：

1. 静态清单 schema、URL、大小和 SHA-256。
2. 官方组件压缩包顶层目录与 `manifest.json`。
3. 安装前后 `UniqueID` 和版本。
4. 旧 `StardewAgentMod/config.json` 保留。
5. 中途失败时事务回滚。
6. 备份路径位于游戏根目录 `.xiaotangyuan-backups`，不在 `Mods`。
7. 旧版遗留备份只迁移小汤圆管理的组件。
8. 隔离假游戏目录的完整下载、解压和升级测试。
9. 饥荒包同时包含 `ChesterAI.exe`、`modmain.lua`、`modinfo.lua` 与 `anim/jingling.zip`。
10. 反馈接收端只授予目标仓库 Issues 写权限，并验证签名、时间戳和 nonce。

构建成功不等于游戏内验证成功。发布后仍需重启对应游戏，检查游戏日志，并完成一次真实文字/语音对话。缺氧还要确认 ONI Adapter 已建立到 `33145` 的连接、媒体 Host 存活且当前 PID 的桥目录被选中。

macOS 必须分别记录四级证据：Swift Host 编译与协议测试、未签名应用结构检查、系统麦克风/输入监控/屏幕录制授权、真实游戏前台的“按住录音 → ASR → Agent/Tool → TTS → 扬声器”。前三者不能替代第四项；正式分发还需要 Developer ID 签名与 notarization。

## 开发与发行分层

日常开发直接运行源码；不要把 NSIS 当作代码刷新机制：

1. 新 checkout 或依赖变化：运行一次 `pnpm install --frozen-lockfile`。
2. 日常启动：运行 `pnpm desktop:dev`；它会先准备最新本地资源，再打开客户端。
3. 只准备不启动：运行 `pnpm desktop:dev:prepare` 或 `pnpm desktop:dev:sync`。
4. 功能阶段验收：运行 `pnpm desktop:pack` 检查 unpacked 目录。
5. Beta 或正式发布：运行 `pnpm desktop:dist` 并单独完成安装、启动、卸载和真实游戏验收。

准备脚本本身只修改 `.artifacts` 隔离目录；真正打开 Desktop 后，按产品要求会自动检查并可能更新 Steam Stardew `Mods`。它不会修改正式 DSH profile。

开发 profile 的 pnpm store 同样隔离在 `.artifacts/desktop-dev-user-data/pnpm-store/v<major>`。当当前 pnpm 主版本与旧 profile 不一致时，准备脚本只重建该 profile 的 `node_modules` 并自动重试，不修改全局 pnpm 配置；首次恢复可能需要联网下载依赖。

准备入口还会预检 `apps/desktop/node_modules/electron`：缺少二进制或 `path.txt` 不规范时先运行 Electron 官方安装脚本，随后重新读取路径并验证可执行文件。这样 Desktop 不依赖 Electron CLI 的首次启动下载兜底。

## 发布前检查表

- 工作树中不包含研究下载、临时包或用户的无关修改。
- `pnpm check` 通过。
- `pnpm check:xiaotangyuan` 通过。
- 饥荒代码变更时 `scripts/build-dont-starve-release.ps1` 通过，且清单与本地资产大小和 SHA-256 一致。
- 星露谷代码变更时对应 `dotnet build` 为 0 警告、0 错误。
- Windows 发布包中存在 `media/windows-x64/XtyMediaHost.exe`；macOS 插件包中存在 `media/macos-arm64/XtyMediaHost`，运行时能将其原子复制为稳定的用户级 `0755` 可执行文件。
- macOS Helper 内嵌麦克风、屏幕录制与输入监控用途说明，且产物为 arm64 Mach-O。
- Release 资产的远端大小和 digest 与本地一致。
- GitHub `main` 已包含生成该资产的源提交。
- `git ls-remote --tags origin` 已确认目标 tag 是否真实存在，文档状态与远端一致。
- 正式 Harness profile 升级后，确认 Web 界面与 `33145` 正常监听。
