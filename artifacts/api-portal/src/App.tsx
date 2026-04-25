import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

type Status = "checking" | "online" | "offline";

const API_KEY = "tzcnb";

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
  return Promise.resolve();
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      style={styles.copyButton}
      onClick={async () => {
        await copyText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

function Badge({ children, tone }: { children: string; tone: "green" | "purple" | "blue" | "orange" | "gray" }) {
  return <span style={{ ...styles.badge, ...styles.badgeTone[tone] }}>{children}</span>;
}

function Card({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return <section style={{ ...styles.card, ...style }}>{children}</section>;
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div style={styles.codeWrap}>
      <pre style={styles.code}><code>{code}</code></pre>
      <CopyButton value={code} />
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>("checking");
  const origin = useMemo(() => window.location.origin, []);
  const baseUrl = origin;
  const v1Url = `${origin}/v1`;

  useEffect(() => {
    let alive = true;
    async function check() {
      try {
        let ok = false;
        const health = await fetch("/api/healthz").catch(() => null);
        ok = Boolean(health?.ok);
        if (!ok) {
          const models = await fetch("/v1/models", { headers: { "x-api-key": API_KEY } }).catch(() => null);
          ok = Boolean(models?.ok);
        }
        if (alive) setStatus(ok ? "online" : "offline");
      } catch {
        if (alive) setStatus("offline");
      }
    }
    check();
    const timer = window.setInterval(check, 15000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const endpoints = [
    { method: "GET", path: "/v1/models", kind: "Both", tone: "gray" as const, desc: "Local model list in OpenAI models format." },
    { method: "POST", path: "/v1/chat/completions", kind: "OpenAI", tone: "blue" as const, desc: "OpenAI-compatible request/response format." },
    { method: "POST", path: "/v1/messages", kind: "Anthropic", tone: "orange" as const, desc: "Anthropic Messages-compatible external API; internally converted to OpenRouter Chat Completions." },
  ];

  const models = [
    { id: "gpt-5.5", provider: "OpenAI" },
    { id: "claude-opus-4-7", provider: "Anthropic", tags: ["Adaptive Thinking", "Prompt Caching", "OpenRouter upstream"] },
    { id: "claude-opus-4-6", provider: "Anthropic" },
    { id: "claude-sonnet-4-6", provider: "Anthropic" },
    { id: "claude-haiku-4-5", provider: "Anthropic" },
  ];

  const examples = [
    `curl "${baseUrl}/v1/models" \\\n  -H "Authorization: Bearer ${API_KEY}"`,
    `curl "${baseUrl}/v1/chat/completions" \\\n  -H "Authorization: Bearer ${API_KEY}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "claude-opus-4-7",\n    "messages": [\n      { "role": "user", "content": "你好，简单介绍一下你自己" }\n    ],\n    "stream": false\n  }'`,
    `curl -N "${baseUrl}/v1/chat/completions" \\\n  -H "Authorization: Bearer ${API_KEY}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "claude-opus-4-7",\n    "messages": [\n      { "role": "user", "content": "测试流式输出，请连续输出三句话" }\n    ],\n    "stream": true\n  }'`,
    `curl "${baseUrl}/v1/messages" \\\n  -H "x-api-key: ${API_KEY}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "claude-opus-4-7",\n    "max_tokens": 1024,\n    "messages": [\n      { "role": "user", "content": "你好，简单介绍一下你自己" }\n    ]\n  }'`,
    `curl -N "${baseUrl}/v1/messages" \\\n  -H "x-api-key: ${API_KEY}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "claude-opus-4-7",\n    "max_tokens": 1024,\n    "stream": true,\n    "messages": [\n      { "role": "user", "content": "测试 Anthropic Messages 流式，请连续输出三句话" }\n    ]\n  }'`,
    `curl "${baseUrl}/v1/chat/completions" \\\n  -H "Authorization: Bearer ${API_KEY}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "claude-opus-4-7",\n    "cache_control": { "type": "ephemeral" },\n    "messages": [\n      { "role": "system", "content": "这里放置足够长且稳定的系统提示词或 RAG 文档内容" },\n      { "role": "user", "content": "基于上面的内容回答一个问题" }\n    ],\n    "stream": false\n  }'`,
  ];

  const statusColor = status === "online" ? "#22c55e" : status === "offline" ? "#ef4444" : "#f59e0b";

  return (
    <main style={styles.page}>
      <div style={styles.bgGlowOne} />
      <div style={styles.bgGlowTwo} />
      <header style={styles.hero}>
        <div style={styles.logo}>OR</div>
        <div style={{ flex: 1 }}>
          <h1 style={styles.title}>OpenRouter API Portal</h1>
          <p style={styles.subtitle}>OpenAI & Anthropic compatible reverse proxy on Replit</p>
        </div>
        <div style={styles.statusPill}>
          <span style={{ ...styles.statusDot, background: statusColor, boxShadow: `0 0 22px ${statusColor}` }} />
          {status === "checking" ? "Checking" : status === "online" ? "Online" : "Offline"}
        </div>
      </header>

      <Card>
        <h2 style={styles.sectionTitle}>Connection Details</h2>
        <div style={styles.detailGrid}>
          {[
            ["Base URL", baseUrl],
            ["OpenAI Base URL", v1Url],
            ["Anthropic Base URL", v1Url],
            ["Authorization Header", `Authorization: Bearer ${API_KEY}`],
            ["x-api-key", `x-api-key: ${API_KEY}`],
          ].map(([label, value]) => (
            <div style={styles.detailItem} key={label}>
              <div style={styles.detailLabel}>{label}</div>
              <div style={styles.detailValue}>{value}</div>
              <CopyButton value={value} />
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <h2 style={styles.sectionTitle}>API Endpoints</h2>
        <div style={styles.endpointList}>
          {endpoints.map((endpoint) => {
            const full = `${origin}${endpoint.path}`;
            return (
              <div style={styles.endpointRow} key={endpoint.path}>
                <div style={styles.endpointMeta}>
                  <Badge tone={endpoint.method === "GET" ? "green" : "purple"}>{endpoint.method}</Badge>
                  <Badge tone={endpoint.tone}>{endpoint.kind}</Badge>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={styles.endpointPath}>{full}</div>
                  <p style={styles.muted}>{endpoint.desc}</p>
                </div>
                <CopyButton value={full} />
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <h2 style={styles.sectionTitle}>Available Models</h2>
        <div style={styles.modelGrid}>
          {models.map((model) => (
            <div style={styles.modelCard} key={model.id}>
              <div style={styles.modelId}>{model.id}</div>
              <Badge tone={model.provider === "OpenAI" ? "blue" : "orange"}>{model.provider}</Badge>
              {model.tags && <div style={styles.tagRow}>{model.tags.map((tag) => <span style={styles.miniTag} key={tag}>{tag}</span>)}</div>}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <h2 style={styles.sectionTitle}>CherryStudio 4 步设置指引</h2>
        <div style={styles.steps}>
          {[
            ["新建供应商", "在 CherryStudio 中添加自定义供应商。"],
            ["选择接口类型", "可选 OpenAI 或 Anthropic；OpenAI 使用 /v1/chat/completions，Anthropic 使用 /v1/messages。"],
            ["填写连接信息", `Base URL 填 ${v1Url}，API Key 填 ${API_KEY}。`],
            ["选择模型并测试", "推荐 claude-opus-4-7，或使用 gpt-5.5。"],
          ].map(([title, desc], index) => (
            <div style={styles.step} key={title}>
              <div style={styles.stepNumber}>{index + 1}</div>
              <div>
                <h3 style={styles.stepTitle}>{title}</h3>
                <p style={styles.muted}>{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <h2 style={styles.sectionTitle}>Quick Test</h2>
        <div style={styles.examples}>{examples.map((code, index) => <CodeBlock code={code} key={index} />)}</div>
      </Card>

      <footer style={styles.footer}>
        {["Replit", "OpenRouter upstream", "OpenAI-compatible API", "Anthropic Messages-compatible API", "Prompt Caching", "Claude Opus 4.7 Adaptive Thinking", "pnpm monorepo"].map((item) => (
          <span style={styles.footerTag} key={item}>{item}</span>
        ))}
      </footer>
    </main>
  );
}

const styles: any = {
  page: {
    minHeight: "100vh",
    background: "hsl(222,47%,11%)",
    color: "#e5edf7",
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    padding: "42px 22px 64px",
    position: "relative",
    overflow: "hidden",
  },
  bgGlowOne: { position: "fixed", width: 460, height: 460, borderRadius: 999, background: "rgba(56,189,248,.16)", filter: "blur(70px)", top: -180, right: -120, pointerEvents: "none" },
  bgGlowTwo: { position: "fixed", width: 520, height: 520, borderRadius: 999, background: "rgba(168,85,247,.12)", filter: "blur(80px)", bottom: -220, left: -170, pointerEvents: "none" },
  hero: { maxWidth: 1180, margin: "0 auto 24px", display: "flex", alignItems: "center", gap: 18, position: "relative", zIndex: 1 },
  logo: { width: 62, height: 62, borderRadius: 18, display: "grid", placeItems: "center", fontWeight: 900, background: "linear-gradient(135deg,#38bdf8,#a78bfa)", color: "#07111f", boxShadow: "0 18px 60px rgba(56,189,248,.35)" },
  title: { fontSize: "clamp(32px,5vw,58px)", lineHeight: 1, margin: 0, letterSpacing: "-0.05em" },
  subtitle: { margin: "10px 0 0", color: "#9fb0c7", fontSize: 17 },
  statusPill: { display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", border: "1px solid rgba(148,163,184,.22)", borderRadius: 999, background: "rgba(15,23,42,.62)", color: "#dbeafe" },
  statusDot: { width: 10, height: 10, borderRadius: 99, display: "inline-block" },
  card: { maxWidth: 1180, margin: "18px auto", padding: 22, border: "1px solid rgba(148,163,184,.18)", borderRadius: 24, background: "linear-gradient(180deg,rgba(15,23,42,.78),rgba(15,23,42,.55))", boxShadow: "0 22px 80px rgba(0,0,0,.22)", position: "relative", zIndex: 1 },
  sectionTitle: { margin: "0 0 18px", fontSize: 22 },
  detailGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 14 },
  detailItem: { padding: 16, border: "1px solid rgba(148,163,184,.14)", borderRadius: 18, background: "rgba(2,6,23,.35)", display: "grid", gap: 9 },
  detailLabel: { color: "#93a4bb", fontSize: 13, textTransform: "uppercase", letterSpacing: ".08em" },
  detailValue: { color: "#f8fafc", wordBreak: "break-word", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 14 },
  copyButton: { border: "1px solid rgba(125,211,252,.35)", background: "rgba(14,165,233,.12)", color: "#bae6fd", borderRadius: 12, padding: "8px 12px", cursor: "pointer", justifySelf: "start" },
  endpointList: { display: "grid", gap: 12 },
  endpointRow: { display: "flex", alignItems: "center", gap: 16, padding: 16, border: "1px solid rgba(148,163,184,.14)", borderRadius: 18, background: "rgba(2,6,23,.28)", flexWrap: "wrap" },
  endpointMeta: { display: "flex", gap: 8, alignItems: "center" },
  endpointPath: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "#e0f2fe", wordBreak: "break-all" },
  muted: { color: "#9fb0c7", margin: "6px 0 0", lineHeight: 1.6 },
  badge: { display: "inline-flex", alignItems: "center", borderRadius: 999, padding: "5px 10px", fontSize: 12, fontWeight: 800, letterSpacing: ".04em" },
  badgeTone: {
    green: { background: "rgba(34,197,94,.14)", color: "#86efac", border: "1px solid rgba(34,197,94,.28)" },
    purple: { background: "rgba(168,85,247,.16)", color: "#d8b4fe", border: "1px solid rgba(168,85,247,.3)" },
    blue: { background: "rgba(59,130,246,.16)", color: "#bfdbfe", border: "1px solid rgba(59,130,246,.3)" },
    orange: { background: "rgba(249,115,22,.15)", color: "#fed7aa", border: "1px solid rgba(249,115,22,.32)" },
    gray: { background: "rgba(148,163,184,.14)", color: "#cbd5e1", border: "1px solid rgba(148,163,184,.25)" },
  },
  modelGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14 },
  modelCard: { display: "grid", alignContent: "start", gap: 12, minHeight: 128, padding: 17, border: "1px solid rgba(148,163,184,.15)", borderRadius: 19, background: "rgba(2,6,23,.32)" },
  modelId: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 16, color: "#f8fafc", wordBreak: "break-word" },
  tagRow: { display: "flex", flexWrap: "wrap", gap: 8 },
  miniTag: { fontSize: 12, color: "#c4b5fd", background: "rgba(124,58,237,.14)", border: "1px solid rgba(124,58,237,.28)", borderRadius: 999, padding: "5px 9px" },
  steps: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 14 },
  step: { display: "flex", gap: 14, padding: 16, borderRadius: 18, border: "1px solid rgba(148,163,184,.14)", background: "rgba(2,6,23,.3)" },
  stepNumber: { minWidth: 36, width: 36, height: 36, borderRadius: 999, display: "grid", placeItems: "center", background: "linear-gradient(135deg,#38bdf8,#a78bfa)", color: "#08111f", fontWeight: 900 },
  stepTitle: { margin: "0 0 4px", fontSize: 16 },
  examples: { display: "grid", gap: 14 },
  codeWrap: { position: "relative", borderRadius: 18, border: "1px solid rgba(125,211,252,.18)", background: "#020617", overflow: "hidden" },
  code: { margin: 0, padding: "18px 18px 54px", overflowX: "auto", color: "#bae6fd", fontSize: 13, lineHeight: 1.65, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" },
  footer: { maxWidth: 1180, margin: "24px auto 0", display: "flex", flexWrap: "wrap", gap: 10, position: "relative", zIndex: 1 },
  footerTag: { color: "#9fb0c7", border: "1px solid rgba(148,163,184,.16)", borderRadius: 999, padding: "8px 12px", background: "rgba(15,23,42,.45)" },
};
