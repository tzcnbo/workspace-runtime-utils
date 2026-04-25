#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/tzcnbo/replit-openrouter-proxy.git}"
BRANCH="${BRANCH:-main}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/home/runner/workspace}"

if [ ! -d "$WORKSPACE_DIR" ]; then
  WORKSPACE_DIR="$(pwd)"
fi

cd "$WORKSPACE_DIR"

echo "==> Replit OpenRouter Proxy bootstrap"
echo "==> Workspace: $WORKSPACE_DIR"
echo "==> Repo: $REPO_URL"

if [ ! -d .git ]; then
  git init
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

bash ./start-replit.sh
