# 更新记录

本项目分别发布 Harness 插件和游戏适配器；两条版本线独立递增。

## Harness 0.7.7 / 星露谷 0.6.1 / 饥荒 0.2.23 / 缺氧 0.6.7 + Adapter 0.1.6 - 未发布

- 主仓库已经保存 `1.0` 稳定分支、`v1.0.0` 标签和源码 Release；本节记录的是 `main` 后续开发内容，不会反向修改 1.0 稳定代码。
- 技能运行时升级为受限源码 `xiaotangyuan-skill-v2`：支持变量、条件、有限循环、失败回退和断言；源码由自有解析器编译，不使用 `eval`，并兼容迁移 v1 技能文件。
- 游戏 Agent Session 改为按 `gameId + saveId` 生成脱敏稳定 ID，同一存档在 Adapter 重连或重新进入游戏后恢复原会话，不同存档继续隔离。
- Desktop 默认打开通用 Harness 页面，并提供按钮、菜单、快捷键和返回按钮在通用页与游戏专属页之间切换；窗口、启动页和产品页统一使用小汤圆品牌图标。
- Harness Core 在未显式指定 revision 时会先刷新状态，并对一次 `REVISION_CONFLICT` 安全重试；显式 revision 保持严格失败语义。
- 修复流式 TTS 已播放部分音频后失败又整段重播的问题；ONI Adapter 增加 Bridge heartbeat 过期判断，避免 Windows PID 复用连接到陈旧会话。
- 桌面产品将 ONI Adapter 接入动态 Adapter Protocol Host；缺氧动作现在统一经过 `dsh-binding → Harness Core → Adapter Protocol`，同时保留旧独立 Profile 的直接工具兼容模式。
- 增加无游戏生产接线测试：真实 Cordis ToolRuntime、Harness Core、WebSocket Host 和 ONI 假文件 Bridge 共同验证动态工具、requestId 与分段 Trace。
- 桌面游戏状态区改为可注册展示层：未知 Adapter 默认显示受限额、敏感字段过滤的标准 observation；缺氧显示殖民地、复制人与光标摘要；Mock Game 保留专属地图。
- 主仓库 `v1.0.0` 当前只提供稳定源码归档；公开安装入口继续使用旧仓库的 Harness Plugin `0.5.1` 和 ONI Adapter `0.1.3`，不把本地构建产物写成已发布安装包。
- 游戏版 Gateway 默认端口统一为 `33145`，并增加跨桌面配置、星露谷、饥荒和缺氧 Adapter 的一致性测试。
- `integration:xiaotangyuan` 现在安装小汤圆和 ONI Adapter，启动桌面同版本 DSH，以本地模拟多模态模型完成 Adapter、状态和对话冒烟闭环后自动清理。
- 桌面发行 Runtime 内置独立 ONI Adapter；通用小汤圆插件与游戏专属 Adapter 的代码和 Bundle 边界保持分离。
- 缺氧 Bridge 支持按住 `Q` 发送 `voice.start`、松开发送 `voice.stop`，并在跟随精灵旁显示聆听、思考和回答状态。

- 定义 `AI-Native Game Context v1` 与 JSON Schema，统一三个游戏及未来 Adapter 的 `meta、scene、player、companion、entities、objectives、ui、extensions`。
- Harness 在入口校验、清理并兼容转换旧 observation；标准 Context 与当前窗口截图在同一次多模态请求中发送，模型终于能直接使用血量、背包、实体、任务和光标等精确事实。
- 增加 12,000 字符提示词预算、深度/数组/字符串上限、5 秒 stale 标记、30 秒过期拒绝和原始存档标识清理。
- 饥荒、星露谷与缺氧改为直接输出统一结构；饥荒附近实体改为先按距离排序再保留最近 30 个。
- 保留三个旧格式的兼容转换，避免已经安装的旧 Adapter 在 Harness 升级后失效。
- 可执行技能改为先在真实游戏中逐步试跑，完整成功后才保存；失败候选只记录 trace，模型可以根据真实错误修订后再试。
- 星露谷小汤圆增加战斗、种植、钓鱼三条成长分支，任一分支达到 20 后进化并获得对应能力，进度按存档保存。
- 缺氧小汤圆增加“水团术”：跟随复制人接触水后觉醒，可在安全距离内吸取、储存和喷出水类液体。
- 饥荒蝴蝶技能补充成功、目标不存在、目标消失和容器已满等回归场景，禁止把失败动作描述成成功。

