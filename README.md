# AI Native Game Harness

让 AI 安全、统一地连接不同游戏。

AI Native Game Harness 是一个基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建的游戏 AI 运行层和 Adapter 框架。它复用 DSH 的模型、Agent、工具、会话和插件能力，再补充游戏状态、动作安全、跨进程通信、Game Pack 和桌面界面。

> 当前处于开发预览阶段：源码和自动测试可用，但尚未发布正式安装包，也尚未完成真实游戏的最终验收。

## 它能做什么

- 让同一个 AI Harness 选择性连接不同游戏。
- 从游戏读取准确状态，而不只依赖截图猜测。
- 把 AI 动作交给游戏侧校验，并返回权威执行结果。
- 支持文字、视觉、语音、记忆和可验证技能学习。
- 用 Game Pack 管理每个游戏的 Adapter、Bridge、内容和版本。
- 在桌面端提供对话、自学习、分析和 Adapter 管理界面。

## 工作方式

```text
玩家
  → DeepSeek Harness Agent
  → AI Native Game Harness
  → 游戏 Adapter / Native Bridge
  → 游戏 API
  → 权威结果与新状态返回 Agent
```

DSH 负责通用 AI Runtime；本项目负责游戏连接和安全执行。游戏 Mod 保持轻量，不在游戏进程里重复实现模型、Agent 或长期记忆。

## 当前接入

| 游戏 | 接入形式 | 当前状态 |
| --- | --- | --- |
| 星露谷物语 | C# / SMAPI Bridge | 开发中 |
| 饥荒联机版 | Lua Mod + Adapter | 开发中 |
| 缺氧 | TypeScript Adapter + C# Bridge | 开发中 |
| Mock Game | TypeScript 参考实现 | 自动测试可用 |

第三方游戏可以从 [`examples/adapter-starter`](examples/adapter-starter) 开始，并使用 Adapter conformance 测试检查协议兼容性。

## 当前进度

- Harness Core、Adapter Protocol、WebSocket Host、DSH Binding 和 Game Pack 注册表已经实现。
- 桌面端已有对话、自学习、分析和 Adapter 中心。
- 24 项集成测试和 18 项平台测试通过。
- 当前源码版本：Harness Plugin `0.7.7`、ONI Adapter `0.1.6`、ONI Bridge `0.6.7`。
- 主仓库暂时没有 GitHub Release；普通玩家安装包仍未正式发布。
- 真实游戏存档中的状态、文字、语音和动作闭环仍待最终验收。

## 开发者快速开始

需要 Node.js 22.19+ 和 pnpm 10.28.2。

```powershell
git clone https://github.com/qimidandapigu/ai-native-game-harness.git
cd ai-native-game-harness
pnpm install --frozen-lockfile
pnpm check
```

运行不依赖真实游戏和模型的演示：

```powershell
pnpm desktop:demo
```

目前不建议普通玩家直接从源码安装。正式 Release 发布后，README 会提供明确的下载和安装入口。

## 文档

- [产品定位与架构介绍](docs/AI_GAME_ENGINE_IDEOLOGY.html)
- [第三方 Adapter 与平台设计](docs/INDEPENDENT_PLATFORM.md)
- [游戏安装与升级](docs/xiaotangyuan/INSTALLATION.md)
- [常见问题与排错](docs/xiaotangyuan/TROUBLESHOOTING.md)
- [真实游戏验收清单](docs/REAL_GAME_ACCEPTANCE.md)
- [内部开发说明](docs/INTERNAL_DEVELOPMENT.md)

## 项目原则

- 优先复用 DSH，不重复开发通用 Agent Runtime。
- 游戏状态和动作结果以游戏 API 为准。
- Harness、Adapter 和 Native Bridge 保持清晰边界。
- 构建成功、自动测试、真实游戏验收和正式发布分别报告。

## License

[MIT](LICENSE)
