# 当前并行开发状态

> 快照时间：2026-08-29 16:30（Asia/Shanghai）  
> 维护者：合并管理任务  
> 这是状态快照，不是提交记录；开始工作前仍须重新检查 Git 和运行进程。

## 结论

当前仓库处于高冲突风险状态，不适合任何任务直接执行 pull、merge、rebase、commit、push 或批量格式化。

- 所有相关任务共用 `C:\game\ai-native-game-harness` 和本地 `main`，没有任务 worktree 隔离。
- 本地 `main` 为 `5216096`，落后 `origin/main` 1 个提交；远端新增的是发布提交 `cdf2310`（tag `v1.1.0`）。
- 当前有 39 个已跟踪文件被修改、18 个未跟踪文件、0 个暂存文件、0 个 Git 冲突文件。
- 改动约为 1003 行新增、98 行删除，已经混合语音、上下文、Work Orchestrator、Desktop、真实游戏、网站和文档工作。
- 小汤圆源码版本当前为 `0.7.9`，Work Orchestrator 为 `0.1.2`，ONI Adapter 清单期望版本为 `0.1.6`。
- 合并管理正在为已通过真实链路验证的最终 Runtime 生成唯一一份 Desktop NSIS 安装包；不得同时启动第二个桌面打包或覆盖 `distribution/desktop`。

## 活跃任务

| 任务 | Task ID | 当前观察到的范围 | 风险与约束 |
|---|---|---|---|
| 合并管理 | `01a04c6a-e9a8-7b03-a1e3-7997378e0e71` | 小汤圆公开回复、Work 分类/恢复、Codex 显式委派、运行版与安装包统一 | 当前是上述共享链路唯一集成者；不要并行覆盖插件、Desktop Runtime 或安装包 |
| 修复小宠物形象不显示 | `01a04b4a-7809-7842-83e5-5e3e41a78420` | 标题指向星露谷宠物形象；实际任务历史还涉及 Work Orchestrator、Codex 执行器、Desktop 打包 | 范围已明显超出标题；必须在继续写入前列出实际文件并停止触碰未认领共享热点 |
| 其他游戏 | `01a04bf5-d3af-7c32-b8f2-6304ff8908fd` | 饥荒、缺氧接入与真实游戏验收 | 只应写 `games/dont-starve-together/**`、`games/oxygen-not-included/**`；插件清单、Desktop、锁文件和公共文档由合并管理统一处理 |
| 配置 | `01a047f4-98b6-71b0-99ca-47b0b11307ac` | GLM、火山语音等本机配置 | 不应提交密钥；配置状态与源码分离 |

DSH Worker 自动创建的 HTML/方案任务位于独立 work-orchestrator workspace，不属于本仓库源码写入者，不纳入上述三方文件竞争。

## 已统一并验证的当前链路

1. 小汤圆始终是同一个游戏陪伴角色，同时具备通用办公能力；游戏状态只在与当前问题相关时使用。
2. 明确的网页、PPT、报告、资料等工作请求先由小汤圆快速确认，公开回复完成后才运行 Work 分类和派发。
3. 后置分类同时参考玩家原话、公开回答和当前关联任务；明确工作原话不会再被错误的游戏回答否决，模糊表达仍由模型判断。
4. 普通工作由真实 Work DSH Session 持续处理；只有玩家明确点名 Codex 才允许 Work Session 委派 Codex。
5. 进度查询恢复同一个 Work Session，先快速确认再返回该 Session 根据历史给出的真实状态，不新建任务、不猜截止时间。
6. Work 结果不再经过会虚构阶段的二次改写；玩家可见文本会过滤内部执行词和 Markdown 标记。
7. 本机运行版已热部署，Desktop 网关 `33145`、媒体宿主和星露谷进程同时保持可用。

最终验证：Work Orchestrator `5/5`、小汤圆 `100/100`、平台 `21/21`；真实星露谷进程 ID 回归中，明确办公请求首句 `2ms` 返回，随后创建一个 DSH Work Session，任务标题为“AI改变游戏网页”，Codex 未被调用。

## 当前共享热点

以下文件已被修改，且可能同时承载多个任务的需求：

- `plugins/xiaotangyuan-game/src/gateway/game-gateway.ts`
- `plugins/xiaotangyuan-game/src/runtime/agent/game-agent-session.ts`
- `plugins/xiaotangyuan-game/src/runtime/speech/speech-controller.ts`
- `plugins/xiaotangyuan-game/package.json`
- `plugins/dsh-work-orchestrator/**`
- `apps/desktop/src/main.mjs`
- `apps/desktop/src/dsh-product-runtime.mjs`
- `apps/desktop/electron-builder.config.mjs`
- `integrations/xiaotangyuan/manifest.json`
- `scripts/integrate-xiaotangyuan-plugin.ps1`
- `scripts/prepare-desktop-runtime.ps1`
- `package.json`、`pnpm-lock.yaml`
- `README.md`、`docs/INTERNAL_DEVELOPMENT.md`、`docs/AI_GAME_ENGINE_IDEOLOGY.html`

这些文件暂时不得由任一功能任务单独“顺手收尾”。版本号、锁文件、安装包和公共文档必须在功能代码冻结后统一生成。

## 已观察到的具体冲突模式

1. 一个任务更新插件并重启 Desktop 时，另一个任务正在重新打包更高版本，导致本机实际生效包从 `0.7.7`、`0.7.8`继续变化到 `0.7.9`。
2. DSH profile 和已安装目录曾被多个任务直接复制 `dist`，运行态与 Git 源码可能短暂不一致。
3. `main` 落后远端发布提交，但本地公共文档和版本文件已有大范围修改，直接 pull 极易在 README、理念 HTML 和版本号处冲突。
4. Desktop 构建、插件安装、Steam Mod 安装都是全局状态；即使 Git 文件不冲突，也会互相覆盖正在测试的二进制。

## 当前冻结规则

在三个活跃任务完成各自 claim 交接前：

- 不拉取或合并 `origin/main`。
- 不提交或推送。
- 不重新生成全仓库锁文件。
- 不启动第二个 Desktop 打包/安装任务。
- 不清理 `.artifacts`、`distribution`、DSH profile 或 Steam Mods。
- 功能任务只完成当前已经开始的原子操作，然后停止新增共享文件修改。

## 待合并管理任务执行

1. 等待正在运行的最终 Desktop 打包完成，记录新产物时间、大小和 SHA256；旧安装包不得当作本轮结果。
2. 收集两个功能任务的实际修改文件与验证结果。
3. 将混合工作拆成至少四个逻辑变更集：
   - 小汤圆语音、上下文与气泡；
   - Work Orchestrator / Codex 执行；
   - 星露谷形象与 Mod；
   - 饥荒和缺氧。
4. 对照远端 `v1.1.0` 发布提交，人工合并版本和公共文档，不直接选择某一侧覆盖。
5. 最后一次性统一版本号、manifest、lockfile、Desktop 安装包和公共文档。
6. 运行分层验证并向用户报告；得到明确授权后再提交或上传。
