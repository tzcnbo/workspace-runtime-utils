#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")"

echo "==> Replit OpenRouter Proxy start"

ensure_node_and_pnpm() {
  if command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
    return 0
  fi

  if command -v node >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1 && ! command -v pnpm >/dev/null 2>&1; then
    echo "==> pnpm not found, enabling via corepack"
    corepack enable
    corepack prepare pnpm@10.26.1 --activate
  fi

  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && ! command -v pnpm >/dev/null 2>&1; then
    echo "==> pnpm not found, installing via npm"
    npm install -g pnpm@10.26.1
  fi

  if command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
    return 0
  fi

  if [ "${REPLIT_PROXY_NIX_REEXEC:-}" != "1" ] && command -v nix-shell >/dev/null 2>&1; then
    echo "==> node/pnpm not found in current shell, retrying inside nix-shell"
    for nix_packages in \
      "nodejs_24 nodePackages.pnpm" \
      "nodejs_22 nodePackages.pnpm" \
      "nodejs_20 nodePackages.pnpm" \
      "nodejs nodePackages.pnpm"; do
      if REPLIT_PROXY_NIX_REEXEC=1 nix-shell -p $nix_packages --run "node -v >/dev/null 2>&1 && pnpm -v >/dev/null 2>&1" >/dev/null 2>&1; then
        echo "==> using nix-shell packages: $nix_packages"
        exec env REPLIT_PROXY_NIX_REEXEC=1 nix-shell -p $nix_packages --run "bash ./start-replit.sh"
      fi
    done
  fi

  echo "ERROR: node/pnpm/corepack are not available in this Replit shell." >&2
  echo "Fix: open the Replit Packages/Tools prompt to install Node.js, or click Run once, then rerun:" >&2
  echo "  bash ./start-replit.sh" >&2
  exit 127
}

ensure_node_and_pnpm

echo "==> Node: $(node -v)"
echo "==> pnpm: $(pnpm -v)"

echo "==> Installing dependencies"
CI=true pnpm install --no-frozen-lockfile

echo "==> Building API Portal"
PORT=24927 BASE_PATH=/ pnpm --filter @workspace/api-portal run build

echo "==> Building API Server"
pnpm --filter @workspace/api-server run build

echo "==> Starting API Server on PORT=${PORT:-8080}"
echo "==> API key: tzcnb"
echo "==> Endpoints: /v1/models, /v1/chat/completions, /v1/messages"
PORT="${PORT:-8080}" node artifacts/api-server/dist/index.js

