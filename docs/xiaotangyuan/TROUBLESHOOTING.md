# 常见问题与排错

## 最短诊断顺序

```text
SMAPI 是否加载 StardewAgentMod？
  ├─ 否 → 先看 SMAPI-latest.txt
  └─ 是 → T 文字是否能打开？
          ├─ 否 → 检查游戏内按键与 MOD 日志
          └─ 是 → 配置的语音键是否出现“正在听”？
                  ├─ 否 → 检查 Harness、Gateway、媒体 Host、前台窗口
                  └─ 是 → 检查 ASR 凭据、TTS 和音频设备
```

## 星露谷 T 和语音键都没反应

先检查 SMAPI 日志：

```text
%APPDATA%\StardewValley\ErrorLogs\SMAPI-latest.txt
```

正常日志应包含类似：

```text
XiaoTangYuan Game AI - Stardew Valley 0.5.0
Content Patcher 2.9.1
TrinketTinker 1.9.0
XiaoTangYuan Companion 0.5.0
```

如果出现 `multiple copies of this mod installed`，说明 `Mods` 中存在同一 `UniqueID` 的多个目录。先升级 Harness 插件到 `0.5.1` 或更新版本，然后再次让 Harness 执行检测和安装；它会把小汤圆管理的旧备份迁移到：

```text
<Stardew Valley>\.xiaotangyuan-backups
```

迁移后必须重启游戏，因为 SMAPI 只在启动阶段加载 MOD。

## 文字能用，但语音键没反应

依次确认：

1. 游戏已经进入存档，不是在标题界面加载 MOD 的中间阶段。
2. 星露谷窗口在前台；媒体 Host 会核对前台进程 ID。
3. Harness 正在运行，并且插件版本是 `0.5.1` 或更新版本；饥荒链路要求 `0.6.1`。
4. `127.0.0.1:32145` 正在监听。
5. Windows 默认录音设备可用，且没有被独占。
6. `media.enabled` 与 `speech.enabled` 没有关闭。
7. `media.pushToTalkVirtualKey` 与实际按键一致：`F8=119`、`Q=81`、`V=86`。源码默认是 F8，一个 Harness profile 当前只能配置一个全局语音键。

如果松开按键后仍长期显示“正在听”，先确认 Harness 的 `3080` 与 Gateway 的 `32145` 仍在监听。`0.7.1` 起松键会立即切换为“正在思考”，并在 30 秒后强制停止异常录音；旧版本在 ASR 返回前会错误地保留“正在听”状态。

`0.7.3` 起修正火山流式 ASR 首个音频包的序号，并在会话建立后立即接管异步错误。火山拒绝某次流式识别时只会终止该次语音并降级，不再导致整个 Harness 退出、游戏永久停留在“正在听”。

`0.7.5` 起游戏 Adapter 可以通过 `voice.start` / `voice.stop` 明确控制 Harness 录音。饥荒联机版中的 V 键不再只更新界面状态，也不再依赖 Harness 全局热键恰好配置成同一个键。

只读检查命令：

```powershell
dsh plugin --profile web list
Get-NetTCPConnection -State Listen |
  Where-Object LocalPort -In 3080,32145
```

## 出现“正在听”，但松开后失败

这说明热键、前台进程和麦克风录制已经工作，问题位于 ASR 或 Provider 配置。

检查：

- DSH 中是否配置了 `speech.credentialRef` 指向的凭据。
- 当前默认凭据名称是否为 `VOLCENGINE_API_KEY`。
- ASR/TTS Resource ID 是否已在对应账号开通。
- Harness 日志是否出现“没有可用的语音识别与合成 Provider”。

不要把真实 API Key 复制进 MOD 配置或仓库文件。

## 能转写和回复，但没有声音

这通常是 TTS 或 Windows 播放设备问题：

- 检查 Harness 是否返回 TTS 错误。
- 确认 Windows 默认播放设备正常。
- 确认生成音频格式为 `audio/wav`；媒体 Host 只接受 WAV 播放。

## 有对话，但小汤圆宠物不显示

说明 AI 适配器可能正常，问题位于表现组件。检查 SMAPI 是否加载：

```text
Content Patcher
TrinketTinker
XiaoTangYuan Companion
```

并确认 `Mods/XiaoTangYuanCompanion/content.json` 和两张 PNG 素材存在。宠物资源由 Content Patcher 加载，跟随与渲染由 TrinketTinker 负责，AI 适配器不再自行绘制宠物。

## Harness 页面能用，但游戏连不上

检查两端口：

```text
3080   Harness Web
32145  小汤圆游戏 Gateway
```

Gateway 只绑定本机回环地址。若 `32145` 被占用，检查是否同时安装或启动了旧的 `@qimidandapigu/dsh-game-agent`。

## 饥荒启动时报 `jingling.zip` 缺失

典型错误是：

```text
Could not find an asset matching anim/jingling.zip
```

这表示只更新了 Lua 文件，或安装包在复制过程中不完整。不要从别处单独复制 `modmain.lua`；重新让 Harness 安装当前饥荒包，并确认以下文件存在：