## Harness 插件 0.7.6 / 星露谷适配器 0.5.1 / 饥荒联机版 Mod 0.2.22 - 未发布

- 增加本地游玩统计：按 `gameId + saveId` 记录进入次数、实际活跃时长、游玩日期和最近游玩时间；统计不进入模型 Prompt。
- 游戏连接结束或切换存档后，使用本次对话生成最多两条阶段总结；没有对话时只记统计，不臆造游戏经历。
- 增加 `xiaotangyuan_memory_view`、`xiaotangyuan_memory_correct_shared`、`xiaotangyuan_memory_forget`，玩家可以直接用自然语言查看、纠正和删除记忆。
- 饥荒 Adapter 每 15 秒从本地状态文件向 Harness 发送一次带散列存档 ID 的心跳，使不说话的游玩时间也能计入统计；状态仍只走本机回环连接，不写入长期记忆。

- 增加小汤圆专属长期记忆：共同玩家偏好可跨游戏复用，游戏经历按 `gameId + saveId` 隔离，本地 SQLite 保存并在回复后后台提取。
- 星露谷、饥荒和缺氧 Adapter 现在传递经过散列或安全处理的存档标识，避免跨存档串记忆，也不暴露本地路径和平台账号。
- 增加 Adapter 主动录音控制协议 `voice.start` / `voice.stop`，录音、ASR、Agent 和 TTS 仍由 Harness 统一实现。
- 饥荒联机版的 V 键现在真正启动和停止 Harness 麦克风，不再只切换“正在听/正在思考”状态，也不再依赖全局语音键配置。
- 停止录音时校验发起 Adapter 的游戏进程，避免一个游戏意外终止另一个游戏的录音。
- 修正火山引擎流式 ASR 音频序号和提前失败时的未处理 Promise；过短录音会明确取消并提示玩家重新说话。

## Harness 插件 0.7.1 - 未发布

- 增加厂商无关的能力注册表，以 `vision.observe`、`speech.transcribe`、`speech.synthesize` 描述需求；ASR 与 TTS 可以独立选择 Provider，并继续复用 DSH 凭据。
- 松开 Push-to-Talk 后立即发送 `recording.stopped`，游戏马上从“正在听”切换到“正在思考”，不再等待 ASR 返回。
- 单次录音增加 30 秒自动停止保护，避免系统遗漏 KeyUp 后无限录音。
- 星露谷 Adapter 在 Gateway 正常关闭时也显示连接错误，避免保留过期状态气泡。

## Harness 插件 0.7.0 - 未发布

- Gateway 升级到协议 `1.1`，游戏通过 `assistant.text.start / delta / done / cancel` 接收真实正文流；`1.0` Adapter 保持兼容。
- Windows 媒体 Host 在录音期间每 100ms 发送 PCM16 分片，并支持可取消的 PCM 流式播放。
- ASR 优先使用 WebSocket 实时识别，自动降级到极速单请求，再降级到标准 submit/query。
- Agent 正文达到句子或安全长度边界后立即排入 TTS，音频分片边返回边播放；玩家再次按键可打断 Agent、TTS 和播放。
- 增加真实 HTTP chunked TTS 与极速 ASR 单请求测试，补齐中文架构、配置和故障排查说明。

## 缺氧 C# Bridge 0.6.5 / ONI Adapter 0.1.4 - 未发布

