# Replit OpenRouter 双兼容反代 API

公开仓库：https://github.com/tzcnbo/replit-openrouter-proxy

提供：

- OpenAI-compatible：`GET /v1/models`、`POST /v1/chat/completions`
- Anthropic Messages-compatible：`POST /v1/messages`
- 上游统一只调用 Replit OpenRouter 的 OpenAI Chat Completions：`/chat/completions`
- 外部固定 API Key：`tzcnb`

## 一键启动

空 Replit workspace 里直接粘贴：

```bash
curl -fsSL https://raw.githubusercontent.com/tzcnbo/replit-openrouter-proxy/main/bootstrap-replit.sh | bash
```

已经在仓库目录里则执行：

```bash
bash ./start-replit.sh
```

## 推荐安装方式：直接覆盖当前 Replit workspace

在 Replit Shell 里执行：

```bash
cd /home/runner/workspace
[ -d .git ] || git init
git remote remove origin 2>/dev/null || true
git remote add origin https://github.com/tzcnbo/replit-openrouter-proxy.git
git fetch origin
git reset --hard origin/main
pnpm install --no-frozen-lockfile
PORT=24927 BASE_PATH=/ pnpm --filter @workspace/api-portal run build
pnpm --filter @workspace/api-server run build
pnpm start
```

不要用 `git clone` 到子目录；否则 Replit 的 Run/Publish 可能不会把项目根目录识别对。

## 快速导入

也可以直接打开：

```text
https://replit.com/github.com/tzcnbo/replit-openrouter-proxy
```

## Claude reasoning / thinking

所有 `claude-` 外部模型默认都会向 OpenRouter 上游发送：

```json
{
  "reasoning": { "enabled": true },
  "include_reasoning": true
}
```

`claude-opus-4-7` 额外默认发送：

```json
{
  "verbosity": "xhigh"
}
```

`/v1/messages` 会把 OpenRouter 返回的 `reasoning_details` 转成 Anthropic content 里的 `thinking` / `thinking_delta`，避免客户端看起来没有思考过程。

如果请求里显式关闭思考，例如 `reasoning.enabled=false`、`thinking.type="disabled"` 或 `include_reasoning=false`，服务会尊重关闭配置，不会再自动打开。

## 上游 URL 拼接

Replit 注入的 `AI_INTEGRATIONS_OPENROUTER_BASE_URL` 按 OpenAI SDK 的 `baseURL` 处理：只在后面追加 `/chat/completions`，不会擅自补 `/v1`。例如：

```text
http://...:1106/openrouter-gateway -> http://...:1106/openrouter-gateway/chat/completions
https://openrouter.ai/api/v1 -> https://openrouter.ai/api/v1/chat/completions
```

## Replit 集成

在 Replit Integrations 中添加 OpenRouter / AI Gateway / Replit AI，让 Replit 自动注入：

- `AI_INTEGRATIONS_OPENROUTER_BASE_URL`
- `AI_INTEGRATIONS_OPENROUTER_API_KEY`

程序也会自动尝试查找名字里包含 `OPENROUTER`、`AI_INTEGRATIONS`、`REPLIT`、`AI_GATEWAY` 的等价环境变量。

## 端口

- API Server：默认 `8080`
- API Portal：开发预览 `24927`

??/`pnpm start` ??? API Server??? `artifacts/api-portal/dist/public` ???????????? Replit ??????????? Node ???????? HTML?API Server ?? `tsc` ??????? Vite/esbuild ???

## 鉴权

以下任一方式均可：

```http
Authorization: Bearer tzcnb
x-api-key: tzcnb
```

其他 token 或无 token 都返回 401。

## 常用命令

```bash
pnpm install --no-frozen-lockfile
pnpm build
pnpm start
```

单独构建：

```bash
PORT=24927 BASE_PATH=/ pnpm --filter @workspace/api-portal run build
pnpm --filter @workspace/api-server run build
```

测试：

```bash
curl "http://localhost:8080/v1/models" -H "Authorization: Bearer tzcnb"
```
