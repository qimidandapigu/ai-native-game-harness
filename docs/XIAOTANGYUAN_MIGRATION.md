# XiaoTangYuan source migration

`dsh-xiaotangyuan-game` 已从独立能力原型迁入 AI Native Game Harness 主仓库。迁移后的维护边界如下：

| 原目录 | 主仓库目录 | 用途 |
| --- | --- | --- |
| `apps/harness-plugin` | `plugins/xiaotangyuan-game` | 运行在 DSH 内的游戏插件、记忆、媒体、安装器和 Gateway |
| `apps/windows-media-host` | `apps/windows-media-host` | Windows 语音与视觉媒体子进程源码 |
| `games/*` | `games/*` | 各游戏的 Mod、Native Bridge、Adapter 与内容包 |
| `protocol/v1` | `protocol/v1` | 已有跨语言协议及 Schema |
| `evals/promptfoo` | `evals/promptfoo` | 游戏 Agent 契约评测 |
| `distribution` | `distribution` | 已发布游戏包的安装清单 |

主仓库的 `pnpm integration:xiaotangyuan` 会直接构建内部媒体宿主和插件，再安装到隔离 DSH Profile；构建不再读取相邻的旧仓库。

迁入能力的额外回归测试可通过 `pnpm check:xiaotangyuan` 统一运行；Promptfoo 评测入口保留为 `pnpm eval:promptfoo` 与 `pnpm eval:promptfoo:contract`。

旧仓库暂时保留为历史快照和既有 Release 的静态下载源。它不再接受日常源码修改；等现有游戏包重新发布到主仓库后，可以将旧仓库归档，而不是删除。
