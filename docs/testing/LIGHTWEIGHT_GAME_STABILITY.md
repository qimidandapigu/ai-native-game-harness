# 轻量真实游戏稳定性验收

目标是复用现有能力，把真实游戏长时间验收压缩为一个本地脚本；不部署遥测服务器，不安装 Grafana，不在正式产品中加入杀进程或断网插件。

## 已复用的能力

- DSH 和 Harness 已有的超时、重连与诊断记录；
- 平台测试中的 WebSocket Adapter 断线重连用例；
- Desktop 已有的脱敏诊断导出；
- 缺氧 Adapter 已有的超时、拒绝、旧 revision 和 Bridge 重连用例。

脚本不会重复实现这些能力。每次运行时，它先调用相关现有测试，再开始采样真实进程。

## 使用方法

先启动 AI Native Game Harness，进入一个真实游戏存档并确认 Adapter 已连接，然后在仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/real-game-stability-lite.ps1 -Game stardew -DurationMinutes 60
```

游戏参数：

- `stardew`：星露谷物语；
- `dst`：饥荒联机版；
- `oni`：缺氧；
- `auto`：同时识别任意受支持游戏。

开发时可以先做十秒采样，不要求真实游戏和 Gateway：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/real-game-stability-lite.ps1 -DurationSeconds 10 -SampleIntervalSeconds 2 -SkipResilienceChecks -SkipGatewayRequirement -SkipGameRequirement -AdditionalProcessId $PID
```

## 自动完成什么

每次运行自动完成：

1. 执行现有 Adapter 断线重连和诊断分类测试；缺氧额外执行既有的超时、拒绝与 Bridge 重连测试。
2. 定时采集 Harness、DSH Runtime、媒体 Host、Adapter 和所选游戏的 CPU、Working Set、Private Memory、句柄与线程数。
3. 记录 `33145` 是否监听以及是否存在已建立的 Adapter 连接。
4. 记录 Gateway 状态变化和相关进程 PID 集合变化。
5. 检查游戏与 Adapter 是否至少被真实观察到，并生成机器可读结论。

输出默认位于 `.artifacts/stability-lite/<时间>-<游戏>/`：

- `REPORT.txt`：最短结论；
- `summary.json`：自动判定与汇总；
- `process-metrics.csv`：进程采样明细；
- `events.jsonl`：Gateway 和进程变化；
- `resilience-checks.log`：复用的自动故障测试输出。

## 为什么不自动杀真实游戏

当前最轻版本的“故障注入”在隔离测试进程里完成，覆盖断线、重连、超时、拒绝和旧 revision。它不在真实存档运行期间禁用网卡、杀死游戏或结束 Desktop，避免破坏存档和影响电脑上的其他程序。

真实运行只剩三项很短的体验确认：按键是否冲突、真实麦克风是否正常、游戏画面是否卡顿。它们没有可靠的代码判定标准，不能用“脚本执行成功”代替人的感受。
