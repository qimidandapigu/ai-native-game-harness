# XiaoTangYuan source migration

`dsh-xiaotangyuan-game` 已从独立能力原型迁入 AI Native Game Harness 主仓库。迁移后的维护边界如下：

## 结论

从迁移提交 `92c471f` 开始，`ai-native-game-harness` 是唯一源码仓库。日常开发、修复、文档和版本提交都只发生在这里；旧仓库不再需要同步代码。

| 原目录 | 主仓库目录 | 用途 |
| --- | --- | --- |
| `apps/harness-plugin` | `plugins/xiaotangyuan-game` | 运行在 DSH 内的游戏插件、记忆、媒体、安装器和 Gateway |
| `apps/windows-media-host` | `apps/windows-media-host` | Windows 语音与视觉媒体子进程源码 |
| `games/*` | `games/*` | 各游戏的 Mod、Native Bridge、Adapter 与内容包 |
| `protocol/v1` | `protocol/v1` | 已有跨语言协议及 Schema |
| `distribution` | `distribution` | 已发布游戏包的安装清单 |

主仓库的 `pnpm integration:xiaotangyuan` 会直接构建内部媒体宿主和插件，再安装到隔离 DSH Profile；构建不再读取相邻的旧仓库。

迁入能力的额外回归测试可通过 `pnpm check:xiaotangyuan` 统一运行。

## 今后修改放在哪里

| 要修改的内容 | 目录 |
| --- | --- |
| 小汤圆 DSH 插件 | `plugins/xiaotangyuan-game` |
| 桌面应用和安装包 | `apps/desktop` |
| Windows 语音/视觉宿主 | `apps/windows-media-host` |
| 某个游戏的 Mod、Bridge 或 Adapter | `games/<game>` |
| 跨进程协议 | `contracts` 或兼容期的 `protocol/v1` |
| 产品架构文档 | `docs` |

不要再把相同修改复制回 `dsh-xiaotangyuan-game`，否则会重新产生两个不一致的版本。

旧仓库暂时保留为历史快照和既有 Release 的静态下载源。静态下载链接继续工作不等于需要维护旧源码；等现有游戏包重新发布到主仓库后，可以将旧仓库归档，而不是删除。
