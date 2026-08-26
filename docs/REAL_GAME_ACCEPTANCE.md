# 真实游戏端到端验收清单

这份清单用于证明“真实游戏 + Adapter + Harness Core + DSH Session + Desktop 页面”整条链路成立。无游戏自动测试通过是前置条件，但不能替代本验收。

## 1. 固定本次环境

记录以下信息后再开始：

- Harness commit、DSH 版本、游戏版本、Mod / Adapter / Game Pack 版本；
- 使用的存档名称或可重复的新档步骤；
- 模型 Provider 与模型名；
- Desktop 日志目录和最终导出的诊断文件名。

不要在一次验收中途升级模型、插件或游戏 Mod。

## 2. 连接与状态

- 启动 `pnpm desktop:start` 或安装后的游戏版。
- 打开一个可重复的真实游戏存档。
- Adapter 中心出现正确的 gameId、Adapter 版本、Protocol 版本与能力列表。
- 状态页展示当前权威 Observation，revision 大于等于 0。
- Pack 已安装时，Pack 卡片从“等待 Adapter”变为“Adapter 已连接”。

通过标准：页面显示的信息和游戏内状态一致；没有连接时明确显示等待或断开，不伪造状态。

## 3. 文字动作闭环

选择一个安全、容易观察、会改变 revision 的动作：

1. 在对话页提出明确请求。
2. 核对 DSH 的公开流式回答。
3. 核对游戏内动作确实发生。
4. 核对新 Observation 与游戏画面一致且 revision 前进。
5. 在分析页沿 `sessionId → turn → step → callId → requestId` 找到同一次动作。
6. 核对 Tool 结果、ActionResult、错误码与四段游戏耗时；没有来源的耗时必须显示“未提供”。

再测试一次会被游戏拒绝的动作。通过标准：失败被明确返回，AI 不把失败描述成成功。

## 4. 语音诊断

- 按对应游戏的语音键完成一句短请求。
- 核对语音只触发一次，公开回复只显示一次。
- 在分析页找到同一个 interactionId 下的 `game-agent.latency` 与 `voice.latency`。
- 记录 ASR、首字、Agent、TTS、总耗时；如果失败，记录失败阶段、是否超时和已耗时。

通过标准：页面只展示测量事实，不展示玩家原始转写、Prompt 或模型隐藏思维。

## 5. 断线与恢复

在不退出 Desktop 的情况下短暂停止或重启 Adapter：

- Adapter 中心先显示断开；
- 恢复后显示已连接，重连计数增加；
- 重连后重新取得权威 Observation；
- 新动作仍能执行，不复用旧 revision；
- 分析页可筛选“重连”。

## 6. 导出与判定

点击分析页“导出脱敏诊断”，检查 JSON：

- 包含 Runtime、Adapter、Game Pack、Observation 和最近最多 500 条 Trace；
- token、secret、cookie、credential、API key 等字段已遮盖；
- 不包含聊天正文、语音转写或模型隐藏 reasoning / analysis；
- 能用 id 和时间定位本次文字、语音、动作与重连测试。

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 连接与权威状态 | 待验收 | 截图 / revision |
| 文字成功动作 | 待验收 | callId / requestId |
| 明确失败动作 | 待验收 | errorCode |
| 语音完整链路 | 待验收 | interactionId / 分段耗时 |
| 断线重连 | 待验收 | reconnect Trace |
| 脱敏诊断导出 | 待验收 | JSON 文件名 |

只有六项全部通过，才把首个真实游戏端到端状态标为完成。
