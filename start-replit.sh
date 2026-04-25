#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")"

echo "==> Replit OpenRouter Proxy start"
echo "==> Node: $(node -v 2>/dev/null || echo not-found)"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "==> pnpm not found, enabling via corepack"
  corepack enable
  corepack prepare pnpm@10.32.1 --activate
fi

echo "==> Installing dependencies"
pnpm install --no-frozen-lockfile

echo "==> Building API Portal"
PORT=24927 BASE_PATH=/ pnpm --filter @workspace/api-portal run build

echo "==> Building API Server"
pnpm --filter @workspace/api-server run build

echo "==> Starting API Server on PORT=${PORT:-8080}"
echo "==> API key: tzcnb"
echo "==> Endpoints: /v1/models, /v1/chat/completions, /v1/messages"
PORT="${PORT:-8080}" node artifacts/api-server/dist/index.js

