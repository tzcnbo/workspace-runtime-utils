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

fs.rmSync(deployDir, { recursive: true, force: true });

run("node", ["scripts/write-static-portal.mjs"]);
run("pnpm", ["--filter", "@workspace/api-server", "run", "build"]);
run("pnpm", ["--filter", "@workspace/api-server", "deploy", "--prod", "--legacy", "artifacts/api-server/.deploy"]);

const portalDist = resolve(root, "artifacts/api-portal/dist/public");
if (fs.existsSync(portalDist)) {
  fs.cpSync(portalDist, resolve(deployDir, "public"), { recursive: true });
}

console.log("Built self-contained API server deploy bundle at artifacts/api-server/.deploy");
