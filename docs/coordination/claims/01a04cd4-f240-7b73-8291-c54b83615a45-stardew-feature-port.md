# StardewAIChat 功能移植到最新 Harness

- Task ID: `01a04cd4-f240-7b73-8291-c54b83615a45`
- 状态：V 键即时结束与收获旋转演出回归已修复；`0.8.2` 开发资源已准备并通过客户端同源更新器安装到真实 Steam Mods，等待重启 Desktop/游戏后进行真实语音与动画验收；按用户授权通过独立功能分支交付
- 原始分支与 worktree：`codex/stardew-feature-port-latest` / `/Users/voyager/Desktop/ai_game/ai-native-game-harness-worktrees/stardew-feature-port-latest`
- 主目录集成：用户于 2026-09-01 明确授权将本任务改动同步到 `/Users/voyager/Desktop/ai_game/ai-native-game-harness`，当时保持未提交；随后又明确要求客户端启动时自动适配语音、检查 Mod、安装缺失依赖并更新游戏 Mod。因此本任务在共享 `main` 中作为该范围的集成管理任务继续实施。用户于 2026-09-04 进一步授权把最终成果提交并仅推送到新的 GitHub 功能分支。
- 基线：主目录与原始 worktree 同为 `219cb514fe32b86ebe6a69323d18e7986e77e0c3`；`StardewAIChat` 始终只读。
- 目标：保持最新 `ai-native-game-harness` 的 monorepo、DSH、Harness Core、Adapter Protocol 和 Desktop 架构不变，把 Stardew 功能适配到既有 seam，并保持 Harness、游戏接口、用户界面三层分离。

## 认领范围

- `.gitignore`（仅放行 macOS MediaHost 源文件，继续忽略生成二进制）
- `games/stardew-valley/**`
- `plugins/xiaotangyuan-game/src/config.ts`
- `plugins/xiaotangyuan-game/src/gateway/**`
- `plugins/xiaotangyuan-game/src/protocol/**`
- `plugins/xiaotangyuan-game/src/runtime/**`
- `plugins/xiaotangyuan-game/src/installation/**`
- `plugins/xiaotangyuan-game/package.json`
- `plugins/xiaotangyuan-game/test/**`
- `distribution/stardew-valley-v2.json`（仅把两个依赖切换到已验证的官方固定资产入口）
- `apps/desktop/src/main.mjs`
- `apps/desktop/src/preload.cjs`
- `apps/desktop/src/product.html`
- `apps/desktop/src/product.js`
- `apps/desktop/src/product.css`
- `apps/desktop/src/stardew-bootstrap.mjs`
- `apps/desktop/src/game-view-models.mjs`
- `apps/desktop/src/dsh-product-runtime.mjs`
- `apps/desktop/src/dsh-process-options.mjs`
- `apps/desktop/src/voice-credentials.mjs`
- `apps/desktop/src/plugin-archive-cache.mjs`（开发态以内容指纹规避同版本 tarball 缓存）
- `apps/desktop/electron-builder.config.mjs`
- `scripts/prepare-desktop-dev.mjs`
- `scripts/desktop-profile-store.mjs`
- `scripts/desktop-electron-runtime.mjs`
- `scripts/prepare-desktop-runtime.mjs`
- `scripts/smoke-desktop-startup.mjs`
- `scripts/smoke-speech.mjs`（仅适配 DSH 官方版本化凭据格式与 Desktop 实际 TTS 配置）
- `package.json`（仅调整 Desktop 本地准备、启动和打包入口）
- `integrations/xiaotangyuan/manifest.json`（仅同步插件开发版本契约）
- `tests/integration/**` 与 `tests/platform/platform.test.ts` 中本功能相关接线和断言
- `docs/STARDEW_AI_CHAT_MIGRATION_PLAN.md`
- `docs/xiaotangyuan/**`
- 本 claim 文件

## 共享热点处理

- 已按用户授权修改：根 `package.json`、Integration manifest、Desktop `main.mjs` / builder、插件 `package.json`。
- 未修改：`pnpm-lock.yaml`、插件 `cordis.patch.yml`、两个 PowerShell 集成/准备脚本、根 `README.md`、`docs/AI_GAME_ENGINE_IDEOLOGY.html` 和其他任务的 claim / STATUS。
- 本轮依据用户此前对自动安装/更新的明确授权，使用客户端同源事务更新器把真实 Steam Mods 从 `0.8.1` 更新到 `0.8.2`，旧版保存在 `.xiaotangyuan-backups`；不更新正式 DSH Profile，不改写历史。代码按后续明确授权仅提交并推送到 `codex/stardew-harness-port-0.8.2`，不写入远端 `main`。

