import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Replit deployment packaging can preserve pnpm workspace package symlinks
// without their root .pnpm targets. Remove workspace-local node_modules so
// Node resolves dependencies from the hoisted root node_modules instead.
for (const dir of [
  "artifacts/api-server/node_modules",
  "artifacts/api-portal/node_modules",
]) {
  rmSync(resolve(root, dir), { recursive: true, force: true });
}

await import(pathToFileURL(resolve(root, "artifacts/api-server/dist/index.js")).href);
