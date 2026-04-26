import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "./write-static-portal.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(root, "artifacts/api-portal/dist/public");
const port = Number(process.env.PORT || 24927);
const host = process.env.HOST || "0.0.0.0";
const apiTarget = (process.env.API_TARGET || "http://localhost:8080").replace(/\/+$/, "");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

async function proxy(req, res) {
  try {
    const target = new URL(req.url || "/", apiTarget);
    const headers = { ...req.headers };
    delete headers.host;
    const upstream = await fetch(target, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method || "GET") ? undefined : req, duplex: "half" });
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
    }
    res.end();
  } catch (error) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Proxy error: ${error?.message || error}`);
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/v1")) return void proxy(req, res);
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const file = resolve(publicDir, requested);
  const safe = file.startsWith(publicDir) && existsSync(file) && statSync(file).isFile();
  const finalFile = safe ? file : join(publicDir, "index.html");
  res.writeHead(200, { "content-type": mime[extname(finalFile)] || "application/octet-stream" });
  createReadStream(finalFile).pipe(res);
});

server.listen(port, host, () => console.log(`Static API Portal listening on http://${host}:${port}`));