## 实现结果

- Desktop 启动时查找 Stardew、检查 SMAPI、检查依赖与第一方 Mod，并通过 preload IPC 在客户端显示状态和提供“重新检查”。失败不会阻塞 AI Runtime。
- Content Patcher 与 TrinketTinker 使用固定官方资产、大小与 SHA-256；缺失或低版本时事务安装，失败逆序回滚。
- `StardewAgentMod` 与 `XiaoTangYuanCompanion` 使用客户端内置 `0.8.2`；旧版更新、配置保留、新版本不降级、写入前备份。
- Desktop 动态分配的 Adapter Protocol 地址通过既有 `gateway.ready` 自动通知 Mod；Mod 仅接受 loopback `ws/wss` 地址并重连，默认 `33245` 只作为非 Desktop 回退。
- macOS MediaHost 随插件打包，并在启动时原子落到稳定用户目录、赋予 `0755` 后运行；麦克风、输入监控和屏幕录制仍服从 macOS TCC。
- 跨平台 Node 准备脚本生成隔离开发 profile、插件 `.tgz`、Stardew 内置资源、Desktop Runtime 与打包输入，不把生成目录作为源码交换渠道。

## 自动验证

- Stardew Adapter Release build：通过，0 warning / 0 error。
- 小汤圆插件：仓库指定 `check` 通过，TypeScript build 与 21 files / 126 tests 通过；包含 macOS bundle 路径检查、helper 临时编译及 ready/shutdown smoke。
- Work Orchestrator：仓库指定 `check` 通过，TypeScript build 与 7 tests 通过。
- integration-tests：18 files / 62 tests 通过；需要回环监听的测试在解除网络沙箱后复跑通过，其中包含 pnpm profile store 恢复、内容指纹安装、Electron Runtime、语音凭据与 Desktop 接线测试。
- platform-tests：22 tests 通过。
- 真实官方依赖字节：Content Patcher `2.9.1` 与 TrinketTinker `1.9.0` 的大小和 SHA-256 与清单一致，manifest 复验通过，并在隔离游戏目录完成四包安装。
- Desktop：隔离 profile、明确不存在的 `STARDEW_GAME_PATH` 下启动 Electron；preload、Stardew IPC/状态卡、DSH Web、Gateway 和优雅退出通过，残留进程 0；mock Adapter 实际接入后页面显示“游戏已接入”、连接数 `1`，语音配置卡完成初始化且 renderer 不含 secret 字段。
- `pnpm desktop:dev:prepare` 使用项目锁定的 pnpm `10.28.2` 从头通过；最新 profile 的三个本地插件均引用内容指纹路径，插件包包含 macOS helper 和修正后的 Stardew installer 导出。
- 无密钥语音 smoke 已运行并准确停在 `VOLCENGINE_API_KEY 未配置`；尚未发起真实火山请求。
- 最终 `git diff --check`、冲突标记和共享热点检查通过；`pnpm-lock.yaml` 未修改，`StardewAIChat` 为 clean，隔离 Desktop smoke 报告残留进程 0。

## 验收边界

- 真实 Steam Mods 已通过客户端同源更新器安装为 `0.8.2`，但未更新正式 DSH Profile，也未构建/签名 macOS 或 Windows 安装包。
- 尚未重启真实 Stardew 1.6 存档验收本轮 V 按住说话生命周期和旋转收获演出。
- 未授予真实宿主 macOS TCC 权限，未使用真实 Provider 凭据完成 `V` 按住说话 → ASR → Agent/Tool → TTS → 扬声器的端到端验收。
- 自动测试、隔离安装和 Desktop smoke 不能替代上述真实游戏验收。

## 2026-09-01 启动故障修复

