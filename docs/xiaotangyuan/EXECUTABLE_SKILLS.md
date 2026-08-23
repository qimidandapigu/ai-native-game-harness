# 小汤圆可执行技能（轻量版）

## 边界

共享 Harness 负责技能程序、校验、版本、执行轨迹、成功/失败统计和每游戏最多 10 个活跃技能。游戏 Adapter 在握手时公布原子能力的名称、用途、参数和返回值，并负责执行；Lua/C# Mod 才能调用游戏原生 API。

同一套 `xiaotangyuan-skill-v1` 运行时可供《饥荒联机版》《星露谷物语》和《缺氧》使用，但技能程序不能跨游戏照搬：三个 Adapter 分别提供自己的原子能力。

## 程序格式

技能不是任意 JavaScript，而是可持久化、可修改的受限 JSON 程序：

```json
{
  "language": "xiaotangyuan-skill-v1",
  "steps": [
    { "op": "call", "atom": "dst.find_nearest_butterfly", "args": { "radius": 20 }, "saveAs": "target" },
    { "op": "call", "atom": "dst.attack_butterfly", "args": { "targetId": "$target.targetId" }, "saveAs": "attack" },
    { "op": "call", "atom": "dst.collect_butterfly_loot", "args": { "x": "$attack.x", "z": "$attack.z", "radius": 4 } }
  ]
}
```

运行时最多接受 20 个步骤，只能调用 Adapter 在握手中声明的原子能力，且不允许文件、网络、系统命令或任意代码执行。每一步的参数、返回值和错误都会形成 trace；失败立即停止，模型可依据 trace 在玩家教学或确认修复时生成下一版本。旧版本进入本地 history。

技能保存在用户 profile 目录的 `skills-v1.json`。每次候选程序及其错误 trace 会先记入 `learningAttempts`；只有真实试跑完整成功，程序才会进入 `skills`。每个游戏默认最多 10 个活跃技能；第 11 个进入时，低成功率、低使用频率且较旧的技能会被标记为 `archived`，不会删除。

## 饥荒首个学习目标

系统不会内置 `dst.hunt-and-collect-butterfly`。玩家提出教学目标后，模型根据 Adapter 公布的三个原子能力生成候选程序，并立即执行：

1. 在玩家 20 单位内寻找最近的活蝴蝶。
2. 由服务器验证目标和距离，让小汤圆追到攻击距离并造成 1 点伤害。
3. 在击杀点附近寻找 `butterflywings` 或 `butter`，走过去放入小汤圆容器。
4. 任一步找不到目标、目标消失、超时或容器已满，都会把真实错误传回 Harness 并记录失败。

如果任一步失败，候选程序不会保存；模型只能依据 trace 修订后再次试跑。完整成功后才产生第 1 版技能，后续成功修订形成新版本。后续游戏只需实现自己的 Adapter 原子能力，不需要复制技能存储与运行时。