```text
<DST>\mods\dont-starve-ai-mod\anim\jingling.zip
<DST>\mods\dont-starve-ai-mod\ChesterAI.exe
```

当前 Mod 有安全回退，动画缺失时应显示原版切斯特而不是阻止游戏启动；如果仍出现该崩溃，说明加载的不是 `0.2.18` 或更新版本。检查 `client_log.txt` 中的 Mod 版本和实际 Mod 路径。

## 饥荒能启动，但仍是原版切斯特

1. 必须进入世界并生成切斯特；标题界面不会创建 `Jingling` 显示实体。
2. 检查 `anim/jingling.zip` 是否存在。
3. 在 `client_log.txt` 中搜索 `Jingling visual installed for Chester`。
4. 如果日志只显示 Mod 加载成功而没有该行，先确认当前世界确实存在切斯特。

## 饥荒从 Steam 启动但 Adapter 没连接

Steam 启动项必须是一整行，并保留 `%command%`：

```text
"<DST>\mods\dont-starve-ai-mod\ChesterAI.exe" %command%
```

平时先启动 Harness，再从 Steam 启动游戏。直接双击 `dontstarve_steam_x64.exe` 会绕过 Adapter 启动器。

## 缺氧按 Q 没反应

先确认 profile 中确实配置了 `pushToTalkVirtualKey: 81`，然后检查四层：

```powershell
dsh plugin --profile web list --depth 0
Get-Process OxygenNotIncluded,XtyMediaHost -ErrorAction SilentlyContinue
Get-NetTCPConnection -State Listen |
  Where-Object LocalPort -In 3080,32145
Get-NetTCPConnection -State Established -LocalPort 32145 -ErrorAction SilentlyContinue
```

正常状态应同时满足：

- Harness 插件 `0.7.7` 和 ONI Adapter `0.1.5` 已安装；
- `XtyMediaHost.exe` 正在运行；
- 缺氧窗口位于前台；
- `32145` 除监听外还有一个来自 ONI Adapter 的已建立连接；
- 当前进程目录存在 `%LOCALAPPDATA%\XiaoTangYuan\oni-bridge\<PID>\session.json`。

ONI Adapter `0.1.3` 修复了 Windows 桥目录丢失反斜杠、旧 PID 被错误选择，以及 CONNECTING WebSocket 关闭时拖垮 Harness 的问题。若目录中保留旧 PID 子目录无需手工删除；Adapter 只选择仍存活且最新的进程。

出现“正在听你说话…”说明按键、前台进程和录音已经正常。语音键是按住说话、松开提交，不是点按开关；`0.7.2` 起录音过短会直接在游戏中提示。随后若显示“语音识别成功但没有返回文本”，请检查默认麦克风是否正确并说满 1～2 秒，而不是继续排查 Q 键。

## 缺氧精灵显示成四个小头像

这是旧版把 `128x32` 的四帧横向 Sprite Sheet 整张压进方框导致的。确认 `mod_info.yaml` 为 `0.6.1` 或更新版本，并完全退出、重新启动缺氧；运行中的 Unity 不会热更新已经加载的 DLL。安装器会把旧版本保存在：

```text
%USERPROFILE%\Documents\Klei\OxygenNotIncluded\mods\.xiaotangyuan-backups
```

如果重启后 Mod 被关闭，检查 `mods.json` 中对应 `staticID` 的 `enabled`、`crash_count` 和顶层 `mod_load_in_progress`，并优先通过游戏 Mods 页面重新启用，避免安全模式反复覆盖配置。

## 缺氧语音回复仍然慢

Harness `0.7.1` 只调用一次支持图片输入的 Agent，并启用 PCM 流式 ASR、真实正文 token 增量和流式 TTS 播放。日志中的 `firstTextMs` 是游戏首次看见正文的时间；语音日志分别记录 ASR、Agent、TTS。若出现“流式语音识别失败，自动降级”，请确认账号已开通 `volc.bigasr.sauc.duration`；未开通时会先尝试 `volc.bigasr.auc_turbo`，最后才回到标准 submit/query。

## 自动反馈没有生成 Issue

只有模型判断为明确产品建议时才调用 `game_feedback_submit`。如果已经调用但提交失败，依次检查：

1. `feedback.enabled` 是否为 `true`。
2. `feedback.endpoint` 是否指向已部署的接收端。
3. `feedback.credentialRef` 是否能从 DSH 凭据库解析。
4. 接收端是否配置 GitHub Token、目标仓库和与客户端一致的 HMAC 密钥。
5. 请求时间是否偏差过大，或 nonce 是否被判定为重放。

不要把 GitHub Token 放进 Harness 对话、游戏 Mod 或公开日志。

## 提交问题时需要的信息

请提供：

- Harness 插件版本。
- 游戏名称、游戏 Mod/Adapter 版本和安装方式。
- `StardewAgentMod`、Content Patcher、TrinketTinker 和外观包版本。
- `SMAPI-latest.txt` 中从“Loading mods”到“Mods loaded and ready”的相关片段。
- 按 `T`、按住配置的语音键、松开后分别出现什么现象。
- Harness 是否能监听 `32145`。

请先遮盖 API Key、Token 和其他凭据；日志中不应主动加入这些秘密。
