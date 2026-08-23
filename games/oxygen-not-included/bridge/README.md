# Oxygen Not Included C# Bridge

这是 AIHarness 缺氧 Adapter 的游戏内 Bridge，只负责：

- 读取周期、世界、鼠标格、选中对象和复制人状态；
- 显示精灵、文字面板、状态和回复气泡；
- 校验并执行移动、挖掘、分段挖路和白名单建筑任务；
- 通过本地文件协议与 TypeScript ONI Adapter 通信。

模型、API Key、截图、录音、ASR、TTS、对话历史和长期记忆全部由 AIHarness 管理，本 Mod 不包含这些实现。

当前 Bridge 版本为 `0.6.6`。精灵不再固定在屏幕角落，而是绑定一个自己选定并记住的复制人悬浮跟随；只有玩家明确命令时才会切换目标。四帧横向 Sprite Sheet 会根据复制人的实际移动方向选择画面：静止为正面，水平移动为左/右，上下攀爬均为背面。Bridge 通过下面的用户目录加载，不应复制到 Steam 游戏程序集目录：

精灵第一次出现时会从存活复制人中选择一个“喜欢的人”并把名字保存在 `config.json`；普通点选不会改变目标。玩家明确说“让小汤圆改跟着某某”时，Harness 调用 `oni_companion_follow` 切换并永久记住。Bridge 每帧把复制人的世界坐标投影到屏幕坐标，并叠加轻微上下漂浮和左右摇摆；目标离开镜头时精灵隐藏。精灵尺寸按镜头中一个游戏格的像素高度计算，因此缩放镜头时与复制人的相对大小保持稳定；静止显示正面，水平移动显示左/右，上下攀爬均显示背面。

```text
%USERPROFILE%\Documents\Klei\OxygenNotIncluded\mods\Local\DoubaoAI
```

安装或更新 DLL 后必须完全退出并重新启动缺氧；Unity 不会热更新已经加载的 Mod 程序集。

构建：

```powershell
pnpm build:oni
```

发布包与安装清单：

```powershell
pnpm pack:oni
```

Harness 中的 `oxygen_not_included_mod_detect` / `oxygen_not_included_mod_install`
负责检测、校验下载、备份、安装和失败回滚。旧版 `config.json` 不会迁移，避免遗留直连模型 Key。
