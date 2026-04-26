import { spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmStoreMarker = resolve(root, "node_modules", ".pnpm");
const lockPath = resolve(root, ".replit-install.lock");
const lockTimeoutMs = 120_000;
const staleLockMs = 300_000;

function depsPresent() {
  return existsSync(pnpmStoreMarker) && (existsSync(resolve(root, "node_modules", ".bin", "vite")) || existsSync(resolve(root, "node_modules", ".bin", "tsx")));
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function acquireLock() {
  const deadline = Date.now() + lockTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return true;
    } catch {
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > staleLockMs) rmSync(lockPath, { force: true });
      } catch {
        // Ignore races while another workflow is creating/removing the lock.
      }
      await sleep(750);
      if (depsPresent()) return false;
    }
  }
  throw new Error("Timed out waiting for pnpm install lock");
}

if (!depsPresent()) {
  const ownsLock = await acquireLock();
  try {
    if (!depsPresent()) {
      console.log("==> node_modules missing, running pnpm install --no-frozen-lockfile");
      const result = spawnSync("pnpm", ["install", "--no-frozen-lockfile"], {
        cwd: root,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: { ...process.env, CI: "true" },
      });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  } finally {
    if (ownsLock) rmSync(lockPath, { force: true });
  }
}
