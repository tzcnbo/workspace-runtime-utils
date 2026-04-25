# Replit OpenRouter 双兼容反代 API

这个 monorepo 提供：

- OpenAI-compatible：`GET /v1/models`、`POST /v1/chat/completions`
- Anthropic Messages-compatible：`POST /v1/messages`
- 上游统一只调用 Replit OpenRouter 的 OpenAI Chat Completions：`/chat/completions`
- 外部固定 API Key：`tzcnb`

## Replit 部署

1. 在 Replit 新建项目或从 GitHub 导入本仓库。
2. 在 Replit Integrations 添加 OpenRouter / AI Gateway / Replit AI，使 Replit 自动注入：
   - `AI_INTEGRATIONS_OPENROUTER_BASE_URL`
   - `AI_INTEGRATIONS_OPENROUTER_API_KEY`
3. Shell 执行：

```bash
pnpm install
pnpm build
pnpm start
```

启动后访问：

- Portal：`https://你的-repl-url/`
- Models：`https://你的-repl-url/v1/models`

## 本地开发

```bash
pnpm install
pnpm --filter @artifact/api-server dev
```

如要本地真实请求上游，请设置 OpenRouter 环境变量：

```bash
export AI_INTEGRATIONS_OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"
export AI_INTEGRATIONS_OPENROUTER_API_KEY="..."
```

## 鉴权

以下任一方式均可：

```http
Authorization: Bearer tzcnb
x-api-key: tzcnb
```

其他 token 或无 token 都返回 401。

## 快速测试

```bash
curl "$BASE_URL/v1/models" -H "Authorization: Bearer tzcnb"
```