- 精灵首次选择并持久记住一个复制人，普通点选不再切换；新增 `oni_companion_follow` 工具，仅在玩家明确命令时更换跟随对象。
- 精灵尺寸改为依据镜头内游戏格大小计算，镜头缩放时与复制人的相对大小保持稳定。
- 精灵静止时恢复正面，水平移动显示左/右，上下攀爬均显示背面。

## 饥荒联机版 Mod 0.2.20 - 未发布

- 精灵朝向改为使用 DST 渲染朝向 `AnimState:GetCurrentFacing()`，修复旋转镜头后世界角度与屏幕方向不一致的问题。
- 将原版 Chester 的实体名称、交互提示和 Mod 配置文案统一显示为“小汤圆”。

## Harness 插件 0.6.3 - 未发布

- 游戏会话改为单次多模态调用：同一个支持图片输入的 Agent 直接接收玩家文字和当前游戏窗口截图并回答。
- 删除“视觉模型先转文字、再调用对话模型”的串行双模型链路，当前模型提示词不再包含结构化 observation。
- 通用 Push-to-Talk 默认键改为 F8，并明确一个 Harness profile 当前只支持一个全局语音键。
- ONI Adapter 更新到 `0.1.3`：修复 Windows 桥目录拼接、旧 PID 选择和 WebSocket 连接期异常。
- ONI C# Bridge 更新到 `0.6.1`：修复横向四帧精灵图被整张压缩显示的问题。
- 完善缺氧安装、语音、单模型多模态链路和故障排查文档。
- 主动聊天改由 Harness 统一调度；星露谷、饥荒和缺氧默认在玩家连续 3 分钟没有交互后主动观察画面并说话。

## Harness 插件 0.6.1 - 未发布

- 将饥荒 Lua Mod、Python Adapter、Jingling 动画、测试和构建历史统一迁入 `games/dont-starve-together`，停止双仓库开发。
- 增加根目录 `check:dst`、`build:dst`，玩家包构建后自动刷新同仓库发布清单的大小与 SHA-256。
- 增加《饥荒联机版》检测、固定清单校验、事务安装、备份回滚和 Steam 启动项生成。
- 通用媒体层按已注册游戏进程截取客户窗口，供星露谷、饥荒和后续游戏复用。
- 增加 `chat.retry` 与一次性 `assistant.compose`，分别支持重试和不污染主会话的游戏提醒。
- 增加自动玩家反馈工具：模型整理明确建议，官方 Harness 使用 HMAC 签名提交到私有 GitHub Issues 接收端。
- 增加可选缺氧 Adapter 与独立发布清单；游戏专属知识和动作不进入通用插件。
- 完善饥荒、缺氧、反馈、安全边界和开发版安装文档。

## Harness 插件 0.5.1 - 2026-08-16

- 修复升级备份留在 `Mods` 后被 SMAPI 识别为重复 MOD 的问题。
- 新备份改到游戏根目录 `.xiaotangyuan-backups`。
- 自动迁移旧安装器遗留的小汤圆相关备份，不移动其他 MOD。
- 增加备份迁移与路径保护测试。
- 继续内置 Windows x64 麦克风与音频播放 Host。

## 星露谷适配器 0.5.0 - 2026-08-16

- 将宠物资源加载交给 Content Patcher。
- 将宠物跟随、动画和渲染交给 TrinketTinker。
- 新增独立 `XiaoTangYuanCompanion` 内容包。
- AI 适配器只保留游戏状态、Gateway、文字输入和游戏内回复呈现。
- Harness 安装器自动安装并校验两个第三方组件。

## Harness 插件 0.4.2 - 2026-08-16

- 完成 Windows 媒体 Host 打包。
- 支持按住说话、ASR、Agent 回复、TTS 和游戏音频播放链路。
- 支持 DSH 凭据引用和多模态模型路由。

更早版本属于单仓库整合和原型阶段，不作为当前安装入口。