- 用户本地执行 `pnpm desktop:dev` 时，隔离 profile 的 `node_modules` 由 pnpm v11 store 建立，而当前 pnpm v10 选择另一 store，触发 `ERR_PNPM_UNEXPECTED_STORE`。
- 本任务仅调整仓库 `.artifacts/desktop-dev-user-data` 下的生成 profile 恢复逻辑；不修改全局 pnpm 配置、正式 DSH profile 或 Steam Mods。
- 准备脚本探测 DSH profile 实际使用的 pnpm，按主版本选择项目内 store，预检 `.modules.yaml`，不匹配时只重建隔离 `node_modules`，并对安装期间的同类错误自动重试一次。
- 同时兼容通过 `.js` / `.cjs` 启动器和原生可执行文件运行 pnpm，避免把原生 pnpm 误交给 Node 解释。
- 6 项针对性回归测试通过；使用 pnpm `10.28.2` 的完整 `desktop:dev:prepare` 连续两次通过。生成元数据确认 `packageManager: pnpm@10.28.2`、store 为仓库内 `pnpm-store/v10`，第二次未再次触发重建。

## 2026-09-01 Electron 首次启动故障修复

- 用户第二次日志确认 store 恢复、打包与 profile 安装均已完成；实际失败点已推进到 Electron CLI，错误路径以换行结尾并触发 `spawn .../Electron ENOENT`。
- 根因是旧 Electron `path.txt` 带尾随换行且二进制缺失，运行时兜底下载后仍返回下载前缓存的路径；版本、pnpm symlink、arm64 架构和执行权限均已排除。
- `desktop:dev:prepare` 现在先完成 Electron 官方安装与路径预检，安装后重新读取 `path.txt`，限制目标位于 `dist` 内并验证可执行权限；不修改依赖源码或锁文件。
- 精确回归测试先红后绿，3/3 通过；修复后的完整准备通过，Electron CLI 输出 `v43.4.1`。隔离 Desktop 冒烟通过 preload、DSH Web、`33145` 与优雅退出，残留进程 0，且未写入真实 Steam Mods。

## 2026-09-02 内置 AI Runtime 启动故障修复

- 用户确认 Electron 已能启动，但客户端弹出“内置 AI Runtime 未能启动”。同一 DSH 命令用系统 Node 与相同 profile、patch、cwd 和端口可正常启动，因此问题定位到 Electron `utilityProcess.fork` 边界。
- 根因是开发模式把 `DSH_DISABLE_HMR: undefined` 放进原生子进程环境对象；Electron 43 的 `utilityProcess.fork` 只接受字符串环境变量，并在生成 Utility Process 前同步失败。显式设置字符串后，DSH Web、产品桥和 `33145` Gateway 均立即就绪。
- 新增纯函数 `buildDshChildEnvironment`，过滤所有非字符串环境值；开发版保留用户显式值但不注入 `undefined`，打包版继续强制 `DSH_DISABLE_HMR=1`。Runtime、Harness、游戏接口和 UI 分层不变。
- 精确回归测试先红后绿，2/2 通过；完整 integration 17 files / 52 tests、platform 22 tests、产品 Runtime smoke、两个入口语法检查和 `git diff --check` 均通过。
- 使用与 `pnpm desktop:dev` 相同的 Electron 内置 Runtime 模式、明确不存在的 `STARDEW_GAME_PATH` 实测通过：DSH Web、产品桥和 `33145` 均就绪；未安装或修改真实 Steam Mods，未提交代码。

## 2026-09-04 macOS Mod 更新、语音配置与接入状态修复

- macOS 自动更新失败的根因是备份目录按 `.app` 根目录计算，安全边界却只允许写入 `Mods` 的同级目录；现统一使用 `resolve(modsPath, '..', '.xiaotangyuan-backups')`，并以 macOS `.app/Contents/MacOS/Mods` 布局增加先红后绿回归测试。
- 开发 profile 曾继续加载旧的同版本 `0.8.0` tarball；现将每个本地插件包复制到带 SHA-256 的不可变安装路径后再交给 DSH，避免 pnpm/DSH 按原路径复用旧内容。完整准备后 profile 已指向新哈希并确认 installer 包含修复代码。
- Electron 主进程新增本地火山语音凭据存储，使用 DSH 官方版本化 YAML、跨进程锁、原子写入和 `0600` 权限；preload 只暴露状态与写入动作，renderer 永远收不到 Key。环境变量凭据只读且不会被客户端覆盖。
- 游戏版“Adapter 中心”新增火山 ASR/TTS 配置卡；默认 Harness 页右下角入口和游戏版顶部都订阅实时 Adapter 快照，连接后明确显示“游戏已接入”。
- 隔离 Electron 使用 mock Adapter 完成运行态验收：`游戏已接入`、连接数 `1`、语音表单就绪、未暴露 secret、Stardew 隔离检查和优雅退出均通过，残留进程 `0`。
- 真实 Steam Mods 仍未由本任务主动改动；真实火山 ASR/TTS 仍需要用户在客户端本机填写 Key，并完成 macOS 麦克风、输入监控/辅助功能权限和实际游戏前台验收。

