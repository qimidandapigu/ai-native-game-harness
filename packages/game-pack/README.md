# Game Pack

Game Pack 是一个游戏接入包的可分发清单，不是另一套游戏运行时。它把 Adapter 入口、剧情、角色、玩法说明、本地化、资源和权限声明放在同一个可校验目录中。

## 安装边界

`GamePackRegistry` 会在安装前执行以下检查：

- `game-pack.json` 符合 schema，id 与版本有效；
- Adapter、内容和资源入口都位于 Pack 内且真实存在；
- 不允许符号链接、越界路径和不受限的大目录；
- 先复制到临时目录并复验，再原子替换正式副本；
- 卸载只删除 Harness 管理的副本，不动源文件夹和游戏本体。

安装成功只表示 Pack 已校验、登记并可被发现，不表示 Desktop 会直接执行未知第三方代码。Adapter 的启动方式、权限授权和签名策略仍需在后续安全层中明确。

最小清单见 [`examples/adapter-starter/game-pack.json`](../../examples/adapter-starter/game-pack.json)。

## API

```ts
const registry = new GamePackRegistry(storageDirectory)
await registry.install(sourceDirectory)
const packs = await registry.list()
const content = await registry.loadContent('your-game')
await registry.uninstall('your-game', '1.0.0')
```
