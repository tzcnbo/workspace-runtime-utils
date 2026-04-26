import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deployDir = resolve(root, "artifacts/api-server/.deploy");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, CI: "true" },
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function runPnpm(args) {
  const currentPnpm = process.env.npm_execpath || "";
  if (currentPnpm.toLowerCase().includes("pnpm")) {
    run(process.execPath, [currentPnpm, ...args]);
    return;
  }
  run("pnpm", args);
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(resolve(src, entry), resolve(dest, entry));
    }
    return;
  }
  fs.mkdirSync(resolve(dest, ".."), { recursive: true });
  fs.copyFileSync(src, dest);
}

fs.rmSync(deployDir, { recursive: true, force: true });

run("node", ["scripts/write-static-portal.mjs"]);
runPnpm(["--filter", "@workspace/api-server", "run", "build"]);
runPnpm(["--filter", "@workspace/api-server", "deploy", "--prod", "--legacy", "artifacts/api-server/.deploy"]);

const portalDist = resolve(root, "artifacts/api-portal/dist/public");
if (fs.existsSync(portalDist)) {
  copyRecursive(portalDist, resolve(deployDir, "public"));
}

console.log("Built self-contained API server deploy bundle at artifacts/api-server/.deploy");