## 2026-09-04 真实游戏交互现场诊断

- 用户已确认火山 TTS 能正常出声，并在真实游戏中报告：按 V 没有录音反馈、T 提交后菜单不关闭、语音气泡不显示实际台词；同时要求测试阶段先绕过全部成长/剧情能力门禁。
- 当前现场证据：真实 Steam Mods 四个包均为客户端管理的最新版本；源码与已安装 `StardewAgentMod.dll` SHA-256 一致。SMAPI 日志显示独立聊天链路能生成并播放同伴回复，但 Adapter Protocol 握手被拒绝，且 `CompanionLifeModule` 的 save-data key 因包含 `/` 在 `SaveLoaded` 抛错。
- 本轮继续认领 `games/stardew-valley/adapter/**`、`plugins/xiaotangyuan-game/test/**`、`tests/integration/**` 及本 claim；先增加可失败回归，再做最小修复。仍不修改 `StardewAIChat`、`pnpm-lock.yaml`、其他 claim 或 `STATUS.md`。

## 2026-09-04 真实游戏交互回归修复结果

- V 改为由 SMAPI 的 `ButtonPressed` / `ButtonReleased` 直接调用 Gateway `voice.start` / `voice.stop`；按下后立即在气泡和 HUD 显示“正在连接麦克风”，录音开始后显示“正在听”。macOS MediaHost 的进程级录音错误会回送游戏，并给出麦克风权限提示。
- T 的 `NamingMenu` 回调先调用 `Game1.exitActiveMenu()`，再校验和发送文字，空文本也会关闭菜单。
- TTS phrase 使用独立 `AssistantSpeechCaptionChanged` 事件驱动实际台词气泡；`speaking` 状态只延长气泡与切换演唱外观，不再用状态占位文字覆盖台词。
- Adapter 握手会在 hello ack 前处理 Harness 首次 `game.observe` 请求，修复真实日志中的 `Adapter handshake rejected`；存档数据键改为 SMAPI 接受的无斜杠键。
- `UnlockAllForTesting=true` 默认开启：所有十项迁移动作绕过剧情 unlock 与成长形态门禁，同时继续保留地点、目标、体力和安全条件；不会改写真实存档成长/剧情进度。GMCM 中可关闭该测试开关。
- Adapter、内容包与插件统一升为 `0.8.1`；`.artifacts/stardew` 和隔离开发 profile 已重新生成，下一次 Desktop 启动会通过既有 Mod 检查/更新链路把真实游戏中的 `0.8.0` 更新为 `0.8.1`。
- 回归验证：插件 TypeScript build 通过；21 files / 127 tests 通过；integration 19 files / 68 tests 通过；platform 22 tests 通过；Stardew Release build 0 warning / 0 error；macOS Swift helper 编译与 JSON-lines smoke 通过；隔离 Desktop smoke 显示“游戏已接入”、连接数 1、语音配置 ready、残留进程 0。
- 最终文本检查：`git diff --check` 与冲突标记检查通过；`pnpm-lock.yaml` 未修改；`StardewAIChat` clean；未提交、未推送。
- 真实 Steam Mods 在本任务结束时仍为 `0.8.0`，本任务没有绕过客户端直接复制；真实 V → 麦克风 → 火山 ASR → Agent/Tool → 火山 TTS 和实际气泡仍需用户重启 Desktop/游戏后验收。

## 2026-09-04 macOS 重复录音崩溃与文字对话降级修复

