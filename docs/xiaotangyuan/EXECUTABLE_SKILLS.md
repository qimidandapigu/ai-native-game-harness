# 小汤圆可执行技能（轻量版）

## 边界

共享 Harness 负责技能程序、校验、版本、执行轨迹、成功/失败统计和每游戏最多 5 个活跃技能。游戏 Adapter 在握手时公布原子能力的名称、用途、参数和返回值，并负责执行；Lua/C# Mod 才能调用游戏原生 API。

同一套 `xiaotangyuan-skill-v2` 运行时可供《饥荒联机版》《星露谷物语》和《缺氧》使用，但技能源码不能跨游戏照搬：三个 Adapter 分别提供自己的原子能力。已学会的 `xiaotangyuan-skill-v1` 顺序程序仍可执行。

## 程序格式

模型生成并修改 TypeScript 风格的技能源码：

```typescript
let target = await atom("dst.find_nearest_entity", {
  prefab: "butterfly",
  radius: 20
});

let attack = await atom("dst.attack_target", {
  targetId: target.targetId
});

if (attack.defeated == true) {
  await atom("dst.collect_items", {
    prefabs: ["butterflywings", "butter"],
    x: attack.x,
    z: attack.z,
    radius: 4
  });
} else {
  fail("没有击败目标");
}
```

源码由 Harness 自己的解析器编译成受限 AST，不使用 `eval` 或 Node `vm`。允许变量、`if/else`、最多 10 次的 `repeat`、`try/catch` 回退、`assert`、`fail` 和循环内 `break`。单次运行最多调用 60 个原子；源码最多 12000 字符、控制结构最多嵌套 8 层。

源码不能访问文件、网络、进程、模块或任意 JavaScript，只能调用 Adapter 握手中声明的原子能力。每次原子调用的参数、返回值和错误都会形成 trace；`catch` 不能静默吞错，必须调用回退原子、执行断言或明确 `fail`。

技能保存在用户 profile 目录的 `skills-v2.json`，记录源码和编译后的 AST。首次启动 v2 时会读取 `skills-v1.json` 并生成新文件，旧文件保留作为备份。每次候选源码及其编译错误或执行 trace 会先记入 `learningAttempts`；只有真实试跑完整成功，源码才会进入 `skills`。每个游戏默认最多 5 个活跃技能；第 6 个进入时，低成功率、低使用频率且较旧的技能会被标记为 `archived`，不会删除。

## 饥荒首个学习目标

系统不会内置完整技能。玩家提出教学目标后，模型根据 Adapter 公布的通用原子生成候选源码，并立即执行：

1. 按一个或多个 prefab 寻找最近实体。
2. 攻击生物、砍伐真实 `CHOP` 对象，或者选择其他游戏原子。
3. 按条件判断结果，必要时有限重试或执行回退方案。
4. 在目标位置拾取指定地面物品并放入小汤圆容器。
5. 任一步找不到目标、目标消失、超时或容器已满，都会把真实错误传回 Harness 并记录失败。

如果任一步失败，候选程序不会保存；模型只能依据 trace 修订后再次试跑。完整成功后才产生第 1 版技能，后续成功修订形成新版本。后续游戏只需实现自己的 Adapter 原子能力，不需要复制技能存储与运行时。
