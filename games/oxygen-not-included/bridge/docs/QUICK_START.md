# 快速开始

1. 构建并安装 AIHarness 游戏插件。
2. 运行 `pnpm build:oni` 构建缺氧 Bridge。
3. 将 Bridge 输出和 `assets`、`mod.yaml`、`mod_info.yaml` 安装到缺氧本地 Mod 目录。
4. 启动 AIHarness，再启动《缺氧》。

Bridge 默认使用 `%LOCALAPPDATA%\XiaoTangYuan\oni-bridge` 与 TypeScript Adapter 通信。需要覆盖时，可在 `config.json` 设置 `HarnessBridgeRoot`。

可用工具：`oni_move`、`oni_dig`、`oni_dig_path`、`oni_build`。动作目标固定为 Adapter 最近收到的游戏鼠标格，C# 会再次校验人物、格子、材料、科技和可达性。