- 用户在真实游戏确认 Desktop 已显示“游戏已接入”，但 V 提示麦克风启动失败，T 提示无法连接小汤圆。SMAPI 日志同时证明 Adapter Protocol 已连接；失败信息是游戏端兼容提示，并不代表 Harness 插件断连。
- macOS DiagnosticReport 将媒体进程退出定位到 `AVAudioEngineImpl::InstallTapOnNode` / `MicrophoneRecorder.start` 的 `SIGABRT`：首轮录音停止后复用同一个 `AVAudioEngine.inputNode`，第二轮安装 tap 时触发 Objective-C 异常。
- `MicrophoneRecorder` 改为每个 `RecordingState` 独占一个 `AVAudioEngine`，停止、取消或启动失败时清理该会话自己的 tap、engine 和 converter；迟到的旧音频回调通过对象身份检查隔离，不能写入新录音。
- 文字对话仍会优先获取游戏窗口截图；Media Host、屏幕录制权限或附件保存不可用时，`MultimodalRouter` 记录诊断并返回无图片输入，Agent 继续使用结构化游戏状态和玩家文字，不再因媒体故障让 T 请求整体失败。
- 两个精确回归先红后绿：重复录音的 engine 所有权约束，以及截图服务抛出“Media Host 尚未启动”后的 text-only 降级。插件 TypeScript 编译、macOS Swift 编译、22 files / 129 tests、integration + platform 20 files / 90 tests、Stardew Release build、`git diff --check` 均通过；回环测试首次在沙箱内因 `listen EPERM` 失败，解除该测试的回环限制后全部通过。
- `desktop:dev:prepare` 已用本机缓存的 pnpm `10.28.2` 完成；开发 profile 指向内容哈希 `0ee82e05...` 的新 `0.8.1` tarball，profile 内 MediaHost 与源码构建二进制 SHA-256 同为 `1e117891...`。没有修改全局 pnpm 配置，也没有直接改 Steam Mods。
- 仍需用户完全退出旧 Desktop 和游戏后重新运行 `pnpm desktop:dev`，再在真实存档连续执行至少两轮 V 录音并验证 T 对话；自动测试不能替代真实麦克风、火山 ASR/TTS 与游戏内动作验收。

## 2026-09-04 V 键即时结束与旋转收获演出修复

- 真实 SMAPI 日志显示 V 的开始与停止请求落在同一秒，随后立即出现通用失败台词；同时没有新的 macOS MediaHost 崩溃报告。与只读参考项目对照后，根因定位为游戏 Mod 在 `ButtonPressed` 中调用 `Helper.Input.Suppress(V)`，使按住说话生命周期被 SMAPI 提前收束。现仅移除语音处理器中的 Suppress；T 键输入仍保留 Suppress。
- 精确回归先红后绿：语音处理器不再吞掉 V 键；`ButtonReleased` 仍是唯一停止入口。原有 MediaHost 全局快捷键与 Mod RPC 双入口由录音状态幂等保护，不新增第三条语音链路。
- 收获动作仍在游戏接口层同步完成权威 `Crop.harvest`、背包/箱子处理与体力扣除；成功目标被压缩成只读 `ActionItemFlight`，经 `HarvestWhirlwindEffect` 交给表现层。`HarvestWhirlwindAnimation` 复用只读参考项目的 2.4 秒、六臂阿基米德螺线、图标自转与向玩家汇聚算法，不持有或修改 `Crop`/`HoeDirt`。
- Mod 与内容包统一升为 `0.8.2`，Release build 0 warning / 0 error；插件 TypeScript 编译和 22 files / 129 tests 通过；integration + platform 在允许本机回环监听后 20 files / 91 tests 通过；`git diff --check` 通过。
- `.artifacts/stardew` 已生成 `0.8.2` bundle。客户端同源事务更新器已把真实 Steam Mods 的 `StardewAgentMod` 与 `XiaoTangYuanCompanion` 从 `0.8.1` 更新到 `0.8.2`，依赖 Content Patcher `2.9.1` 与 TrinketTinker `1.9.0` 保持不变；安装后 DLL SHA-256 与 bundle 一致，旧版保存在 `.xiaotangyuan-backups`。
- 完整 `desktop:dev:prepare` 首次在受限环境中停在开发 Profile 的 `pnpm add` 依赖解析并被主动终止；允许正常本机网络后使用同一项目流程复跑成功，隔离 Profile、Electron Runtime 与 `0.8.2` Stardew bundle 均已就绪，残留准备进程为 0。真实 V → ASR → Agent/Tool → TTS 与游戏内旋转动画仍需用户重启后验收。

## 2026-09-04 独立 GitHub 分支交付

- 交付分支为 `codex/stardew-harness-port-0.8.2`；只推送该分支，不创建合并提交，不修改远端 `main`。
- 推送前只读刷新发现远端 `main` 已从本任务基线 `219cb514fe32b86ebe6a69323d18e7986e77e0c3` 前进到 `da27a43`，且新增提交触及部分同名热点文件。
- 为避免擅自合并远端变化或覆盖当前已验收成果，本分支保持基于原始基线；如后续需要合入最新 `main`，须先单独审查并协调重叠改动。
