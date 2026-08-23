# Oxygen Not Included Adapter

这是可独立安装、选择性加载的 DeepSeek Harness 插件，不是通用 Harness
核心的内置模块。当前源码版本为 `0.1.5`，只有选择《缺氧》的玩家需要下载它。

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

安装已发布 Adapter：

```powershell
dsh plugin --profile web add "https://github.com/qimidandapigu/dsh-xiaotangyuan-game/releases/download/oni-v0.6.1/qimidandapigu-oni-adapter-0.1.3.tgz"
```

打包独立 Adapter：

```powershell
pnpm pack:oni-adapter
```
