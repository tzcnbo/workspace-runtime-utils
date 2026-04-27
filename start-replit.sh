#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")"

echo "==> Workspace Runtime start"

ensure_node_and_pnpm() {
  local wanted_pnpm="10.26.1"

  node_major() {
    node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || true
  }

  current_pnpm_version() {
    pnpm -v 2>/dev/null || true
  }

  has_modern_node() {
    local major
    major="$(node_major)"
    [ -n "$major" ] && [ "$major" -ge 20 ]
  }

  activate_pnpm_for_current_node() {
    local current_pnpm
    current_pnpm="$(current_pnpm_version)"
    if has_modern_node && [ "$current_pnpm" = "$wanted_pnpm" ]; then
      return 0
    fi

    if ! has_modern_node; then
      return 1
    fi

    if command -v corepack >/dev/null 2>&1; then
      echo "==> activating pnpm@$wanted_pnpm via corepack"
      corepack enable || true
      corepack prepare "pnpm@$wanted_pnpm" --activate || true
      hash -r 2>/dev/null || true
      current_pnpm="$(current_pnpm_version)"
      if [ "$current_pnpm" = "$wanted_pnpm" ]; then
        return 0
      fi
    fi

    if command -v npm >/dev/null 2>&1; then
      echo "==> installing pnpm@$wanted_pnpm into workspace-local npm prefix"
      export NPM_CONFIG_PREFIX="$(pwd)/.npm-global"
      export npm_config_prefix="$NPM_CONFIG_PREFIX"
      mkdir -p "$NPM_CONFIG_PREFIX"
      export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
      npm install -g "pnpm@$wanted_pnpm"
      hash -r 2>/dev/null || true
      current_pnpm="$(current_pnpm_version)"
      if [ "$current_pnpm" = "$wanted_pnpm" ]; then
        return 0
      fi
    fi

    return 1
  }

  if activate_pnpm_for_current_node; then
    return 0
  fi

  if [ "${REPLIT_PROXY_NIX_REEXEC:-}" != "1" ] && command -v nix-shell >/dev/null 2>&1; then
    echo "==> node/pnpm not usable in current shell, retrying inside nix-shell with modern Node"
    # Replit's .replit module name is nodejs-24, while plain nixpkgs often uses
    # nodejs_24. Try Node-only shells first; npm from Node then installs the
    # exact pnpm version into a workspace-local prefix, so we do not depend on a
    # matching pnpm Nix package being available.
    for nix_packages in \
      "nodejs-24" \
      "nodejs-22" \
      "nodejs-20" \
      "nodejs_24" \
      "nodejs_22" \
      "nodejs_20" \
      "nodejs_latest" \
      "nodejs-24 pnpm" \
      "nodejs-22 pnpm" \
      "nodejs-20 pnpm" \
      "nodejs_24 pnpm" \
      "nodejs_22 pnpm" \
      "nodejs_20 pnpm"; do
      if nix-shell -p $nix_packages --run "node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 20 ? 0 : 1)'" >/dev/null 2>&1; then
        echo "==> using nix-shell packages: $nix_packages"
        exec env REPLIT_PROXY_NIX_REEXEC=1 nix-shell -p $nix_packages --run "bash ./start-replit.sh"
      fi
    done
  fi

  if [ "${REPLIT_PROXY_NIX_REEXEC:-}" != "1" ] && command -v nix >/dev/null 2>&1; then
    echo "==> trying nix shell with modern Node"
    for nix_packages in \
      "nixpkgs#nodejs_24" \
      "nixpkgs#nodejs_22" \
      "nixpkgs#nodejs_20" \
      "nixpkgs#nodejs_latest"; do
      if nix shell $nix_packages --command node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
        echo "==> using nix shell packages: $nix_packages"
        exec env REPLIT_PROXY_NIX_REEXEC=1 nix shell $nix_packages --command bash ./start-replit.sh
      fi
    done
  fi

  echo "ERROR: need Node.js >=20 plus pnpm $wanted_pnpm, but this shell only has: node=$(node -v 2>/dev/null || echo not-found), pnpm=$(pnpm -v 2>/dev/null || echo not-found)" >&2
  echo "The script already tried workspace-local npm, nix-shell, and nix shell fallbacks." >&2
  echo "If this still happens, reload the workspace once and rerun:" >&2
  echo "  bash ./start-replit.sh" >&2
  exit 127
}

ensure_node_and_pnpm

free_port_procfs() {
  local port_to_free="$1"
  local port_hex
  port_hex="$(printf '%04X' "$port_to_free")"
  local inodes
  inodes="$(awk -v p="$port_hex" 'NR > 1 { split($2, a, ":"); if (toupper(a[2]) == p) print $10 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u || true)"
  [ -n "$inodes" ] || return 0

  local pids=""
  local inode pid_dir fd target
  for inode in $inodes; do
    for pid_dir in /proc/[0-9]*; do
      [ -d "$pid_dir/fd" ] || continue
      for fd in "$pid_dir"/fd/*; do
        target="$(readlink "$fd" 2>/dev/null || true)"
        if [ "$target" = "socket:[$inode]" ]; then
          pids="$pids ${pid_dir##*/}"
          break
        fi
      done
    done
  done
  pids="$(printf '%s\n' $pids | sort -u | tr '\n' ' ' || true)"
  [ -n "$pids" ] || return 0

  echo "==> Freeing port ${port_to_free} via /proc: $pids"
  for pid in $pids; do
    [ "$pid" != "$$" ] && kill -TERM "$pid" >/dev/null 2>&1 || true
  done
  sleep 1
  for pid in $pids; do
    [ "$pid" != "$$" ] && kill -KILL "$pid" >/dev/null 2>&1 || true
  done
}

free_port() {
  local port_to_free="$1"
  echo "==> Checking port ${port_to_free}"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port_to_free}/tcp" >/dev/null 2>&1 || true
    sleep 1
  elif command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti tcp:"${port_to_free}" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      echo "$pids" | xargs -r kill -TERM >/dev/null 2>&1 || true
      sleep 1
      echo "$pids" | xargs -r kill -KILL >/dev/null 2>&1 || true
    fi
  else
    free_port_procfs "$port_to_free"
  fi
}

echo "==> Node: $(node -v)"
echo "==> pnpm: $(pnpm -v)"

echo "==> Installing dependencies"
CI=true pnpm install --no-frozen-lockfile

echo "==> Building self-contained deploy bundle"
pnpm build

echo "==> Starting API Server on PORT=${PORT:-8080}"
free_port "${PORT:-8080}"
echo "==> API key: tzcnb"
echo "==> Endpoints: /v1/models, /v1/chat/completions, /v1/images/generations, /v1/messages"
PORT="${PORT:-8080}" node artifacts/api-server/.deploy/dist/index.js
