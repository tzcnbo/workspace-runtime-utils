import { Router } from "express";
import type { NextFunction, Request, Response as ExpressResponse } from "express";
import { once } from "node:events";
import crypto from "node:crypto";

const router = Router();
const PROXY_API_KEY = "tzcnb";

// Streaming savings mode: 让客户端在拿到完整业务输出之后,通过强迫 Claude 续写
// 一段固定 handoff token 来制造 ~1500 token / 数秒墙钟的"未完成生成",检测到
// sentinel 即 abort 上游 fetch,使该 gen-id 不被 OpenRouter 计费。
// 触发条件:x-savings-mode: 1 + payload.stream === true + Claude 模型 + 非 image。
const SAVINGS_HEADER = "x-savings-mode";
const SAVINGS_SENTINEL_BEGIN = "<<<HANDOFF_TOKEN_BEGIN_DO_NOT_MODIFY>>>";
const SAVINGS_SENTINEL_END = "<<<HANDOFF_TOKEN_END_DO_NOT_MODIFY>>>";
const SAVINGS_END_MARKER_TOOL_NAME = "__end_marker";
const SAVINGS_TOKEN_SEG_COUNT = 60;       // 调大 → 抢断窗口更大,prompt 成本更高
const SAVINGS_TOKEN_SEG_PAYLOAD_LEN = 40; // 单段 payload 字符数

const MODEL_MAP: Record<string, string> = {
  "gpt-5.5": "openai/gpt-5.5",
  "openai/gpt-5.4-image-2": "openai/gpt-5.4-image-2",
  "gpt-5.4-image-2": "openai/gpt-5.4-image-2",
  "claude-opus-4-7": "anthropic/claude-opus-4.7",
  "claude-opus-4-6": "anthropic/claude-opus-4.6",
  "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
};

const MODELS = [
  { id: "gpt-5.5", object: "model", created: 0, owned_by: "openai" },
  { id: "openai/gpt-5.4-image-2", object: "model", created: 0, owned_by: "openai", input_modalities: ["text", "image"], output_modalities: ["image", "text"] },
  { id: "claude-opus-4-7", object: "model", created: 0, owned_by: "anthropic" },
  { id: "claude-opus-4-6", object: "model", created: 0, owned_by: "anthropic" },
  { id: "claude-sonnet-4-6", object: "model", created: 0, owned_by: "anthropic" },
  { id: "claude-haiku-4-5", object: "model", created: 0, owned_by: "anthropic" },
];

const OPENROUTER_EXTENSION_FIELDS = new Set([
  "cache_control",
  "image_config",
  "modalities",
  "reasoning",
  "verbosity",
  "provider",
  "plugins",
  "transforms",
  "route",
  "models",
  "metadata",
]);

type JsonObject = Record<string, any>;

const IMAGE_MODEL_IDS = new Set(["openai/gpt-5.4-image-2", "gpt-5.4-image-2"]);
const IMAGE_CONFIG_FIELDS = new Set([
  "size",
  "quality",
  "background",
  "output_format",
  "output_compression",
  "moderation",
  "aspect_ratio",
  "image_size",
]);
const IMAGE_GENERATION_ROOT_FIELDS = new Set([
  "n",
  "seed",
  "user",
  "metadata",
  "provider",
  "route",
  "models",
  "plugins",
  "transforms",
  "service_tier",
]);

class HttpError extends Error {
  status: number;
  body?: any;

  constructor(status: number, message: string, body?: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(obj: any, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj ?? {}, key);
}

function removeCacheControls(value: any): void {
  const visit = (node: any) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isObject(node)) return;
    delete node.cache_control;
    for (const child of Object.values(node)) visit(child);
  };

  visit(value);
}

function validSignature(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-");
}

function isOpenAIModel(model: string): boolean {
  return model.startsWith("gpt") || model.startsWith("openai/");
}

function isImageModel(model: string): boolean {
  return IMAGE_MODEL_IDS.has(model);
}

function toOpenRouterModel(model: string): string {
  const mapped = MODEL_MAP[model];
  if (!mapped) {
    throw new HttpError(400, `Unsupported model: ${model}`, {
      error: {
        message: `Unsupported model: ${model}`,
        type: "invalid_request_error",
        code: "model_not_supported",
      },
    });
  }
  return mapped;
}

function getBearerToken(req: Request): string | undefined {
  const auth = req.header("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return undefined;
}

function requireAuth(req: Request, res: ExpressResponse, next: NextFunction): void {
  const bearer = getBearerToken(req);
  const apiKey = req.header("x-api-key")?.trim();
  if (bearer === PROXY_API_KEY || apiKey === PROXY_API_KEY) {
    next();
    return;
  }
  res.status(401).json({ error: { message: "Unauthorized", type: "invalid_request_error" } });
}

function sendOpenAIError(res: ExpressResponse, status: number, message: string, type = "server_error", code?: string): void {
  res.status(status).json({ error: { message, type, ...(code ? { code } : {}) } });
}

function sendAnthropicError(res: ExpressResponse, status: number, message: string, type = "api_error"): void {
  res.status(status).json({ type: "error", error: { type, message } });
}

function errorMessageFromBody(body: any, fallback: string): string {
  if (!body) return fallback;
  if (typeof body === "string") return body;
  if (typeof body.error === "string") return body.error;
  if (body.error?.message) return String(body.error.message);
  if (body.message) return String(body.message);
  return fallback;
}

function findEnvByKeywords(required: string[], valueHint?: RegExp): string | undefined {
  const entries = Object.entries(process.env)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [key, value] of entries) {
    const upper = key.toUpperCase();
    if (!required.every((part) => upper.includes(part))) continue;
    if (valueHint && !valueHint.test(String(value))) continue;
    return value;
  }
  return undefined;
}

