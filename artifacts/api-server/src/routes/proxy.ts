import { Router } from "express";
import type { NextFunction, Request, Response as ExpressResponse } from "express";
import { once } from "node:events";
import crypto from "node:crypto";

const router = Router();
const PROXY_API_KEY = "tzcnb";

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

function extractReasoningDeltas(choice: any): string[] {
  const delta = choice?.delta || {};
  const out: string[] = [];
  const direct = [delta.reasoning, delta.reasoning_content, delta.thinking, delta.thinking_delta];
  for (const value of direct) {
    if (typeof value === "string" && value.length > 0) out.push(value);
  }

  if (Array.isArray(delta.reasoning_details)) {
    for (const detail of delta.reasoning_details) {
      const text = reasoningDetailText(detail);
      if (text) out.push(text);
    }
  }

  return out;
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
