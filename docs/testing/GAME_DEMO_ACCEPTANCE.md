# 游戏内办公演示验收

## 一键准备

在仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-game-demo.ps1
```

脚本会安装缺失的工作区依赖、构建并检查小汤圆与 Work Orchestrator、运行无游戏双 Session E2E、准备隔离的 Desktop 开发 Profile、完成 Desktop 启动冒烟测试、生成演示话术并启动 Desktop。它不会启动或修改星露谷存档。

只准备但不启动 Desktop：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-game-demo.ps1 -NoLaunch
```

## 自动化已经检查什么

- 小汤圆先返回简短确认，工作识别在公开回答之后发生。
- 陪聊 Session 和工作 Session 是两个不同的 Session。
- 进度查询和修改意见复用原工作 Session，不重复创建。
- 最终 HTML 确实写入测试工作目录。
- 玩家可见的回答和通知不暴露 DSH、Worker、Codex、分类器等内部词。
- Desktop preload 实际加载；隔离启动的真实 DSH Web 返回 HTTP 成功，`33145` 实际监听。
- 冒烟测试使用临时开发 Profile，不读写正式版 Profile。
- Desktop 正常退出后，测试进程与 `33145` 监听不会残留。

自动化测试使用 Mock Game 和确定性模型/工具替身。Desktop 冒烟会并排启动真实 Desktop 壳层与隔离 DSH Runtime，以验证 preload、Web、端口、Profile 隔离和退出清理；它暂不覆盖打包版 Desktop 内部拉起 DSH 的进程桥。它能证明编排、持久 Session、文件落盘与基础生命周期，但不能代替真实麦克风、真实语音服务、星露谷画面或人的内容质量判断。

2026-08-31 的正式 Desktop Profile 复测还验证了真实联网、写入 HTML、准确打开成果，以及后续进度查询继续使用原工作会话。这一结果补足了模型与办公工具的本机链路证据，但仍不替代下方真实游戏现场检查。

## 最后 10 分钟人工验收

1. 启动星露谷并进入存档，确认游戏没有卡顿或失去控制。
2. 按 `V` 说第一句演示话术，确认气泡位置正确、回答简短，且在语音播放结束约 5 秒后消失。
3. 依次询问进度和提出修改意见，确认 ChatList 中始终保留一个陪聊会话和同一个工作会话。
4. 等待小汤圆主动简短汇报，确认游戏不中断，气泡没有展示整篇文档或内部实现词。
5. 说“思路对了，请生成 HTML 并打开给我看”，确认浏览器实际打开最终 HTML，内容包含修改后的真实案例。

演示话术生成在 `.artifacts/game-demo/VOICE_SCRIPT.txt`。任一项失败时，保留当时的游戏截图、Desktop 轨迹页和时间点；不要连续重复按 `V` 覆盖第一条失败记录。
