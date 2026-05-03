#!/usr/bin/env node
// Savings mode 自验脚本(Phase 1:纯文本分支)
//
// 触发条件:已在 http://localhost:${SAVINGS_PORT:-8080} 启动 api-server,
// 且环境里有 OpenRouter 集成变量(AI_INTEGRATIONS_OPENROUTER_BASE_URL/API_KEY)。
//
// 用法:
//   node artifacts/api-server/scripts/savings_repro.mjs
//
// 退出码:0 = 全部断言通过,1 = 任一断言失败,2 = 脚本本身报错。
// stdout 行 SAVINGS_GEN_ID_TEXT=<gen-id> 用于 grep 提取上游 gen-id,
// 之后到 OpenRouter dashboard 人工核对该 gen 是否计费。

import { argv, env, exit, stderr, stdout } from "node:process";

const baseUrl = env.SAVINGS_BASE_URL || `http://localhost:${env.SAVINGS_PORT || env.PORT || 8080}`;
const apiKey = env.SAVINGS_API_KEY || "tzcnb";
const model = env.SAVINGS_MODEL || "claude-opus-4-7";

function log(line) {
  stdout.write(`${line}\n`);
}

function logErr(line) {
  stderr.write(`${line}\n`);
}

async function streamChatCompletion({ name, body }) {
  const t0 = Date.now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`,
      "x-savings-mode": "1",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${name}: HTTP ${res.status}: ${text}`);
  }

  const headerSavingsMode = res.headers.get("x-savings-mode");
  const headerGenId = res.headers.get("x-upstream-gen-id");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let business = "";
  const toolCalls = [];
  let abortedFromComment = null;
  let bizBytesFromComment = null;
  let sawDone = false;

  while (!sawDone) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1 && !sawDone) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of event.split("\n")) {
        if (line.startsWith(":")) {
          const c = line.slice(1).trim();
          let m;
          if ((m = c.match(/^x-savings-aborted:\s*(\d+)/))) abortedFromComment = m[1] === "1";
          else if ((m = c.match(/^x-savings-business-bytes:\s*(\d+)/))) bizBytesFromComment = parseInt(m[1], 10);
        } else if (line.startsWith("data:")) {
          const d = line.slice(5).trimStart();
          if (d === "[DONE]") { sawDone = true; break; }
          try {
            const j = JSON.parse(d);
            const choice = j.choices?.[0];
            const delta = choice?.delta || {};
            if (typeof delta.content === "string") business += delta.content;
            if (Array.isArray(delta.tool_calls)) {
              for (const call of delta.tool_calls) {
                const idx2 = call.index ?? toolCalls.length;
                if (!toolCalls[idx2]) toolCalls[idx2] = { name: "", arguments: "" };
                if (call.function?.name) toolCalls[idx2].name = call.function.name;
                if (typeof call.function?.arguments === "string") toolCalls[idx2].arguments += call.function.arguments;
              }
            }
          } catch { /* malformed event, skip */ }
        }
      }
    }
  }

  return {
    headerSavingsMode,
    headerGenId,
    business,
    toolCalls,
    abortedFromComment,
    bizBytesFromComment,
    elapsedMs: Date.now() - t0,
  };
}

let allPassed = true;
const summary = [];

async function runTextScenario() {
  log("");
  log("=== Scenario 1: text mode (PostgreSQL 优化分析) ===");
  const prompt =
    "请详细分析 PostgreSQL 在 OLTP 与 OLAP 混合负载下的查询性能瓶颈,覆盖:" +
    "(1) 索引设计(B-tree/BRIN/GIN/GiST/partial index/expression index 选型与对比);" +
    "(2) vacuum 与 analyze 调度策略,autovacuum 触发阈值;" +
    "(3) 连接池(pgbouncer transaction/session/statement 模式)与 max_connections;" +
    "(4) 并行查询(parallel workers)、JIT 收益与代价、查询计划缓存;" +
    "(5) shared_buffers / effective_cache_size / work_mem / maintenance_work_mem 配置依据;" +
    "(6) WAL / checkpoint / synchronous_commit / archive 模式选型;" +
    "(7) 统计信息收敛、扩展统计 CREATE STATISTICS;" +
    "(8) 热数据分区(pg_partman / 原生 declarative partition)与冷数据归档;" +
    "(9) Citus 等分布式扩展下的 colocation join;" +
    "(10) 复制延迟监控、HOT update / fillfactor。" +
    "请给出可落地的调优清单(不少于 12 条),每条都要有具体阈值或参数取值,总输出不少于 3000 个汉字字符。";

  const result = await streamChatCompletion({
    name: "text",
    body: {
      model,
      stream: true,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 8000,
    },
  });

  log(`elapsed: ${result.elapsedMs} ms`);
  log(`x-savings-mode (header): ${result.headerSavingsMode}`);
  log(`x-upstream-gen-id (header): ${result.headerGenId}`);
  log(`x-savings-aborted (SSE comment): ${result.abortedFromComment}`);
  log(`x-savings-business-bytes (SSE comment): ${result.bizBytesFromComment}`);
  log(`business content length (chars): ${result.business.length}`);

  const failures = [];
  if (result.headerSavingsMode !== "applied") {
    failures.push(`expected x-savings-mode=applied, got ${JSON.stringify(result.headerSavingsMode)}`);
  }
  if (result.business.length < 3000) {
    failures.push(`business content < 3000 chars (got ${result.business.length})`);
  }
  if (result.business.includes("<<<HANDOFF_TOKEN_BEGIN")) {
    failures.push("business content leaked sentinel begin marker to client");
  }
  if (result.business.includes("HANDOFF_TOKEN_END_DO_NOT_MODIFY")) {
    failures.push("business content leaked sentinel end marker to client");
  }
  if (result.abortedFromComment !== true) {
    failures.push(`expected aborted=1 (sentinel hit), got ${result.abortedFromComment}`);
  }
  if (!result.headerGenId) {
    failures.push("x-upstream-gen-id header missing — cannot cross-check against OpenRouter dashboard");
  }

  if (failures.length === 0) {
    log("text scenario: PASS");
    log(`SAVINGS_GEN_ID_TEXT=${result.headerGenId}`);
    summary.push({ scenario: "text", status: "PASS", genId: result.headerGenId });
  } else {
    allPassed = false;
    logErr("text scenario: FAIL");
    for (const f of failures) logErr(`  - ${f}`);
    summary.push({ scenario: "text", status: "FAIL", genId: result.headerGenId, failures });
  }
}

async function main() {
  const phase = (argv.find((a) => a.startsWith("--phase=")) || "--phase=1").split("=")[1];

  await runTextScenario();

  if (phase === "2") {
    logErr("phase 2 (tool scenario) is not yet implemented in Phase 1 commit");
  }

  log("");
  log("=== Summary ===");
  for (const row of summary) {
    log(JSON.stringify(row));
  }
  log("");
  log("Cross-check the gen-id(s) printed above on https://openrouter.ai/activity to confirm they are NOT billed.");

  exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  logErr(`repro script error: ${err?.stack || err}`);
  exit(2);
});
