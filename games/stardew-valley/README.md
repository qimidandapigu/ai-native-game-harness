# 小汤圆游戏 AI：星露谷物语

星露谷集成由 SMAPI 游戏接口、Harness 双通道连接和独立表现组件组成。当前源码中的适配器与外观内容包版本均为 `0.8.2`（均未发布）。

## 组件

| 组件 | 是否第一方 | 职责 |
|---|---|---|
| `StardewAgentMod` | 是 | 权威状态、十项动作、陪伴生活、双 Gateway、文字入口与 UI 接线 |
| `XiaoTangYuanCompanion` | 是 | 普通、唱歌与骑乘图像及 TrinketTinker 配置 |
| Content Patcher | 否 | 内容资源和数据加载 |
| TrinketTinker | 否 | 宠物跟随、动画和渲染 |

模型、Prompt、记忆、视觉、麦克风、ASR、TTS 和音频播放都由 Harness 插件负责。游戏适配器不保存任何 Provider Key。

## 三层边界

```text
Harness 层        Agent / DSH Tool / 记忆 / ASR / TTS / Native Media Host
游戏接口层        SMAPI 权威状态、主线程 Gate、动作、体力、叙事与存档
用户界面层        气泡、HUD、日记、光环、粒子、唱歌/骑乘外观与 Desktop 状态卡
```

`ModEntry` 只作为 Composition Root 接线。游戏接口层通过 `IPresentationSink` 发出表现事件，不直接依赖具体 UI；UI 不执行世界修改。会话、语音和呈现继续走 `33145`，权威观察、动作、结果和 revision 走 Desktop 分配的 Adapter Protocol 端口；Gateway 会自动通知 Mod，`33245/adapter` 只作为非 Desktop 回退值，未另建第三套 Agent。

## Desktop 自动检查、安装与更新

本地开发时，在仓库根目录运行：

```bash
pnpm desktop:dev
```

这个命令会先按当前平台构建语音 helper、Stardew Mod、插件包和隔离开发 profile，再打开客户端。客户端启动后自动：

- 查找 Stardew Valley 与 SMAPI；
- 安装缺失/旧版 Content Patcher 和 TrinketTinker；
- 安装或更新内置 `StardewAgentMod` 与 `XiaoTangYuanCompanion`，但不降级更高版本；
- 保留 `config.json`，在 `.xiaotangyuan-backups` 备份旧目录，失败时回滚；
- 在启动页和“管理游戏连接”页显示结果，并提供“重新检查”。

第三方组件仍从固定官方来源下载，每个下载都经过地址、版本、大小和 SHA-256 校验。SMAPI 是明确前置条件：缺失时客户端会提示，但不会静默执行第三方安装脚本。

第一次使用语音时，点击客户端右下角“进入游戏版”，在“Adapter 中心”的“VOLCENGINE ASR / TTS”卡片中填写火山 API Key。密钥只保存在本机凭据存储中，页面不会读取或回显。macOS 还需要允许麦克风与输入监控/辅助功能，授权后完全重启客户端。

安装完成后必须通过 SMAPI 启动或重启游戏。

## 使用

进入存档后：

- 按 `T` 打开文字输入框。
- 保持游戏在前台，按住 `V` 说话，松开后提交。
- 录音、转写、思考和最终回复状态会通过 HUD 或小汤圆气泡显示。
- Adapter 建立实时连接后，客户端顶部与原 Harness 页右下角会显示“游戏已接入”。

## 三分支成长

新存档或尚未培养的小汤圆处于未定型状态，三条成长分支分别计算：

| 行为 | 成长 | 进化后能力 |
|---|---:|---|
| 击败一个怪物 | 战斗 `+1` | 每次击败怪物恢复 `2` 点生命 |
| 种下一颗种子 | 种植 `+1` | 新种下的作物立即被浇水 |
| 成功钓上一条鱼 | 钓鱼 `+2` | 每条鱼恢复 `8` 点体力 |

任意分支先达到 `20`，小汤圆就会锁定并进化为对应形态。成长数据保存在玩家存档中，并会随游戏观察一起发送给 Harness。可在 SMAPI 控制台输入 `xty_growth` 查看当前进度。