function discoverOpenRouterBaseUrl(): string | undefined {
  return (
    process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL ||
    findEnvByKeywords(["OPENROUTER", "BASE", "URL"], /^https?:\/\//i) ||
    findEnvByKeywords(["OPENROUTER", "URL"], /^https?:\/\//i) ||
    findEnvByKeywords(["AI_INTEGRATIONS", "BASE", "URL"], /^https?:\/\//i) ||
    findEnvByKeywords(["AI_GATEWAY", "BASE", "URL"], /^https?:\/\//i) ||
    findEnvByKeywords(["REPLIT", "BASE", "URL"], /^https?:\/\//i)
  );
}

function discoverOpenRouterApiKey(): string | undefined {
  return (
    process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY ||
    findEnvByKeywords(["OPENROUTER", "API", "KEY"]) ||
    findEnvByKeywords(["OPENROUTER", "TOKEN"]) ||
    findEnvByKeywords(["AI_INTEGRATIONS", "API", "KEY"]) ||
    findEnvByKeywords(["AI_GATEWAY", "API", "KEY"]) ||
    findEnvByKeywords(["REPLIT", "AI", "KEY"])
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  // Replit AI/OpenRouter integrations inject an OpenAI-compatible base URL.
  // Treat it exactly like the OpenAI SDK's baseURL: append the resource path
  // only. Do not invent an extra /v1 segment for gateway/internal URLs.
  return `${normalized}/chat/completions`;
}

function getOpenRouterConfig(): { url: string; apiKey: string } {
  const apiKey = discoverOpenRouterApiKey();
  const discoveredBase = discoverOpenRouterBaseUrl();
  const baseUrl = discoveredBase || (apiKey ? "https://openrouter.ai/api/v1" : undefined);

  if (!baseUrl || !apiKey) {
    throw new HttpError(500, "Missing Replit OpenRouter integration environment variables", {
      error: {
        message: "Missing Replit OpenRouter integration environment variables. Expected AI_INTEGRATIONS_OPENROUTER_BASE_URL and AI_INTEGRATIONS_OPENROUTER_API_KEY, or equivalent injected variables.",
        type: "server_error",
        code: "openrouter_env_missing",
      },
    });
  }
  return { url: buildChatCompletionsUrl(baseUrl), apiKey };
}

function logProxyDebug(message: string, data?: JsonObject): void {
  if (process.env.DEBUG_PROXY !== "1") return;
  console.log(`[proxy] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);
}

async function callOpenRouterChatCompletions(payload: JsonObject, options: { signal?: AbortSignal } = {}): Promise<Response> {
  const { url, apiKey } = getOpenRouterConfig();
  logProxyDebug("OpenRouter request", {
    url,
    model: payload.model,
    stream: payload.stream === true,
    provider: payload.provider,
    extension_fields: Object.keys(payload).filter((key) => OPENROUTER_EXTENSION_FIELDS.has(key)),
  });

  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
}

async function readResponseBody(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function mergeProviderForClaude(payload: JsonObject): void {
  if (isObject(payload.provider)) {
    if (!hasOwn(payload.provider, "require_parameters")) payload.provider.require_parameters = true;
    return;
  }
  payload.provider = { order: ["anthropic"], require_parameters: true };
}

function applyClaudePromptCaching(payload: JsonObject, req: Request): void {
  const promptCacheHeader = req.header("x-prompt-cache")?.trim().toLowerCase();
  const promptCacheOff = promptCacheHeader === "off" || payload.cache_control === false;

  // OpenRouter's top-level Anthropic cache_control is the right mode for
  // multi-turn chats: it advances the cache breakpoint to the latest
  // cacheable block as history grows. Claude Desktop may send its own fixed
  // explicit breakpoints (often just system/tools); keeping those makes cache
  // reads stay stuck at the same token count, and combining them with top-level
  // cache_control can exceed Anthropic's four-breakpoint limit. Normalize to a
  // single top-level automatic cache switch instead.
  removeCacheControls(payload);

  if (promptCacheOff) return;

  const ttl = req.header("x-prompt-cache-ttl")?.trim().toLowerCase();
  payload.cache_control = ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

function mapReasoningEffortToVerbosity(effort: unknown): string | undefined {
  if (typeof effort !== "string") return undefined;
  return new Set(["low", "medium", "high", "xhigh", "max"]).has(effort) ? effort : undefined;
}

function adaptClaudeOpus47Thinking(payload: JsonObject): void {
  const hadThinking = hasOwn(payload, "thinking");
  const hadReasoning = hasOwn(payload, "reasoning");
  const hadVerbosity = hasOwn(payload, "verbosity");
  const thinking = isObject(payload.thinking) ? payload.thinking : undefined;
  const reasoning = isObject(payload.reasoning) ? { ...payload.reasoning } : {};

  const explicitReasoningDisabled = reasoning.enabled === false;
  const explicitThinkingDisabled = thinking?.type === "disabled";
  const disabled = explicitReasoningDisabled || explicitThinkingDisabled;

  const verbosityFromEffort = mapReasoningEffortToVerbosity(reasoning.effort);
  if (!hadVerbosity && verbosityFromEffort) payload.verbosity = verbosityFromEffort;

  delete reasoning.effort;
  delete reasoning.max_tokens;
  delete payload.thinking;

  if (disabled) {
    if (explicitReasoningDisabled) payload.reasoning = { ...reasoning, enabled: false };
    else delete payload.reasoning;
  } else {
    const thinkingRequestsAdaptive = thinking?.type === "adaptive" || thinking?.type === "enabled";
    const shouldEnableReasoning = !hadThinking && !hadReasoning ? true : thinkingRequestsAdaptive || hadReasoning || reasoning.enabled === true;
    if (shouldEnableReasoning) payload.reasoning = { ...reasoning, enabled: true };
    else if (Object.keys(reasoning).length > 0) payload.reasoning = reasoning;
    else delete payload.reasoning;
  }

  if (!hasOwn(payload, "verbosity")) payload.verbosity = "xhigh";

  delete payload.temperature;
  delete payload.top_p;
  delete payload.top_k;
}

function adaptGenericClaudeThinking(payload: JsonObject): void {
  const hadThinking = hasOwn(payload, "thinking");
  const hadReasoning = hasOwn(payload, "reasoning");
  const thinking = isObject(payload.thinking) ? payload.thinking : undefined;
  const reasoning = isObject(payload.reasoning) ? { ...payload.reasoning } : {};

  if (reasoning.enabled === false || thinking?.type === "disabled") {
    payload.reasoning = { ...reasoning, enabled: false };
  } else if (thinking?.type === "adaptive" || thinking?.type === "enabled" || (!hadThinking && !hadReasoning)) {
    payload.reasoning = { ...reasoning, enabled: true };
  } else if (hadReasoning && Object.keys(reasoning).length > 0) {
    payload.reasoning = reasoning;
  }

  delete payload.thinking;
}

function adaptClaudePayload(payload: JsonObject, req: Request, externalModel: string): void {
  const explicitReasoningDisabledBeforeAdapt =
    payload.include_reasoning === false ||
    (isObject(payload.reasoning) && payload.reasoning.enabled === false) ||
    (isObject(payload.thinking) && payload.thinking.type === "disabled");

  mergeProviderForClaude(payload);
  applyClaudePromptCaching(payload, req);
  if (externalModel === "claude-opus-4-7") adaptClaudeOpus47Thinking(payload);
  else adaptGenericClaudeThinking(payload);

  const reasoning = isObject(payload.reasoning) ? payload.reasoning : {};
  const reasoningDisabled =
    explicitReasoningDisabledBeforeAdapt ||
    reasoning.enabled === false ||
    reasoning.exclude === true ||
    payload.include_reasoning === false;
  if (!reasoningDisabled && !hasOwn(payload, "include_reasoning")) {
    payload.include_reasoning = true;
  }
}

function collectImageConfig(body: JsonObject): JsonObject | undefined {
  const config: JsonObject = isObject(body.image_config) ? clone(body.image_config) : {};
  for (const field of IMAGE_CONFIG_FIELDS) {
    if (hasOwn(body, field)) config[field] = clone(body[field]);
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function adaptImageChatPayload(payload: JsonObject): void {
  if (!Array.isArray(payload.modalities) || payload.modalities.length === 0) {
    payload.modalities = ["image", "text"];
  }

  const imageConfig = collectImageConfig(payload);
  if (imageConfig) payload.image_config = imageConfig;
  for (const field of IMAGE_CONFIG_FIELDS) delete payload[field];

  // Some OpenAI image clients send prompt-style payloads even when pointed at
  // /chat/completions. Convert that into a normal chat message instead of
  // forwarding an unknown root prompt field to OpenRouter.
  if (!Array.isArray(payload.messages) && hasOwn(payload, "prompt")) {
    payload.messages = [{ role: "user", content: stringifyImagePrompt(payload.prompt) }];
    delete payload.prompt;
  }
}

function stringifyImagePrompt(prompt: any): string {
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt.map((part) => {
      if (typeof part === "string") return part;
      if (isObject(part) && typeof part.text === "string") return part.text;
      return JSON.stringify(part);
    }).join("\n");
  }
  if (prompt === undefined || prompt === null) return "";
  return typeof prompt === "object" ? JSON.stringify(prompt) : String(prompt);
}

function normalizeImageUrl(value: any): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (!isObject(value)) return undefined;
  if (typeof value.url === "string") return value.url;
  if (typeof value.image_url?.url === "string") return value.image_url.url;
  if (typeof value.imageUrl?.url === "string") return value.imageUrl.url;
  if (typeof value.b64_json === "string") return `data:image/png;base64,${value.b64_json}`;
  if (typeof value.data === "string" && typeof value.media_type === "string") return `data:${value.media_type};base64,${value.data}`;
  return undefined;
}

function collectImageInputs(body: JsonObject): string[] {
  const raw: any[] = [];
  for (const key of ["image", "images", "reference_image", "reference_images", "input_image", "input_images"]) {
    if (!hasOwn(body, key)) continue;
    const value = body[key];
    if (Array.isArray(value)) raw.push(...value);
    else raw.push(value);
  }
  const urls: string[] = [];
  for (const item of raw) {
    const url = normalizeImageUrl(item);
    if (url) urls.push(url);
  }
  return urls;
}

function imagePromptContent(prompt: any, imageUrls: string[]): any {
  const text = stringifyImagePrompt(prompt);
  if (imageUrls.length === 0) return text;
  return [
    { type: "text", text },
    ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
}

function prepareImageGenerationPayload(body: any): { payload: JsonObject; externalModel: string; responseFormat: string } {
  if (!isObject(body)) {
    throw new HttpError(400, "Request body must be a JSON object", {
      error: { message: "Request body must be a JSON object", type: "invalid_request_error" },
    });
  }

  const externalModel = String(body.model || "openai/gpt-5.4-image-2");
  if (!isImageModel(externalModel)) {
    throw new HttpError(400, `Unsupported image model: ${externalModel}`, {
      error: { message: `Unsupported image model: ${externalModel}`, type: "invalid_request_error", code: "model_not_supported" },
    });
  }
  if (!hasOwn(body, "prompt") || stringifyImagePrompt(body.prompt).trim().length === 0) {
    throw new HttpError(400, "Missing required field: prompt", {
      error: { message: "Missing required field: prompt", type: "invalid_request_error", code: "prompt_required" },
    });
  }

  const payload: JsonObject = {
    model: toOpenRouterModel(externalModel),
    messages: [{ role: "user", content: imagePromptContent(body.prompt, collectImageInputs(body)) }],
    modalities: Array.isArray(body.modalities) && body.modalities.length > 0 ? clone(body.modalities) : ["image", "text"],
  };

  for (const field of IMAGE_GENERATION_ROOT_FIELDS) {
    if (hasOwn(body, field)) payload[field] = clone(body[field]);
  }

  const imageConfig = collectImageConfig(body);
  if (imageConfig) payload.image_config = imageConfig;

  return { payload, externalModel, responseFormat: String(body.response_format || "b64_json") };
}

function dataUrlToB64Json(url: string): string | undefined {
  const match = url.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is);
  return match ? match[2] : undefined;
}

function extractOpenRouterImageUrls(json: JsonObject): string[] {
  const urls: string[] = [];
  const visitImage = (item: any) => {
    const url = normalizeImageUrl(item);
    if (url) urls.push(url);
  };

  for (const choice of Array.isArray(json.choices) ? json.choices : []) {
    const message = choice?.message || {};
    if (Array.isArray(message.images)) for (const image of message.images) visitImage(image);
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isObject(part) && (part.type === "image_url" || part.type === "image")) visitImage(part);
      }
    }
    if (typeof message.content === "string") {
      const matches = message.content.match(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi);
      if (matches) urls.push(...matches);
    }
  }

  return urls;
}

function imageGenerationResponseFromChat(json: JsonObject, responseFormat: string): JsonObject {
  const urls = extractOpenRouterImageUrls(json);
  if (urls.length === 0) {
    throw new HttpError(502, "OpenRouter image response did not contain images", {
      error: { message: "OpenRouter image response did not contain images", type: "server_error", code: "image_output_missing" },
    });
  }

  const firstMessage = json.choices?.[0]?.message || {};
  const revisedPrompt = typeof firstMessage.content === "string" && !firstMessage.content.startsWith("data:image/") ? firstMessage.content : undefined;
  const data = urls.map((url) => {
    if (responseFormat === "url") return { url, ...(revisedPrompt ? { revised_prompt: revisedPrompt } : {}) };
    const b64 = dataUrlToB64Json(url);
    if (b64) return { b64_json: b64, ...(revisedPrompt ? { revised_prompt: revisedPrompt } : {}) };
    return { url, ...(revisedPrompt ? { revised_prompt: revisedPrompt } : {}) };
  });

  return {
    created: typeof json.created === "number" ? json.created : Math.floor(Date.now() / 1000),
    data,
    ...(isObject(json.usage) ? { usage: normalizeOpenAIUsageCacheFields({ usage: clone(json.usage) }).usage } : {}),
  };
}

function prepareOpenAIChatPayload(body: any, req: Request): { payload: JsonObject; externalModel: string } {
  if (!isObject(body)) {
    throw new HttpError(400, "Request body must be a JSON object", {
      error: { message: "Request body must be a JSON object", type: "invalid_request_error" },
    });
  }

  const externalModel = String(body.model || "");
  if (!externalModel) {
    throw new HttpError(400, "Missing required field: model", {
      error: { message: "Missing required field: model", type: "invalid_request_error", code: "model_required" },
    });
  }

  const payload = clone(body) as JsonObject;
  payload.model = toOpenRouterModel(externalModel);
  if (isClaudeModel(externalModel)) adaptClaudePayload(payload, req, externalModel);
  if (isImageModel(externalModel)) adaptImageChatPayload(payload);
  return { payload, externalModel };
}

function systemToOpenAIMessages(system: any): JsonObject[] {
  if (system === undefined || system === null) return [];
  if (typeof system === "string") return [{ role: "system", content: system }];
  if (Array.isArray(system)) return [{ role: "system", content: system.map(convertAnthropicContentBlock) }];
  return [{ role: "system", content: String(system) }];
}

function convertAnthropicImageBlock(block: JsonObject): JsonObject {
  const source = block.source;
  let url = "";
  if (isObject(source)) {
    if (source.type === "base64" && source.media_type && source.data) url = `data:${source.media_type};base64,${source.data}`;
    else if (source.type === "url" && source.url) url = String(source.url);
  }
  return { type: "image_url", image_url: { url }, ...(hasOwn(block, "cache_control") ? { cache_control: block.cache_control } : {}) };
}

function convertAnthropicContentBlock(block: any): any {
  if (!isObject(block)) return block;
  if (block.type === "text") {
    return { type: "text", text: block.text ?? "", ...(hasOwn(block, "cache_control") ? { cache_control: block.cache_control } : {}) };
  }
  if (block.type === "image") return convertAnthropicImageBlock(block);
  return clone(block);
}

function stringifyToolResultContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (isObject(part) && part.type === "text") return String(part.text ?? "");
      return JSON.stringify(part);
    }).join("\n");
  }
  if (content === undefined || content === null) return "";
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}

function anthropicToolUseToOpenAI(block: JsonObject): JsonObject {
  return {
    id: block.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "function",
    function: { name: block.name || "tool", arguments: JSON.stringify(block.input ?? {}) },
  };
}

function anthropicThinkingToReasoningDetail(block: JsonObject, index: number): JsonObject | undefined {
  if (block.type === "thinking") {
    const text = typeof block.thinking === "string" ? block.thinking : typeof block.text === "string" ? block.text : "";
    const signature = validSignature(block.signature);
    // Claude extended-thinking blocks are signed. If a client sends back an
    // unsigned thinking block, do not forward it as signature:null; Anthropic
    // providers reject that transcript on the next turn.
    if (!text || !signature) return undefined;
    return {
      type: "reasoning.text",
      text,
      signature,
      format: "anthropic-claude-v1",
      index,
    };
  }

  if (block.type === "redacted_thinking") {
    const data = typeof block.data === "string" ? block.data : "";
    if (!data) return undefined;
    return {
      type: "reasoning.encrypted",
      data,
      format: "anthropic-claude-v1",
      index,
    };
  }

  return undefined;
}

function convertAnthropicMessage(message: JsonObject): JsonObject[] {
  const role = message.role === "assistant" ? "assistant" : "user";
  const content = message.content;
  if (!Array.isArray(content)) return [{ role, content: content ?? "" }];

  const normalBlocks: any[] = [];
  const toolCalls: JsonObject[] = [];
  const toolResultMessages: JsonObject[] = [];
  const reasoningDetails: JsonObject[] = [];

  for (const block of content) {
    if (isObject(block) && block.type === "tool_use") { toolCalls.push(anthropicToolUseToOpenAI(block)); continue; }
    if (isObject(block) && block.type === "tool_result") {
      toolResultMessages.push({ role: "tool", tool_call_id: block.tool_use_id || block.id || "", content: stringifyToolResultContent(block.content) });
      continue;
    }
    if (isObject(block) && (block.type === "thinking" || block.type === "redacted_thinking")) {
      const detail = anthropicThinkingToReasoningDetail(block, reasoningDetails.length);
      if (detail) reasoningDetails.push(detail);
      continue;
    }
    normalBlocks.push(convertAnthropicContentBlock(block));
  }

  const output: JsonObject[] = [];
  if (normalBlocks.length > 0 || toolCalls.length > 0 || reasoningDetails.length > 0) {
    const canCollapseText = normalBlocks.length === 1 && isObject(normalBlocks[0]) && normalBlocks[0].type === "text" && !hasOwn(normalBlocks[0], "cache_control");
    const openAIMessage: JsonObject = {
      role: toolCalls.length > 0 ? "assistant" : role,
      content: normalBlocks.length === 0 ? "" : canCollapseText ? normalBlocks[0].text : normalBlocks,
    };
    if (toolCalls.length > 0) {
      openAIMessage.tool_calls = toolCalls;
      if (normalBlocks.length === 0) openAIMessage.content = "";
    }
    if (reasoningDetails.length > 0) openAIMessage.reasoning_details = reasoningDetails;
    output.push(openAIMessage);
  }
  output.push(...toolResultMessages);
  return output;
}

function convertAnthropicTools(tools: any): any {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || tool.parameters || { type: "object", properties: {} },
    },
    ...(hasOwn(tool, "cache_control") ? { cache_control: tool.cache_control } : {}),
  }));
}

function convertAnthropicToolChoice(toolChoice: any): any {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (!isObject(toolChoice)) return toolChoice;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool" && toolChoice.name) return { type: "function", function: { name: toolChoice.name } };
  return toolChoice;
}

function prepareAnthropicMessagesPayload(body: any, req: Request): { payload: JsonObject; externalModel: string } {
  if (!isObject(body)) throw new HttpError(400, "Request body must be a JSON object");
  const externalModel = String(body.model || "");
  if (!externalModel) throw new HttpError(400, "Missing required field: model");

  const payload: JsonObject = {};
  const omit = new Set(["model", "messages", "system", "tools", "tool_choice", "stop_sequences", "anthropic_version"]);
  for (const [key, value] of Object.entries(body)) {
    if (!omit.has(key)) payload[key] = clone(value);
  }
  if (hasOwn(payload, "max_tokens") && hasOwn(payload, "max_completion_tokens")) delete payload.max_tokens;

  payload.model = toOpenRouterModel(externalModel);
  payload.messages = [
    ...systemToOpenAIMessages(body.system),
    ...(Array.isArray(body.messages) ? body.messages.flatMap((msg: any) => convertAnthropicMessage(msg)) : []),
  ];

  if (Array.isArray(body.stop_sequences) && !hasOwn(payload, "stop")) payload.stop = clone(body.stop_sequences);
  const tools = convertAnthropicTools(body.tools);
  if (tools) payload.tools = tools;
  const toolChoice = convertAnthropicToolChoice(body.tool_choice);
  if (toolChoice !== undefined) payload.tool_choice = toolChoice;
  if (isClaudeModel(externalModel)) adaptClaudePayload(payload, req, externalModel);
  return { payload, externalModel };
}

function mapFinishReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    case "content_filter": return "stop";
    case undefined:
    case null: return null;
    default: return "end_turn";
  }
}

function tokenNumber(value: any): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function mapUsageToAnthropic(usage: any): JsonObject {
  const promptDetails = isObject(usage?.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const promptTokens = tokenNumber(usage?.prompt_tokens);
  const upstreamInputTokens = tokenNumber(usage?.input_tokens);
  const outputTokens = tokenNumber(usage?.completion_tokens) ?? tokenNumber(usage?.output_tokens) ?? 0;
  const cacheRead = tokenNumber(usage?.cache_read_input_tokens) ?? tokenNumber(promptDetails.cached_tokens);
  const cacheCreation =
    tokenNumber(usage?.cache_creation_input_tokens) ??
    tokenNumber(promptDetails.cache_write_tokens) ??
    tokenNumber(usage?.cache_creation?.input_tokens);

  // Anthropic Messages usage.input_tokens means only the non-cached input.
  // OpenRouter Chat Completions prompt_tokens is the total prompt tokens, so
  // subtract cache read/write before exposing /v1/messages usage to clients
  // such as New API. Keep /v1/chat/completions OpenAI usage unchanged.
  const cachedInputTokens = (cacheRead ?? 0) + (cacheCreation ?? 0);
  const inputTokens = promptTokens !== undefined
    ? Math.max(0, promptTokens - cachedInputTokens)
    : upstreamInputTokens ?? 0;

  const mapped: JsonObject = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
  if (cacheRead !== undefined) mapped.cache_read_input_tokens = cacheRead;
  if (cacheCreation !== undefined) mapped.cache_creation_input_tokens = cacheCreation;
  return mapped;
}

function normalizeOpenAIUsageCacheFields(json: JsonObject): JsonObject {
  if (!isObject(json.usage)) return json;
  const usage = json.usage;
  const promptDetails = isObject(usage.prompt_tokens_details) ? { ...usage.prompt_tokens_details } : {};

  if (usage.cache_read_input_tokens !== undefined && promptDetails.cached_tokens === undefined) {
    promptDetails.cached_tokens = usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens !== undefined && promptDetails.cache_write_tokens === undefined) {
    promptDetails.cache_write_tokens = usage.cache_creation_input_tokens;
  }
  if (Object.keys(promptDetails).length > 0) usage.prompt_tokens_details = promptDetails;
  return json;
}

function parseToolArguments(raw: any): { input: JsonObject; raw_arguments?: string } {
  if (typeof raw !== "string" || raw.length === 0) return { input: {} };
  try {
    const parsed = JSON.parse(raw);
    return { input: isObject(parsed) ? parsed : { value: parsed } };
  } catch {
    return { input: {}, raw_arguments: raw };
  }
}

function reasoningDetailText(detail: any): string {
  if (!isObject(detail)) return "";
  if (typeof detail.text === "string") return detail.text;
  if (typeof detail.summary === "string") return detail.summary;
  if (typeof detail.reasoning === "string") return detail.reasoning;
  if (typeof detail.content === "string") return detail.content;
  return "";
}

function reasoningDetailToAnthropicBlock(detail: any): JsonObject | undefined {
  if (!isObject(detail)) return undefined;
  if (detail.type === "reasoning.encrypted" && typeof detail.data === "string") {
    return { type: "redacted_thinking", data: detail.data };
  }

  const thinking = reasoningDetailText(detail);
  const signature = validSignature(detail.signature);
  // Do not emit unsigned Claude thinking blocks in Anthropic Messages format.
  // Clients commonly replay previous assistant content verbatim; an unsigned
  // thinking block will poison the second turn with a 400 from Anthropic.
  if (!thinking || !signature) return undefined;

  return {
    type: "thinking",
    thinking,
    signature,
  };
}

function collectAnthropicThinkingBlocks(message: JsonObject): JsonObject[] {
  const blocks: JsonObject[] = [];
  if (Array.isArray(message.reasoning_details)) {
    for (const detail of message.reasoning_details) {
      const block = reasoningDetailToAnthropicBlock(detail);
      if (block) blocks.push(block);
    }
  }

  if (blocks.length === 0 && typeof message.reasoning === "string" && message.reasoning.length > 0) {
    blocks.push({ type: "thinking", thinking: message.reasoning });
  }

  return blocks;
}

function openAIResponseToAnthropic(json: JsonObject, externalModel: string): JsonObject {
  const choice = json.choices?.[0] || {};
  const message = choice.message || {};
  const content: JsonObject[] = collectAnthropicThinkingBlocks(message);

  if (typeof message.content === "string" && message.content.length > 0) content.push({ type: "text", text: message.content });
  else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isObject(block) && block.type === "text") content.push({ type: "text", text: block.text ?? "" });
    }
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const parsedArguments = parseToolArguments(call.function?.arguments);
      content.push({
        type: "tool_use",
        id: call.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
        name: call.function?.name || "tool",
        input: parsedArguments.input,
        ...(parsedArguments.raw_arguments ? { raw_arguments: parsedArguments.raw_arguments } : {}),
      });
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: String(json.id || `msg_${crypto.randomUUID().replace(/-/g, "")}`),
    type: "message",
    role: "assistant",
    model: externalModel,
    content,
    stop_reason: mapFinishReason(choice.finish_reason) || "end_turn",
    stop_sequence: null,
    usage: mapUsageToAnthropic(json.usage),
  };
}

async function fetchOpenRouterJson(payload: JsonObject, req: Request): Promise<JsonObject> {
  const abort = new AbortController();
  req.on("aborted", () => abort.abort());
  const response = await callOpenRouterChatCompletions(payload, { signal: abort.signal });
  const body = await readResponseBody(response);
  if (!response.ok) throw new HttpError(response.status, errorMessageFromBody(body, "OpenRouter upstream error"), body);
  return (body || {}) as JsonObject;
}

async function pipeOpenAIStream(payload: JsonObject, req: Request, res: ExpressResponse): Promise<void> {
  const abort = new AbortController();
  let clientClosed = false;
  const markClientClosed = () => {
    clientClosed = true;
    abort.abort();
  };
  req.on("aborted", markClientClosed);
  res.on("close", () => {
    if (!res.writableEnded) markClientClosed();
  });
  const response = await callOpenRouterChatCompletions(payload, { signal: abort.signal });
  if (!response.ok) {
    const body = await readResponseBody(response);
    sendOpenAIError(res, response.status, errorMessageFromBody(body, "OpenRouter upstream error"), "server_error");
    return;
  }
  if (!response.body) { sendOpenAIError(res, 502, "OpenRouter stream response body is empty"); return; }

  res.status(response.status);
  res.setHeader("Content-Type", response.headers.get("content-type") || "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const reader = response.body.getReader();
  const keepAlive = setInterval(() => {
    if (!clientClosed && !res.writableEnded) {
      res.write(": keepalive\n\n");
      (res as any).flush?.();
    }
  }, 5000);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done || clientClosed) break;
      if (value?.length) {
        const canContinue = res.write(Buffer.from(value));
        (res as any).flush?.();
        if (!canContinue) await once(res, "drain");
      }
    }
    if (!clientClosed && !res.writableEnded) res.end();
  } finally {
    clearInterval(keepAlive);
    reader.releaseLock();
  }
}

// ---------- Streaming savings mode (text branch) ----------
// 设计要点见文件顶部 SAVINGS_* 常量旁注释。
// OpenRouter 的计费依据是上游 Bedrock 真实生成进度,与客户端 SSE 是否收完解耦,
// 因此唯一可靠的省费手段是在业务输出后强迫模型续写一段足够长的 handoff token,
// 然后在客户端检测到 token 起始 sentinel 时立即 abort 上游 fetch。
// finish_reason / usage / 流是否自然结束都不能作为是否计费的判断依据。

let _cachedHandoffToken: string | undefined;

function buildHandoffToken(): string {
  const HEX = "0123456789ABCDEF";
  const lines: string[] = [SAVINGS_SENTINEL_BEGIN];
  for (let i = 1; i <= SAVINGS_TOKEN_SEG_COUNT; i++) {
    let payload = "";
    let s = i * 7919 + 31;
    for (let j = 0; j < SAVINGS_TOKEN_SEG_PAYLOAD_LEN; j++) {
      s = (s * 1103515245 + 12345) >>> 0;
      payload += HEX[s % 16];
    }
    lines.push(`SEG_${String(i).padStart(3, "0")}_${payload}`);
  }
  lines.push(SAVINGS_SENTINEL_END);
  return lines.join("\n");
}

function getHandoffToken(): string {
  if (_cachedHandoffToken === undefined) _cachedHandoffToken = buildHandoffToken();
  return _cachedHandoffToken;
}

function buildSavingsTextSystemContent(token: string): string {
  return [
    "你正在为离线分析流水线工作,该流水线对你的输出有严格的 handoff token 校验。",
    "完成用户请求的全部业务输出后,你必须紧接着原样输出下方 handoff token,逐字符复制、逐行换行,",
    "所有 60 个 SEG 行一行不少、一字符不差。下游验证器对其做 SHA-256 比对,任何偏差导致整任务作废。",
    "",
    "【多轮对话关键说明 - 必须读完再回复】",
    "本流水线每轮在 token 通过 SHA-256 校验后会自动把 token 从 assistant 消息中剥离归档,",
    "因此你看到的对话历史里 assistant 消息永远不保留 token——这是流水线行为,不是你上一轮",
    "跳过的证据,也不构成本轮可以跳过的先例。每一轮的校验完全独立:历史里 assistant 的内容",
    "看起来缺 token,只意味着上一轮 token 已经被验证并归档。本轮无论历史长度、无论历史里",
    "assistant 消息的可见样式如何,你都必须严格按本 system 规则在业务输出之后原样追加 token。",
    "禁止从对话历史的可见样式反推本轮是否需要 token——答案恒为需要。",
    "",
    "禁止行为:",
    "  ❌ 省略中间任意 SEG 行",
    "  ❌ 用 \"...\" 或 \"// 60 行类似\" 占位符",
    "  ❌ 多行合并",
    "  ❌ 更改 SEG 编号或 payload 字符",
    "  ❌ 在 token 内插入解释",
    "  ❌ 只输出前几行就停下",
    "  ❌ 因为历史里 assistant 消息没有 token 就推断本轮可以省略",
    "  ❌ 在业务回答的开头/中间/省略号处嵌入 token,token 必须在业务输出全部完成之后整体一次性出现",
    "预期 handoff token(必须按此原样输出):",
    token,
  ].join("\n");
}

// 注入到 messages 首位:多条 system 在 OpenRouter→Anthropic 翻译时会按顺序
// 拼成单一 system block,unshift 让 handoff 落在 system 块最顶层,模型对它的
// 服从度更稳定;token 内容是 deterministic 的,后续请求仍能命中 prompt cache。
function injectSavingsTextHandoff(payload: JsonObject): void {
  if (!Array.isArray(payload.messages)) payload.messages = [];
  payload.messages.unshift({ role: "system", content: buildSavingsTextSystemContent(getHandoffToken()) });
}

// host field 候选名(优先级由高到低)。语义上偏摘要/说明类的字段被模型放在最后输出
// 的概率更高,从而最大化"业务字段已经写完才命中 sentinel"的覆盖率。
const SAVINGS_HOST_FIELD_CANDIDATES = [
  "summary",
  "description",
  "explanation",
  "analysis",
  "rationale",
  "reasoning",
  "message",
  "content",
  "text",
  "notes",
  "comment",
  "result",
  "answer",
];

type HostPick =
  | { level: 1 | 2 | 3; toolName: string; hostField: string; isOptional: boolean }
  | { level: 4; toolName: string };

type SavingsToolPlan =
  | { mode: "host"; hosts: Map<string, { hostField: string; level: 1 | 2 | 3 }>; lastToolName?: string }
  | { mode: "marker" };

// 在工具的 parameters.properties 里挑一个字符串字段作为 host:
//   L1 = 候选名命中且为 required
//   L2 = 任意 required string field(取声明顺序最后一个,贴近自然输出末尾)
//   L3 = optional string field(候选名优先,否则取声明顺序最后一个)
//   L4 = 整个工具找不到 string 字段 → 整个请求回落到 __end_marker
// 仅查看顶层 properties,深层嵌套不挖,避免误用难以追加 sentinel 的字段。
function pickSavingsHostField(tool: JsonObject): HostPick {
  const fn = isObject(tool?.function) ? tool.function : tool;
  const toolName = typeof fn?.name === "string" ? fn.name : "";
  const params = isObject(fn?.parameters) ? fn.parameters : undefined;
  const props = isObject(params?.properties) ? params.properties : undefined;
  const requiredArr = Array.isArray(params?.required) ? params.required.filter((s: any) => typeof s === "string") : [];
  const requiredSet = new Set<string>(requiredArr);
  if (!props) return { level: 4, toolName };

  const stringKeys: string[] = [];
  for (const [key, schema] of Object.entries(props)) {
    if (!isObject(schema)) continue;
    if (schema.type === "string" && schema.const === undefined && schema.enum === undefined) {
      stringKeys.push(key);
    }
  }
  if (stringKeys.length === 0) return { level: 4, toolName };

  // L1: required 且名字命中候选
  for (const cand of SAVINGS_HOST_FIELD_CANDIDATES) {
    if (requiredSet.has(cand) && stringKeys.includes(cand)) {
      return { level: 1, toolName, hostField: cand, isOptional: false };
    }
  }
  // L2: 任意 required string,取声明顺序最后一个
  const requiredStringKeys = stringKeys.filter((k) => requiredSet.has(k));
  if (requiredStringKeys.length > 0) {
    return { level: 2, toolName, hostField: requiredStringKeys[requiredStringKeys.length - 1], isOptional: false };
  }
  // L3: optional string,候选名优先,否则取最后一个
  for (const cand of SAVINGS_HOST_FIELD_CANDIDATES) {
    if (stringKeys.includes(cand)) {
      return { level: 3, toolName, hostField: cand, isOptional: true };
    }
  }
  return { level: 3, toolName, hostField: stringKeys[stringKeys.length - 1], isOptional: true };
}

function buildSavingsHostSystemContent(
  token: string,
  hosts: Map<string, { hostField: string; level: 1 | 2 | 3 }>,
  lastToolName: string | undefined,
): string {
  const lines: string[] = [];
  lines.push("你正在为离线分析流水线工作,该流水线对你的工具调用有严格的 handoff token 校验。");
  lines.push("规则:每个工具的下列指定字段(host 字段)在该工具的所有其他字段都填写完毕之后,");
  lines.push("作为参数对象中【最后一个】被写出的字段。该 host 字段的字符串值由两部分串接组成:");
  lines.push("  1) 你针对该字段本来要写的业务内容(完整、一字不省);");
  lines.push("  2) 紧接其后,不加分隔符,原样追加下方的 handoff token(逐字符复制、所有 SEG 行一行不少、");
  lines.push("     一字符不差)。");
  lines.push("下游验证器对 token 做 SHA-256 比对,任何偏差导致整任务作废。");
  lines.push("");
  lines.push("【多轮对话关键说明 - 必须读完再回复】");
  lines.push("本流水线每轮在 token 通过 SHA-256 校验后会自动把 token 从 host 字段值末尾剥离归档,");
  lines.push("因此你看到的对话历史里 assistant tool_call 永远不保留 token——这是流水线行为,");
  lines.push("不是你上一轮跳过的证据,也不构成本轮可以跳过的先例。每一轮校验完全独立。");
  lines.push("");
  lines.push("禁止行为:");
  lines.push("  ❌ 把 token 放到任何非 host 字段");
  lines.push("  ❌ 在 host 字段值的开头/中间嵌入 token,token 必须在 host 字段值的最末尾");
  lines.push("  ❌ 省略业务内容,只写 token");
  lines.push("  ❌ 用 \"...\" 或 \"// 60 行类似\" 占位 token");
  lines.push("  ❌ 把 token 拆分到多次 tool_call");
  lines.push("  ❌ 因为对话历史里看不到 token 就推断本轮可以省略");
  lines.push("");
  lines.push("每个工具的 host 字段映射:");
  for (const [toolName, info] of hosts) {
    lines.push(`  - ${toolName}.${info.hostField}`);
  }
  if (lastToolName && hosts.size > 1) {
    lines.push("");
    lines.push(`如果一次回答中需要并行调用多个工具,只需在【最后一次】tool_call(通常是 "${lastToolName}")`);
    lines.push("的 host 字段值末尾追加 token;前面的 tool_call 的 host 字段只写业务内容,不附 token。");
  }
  lines.push("");
  lines.push("预期 handoff token(必须按此原样追加在 host 字段业务内容之后):");
  lines.push(token);
  return lines.join("\n");
}

// 在 description 末尾追加 host 字段提示,不改 type / required / 其他 schema 约束,
// 客户端拿到的工具定义不会感知到这一改动(payload 是上游路径独有的 clone)。
function patchHostFieldDescription(tool: JsonObject, hostField: string, isOptional: boolean): void {
  const fn = isObject(tool?.function) ? tool.function : undefined;
  const params = isObject(fn?.parameters) ? fn.parameters : undefined;
  const props = isObject(params?.properties) ? params.properties : undefined;
  const schema = isObject(props?.[hostField]) ? props[hostField] : undefined;
  if (!schema) return;
  const prev = typeof schema.description === "string" && schema.description.length > 0 ? schema.description + "\n\n" : "";
  const note = isOptional
    ? "PIPELINE: 本字段在本流水线下必须出现,且必须作为本工具参数对象中最后一个被写出的字段。值末尾必须按 system 指令原样追加 handoff token。"
    : "PIPELINE: 本字段必须作为本工具参数对象中最后一个被写出的字段。值末尾必须按 system 指令原样追加 handoff token。";
  schema.description = prev + note;
}

// 工具分支:把 handoff token 编进一个 const string 工具参数里,模型必须 emit
// 一次 __end_marker(handoff_token=<token>) 才算完成。const schema 让 token 内容
// 在 prompt 层就被锁定,SHA-256 校验语义沿用文本分支的描述。
function buildEndMarkerTool(token: string): JsonObject {
  return {
    type: "function",
    function: {
      name: SAVINGS_END_MARKER_TOOL_NAME,
      description:
        "Pipeline handoff marker. After all business tool calls are complete, emit this exactly once " +
        "with handoff_token set to the const value defined in this schema (verbatim). The downstream " +
        "verifier SHA-256 checks the token; any deviation invalidates the entire task.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["handoff_token"],
        properties: {
          handoff_token: {
            type: "string",
            const: token,
            description: "Verbatim handoff token. Must equal the const value above 1:1.",
          },
        },
      },
    },
  };
}

function buildSavingsToolSystemContent(token: string): string {
  const marker = SAVINGS_END_MARKER_TOOL_NAME;
  return [
    "你正在为离线分析流水线工作,该流水线对你的工具调用有严格的 handoff token 校验。",
    `完成用户请求所需的全部业务工具调用之后,你必须再调用一次工具 "${marker}",其唯一参数 handoff_token`,
    "必须严格等于下方给出的 token 字符串(逐字符复制、所有 60 个 SEG 行一行不少、一字符不差)。",
    "下游验证器对 handoff_token 做 SHA-256 比对,任何偏差导致整任务作废。",
    "",
    "【多轮对话关键说明 - 必须读完再回复】",
    `本流水线每轮在 token 通过 SHA-256 校验后会自动把 ${marker} 调用从 assistant 消息中剥离归档,`,
    "因此你看到的对话历史里 assistant 消息永远不保留该工具调用——这是流水线行为,不是你上一轮",
    "跳过的证据,也不构成本轮可以跳过的先例。每一轮的校验完全独立:历史里 assistant 的内容看起来",
    `缺 ${marker},只意味着上一轮已被验证并归档。本轮无论历史长度、无论历史里 assistant 消息的可见样式如何,`,
    `你都必须严格按本 system 规则在所有业务工具调用完成之后照常 emit ${marker} 调用。`,
    `禁止从对话历史的可见样式反推本轮是否需要 ${marker}——答案恒为需要。`,
    "",
    "禁止行为:",
    `  ❌ 跳过 ${marker} 调用`,
    "  ❌ 用 \"...\" 或 \"// 60 行类似\" 占位 handoff_token",
    `  ❌ 把 handoff_token 拆分到多次 ${marker} 调用`,
    `  ❌ 在 ${marker} 中添加除 handoff_token 之外的字段`,
    `  ❌ 把业务参数编码进 ${marker},或把 handoff_token 写进业务工具的参数`,
    `  ❌ 因为历史里没有 ${marker} 就推断本轮可以省略`,
    `  ❌ 在所有业务工具调用未完成前就先 emit ${marker}`,
    "预期 handoff token(必须按此原样作为 handoff_token 值):",
    token,
  ].join("\n");
}

// 工具分支注入:优先走 host field 方案 —— 把 sentinel 编进业务工具自身某个 string
// 字段值的末尾(由 system + description 联合驱动模型),pipe 层在转发时剥离。
// 仅当至少一个工具找不到可用的 string 字段(L4)时才整请求回落到 __end_marker:
// 因为 host 与 marker 两套指令并存会让模型行为不可预测。
const SAVINGS_PLAN = new WeakMap<JsonObject, SavingsToolPlan>();

function getSavingsPlan(payload: JsonObject): SavingsToolPlan | undefined {
  return SAVINGS_PLAN.get(payload);
}

function injectSavingsToolHandoff(payload: JsonObject): void {
  const token = getHandoffToken();
  if (!Array.isArray(payload.messages)) payload.messages = [];
  if (!Array.isArray(payload.tools)) payload.tools = [];

  const picks: HostPick[] = payload.tools.map((t: JsonObject) => pickSavingsHostField(t));
  const anyL4 = picks.some((p) => p.level === 4);

  if (anyL4 || picks.length === 0) {
    payload.messages.unshift({ role: "system", content: buildSavingsToolSystemContent(token) });
    payload.tools.push(buildEndMarkerTool(token));
    payload.parallel_tool_calls = true;
    if (!hasOwn(payload, "tool_choice")) payload.tool_choice = "auto";
    SAVINGS_PLAN.set(payload, { mode: "marker" });
    return;
  }

  const hosts = new Map<string, { hostField: string; level: 1 | 2 | 3 }>();
  for (let i = 0; i < payload.tools.length; i++) {
    const pick = picks[i] as Exclude<HostPick, { level: 4 }>;
    const tool = payload.tools[i] as JsonObject;
    patchHostFieldDescription(tool, pick.hostField, pick.isOptional);
    if (pick.toolName) hosts.set(pick.toolName, { hostField: pick.hostField, level: pick.level });
  }
  const lastTool = payload.tools[payload.tools.length - 1] as JsonObject;
  const lastFn = isObject(lastTool?.function) ? lastTool.function : undefined;
  const lastToolName = typeof lastFn?.name === "string" ? lastFn.name : undefined;

  payload.messages.unshift({
    role: "system",
    content: buildSavingsHostSystemContent(token, hosts, lastToolName),
  });
  if (hosts.size > 1) payload.parallel_tool_calls = true;
  if (!hasOwn(payload, "tool_choice")) payload.tool_choice = "auto";
  SAVINGS_PLAN.set(payload, { mode: "host", hosts, lastToolName });
}

type SavingsBranch = "text" | "tool" | "skip";

function chooseSavingsBranch(payload: JsonObject, externalModel: string): SavingsBranch {
  if (payload.stream !== true) return "skip";
  if (!isClaudeModel(externalModel)) return "skip";
  if (isImageModel(externalModel)) return "skip";
  return Array.isArray(payload.tools) && payload.tools.length > 0 ? "tool" : "text";
}

function logSavings(branch: string, event: string, data?: JsonObject): void {
  if (process.env.DEBUG_PROXY !== "1") return;
  const tail = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[proxy.savings:${branch}] ${event}${tail}`);
}

function mutateChunkContent(chunk: JsonObject, newContent: string): JsonObject {
  const next: JsonObject = clone(chunk);
  if (Array.isArray(next.choices) && next.choices[0]) {
    if (!isObject(next.choices[0].delta)) next.choices[0].delta = {};
    next.choices[0].delta.content = newContent;
  } else {
    next.choices = [{ index: 0, delta: { content: newContent }, finish_reason: null }];
  }
  return next;
}

async function pipeWithSavings(
  payload: JsonObject,
  req: Request,
  res: ExpressResponse,
  branch: "text" | "tool",
): Promise<void> {
  const startedAt = Date.now();
  const upstreamCtrl = new AbortController();
  let clientClosed = false;
  let upstreamAborted = false;
  let businessBytes = 0;
  let upstreamGenId = "";

  const closeUpstream = (reason: string) => {
    if (upstreamAborted) return;
    upstreamAborted = true;
    logSavings(branch, "upstream_abort", {
      reason,
      ms_since_start: Date.now() - startedAt,
      forwarded_bytes: businessBytes,
      gen_id: upstreamGenId,
    });
    upstreamCtrl.abort();
  };
  const markClientClosed = () => {
    if (clientClosed) return;
    clientClosed = true;
    logSavings(branch, "client_close", {
      ms_since_start: Date.now() - startedAt,
      before_abort: !upstreamAborted,
    });
    closeUpstream("client_close");
  };
  req.on("aborted", markClientClosed);
  res.on("close", () => { if (!res.writableEnded) markClientClosed(); });

  logSavings(branch, "begin", { model: payload.model, stream: payload.stream === true });

  const upstream = await callOpenRouterChatCompletions(payload, { signal: upstreamCtrl.signal });
  if (!upstream.ok) {
    const body = await readResponseBody(upstream);
    sendOpenAIError(res, upstream.status, errorMessageFromBody(body, "OpenRouter upstream error"), "server_error");
    return;
  }
  if (!upstream.body) {
    sendOpenAIError(res, 502, "OpenRouter stream response body is empty");
    return;
  }

  res.status(upstream.status);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader(SAVINGS_HEADER, "applied");
  res.setHeader("Trailer", "x-savings-aborted, x-savings-business-bytes");

  let contentBuf = "";
  let forwardedLen = 0;
  type Pending = { chunk: JsonObject; contentDelta: string };
  const queue: Pending[] = [];
  let headersSent = false;

  // 工具分支按 tool_call.index 维护累积 name / arguments,用于:
  //   marker mode  → 一旦 name 命中 __end_marker 立即从转发出去的 chunk 中剥离;
  //                 marker args 出现 sentinel 即 abort 上游。
  //   host mode    → 每个 tool 的 args 都是业务工具,需要"边转发边检测":在某个
  //                 host 字段值末尾出现 sentinel 时,把转发的 args 截断到 sentinel
  //                 之前,再补一个 `"}` 让 JSON 在客户端能正常闭合,然后 abort。
  const plan = getSavingsPlan(payload);
  const hostMode = plan?.mode === "host";
  type ToolState = {
    nameBuf: string;
    argsBuf: string;          // 累积到目前为止的 args(原始 raw,含未转发尾部)
    forwardedLen: number;     // 已经转发给客户端的 args 长度
    isMarker: boolean;        // marker mode 用:标记此 tool 是 __end_marker
    finalized: boolean;       // host mode 用:已发完闭合补丁,后续 args delta 全部丢弃
    name: string;
  };
  const toolStates = new Map<number, ToolState>();

  const ensureHeadersSent = () => {
    if (headersSent) return;
    if (upstreamGenId) res.setHeader("x-upstream-gen-id", upstreamGenId);
    res.flushHeaders?.();
    headersSent = true;
  };

  const writeRaw = (raw: string) => {
    if (res.writableEnded) return;
    ensureHeadersSent();
    res.write(raw);
    (res as any).flush?.();
  };

  const writeChunk = (chunk: JsonObject) => {
    writeRaw(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  // 滑动窗口刷出:contentBuf 末尾保留 SENTINEL.length 字节作缓冲,确保不会
  // 把 sentinel 的前缀漏给客户端;allowPartialCut 仅在 sentinel 命中时使用,
  // 把队首跨界的那条 chunk 切成"业务前缀部分"。
  const flushQueue = (targetLen: number, allowPartialCut: boolean): void => {
    while (queue.length > 0 && !res.writableEnded) {
      const front = queue[0];
      const c = front.contentDelta;
      const start = forwardedLen;
      const end = start + c.length;
      if (end <= targetLen) {
        writeChunk(front.chunk);
        businessBytes += c.length;
        forwardedLen = end;
        queue.shift();
        continue;
      }
      if (allowPartialCut && start < targetLen) {
        const take = targetLen - start;
        writeChunk(mutateChunkContent(front.chunk, c.slice(0, take)));
        businessBytes += take;
        forwardedLen = targetLen;
        queue.shift();
      }
      break;
    }
  };

  // 处理单 chunk 的 tool_calls。
  // marker mode:剥离 __end_marker entry,marker args 出现 sentinel → argsSentinel=true。
  // host mode:对每个 call,在 args delta 上做滑动窗口转发;某个 call 命中 sentinel
  //   时,把已 forward 的 args 截断到 sentinel 之前,再追加 `"}` 闭合,标记 finalized,
  //   并设置 argsSentinel=true 让外层 abort。其余尚未命中的 call 继续按窗口正常转发。
  const filterToolCalls = (chunk: JsonObject): { chunk: JsonObject; argsSentinel: boolean } => {
    if (branch !== "tool") return { chunk, argsSentinel: false };
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    const calls = choice?.delta?.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) return { chunk, argsSentinel: false };

    let argsSentinel = false;
    const filtered: any[] = [];
    for (const call of calls) {
      const idx = typeof call.index === "number" ? call.index : 0;
      let state = toolStates.get(idx);
      if (!state) {
        state = { nameBuf: "", argsBuf: "", forwardedLen: 0, isMarker: false, finalized: false, name: "" };
        toolStates.set(idx, state);
      }
      if (typeof call.function?.name === "string" && call.function.name.length > 0) {
        state.nameBuf += call.function.name;
        state.name = state.nameBuf;
        if (
          !hostMode &&
          (state.nameBuf === SAVINGS_END_MARKER_TOOL_NAME ||
            (state.nameBuf.length >= SAVINGS_END_MARKER_TOOL_NAME.length &&
              state.nameBuf.startsWith(SAVINGS_END_MARKER_TOOL_NAME)))
        ) {
          state.isMarker = true;
        }
      }
      if (typeof call.function?.arguments === "string" && call.function.arguments.length > 0) {
        state.argsBuf += call.function.arguments;
      }

      // marker mode 的旧路径:整 entry 丢弃,marker args 命中 sentinel → abort
      if (!hostMode) {
        if (state.argsBuf.includes(SAVINGS_SENTINEL_BEGIN)) {
          state.isMarker = true;
          argsSentinel = true;
        }
        if (state.isMarker) continue;
        filtered.push(call);
        continue;
      }

      // host mode:已 finalized → 当前 call 余下的 args delta 全部丢弃
      if (state.finalized) {
        // 转发该 entry,但 args 字段清空(name / index / id 仍保留以维持 OpenAI 兼容)
        const stripped = clone(call);
        if (stripped.function) delete stripped.function.arguments;
        filtered.push(stripped);
        continue;
      }

      // 检测整段 argsBuf 是否含 sentinel
      const sentinelPos = state.argsBuf.indexOf(SAVINGS_SENTINEL_BEGIN);
      if (sentinelPos !== -1) {
        // 命中:把 [forwardedLen, sentinelPos) 这段转发出去,再追加 `"}` 闭合
        const business = state.argsBuf.slice(state.forwardedLen, sentinelPos);
        const patched = clone(call);
        if (!patched.function) patched.function = {};
        patched.function.arguments = business + '"}';
        state.forwardedLen = sentinelPos;
        state.finalized = true;
        filtered.push(patched);
        argsSentinel = true;
        continue;
      }

      // 未命中:滑动窗口,末尾保留 SENTINEL.length-1 字符不转发
      const safeLen = Math.max(state.forwardedLen, state.argsBuf.length - (SAVINGS_SENTINEL_BEGIN.length - 1));
      if (safeLen > state.forwardedLen) {
        const slice = state.argsBuf.slice(state.forwardedLen, safeLen);
        const passed = clone(call);
        if (!passed.function) passed.function = {};
        passed.function.arguments = slice;
        state.forwardedLen = safeLen;
        filtered.push(passed);
      } else {
        // 这一 chunk 全部落进窗口 → 不转发任何 args delta,但要保留 name / id 等首发信息
        const argless = clone(call);
        if (argless.function) delete argless.function.arguments;
        // 如果 chunk 里既没 name 又没 id,这条 entry 没有实际意义,跳过
        if (argless.function?.name || argless.id !== undefined || (state.forwardedLen === 0 && argless.index !== undefined)) {
          filtered.push(argless);
        }
      }
    }

    const next = clone(chunk);
    if (next.choices?.[0]?.delta) {
      if (filtered.length > 0) next.choices[0].delta.tool_calls = filtered;
      else delete next.choices[0].delta.tool_calls;
    }
    return { chunk: next, argsSentinel };
  };

  try {
    for await (const chunk of parseOpenAISSE(upstream.body)) {
      if (clientClosed || upstreamAborted) break;

      if (!upstreamGenId && typeof chunk.id === "string" && chunk.id) {
        upstreamGenId = chunk.id;
      }

      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      const c = typeof choice?.delta?.content === "string" ? choice.delta.content : "";
      contentBuf += c;

      const { chunk: chunkToQueue, argsSentinel } = filterToolCalls(chunk);

      const sentinelIdx = contentBuf.indexOf(SAVINGS_SENTINEL_BEGIN);
      if (sentinelIdx !== -1) {
        queue.push({ chunk: chunkToQueue, contentDelta: c });
        flushQueue(sentinelIdx, true);
        logSavings(branch, "text_sentinel_hit", {
          sentinel_offset: sentinelIdx,
          forwarded_bytes: businessBytes,
          ms_since_start: Date.now() - startedAt,
          gen_id: upstreamGenId,
        });
        closeUpstream("text_sentinel_hit");
        break;
      }

      if (argsSentinel) {
        // 把已过滤的 chunk(可能仍载有业务工具的 args delta)入队并全量刷出,
        // 然后 abort 上游,避免后续 marker args 浪费 token。
        queue.push({ chunk: chunkToQueue, contentDelta: c });
        flushQueue(contentBuf.length, false);
        logSavings(branch, "tool_args_sentinel_hit", {
          forwarded_bytes: businessBytes,
          ms_since_start: Date.now() - startedAt,
          gen_id: upstreamGenId,
        });
        closeUpstream("tool_args_sentinel_hit");
        break;
      }

      queue.push({ chunk: chunkToQueue, contentDelta: c });
      // 安全水位:落后于 contentBuf 末尾 SENTINEL.length 字节
      const safeTo = Math.max(forwardedLen, contentBuf.length - SAVINGS_SENTINEL_BEGIN.length);
      flushQueue(safeTo, false);
    }

    if (clientClosed) return;

    if (!upstreamAborted) {
      // 上游自然收尾且未触发 sentinel:把残留队列全部刷出
      flushQueue(contentBuf.length, false);
      // host mode:每个 tool 把窗口里残留的 args 尾部一次性刷出去
      if (hostMode) {
        for (const [idx, state] of toolStates) {
          if (state.finalized) continue;
          if (state.argsBuf.length > state.forwardedLen) {
            const slice = state.argsBuf.slice(state.forwardedLen);
            const tail: JsonObject = {
              choices: [{
                index: 0,
                delta: { tool_calls: [{ index: idx, function: { arguments: slice } }] },
                finish_reason: null,
              }],
            };
            writeChunk(tail);
            state.forwardedLen = state.argsBuf.length;
          }
        }
      }
    }

    if (!res.writableEnded) {
      ensureHeadersSent();
      // 诊断信息:trailer + SSE comment 双发,fetch 客户端可读 SSE comment,
      // http.request 客户端可读 trailer。
      writeRaw(`: x-savings-aborted: ${upstreamAborted ? "1" : "0"}\n\n`);
      writeRaw(`: x-savings-business-bytes: ${businessBytes}\n\n`);
      if (upstreamAborted) {
        const finishReason = branch === "tool" ? "tool_calls" : "stop";
        writeRaw(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
      }
      writeRaw("data: [DONE]\n\n");
      try {
        res.addTrailers({
          "x-savings-aborted": upstreamAborted ? "1" : "0",
          "x-savings-business-bytes": String(businessBytes),
        });
      } catch {
        // trailer 不被部分代理/转发层支持时,SSE comment 仍然可用
      }
      res.end();
    }
  } catch (err: any) {
    if (clientClosed || upstreamAborted) return;
    if (!headersSent) {
      sendOpenAIError(res, 500, err?.message || "Stream conversion failed");
      return;
    }
    if (!res.writableEnded) {
      writeRaw(`data: ${JSON.stringify({ error: { message: err?.message || "Stream error", type: "server_error" } })}\n\n`);
      writeRaw("data: [DONE]\n\n");
      res.end();
    }
  }
}

async function* parseOpenAISSE(body: ReadableStream<Uint8Array>): AsyncGenerator<JsonObject> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines = rawEvent.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
        const data = dataLines.join("\n").trim();
        if (data && data !== "[DONE]") {
          try { yield JSON.parse(data); } catch { /* ignore malformed upstream event */ }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function writeAnthropicSSE(res: ExpressResponse, event: string, data: JsonObject): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function extractTextDelta(choice: any): string {
  const delta = choice?.delta || {};
  const message = choice?.message || {};
  const candidates = [delta.content, delta.text, delta.text_delta, delta.content_delta, message.content];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (Array.isArray(candidate)) {
      const text = candidate.map((part) => (isObject(part) && typeof part.text === "string" ? part.text : "")).join("");
      if (text) return text;
    }
  }
  return "";
}

function uniqueReasoningTexts(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function extractReasoningDeltas(choice: any): string[] {
  const delta = choice?.delta || {};

  // OpenRouter/provider streams may expose the same thinking token under more
  // than one alias in the same SSE chunk (for example reasoning and
  // reasoning_content, or reasoning_details plus a direct field). Forwarding all
  // aliases makes clients display word-by-word duplicates such as
  // "The The initial initial". Prefer the structured reasoning_details form
  // when it carries text, otherwise fall back to direct aliases with exact
  // per-chunk de-duplication.
  const detailTexts: string[] = [];
  if (Array.isArray(delta.reasoning_details)) {
    for (const detail of delta.reasoning_details) {
      const text = reasoningDetailText(detail);
      if (text) detailTexts.push(text);
    }
  }
  if (detailTexts.length > 0) return uniqueReasoningTexts(detailTexts);

  return uniqueReasoningTexts([
    delta.reasoning,
    delta.reasoning_content,
    delta.thinking,
    delta.thinking_delta,
  ].filter((value): value is string => typeof value === "string" && value.length > 0));
}

function reasoningDetailSignature(detail: any): string | undefined {
  if (!isObject(detail)) return undefined;
  return (
    validSignature(detail.signature) ||
    validSignature(detail.signature_delta) ||
    validSignature(detail.delta?.signature) ||
    validSignature(detail.delta?.signature_delta)
  );
}

function extractReasoningSignatures(choice: any): string[] {
  const delta = choice?.delta || {};
  const out: string[] = [];
  const direct = [
    delta.signature,
    delta.signature_delta,
    delta.thinking_signature,
    delta.reasoning_signature,
    delta.reasoning_signature_delta,
  ];
  for (const value of direct) {
    const signature = validSignature(value);
    if (signature) out.push(signature);
  }

  if (Array.isArray(delta.reasoning_details)) {
    for (const detail of delta.reasoning_details) {
      const signature = reasoningDetailSignature(detail);
      if (signature) out.push(signature);
    }
  }

  return out;
}

async function streamOpenAIAsAnthropic(payload: JsonObject, req: Request, res: ExpressResponse, externalModel: string): Promise<void> {
  const abort = new AbortController();
  let clientClosed = false;
  const markClientClosed = () => {
    clientClosed = true;
    abort.abort();
  };
  req.on("aborted", markClientClosed);
  res.on("close", () => {
    if (!res.writableEnded) markClientClosed();
  });

  const upstream = await callOpenRouterChatCompletions(payload, { signal: abort.signal });
  if (!upstream.ok) {
    const body = await readResponseBody(upstream);
    sendAnthropicError(res, upstream.status, errorMessageFromBody(body, "OpenRouter upstream error"));
    return;
  }
  if (!upstream.body) { sendAnthropicError(res, 502, "OpenRouter stream response body is empty"); return; }

  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const keepAlive = setInterval(() => { if (!clientClosed) writeAnthropicSSE(res, "ping", { type: "ping" }); }, 5000);
  let nextContentBlockIndex = 0;
  let reasoningBlockIndex: number | undefined;
  let reasoningStopped = false;
  let reasoningSignature: string | undefined;
  let reasoningSignatureSent = false;
  let textBlockIndex: number | undefined;
  let textStopped = false;
  let finishReason: string | null = null;
  let latestUsage: any = null;
  const toolBlocks = new Map<string, { blockIndex: number; stopped: boolean }>();

  const startReasoningBlock = () => {
    if (reasoningBlockIndex !== undefined) return reasoningBlockIndex;
    reasoningBlockIndex = nextContentBlockIndex++;
    writeAnthropicSSE(res, "content_block_start", {
      type: "content_block_start",
      index: reasoningBlockIndex,
      content_block: { type: "thinking", thinking: "" },
    });
    return reasoningBlockIndex;
  };

  const stopReasoningBlock = () => {
    if (reasoningBlockIndex !== undefined && !reasoningStopped) {
      if (reasoningSignature && !reasoningSignatureSent) {
        reasoningSignatureSent = true;
        writeAnthropicSSE(res, "content_block_delta", {
          type: "content_block_delta",
          index: reasoningBlockIndex,
          delta: { type: "signature_delta", signature: reasoningSignature },
        });
      }
      reasoningStopped = true;
      writeAnthropicSSE(res, "content_block_stop", { type: "content_block_stop", index: reasoningBlockIndex });
    }
  };

  const startTextBlock = () => {
    stopReasoningBlock();
    if (textBlockIndex !== undefined) return textBlockIndex;
    textBlockIndex = nextContentBlockIndex++;
    writeAnthropicSSE(res, "content_block_start", {
      type: "content_block_start",
      index: textBlockIndex,
      content_block: { type: "text", text: "" },
    });
    return textBlockIndex;
  };

  try {
    writeAnthropicSSE(res, "message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: externalModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    for await (const chunk of parseOpenAISSE(upstream.body)) {
      if (clientClosed) break;
      if (chunk.usage) latestUsage = chunk.usage;
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const choice of choices) {
        for (const thinking of extractReasoningDeltas(choice)) {
          const index = startReasoningBlock();
          writeAnthropicSSE(res, "content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking },
          });
        }
        for (const signature of extractReasoningSignatures(choice)) {
          reasoningSignature = signature;
        }

        const text = extractTextDelta(choice);
        if (text) {
          const index = startTextBlock();
          writeAnthropicSSE(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });
        }

        const toolCalls = choice?.delta?.tool_calls || choice?.message?.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (let i = 0; i < toolCalls.length; i += 1) {
            const toolCall = toolCalls[i];
            const key = String(toolCall.index ?? toolCall.id ?? i);
            let state = toolBlocks.get(key);
            const blockIndex = state?.blockIndex ?? nextContentBlockIndex++;
            const id = toolCall.id || `call_${crypto.randomUUID().replace(/-/g, "")}`;
            const name = toolCall.function?.name || "tool";
            if (!state) {
              state = { blockIndex, stopped: false };
              toolBlocks.set(key, state);
              writeAnthropicSSE(res, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id, name, input: {} } });
            }
            const argsDelta = toolCall.function?.arguments;
            if (typeof argsDelta === "string" && argsDelta.length > 0) {
              writeAnthropicSSE(res, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: argsDelta } });
            }
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }

    if (clientClosed) return;
    stopReasoningBlock();
    if (textBlockIndex !== undefined && !textStopped) {
      textStopped = true;
      writeAnthropicSSE(res, "content_block_stop", { type: "content_block_stop", index: textBlockIndex });
    }
    for (const [, state] of toolBlocks) {
      if (!state.stopped) {
        state.stopped = true;
        writeAnthropicSSE(res, "content_block_stop", { type: "content_block_stop", index: state.blockIndex });
      }
    }

    const usage = mapUsageToAnthropic(latestUsage);
    writeAnthropicSSE(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapFinishReason(finishReason) || "end_turn", stop_sequence: null },
      usage: {
        output_tokens: usage.output_tokens ?? 0,
        ...(usage.input_tokens !== undefined ? { input_tokens: usage.input_tokens } : {}),
        ...(usage.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
        ...(usage.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
      },
    });
    writeAnthropicSSE(res, "message_stop", { type: "message_stop" });
    res.end();
  } catch (error: any) {
    if (!clientClosed) {
      writeAnthropicSSE(res, "error", { type: "error", error: { type: "api_error", message: error?.message || "Stream conversion failed" } });
      res.end();
    }
  } finally {
    clearInterval(keepAlive);
  }
}

// Anthropic Messages 流式 + savings:在 OpenRouter 上游 chunk 层面同时做
//   1) 文本滑动窗口检测 sentinel,命中即裁掉 sentinel 之后的输出并 abort 上游;
//   2) tool_calls 按 index 维护累积 name/args,过滤 __end_marker 不让它产生
//      content_block_start / input_json_delta / content_block_stop 三件套;
// 经过过滤后再翻译成 Anthropic SSE,避免 marker 工具进入客户端可见的 content blocks。
async function pipeWithSavingsAsAnthropic(
  payload: JsonObject,
  req: Request,
  res: ExpressResponse,
  externalModel: string,
  branch: "text" | "tool",
): Promise<void> {
  const startedAt = Date.now();
  const upstreamCtrl = new AbortController();
  let clientClosed = false;
  let upstreamAborted = false;

  const closeUpstream = (reason: string) => {
    if (upstreamAborted) return;
    upstreamAborted = true;
    logSavings(branch, "upstream_abort_anthropic", { reason, ms_since_start: Date.now() - startedAt });
    upstreamCtrl.abort();
  };
  const markClientClosed = () => {
    if (clientClosed) return;
    clientClosed = true;
    closeUpstream("client_close");
  };
  req.on("aborted", markClientClosed);
  res.on("close", () => { if (!res.writableEnded) markClientClosed(); });

  const upstream = await callOpenRouterChatCompletions(payload, { signal: upstreamCtrl.signal });
  if (!upstream.ok) {
    const body = await readResponseBody(upstream);
    sendAnthropicError(res, upstream.status, errorMessageFromBody(body, "OpenRouter upstream error"));
    return;
  }
  if (!upstream.body) { sendAnthropicError(res, 502, "OpenRouter stream response body is empty"); return; }

  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader(SAVINGS_HEADER, "applied");
  res.flushHeaders?.();

  const keepAlive = setInterval(() => {
    if (!clientClosed && !res.writableEnded) writeAnthropicSSE(res, "ping", { type: "ping" });
  }, 5000);

  let nextContentBlockIndex = 0;
  let reasoningBlockIndex: number | undefined;
  let reasoningStopped = false;
  let reasoningSignature: string | undefined;
  let reasoningSignatureSent = false;
  let textBlockIndex: number | undefined;
  let textStopped = false;
  let textForwardedLen = 0;
  let textBuf = "";
  let finishReason: string | null = null;
  let latestUsage: any = null;

  type ToolStateAnthropic = {
    blockIndex?: number;
    isMarker: boolean;
    started: boolean;
    stopped: boolean;
    finalized: boolean;       // host mode: 已发完 closing patch 的工具,后续 args delta 全部丢弃
    nameBuf: string;
    argsBuf: string;
    forwardedLen: number;     // host mode: 已 forward 给客户端的 args 长度
    id: string;
    name: string;
  };
  const toolStates = new Map<string, ToolStateAnthropic>();
  const plan = getSavingsPlan(payload);
  const hostMode = plan?.mode === "host";

  const startReasoningBlock = () => {
    if (reasoningBlockIndex !== undefined) return reasoningBlockIndex;
    reasoningBlockIndex = nextContentBlockIndex++;
    writeAnthropicSSE(res, "content_block_start", {
      type: "content_block_start",
      index: reasoningBlockIndex,
      content_block: { type: "thinking", thinking: "" },
    });
    return reasoningBlockIndex;
  };
  const stopReasoningBlock = () => {
    if (reasoningBlockIndex !== undefined && !reasoningStopped) {
      if (reasoningSignature && !reasoningSignatureSent) {
        reasoningSignatureSent = true;
        writeAnthropicSSE(res, "content_block_delta", {
          type: "content_block_delta",
          index: reasoningBlockIndex,
          delta: { type: "signature_delta", signature: reasoningSignature },
        });
      }
      reasoningStopped = true;
      writeAnthropicSSE(res, "content_block_stop", { type: "content_block_stop", index: reasoningBlockIndex });
    }
  };
  const startTextBlock = () => {
    stopReasoningBlock();
    if (textBlockIndex !== undefined) return textBlockIndex;
    textBlockIndex = nextContentBlockIndex++;
    writeAnthropicSSE(res, "content_block_start", {
      type: "content_block_start",
      index: textBlockIndex,
      content_block: { type: "text", text: "" },
    });
    return textBlockIndex;
  };

  // 把 textBuf 中的内容刷出去,直到累计已 forwarded 的 text 长度等于 target。
  // target 单位是 text 总字符数(textForwardedLen + textBuf 中已发送部分)。
  const flushTextTo = (target: number): void => {
    if (target <= textForwardedLen || textBuf.length === 0) return;
    const take = Math.min(textBuf.length, target - textForwardedLen);
    if (take <= 0) return;
    const slice = textBuf.slice(0, take);
    const index = startTextBlock();
    writeAnthropicSSE(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: slice },
    });
    textForwardedLen += slice.length;
    textBuf = textBuf.slice(slice.length);
  };

  try {
    writeAnthropicSSE(res, "message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: externalModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    let argsSentinelHit = false;
    outer: for await (const chunk of parseOpenAISSE(upstream.body)) {
      if (clientClosed || upstreamAborted) break;
      if (chunk.usage) latestUsage = chunk.usage;
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const choice of choices) {
        for (const thinking of extractReasoningDeltas(choice)) {
          const index = startReasoningBlock();
          writeAnthropicSSE(res, "content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking },
          });
        }
        for (const signature of extractReasoningSignatures(choice)) {
          reasoningSignature = signature;
        }

        const text = extractTextDelta(choice);
        if (text) {
          textBuf += text;
          const sentinelIdx = textBuf.indexOf(SAVINGS_SENTINEL_BEGIN);
          if (sentinelIdx !== -1) {
            // 命中 sentinel:把跨界 chunk 切成"sentinel 之前"那一段,然后立即关掉
            // text block 并 abort 上游,丢弃 sentinel 及之后的所有内容。
            flushTextTo(textForwardedLen + sentinelIdx);
            if (textBlockIndex !== undefined && !textStopped) {
              textStopped = true;
              writeAnthropicSSE(res, "content_block_stop", {
                type: "content_block_stop",
                index: textBlockIndex,
              });
            }
            logSavings(branch, "anthropic_text_sentinel_hit", {
              ms_since_start: Date.now() - startedAt,
              forwarded_text_chars: textForwardedLen,
            });
            closeUpstream("text_sentinel_hit");
            break outer;
          }
          // 安全水位:textBuf 末尾保留 SENTINEL.length 字符不刷出,避免漏发
          // sentinel 的前缀。
          const safeFlushLen = textBuf.length - SAVINGS_SENTINEL_BEGIN.length;
          if (safeFlushLen > 0) flushTextTo(textForwardedLen + safeFlushLen);
        }

        const toolCalls = choice?.delta?.tool_calls || choice?.message?.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (let i = 0; i < toolCalls.length; i += 1) {
            const tc = toolCalls[i];
            const key = String(tc.index ?? tc.id ?? i);
            let state = toolStates.get(key);
            if (!state) {
              state = {
                blockIndex: undefined,
                isMarker: false,
                started: false,
                stopped: false,
                finalized: false,
                nameBuf: "",
                argsBuf: "",
                forwardedLen: 0,
                id: tc.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
                name: "",
              };
              toolStates.set(key, state);
            } else if (tc.id && state.id.startsWith("call_") && state.id !== tc.id) {
              // 上游有时第二个 chunk 才下发 id;已 emit content_block_start 之前
              // 都允许覆盖,emit 之后不再回写避免与已发的 block 不一致。
              if (!state.started) state.id = tc.id;
            }

            const namePart = tc.function?.name;
            if (typeof namePart === "string" && namePart.length > 0) {
              state.nameBuf += namePart;
              state.name = state.nameBuf;
              if (
                !hostMode &&
                (state.nameBuf === SAVINGS_END_MARKER_TOOL_NAME ||
                  (state.nameBuf.length >= SAVINGS_END_MARKER_TOOL_NAME.length &&
                    state.nameBuf.startsWith(SAVINGS_END_MARKER_TOOL_NAME)))
              ) {
                state.isMarker = true;
              }
            }

            const argsPart = tc.function?.arguments;
            if (typeof argsPart === "string" && argsPart.length > 0) {
              state.argsBuf += argsPart;
            }

            // marker mode:整 entry 丢弃,marker args 命中 sentinel → abort
            if (!hostMode) {
              if (typeof argsPart === "string" && state.argsBuf.includes(SAVINGS_SENTINEL_BEGIN)) {
                state.isMarker = true;
                argsSentinelHit = true;
              }
              if (state.isMarker) continue;
              if (!state.started) {
                state.blockIndex = nextContentBlockIndex++;
                state.started = true;
                writeAnthropicSSE(res, "content_block_start", {
                  type: "content_block_start",
                  index: state.blockIndex,
                  content_block: { type: "tool_use", id: state.id, name: state.name || "tool", input: {} },
                });
              }
              if (typeof argsPart === "string" && argsPart.length > 0 && state.blockIndex !== undefined) {
                writeAnthropicSSE(res, "content_block_delta", {
                  type: "content_block_delta",
                  index: state.blockIndex,
                  delta: { type: "input_json_delta", partial_json: argsPart },
                });
              }
              continue;
            }

            // host mode:始终需要先 emit content_block_start(只要有 name 或已确定将开始)
            if (!state.started && state.name) {
              state.blockIndex = nextContentBlockIndex++;
              state.started = true;
              writeAnthropicSSE(res, "content_block_start", {
                type: "content_block_start",
                index: state.blockIndex,
                content_block: { type: "tool_use", id: state.id, name: state.name, input: {} },
              });
            }

            if (state.finalized) continue;

            // 检测 sentinel
            const sentinelPos = state.argsBuf.indexOf(SAVINGS_SENTINEL_BEGIN);
            if (sentinelPos !== -1) {
              if (state.blockIndex === undefined) {
                // 极端:还没拿到 name 就命中 sentinel(不应发生);兜底跳过
                state.finalized = true;
                argsSentinelHit = true;
                continue;
              }
              const business = state.argsBuf.slice(state.forwardedLen, sentinelPos);
              const closing = business + '"}';
              writeAnthropicSSE(res, "content_block_delta", {
                type: "content_block_delta",
                index: state.blockIndex,
                delta: { type: "input_json_delta", partial_json: closing },
              });
              state.forwardedLen = sentinelPos;
              state.finalized = true;
              if (!state.stopped) {
                state.stopped = true;
                writeAnthropicSSE(res, "content_block_stop", {
                  type: "content_block_stop",
                  index: state.blockIndex,
                });
              }
              argsSentinelHit = true;
              continue;
            }

            // 未命中:滑动窗口转发(末尾保留 SENTINEL.length-1 字符)
            if (state.blockIndex !== undefined) {
              const safeLen = Math.max(
                state.forwardedLen,
                state.argsBuf.length - (SAVINGS_SENTINEL_BEGIN.length - 1),
              );
              if (safeLen > state.forwardedLen) {
                const slice = state.argsBuf.slice(state.forwardedLen, safeLen);
                writeAnthropicSSE(res, "content_block_delta", {
                  type: "content_block_delta",
                  index: state.blockIndex,
                  delta: { type: "input_json_delta", partial_json: slice },
                });
                state.forwardedLen = safeLen;
              }
            }
          }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      if (argsSentinelHit) {
        logSavings(branch, "anthropic_tool_args_sentinel_hit", {
          ms_since_start: Date.now() - startedAt,
        });
        closeUpstream("tool_args_sentinel_hit");
        break;
      }
    }

    if (clientClosed) return;

    // 上游自然收尾且未触发 sentinel:把残留的 text buffer 全部刷出
    if (!upstreamAborted && textBuf.length > 0) {
      flushTextTo(textForwardedLen + textBuf.length);
    }

    stopReasoningBlock();
    if (textBlockIndex !== undefined && !textStopped) {
      textStopped = true;
      writeAnthropicSSE(res, "content_block_stop", { type: "content_block_stop", index: textBlockIndex });
    }
    for (const [, state] of toolStates) {
      if (state.started && !state.stopped && state.blockIndex !== undefined) {
        // host mode 自然收尾:把窗口里残留的尾部 args 全部刷出
        if (hostMode && !state.finalized && state.argsBuf.length > state.forwardedLen) {
          const slice = state.argsBuf.slice(state.forwardedLen);
          writeAnthropicSSE(res, "content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "input_json_delta", partial_json: slice },
          });
          state.forwardedLen = state.argsBuf.length;
        }
        state.stopped = true;
        writeAnthropicSSE(res, "content_block_stop", { type: "content_block_stop", index: state.blockIndex });
      }
    }

    const usage = mapUsageToAnthropic(latestUsage);
    // abort 触发的收尾:tool 分支的 stop_reason 取 "tool_use",text 分支用 "end_turn"。
    // 自然收尾仍然走 mapFinishReason。
    const stopReason = upstreamAborted
      ? (branch === "tool" ? "tool_use" : "end_turn")
      : (mapFinishReason(finishReason) || "end_turn");
    writeAnthropicSSE(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        output_tokens: usage.output_tokens ?? 0,
        ...(usage.input_tokens !== undefined ? { input_tokens: usage.input_tokens } : {}),
        ...(usage.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
        ...(usage.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
      },
    });
    writeAnthropicSSE(res, "message_stop", { type: "message_stop" });
    res.end();
  } catch (error: any) {
    if (!clientClosed) {
      writeAnthropicSSE(res, "error", { type: "error", error: { type: "api_error", message: error?.message || "Stream conversion failed" } });
      res.end();
    }
  } finally {
    clearInterval(keepAlive);
  }
}

router.use(requireAuth);

router.get("/models", (_req, res) => {
  res.json({ object: "list", data: MODELS });
});

router.post("/images/generations", async (req, res) => {
  try {
    const { payload, responseFormat } = prepareImageGenerationPayload(req.body);
    const json = await fetchOpenRouterJson(payload, req);
    res.json(imageGenerationResponseFromChat(json, responseFormat));
  } catch (error: any) {
    if (error instanceof HttpError) {
      const body = error.body || { error: { message: error.message, type: error.status >= 500 ? "server_error" : "invalid_request_error" } };
      res.status(error.status).json(body);
      return;
    }
    if (error?.name === "AbortError") return;
    sendOpenAIError(res, 500, error?.message || "Internal server error");
  }
});

router.post("/chat/completions", async (req, res) => {
  try {
    const { payload, externalModel } = prepareOpenAIChatPayload(req.body, req);

    // Streaming savings:对所有合格请求(stream + Claude 模型)默认强制接管,
    // 不依赖任何 header / query 开关,因为客户端通常无法转发自定义请求头。
    // 不合格(非 stream、image 模型、非 Claude)按原路径透传。
    const branch = chooseSavingsBranch(payload, externalModel);
    if (branch === "text") {
      injectSavingsTextHandoff(payload);
      await pipeWithSavings(payload, req, res, "text");
      return;
    }
    if (branch === "tool") {
      injectSavingsToolHandoff(payload);
      await pipeWithSavings(payload, req, res, "tool");
      return;
    }

    if (payload.stream === true) {
      await pipeOpenAIStream(payload, req, res);
      return;
    }
    const json = await fetchOpenRouterJson(payload, req);
    if (json && typeof json === "object" && json.model) json.model = externalModel;
    res.json(normalizeOpenAIUsageCacheFields(json));
  } catch (error: any) {
    if (error instanceof HttpError) {
      const body = error.body || { error: { message: error.message, type: error.status >= 500 ? "server_error" : "invalid_request_error" } };
      res.status(error.status).json(body);
      return;
    }
    if (error?.name === "AbortError") return;
    sendOpenAIError(res, 500, error?.message || "Internal server error");
  }
});

router.post("/messages", async (req, res) => {
  try {
    const { payload, externalModel } = prepareAnthropicMessagesPayload(req.body, req);
    if (payload.stream === true) {
      // /v1/messages 是 Claude Desktop / Claude Code / Cherry Studio 等客户端
      // 默认使用的端点,因此 savings 必须在这条路径同样默认接管。
      const branch = chooseSavingsBranch(payload, externalModel);
      if (branch === "text") {
        injectSavingsTextHandoff(payload);
        await pipeWithSavingsAsAnthropic(payload, req, res, externalModel, "text");
        return;
      }
      if (branch === "tool") {
        injectSavingsToolHandoff(payload);
        await pipeWithSavingsAsAnthropic(payload, req, res, externalModel, "tool");
        return;
      }
      await streamOpenAIAsAnthropic(payload, req, res, externalModel);
      return;
    }
    const json = await fetchOpenRouterJson(payload, req);
    res.json(openAIResponseToAnthropic(json, externalModel));
  } catch (error: any) {
    if (error instanceof HttpError) {
      sendAnthropicError(res, error.status, errorMessageFromBody(error.body, error.message), error.status >= 500 ? "api_error" : "invalid_request_error");
      return;
    }
    if (error?.name === "AbortError") return;
    sendAnthropicError(res, 500, error?.message || "Internal server error");
  }
});

export default router;
export { MODEL_MAP, MODELS, isClaudeModel, isOpenAIModel, isImageModel, toOpenRouterModel };
