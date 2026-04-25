import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import proxyRouter from "./routes/proxy.js";

const app = express();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const jsonParseErrorHandler: express.ErrorRequestHandler = (err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    if (req.path.endsWith("/messages")) {
      res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } });
      return;
    }
    res.status(400).json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } });
    return;
  }
  next(err);
};
app.use(jsonParseErrorHandler);

const router = express.Router();
router.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "openrouter-proxy", time: new Date().toISOString() });
});

app.use("/api", router);
app.use("/v1", proxyRouter);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const portalDistCandidates = [
  path.resolve(process.cwd(), "../api-portal/dist"),
  path.resolve(__dirname, "../../api-portal/dist"),
  path.resolve(__dirname, "../../../api-portal/dist"),
];
const portalDist = portalDistCandidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html")));

if (portalDist) {
  app.use(express.static(portalDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(portalDist, "index.html"));
  });
}

export default app;