注意：

- `T` 是 `StardewAgentMod` 的游戏内按键，可在 `config.json` 中修改。
- `V` 由 `StardewAgentMod` 的 SMAPI 按下/松开事件直接转交既有 Harness Gateway；Native Media Host 只负责实际录音与播放。其他游戏仍可使用 Harness 的全局 Push-to-Talk 配置。
- 麦克风和扬声器不由游戏 MOD 直接访问。

## 权威动作与陪伴功能

Harness 可以通过 Adapter Protocol 调用十项白名单动作：播种、浇水、收割、催熟、清理杂物、起飞、降落、钓鱼协助、矿洞战斗与凌晨救援。每项动作都在 SMAPI 主线程重新检查地图、菜单、目标、体力、能力解锁和转换状态，并返回结构化结果；Prompt 不能绕过这些 Gate。

`0.8.0` 同时迁移了关系、心情、怪癖、每日心愿、仪式、Quest/Ability unlock、日记、社交短评、戳/打互动、体力、飞行生命周期、钓鱼/战斗/救援协助和炸鱼本地玩法。炸鱼只保留为玩家手动操作，不暴露为 Agent Tool。游戏条件和完成事实留在存档；早晚、天气/矿洞、剧情、NPC 对话、低生命/体力、收入跃升和空闲等触发由游戏判定，生成式和本地台词分别通过 Harness 的 `assistant.compose(speak=true)` 与 `assistant.speak` 朗读。日记不朗读，失败时使用本地兜底文本。

## 游戏配置

首次运行后配置文件位于：

```text
Mods\StardewAgentMod\config.json
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `GatewayUrl` | `ws://127.0.0.1:33145` | 游戏版 Harness Gateway |
| `AdapterProtocolUrl` | `ws://127.0.0.1:33245/adapter` | 非 Desktop 回退值；Desktop 运行时会自动发现动态动作通道，不必手工修改 |
| `TextChatKey` | `T` | 游戏内文字对话键 |
| `BubbleYOffset` | `56` | 气泡相对小汤圆世界锚点的垂直偏移；旧版 `220` 会在首次加载时迁移 |
| `ShowCompanion` | `true` | 是否装备隐藏小汤圆同伴 |
| `RitualsEnabled` | `true` | 是否启用早晚、深夜、天气和地点仪式 |
| `ProactiveEnabled` | `true` | 是否启用心愿、剧情/NPC 和低状态等主动反应 |
| `DiaryEnabled` | `true` | 是否生成并保存每日陪伴日记 |
| `IdleEnabled` | `true` | 是否在连续 30 秒沉默后播放空闲提示 |

升级会保留这个配置文件。

如果安装了 Generic Mod Config Menu，可直接在游戏内调整文字键、气泡高度、同伴显隐和四个陪伴开关；保存后同伴显隐会立即应用。语音键、模型、音色与 Provider 凭据属于 Harness 设置，不会出现在 SMAPI Mod 的配置页中。

## 兼容性

- Stardew Valley `1.6.15` 或更高。
- SMAPI `4.4.0` 或更高。
- Content Patcher `2.9.0` 或更高。
- TrinketTinker `1.9.0` 或更高。

适配器 `UniqueID` 为 `qimidandapigu.StardewAgent`，安装目录为 `StardewAgentMod`。外观包 `UniqueID` 为 `qimidandapigu.XiaoTangYuanCompanion`。

备份必须位于游戏根目录 `.xiaotangyuan-backups`。不要把完整旧 MOD 目录复制回 `Mods`，否则 SMAPI 会把它识别为重复副本并跳过所有同 ID 版本。

## 手动安装

推荐使用 Harness 自动安装。手动安装时：

1. 从官方来源安装 Content Patcher 与 TrinketTinker。
2. 从最新 `stardew-v*` Release 解压 `StardewAgentMod` 与 `XiaoTangYuanCompanion` 到 `Mods`。
3. 确认四个组件只有一份。
4. 通过 SMAPI 重启游戏。

出现 T/V 无反应、动作通道未连接、重复 MOD 或宠物不显示时，参见[排错指南](../../docs/xiaotangyuan/TROUBLESHOOTING.md)。
