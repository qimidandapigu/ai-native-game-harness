# 小汤圆游戏 AI：星露谷物语

星露谷集成由一个轻量 SMAPI 适配器和一个外观内容包组成。当前源码中的适配器版本为 `0.6.1`，外观内容包版本为 `0.6.0`（均未发布）。

## 组件

| 组件 | 是否第一方 | 职责 |
|---|---|---|
| `StardewAgentMod` | 是 | 状态采集、T 文字输入、Gateway、游戏内气泡 |
| `XiaoTangYuanCompanion` | 是 | 小汤圆图像与 TrinketTinker 配置 |
| Content Patcher | 否 | 内容资源和数据加载 |
| TrinketTinker | 否 | 宠物跟随、动画和渲染 |

模型、Prompt、记忆、视觉、麦克风、ASR、TTS 和音频播放都由 Harness 插件负责。游戏适配器不保存任何 Provider Key。

## 自动安装

先安装 Harness 插件 `0.5.1` 或更新版本，然后对小汤圆说：

```text
小汤圆，帮我检测并安装星露谷物语的 AI MOD
```

安装器会从小汤圆 Release 安装两个第一方目录，并从 Content Patcher、TrinketTinker 官方来源下载第三方组件。每个下载都经过地址、版本、大小和 SHA-256 校验。

安装完成后必须通过 SMAPI 启动或重启游戏。

## 使用

进入存档后：

- 按 `T` 打开文字输入框。
- 保持游戏在前台，按住 `V` 说话，松开后提交。
- 录音、转写、思考和最终回复状态会通过 HUD 或小汤圆气泡显示。

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
- `F8` 不是 SMAPI 按键；它由 Harness 的 Windows 媒体 Host 监听，可通过 `media.pushToTalkVirtualKey` 修改。
- 麦克风和扬声器不由游戏 MOD 直接访问。

## 游戏配置

首次运行后配置文件位于：

```text
Mods\StardewAgentMod\config.json
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `GatewayUrl` | `ws://127.0.0.1:32145` | Harness Gateway |
| `TextChatKey` | `T` | 游戏内文字对话键 |
| `BubbleYOffset` | `220` | 气泡相对位置 |
| `ShowCompanion` | `true` | 是否装备隐藏小汤圆同伴 |

升级会保留这个配置文件。

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

出现 T/V 无反应、重复 MOD 或宠物不显示时，参见[排错指南](../../docs/TROUBLESHOOTING.md)。
