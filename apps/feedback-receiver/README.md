# XiaoTangYuan Feedback Receiver

这个 Cloudflare Worker 接收官方 Harness 插件签名的功能建议，并使用只保存在 Worker Secret 中的 GitHub Token，在指定私有仓库创建 Issue。

## Secrets

```powershell
pnpm exec wrangler secret put XTY_FEEDBACK_CLIENTS_JSON
pnpm exec wrangler secret put GITHUB_TOKEN
pnpm exec wrangler secret put GITHUB_OWNER
pnpm exec wrangler secret put GITHUB_REPO
```

`XTY_FEEDBACK_CLIENTS_JSON` 是官方客户端 ID 到独立反馈密钥的映射。密钥至少 32 个字符，例如：

```json
{"xiaotangyuan-official":"replace-with-a-random-32-byte-or-longer-secret"}
```

GitHub Token 只授予目标私有仓库的 Issues 写权限，不要授予代码写入或仓库管理权限。

## Deploy

```powershell
pnpm install
pnpm --filter @qimidandapigu/xiaotangyuan-feedback-receiver check
pnpm --filter @qimidandapigu/xiaotangyuan-feedback-receiver deploy
```

部署后把 Worker 的 `/v1/feedback` HTTPS 地址写入 Harness 插件的 `feedback.endpoint`。同一份官方反馈密钥通过 DSH 凭据库保存为 `XIAOTANGYUAN_FEEDBACK_TOKEN`，不进入插件配置、日志或游戏 Mod。

这个签名阻止没有官方反馈凭据的普通请求。公开发布后仍应为不同发行批次或安装分配不同凭据，并在 Cloudflare 配置速率限制；任何静态放在客户端的共享密钥都无法抵抗有意提取。
