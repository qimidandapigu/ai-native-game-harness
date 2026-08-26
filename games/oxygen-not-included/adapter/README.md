# Oxygen Not Included Adapter

这是 AI Native Game Harness 中可独立安装、选择性加载的《缺氧》Adapter，
不是通用 Harness 核心的内置模块。当前源码版本为 `0.1.6`，只有选择《缺氧》的玩家需要下载它。

它负责：

- 缺氧角色知识与 `oni_move` / `oni_dig` / `oni_dig_path` / `oni_build` 工具；
- 小汤圆水团术的 `oni_companion_absorb_water` / `oni_companion_spray_water` 对话工具；
- Harness JSON-RPC 与 C# Bridge 文件协议之间的翻译；
- `oxygen_not_included_mod_detect` / `oxygen_not_included_mod_install`安装工具；
- 缺氧 Bridge Release 的下载、SHA-256 校验、备份、安装和回滚。

它不读取游戏程序集，不保存模型凭据，也不包含模型、语音、截图或记忆实现。

运行时只选择仍存活且最近更新的缺氧进程，忽略桥目录中的旧 PID；默认桥目录使用 `path.join` 生成：

```text
%LOCALAPPDATA%\XiaoTangYuan\oni-bridge
```

Adapter 负责把游戏进程注册给 Gateway。Harness `0.7.0` 随后把玩家文字和游戏截图一次性交给支持图片输入的 Agent，不再执行“视觉描述 → 对话模型”的第二次模型调用。

Windows Game Edition 会动态提供 `adapterProtocolUrl`。此时 ONI 动作工具不再由本插件直接注册，而是经过 `Adapter Protocol → Harness Core → dsh-binding` 统一注册和记录 Trace。没有设置该地址的独立旧 Profile 仍保留直接工具，用于向后兼容。

安装已发布 Adapter：

```powershell
dsh plugin --profile web add "https://github.com/qimidandapigu/dsh-xiaotangyuan-game/releases/download/oni-v0.6.1/qimidandapigu-oni-adapter-0.1.3.tgz"
```

打包独立 Adapter：

```powershell
pnpm --config.node-linker=hoisted --filter @qimidandapigu/oni-adapter pack --pack-destination .release/oni
```
