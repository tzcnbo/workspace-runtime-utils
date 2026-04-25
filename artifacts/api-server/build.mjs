import { build } from "esbuild";
import { rmSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(__dirname, "dist");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [resolve(__dirname, "src/index.ts")],
  outfile: resolve(outdir, "index.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: "linked",
  sourcesContent: false,
  legalComments: "none",
  logLevel: "info",
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});

console.log("Bundled API server to artifacts/api-server/dist/index.js");
