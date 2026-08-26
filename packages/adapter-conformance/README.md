# Adapter Conformance

这是第三方 Game Adapter 的可复用协议体检工具。它直接调用 Adapter，验证：

- `hello` 身份、协议版本和能力清单；
- 能力名称不重复；
- `observe` 返回与 gameId 一致的权威 Observation；
- 指定动作能生成合法 ActionResult；
- 动作后的 Observation revision 不落后于动作结果。

```ts
const report = await runAdapterConformance(adapter, {
  expectedGameId: 'your-game',
  actionCases: [{ capability: 'game.example', arguments: {}, expectOk: true }],
})
```

`report.ok` 适合开发工具展示；`assertAdapterConformance` 适合 CI，失败时会抛出包含每项检查名称的错误。它证明协议行为一致，不替代真实游戏存档验收。

