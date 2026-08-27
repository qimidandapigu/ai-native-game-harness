# Adapter Starter

这是第三方游戏接入的最小可复制模板。

1. 修改 `game-pack.json` 的 id、版本和 Adapter 信息。
2. 在 `src/adapter.ts` 中把内存状态替换成游戏官方 API 或最薄原生 Bridge。
3. 保持 Observation 是权威状态，动作必须返回明确成功或失败，不让模型猜测结果。
4. 运行 `pnpm build`，再用 `@ai-native-game-harness/adapter-conformance` 验证。
5. 把构建后的整个目录作为 Game Pack 安装；Desktop 只校验和登记，不会未经授权自动执行第三方入口。

`content/` 保存动态叙事边界、角色、玩法说明和本地化。剧情由 DSH Session 在运行时滚动生成，不在 Pack 中写死；真正决定游戏结果的规则仍留在游戏本体。
