目标：在 Replit pnpm monorepo 中建立基于 Replit OpenRouter 上游的 OpenAI + Anthropic 双兼容反代 API，并发布。

核心目标：
- 对外提供 OpenAI 兼容接口：
  - GET /v1/models
  - POST /v1/chat/completions
- 对外提供 Anthropic Messages 兼容接口：
  - POST /v1/messages
- 但上游统一只走 Replit OpenRouter 的 OpenAI Chat Completions 端点。
- 不直连 OpenAI 官方 API。
- 不直连 Anthropic 官方 API。
- 不使用 Anthropic SDK。
- 不向 Replit OpenRouter 上游请求 /v1/messages。
- 不向用户索要任何 API Key。
- 外部访问本反代 API 的固定 API Key 为：tzcnb。

【环境准备】

在 Replit Integrations 中添加 OpenRouter / AI Gateway / Replit AI 相关集成，使用 Replit 自动注入的 OpenRouter 上游环境变量。

优先读取以下环境变量：
- AI_INTEGRATIONS_OPENROUTER_BASE_URL
- AI_INTEGRATIONS_OPENROUTER_API_KEY

如果 Replit 实际注入的变量名不同，请自动检查 process.env 中与以下关键词相关的变量并适配：
- OPENROUTER
- AI_INTEGRATIONS
- REPLIT
- AI_GATEWAY

例如可搜索：
- 包含 OPENROUTER 且包含 BASE_URL 的变量
- 包含 OPENROUTER 且包含 API_KEY 的变量
- 包含 AI_INTEGRATIONS 且包含 BASE_URL 的变量
- 包含 AI_INTEGRATIONS 且包含 API_KEY 的变量

重要要求：
- 不要向用户索要任何上游 API Key。
- 不要通过 requestEnvVar 请求 PROXY_API_KEY。
- 不要问用户 PROXY_API_KEY 要设置成什么。
- 直接在服务端将 PROXY_API_KEY 固定为字符串：tzcnb。
- 外部访问本反代 API 时，Authorization: Bearer tzcnb 或 x-api-key: tzcnb 都必须通过。
- 任何其他 token 都返回 401。
- 没有 token 返回 401。
- SESSION_SECRET 已存在则跳过，不存在时按项目现有机制处理。

【上游端点强约束：Replit OpenRouter 只走 OpenAI Chat Completions】

重要：
- Replit 的 OpenRouter 集成上游不要调用 /v1/messages。
- 不要假设 AI_INTEGRATIONS_OPENROUTER_BASE_URL 暴露 Anthropic Messages API。
- 不要向 Replit OpenRouter 上游发送 POST /v1/messages。
- 不要使用 @anthropic-ai/sdk 调 Replit OpenRouter。
- 不要使用 anthropic.messages.create() 调 Replit OpenRouter。
- 不要根据 model 是 claude- 就切换到 Anthropic Messages 上游。
- claude- 模型也必须走 OpenRouter Chat Completions。

本服务的 /v1/messages 只是“对外兼容层”：
- 用户可以请求本服务：POST /v1/messages
- 但服务端内部必须把 Anthropic Messages 请求转换成 OpenAI Chat Completions 格式
- 然后只请求 OpenRouter 上游 Chat Completions
- 再把 OpenRouter 的 OpenAI Chat Completions 响应转换回 Anthropic Message 格式

上游唯一允许的生成接口：
POST ${OPENROUTER_BASE_URL}/chat/completions

baseURL 规范化规则：
- 如果 AI_INTEGRATIONS_OPENROUTER_BASE_URL 已经包含 /v1：
  - 使用：${AI_INTEGRATIONS_OPENROUTER_BASE_URL}/chat/completions
- 如果 AI_INTEGRATIONS_OPENROUTER_BASE_URL 已经包含 /api/v1：
  - 使用：${AI_INTEGRATIONS_OPENROUTER_BASE_URL}/chat/completions
- 如果 AI_INTEGRATIONS_OPENROUTER_BASE_URL 不包含 /v1 或 /api/v1：
  - 自动规范化为：${AI_INTEGRATIONS_OPENROUTER_BASE_URL}/v1/chat/completions
  - 或根据 Replit 实际注入值检测并避免重复 /v1

严禁出现：
- ${AI_INTEGRATIONS_OPENROUTER_BASE_URL}/messages
- ${AI_INTEGRATIONS_OPENROUTER_BASE_URL}/v1/messages
- ${AI_INTEGRATIONS_OPENROUTER_BASE_URL}/api/v1/messages
- https://openrouter.ai/api/v1/messages
- anthropic.messages.create(...)
- client.messages.create(...)
- new Anthropic(...)

实现建议：
- 写一个统一函数 callOpenRouterChatCompletions(payload, options)。
- /v1/chat/completions 和 /v1/messages 两个入口最终都只能调用这个函数。
- 该函数内部使用 fetch 调用 OpenRouter Chat Completions。
- 优先使用 fetch，而不是 OpenAI SDK，因为 OpenRouter 扩展字段如 cache_control、reasoning、verbosity、provider 不能被类型定义过滤。
- 如果使用 OpenAI SDK，必须确认非标准字段可以通过 extra_body / extraBody 或等价机制完整透传。
- 如果 SDK 无法完整透传非标准字段，必须改为 fetch。

【文件修改：artifacts/api-server/src/routes/proxy.ts】

建立或修改 proxy.ts，实现以下路由：

1. GET /v1/models
2. POST /v1/chat/completions
3. POST /v1/messages

【鉴权】

所有 /v1/* 路由都必须验证：

Authorization: Bearer tzcnb

或：

x-api-key: tzcnb

鉴权函数要求：
- 支持 Authorization header，格式 Bearer <token>
- 支持 x-api-key header
- token 必须严格等于 tzcnb
- 失败返回：
  - status: 401
  - JSON: { "error": { "message": "Unauthorized", "type": "invalid_request_error" } }

不要读取用户提供的 PROXY_API_KEY。
不要调用 requestEnvVar 请求 PROXY_API_KEY。
可以定义：

const PROXY_API_KEY = "tzcnb";

【模型列表】

GET /v1/models：

验证 token 后返回固定模型列表。

对外模型 ID：

OpenAI：
- gpt-5.5

Anthropic：
- claude-opus-4-7
- claude-opus-4-6
- claude-sonnet-4-6
- claude-haiku-4-5

返回 OpenAI models 格式：

{
  "object": "list",
  "data": [
    {
      "id": "gpt-5.5",
      "object": "model",
      "created": 0,
      "owned_by": "openai"
    },
    {
      "id": "claude-opus-4-7",
      "object": "model",
      "created": 0,
      "owned_by": "anthropic"
    }
  ]
}

【模型映射】

建立 MODEL_MAP：

对外模型 ID → OpenRouter 上游模型 ID

- gpt-5.5 → openai/gpt-5.5
- claude-opus-4-7 → anthropic/claude-opus-4.7
- claude-opus-4-6 → anthropic/claude-opus-4.6
- claude-sonnet-4-6 → anthropic/claude-sonnet-4.6
- claude-haiku-4-5 → anthropic/claude-haiku-4.5

如果 Replit OpenRouter 对某些模型 ID 使用不同命名：
- 优先尝试上面的映射
- 如果调用失败且错误明确是 model not found，可记录日志并提示检查 OpenRouter 模型 ID
- 不要改变对外模型 ID
- 对外始终保持上述固定 ID

辅助函数：
- isClaudeModel(model): model.startsWith("claude-")
- isOpenAIModel(model): model.startsWith("gpt")
- toOpenRouterModel(model): 使用 MODEL_MAP 映射

【POST /v1/chat/completions：OpenAI 兼容接口】

请求：
- 接受 OpenAI Chat Completions 格式
- 支持 stream true/false
- 支持 messages
- 支持 tools
- 支持 tool_choice
- 支持 temperature、top_p、max_tokens 等常见参数
- 支持 OpenRouter 扩展字段：
  - cache_control
  - reasoning
  - verbosity
  - provider
  - plugins
  - transforms
  - route
  - models
  - metadata

处理流程：
1. 验证 token。
2. 读取 req.body。
3. 检查 model。
4. 将对外 model 映射到 OpenRouter model。
5. 如果是 claude- 模型，执行 Claude 适配：
   - Claude Opus 4.7 自适应思考适配
   - Prompt caching 适配
   - 工具调用兼容处理
   - 去除或忽略 4.7 不支持的采样参数
6. 调用 callOpenRouterChatCompletions。
7. 非流式返回 OpenAI Chat Completions JSON。
8. 流式返回 OpenAI Chat Completions SSE。

【Claude Opus 4.7 自适应思考适配】

重要事实：
- claude-opus-4-7 对外作为本反代暴露的模型 ID。
- 转发到 OpenRouter 上游时，将 claude-opus-4-7 映射为 OpenRouter 模型 ID：anthropic/claude-opus-4.7。
- Claude Opus 4.7 只支持 adaptive thinking。
- Claude Opus 4.7 的 reasoning 是 opt-in，必须显式启用才会使用 reasoning。
- 严禁向 Claude Opus 4.7 上游发送 thinking: { type: "enabled", budget_tokens: ... }。
- 严禁为 Claude Opus 4.7 构造 budget_tokens 或 thinking.budget_tokens。
- 不要使用 reasoning: { effort: "auto" }。
- 不要使用 reasoning.max_tokens 控制 Claude 4.7 思考预算。
- 不要依赖 reasoning.effort 控制 Claude 4.7 思考深度。
- 使用 verbosity 控制整体输出 effort。
- Claude 4.7 支持 verbosity: "xhigh"。
- 不要把 thinking / reasoning 内容合并进普通 content。

OpenRouter 上游请求规则：
当目标模型是 claude-opus-4-7 时：

1. 将 model 改写为：
   "anthropic/claude-opus-4.7"

2. 如果用户请求中没有显式提供 reasoning 或 thinking 配置，则自动注入：

{
  "reasoning": {
    "enabled": true
  }
}

3. 如果用户请求中没有显式提供 verbosity，则自动注入：

{
  "verbosity": "xhigh"
}

说明：
- reasoning.enabled=true 用于开启 Claude 4.7 adaptive thinking。
- verbosity 用于控制整体输出 effort。
- 如用户显式传入 verbosity，则尊重用户传入值。
- 如用户显式要求最高质量，可允许 verbosity: "max"。
- 如用户显式关闭思考，例如 reasoning.enabled=false 或 thinking.type="disabled"，则尊重用户配置，不自动开启 reasoning。

4. 如果用户传入 Anthropic 风格：

{
  "thinking": {
    "type": "adaptive"
  }
}

则转换为 OpenRouter 风格：

{
  "reasoning": {
    "enabled": true
  }
}

并删除 thinking 字段，避免 OpenRouter OpenAI-compatible Chat Completions 上游不识别。

5. 如果用户传入：

{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  }
}

对 claude-opus-4-7 不要原样转发。
应转换为：

{
  "reasoning": {
    "enabled": true
  }
}

并删除：
- thinking
- thinking.budget_tokens
- reasoning.max_tokens
- reasoning.effort

6. 如果用户传入：

{
  "reasoning": {
    "max_tokens": 10000
  }
}

对 claude-opus-4-7 删除 max_tokens，仅保留：

{
  "reasoning": {
    "enabled": true
  }
}

除非用户显式传入 reasoning.enabled=false。

7. 如果用户传入：

{
  "reasoning": {
    "effort": "high"
  }
}

对 claude-opus-4-7 删除 effort。
如果 effort 值为 low / medium / high / xhigh / max，可将其映射为 verbosity。

映射规则：
- low → verbosity: "low"
- medium → verbosity: "medium"
- high → verbosity: "high"
- xhigh → verbosity: "xhigh"
- max → verbosity: "max"

8. 对 Claude Opus 4.7，建议剔除或忽略以下采样参数：
- temperature
- top_p
- top_k

因为 Claude 4.7 不再支持这些采样参数，即使传入也会被忽略。

9. 响应处理：
OpenAI 兼容响应中：
- 普通文本只放到 choices[].message.content 或 choices[].delta.content。
- reasoning / thinking 相关字段如果上游返回，最多保留在兼容的 reasoning 字段中。
- 默认不要向用户暴露原始思考内容。
- 不要把 reasoning / thinking delta 拼进普通 content。

10. 流式处理：
- 必须正确处理普通文本 delta。
- 如果上游返回 reasoning delta / thinking delta，不要把它误当成普通文本。
- 不得因为 reasoning/thinking 事件存在而丢弃 content delta。
- 对外 OpenAI Chat Completions 流式接口必须持续输出 choices[].delta.content。
- 对外 Anthropic Messages 流式接口必须持续输出 content_block_delta / text_delta。

POST /v1/chat/completions 中 claude-opus-4-7 默认上游请求示例：

{
  "model": "anthropic/claude-opus-4.7",
  "messages": [
    { "role": "user", "content": "你好" }
  ],
  "reasoning": {
    "enabled": true
  },
  "verbosity": "xhigh"
}

特别禁止：
- 不要生成 thinking: { type: "enabled", budget_tokens: "auto" }
- 不要生成 thinking: { type: "enabled", budget_tokens: 10000 }
- 不要生成 reasoning: { effort: "auto" }
- 不要生成 reasoning: { effort: "high" } 给 claude-opus-4-7
- 不要生成 reasoning: { max_tokens: 10000 } 给 claude-opus-4-7
- 不要依赖 reasoning.max_tokens 控制 Claude Opus 4.7 的思考深度

【Prompt Caching / Claude 缓存适配】

目标：
- 因为本服务对外暴露 OpenAI Chat Completions 与 Anthropic Messages 两种格式，但上游统一走 OpenRouter，所以必须在格式转换时完整保留 Anthropic / OpenRouter 的缓存字段。
- 重点适配 Claude 模型，尤其是 claude-opus-4-7。
- 不要因为 OpenAI SDK 类型定义不包含 cache_control 就把它丢弃。
- 如果 OpenAI SDK 无法透传非标准字段，改用 fetch 直接请求 OpenRouter /chat/completions，或使用 SDK 支持的 extra_body / extraBody 机制。

Claude 模型缓存规则：
- 仅对 claude- 开头模型启用或透传 Anthropic prompt caching。
- OpenAI 模型不用手动注入 cache_control；OpenAI 系列缓存通常由上游自动处理。
- Claude Opus 4.7、Claude Opus 4.6、Claude Opus 4.5、Claude Haiku 4.5 的最小可缓存 prompt 前缀是 4096 tokens。
- Claude Sonnet 4.6、Claude Haiku 3.5 的最小可缓存 prompt 前缀是 2048 tokens。
- prompt 太短时不报错，但 cache_creation_input_tokens、cache_read_input_tokens 或 prompt_tokens_details.cached_tokens 可能为 0。

默认策略：
- 对 claude- 开头模型，如果用户请求体没有显式传入 cache_control，则默认注入：

{
  "cache_control": {
    "type": "ephemeral"
  }
}

- 默认 TTL 使用 5 分钟。
- 不要默认使用 1 小时 TTL。
- 只有用户显式传入以下配置时，才使用 1 小时 TTL：

{
  "cache_control": {
    "type": "ephemeral",
    "ttl": "1h"
  }
}

- 如果用户显式传入 cache_control，则完整尊重用户配置。
- 如果用户传入 cache_control: false 或 header x-prompt-cache: off，则不要注入缓存字段。
- 如果用户传入 header x-prompt-cache-ttl: 1h，则注入：

{
  "cache_control": {
    "type": "ephemeral",
    "ttl": "1h"
  }
}

【OpenRouter Provider 稳定路由 / 缓存命中要求】

目标：
- Claude prompt cache 的命中不仅依赖 cache_control 和稳定前缀，也依赖请求是否稳定落到支持 Anthropic prompt caching 的 provider。
- 因为上游统一走 OpenRouter，如果 OpenRouter 将相同 Claude 请求路由到不同 provider，或 fallback 到不支持 cache_control 的 provider，可能导致缓存不命中。
- 因此 Claude 模型请求必须尽量稳定路由到 Anthropic provider。

默认规则：
- 对所有 claude- 开头模型，如果用户没有显式传入 provider，则自动注入：

{
  "provider": {
    "order": ["anthropic"],
    "require_parameters": true
  }
}

说明：
- provider.order: ["anthropic"] 表示优先使用 Anthropic 官方 provider。
- require_parameters: true 表示如果请求中包含 cache_control、reasoning、verbosity 等扩展参数，上游 provider 必须支持这些参数，避免被不支持的 provider 忽略。
- 不要默认使用 provider.only，因为 only 会降低 fallback 可用性。
- 如果用户明确要求最高缓存稳定性，可允许使用：

{
  "provider": {
    "only": ["anthropic"],
    "require_parameters": true
  }
}

用户 provider 合并规则：
- 如果用户已经传入 provider，则不要直接覆盖。
- 如果用户 provider 中没有 require_parameters，则补充：
  require_parameters: true
- 如果用户已经传入 provider.order，则保留用户的 order。
- 如果用户已经传入 provider.only，则保留用户的 only。
- 如果用户传入 allow_fallbacks、ignore 或其他 OpenRouter provider 字段，也必须保留。
- 不要同时生成冲突的 order 和 only，除非用户已经这样传入且 OpenRouter 接受。

缓存排查要求：
- 在调试日志中记录最终发送给 OpenRouter 的 provider 字段，但不要记录 API Key。
- 如果 usage 中 cache_read_input_tokens / prompt_tokens_details.cached_tokens 长期为 0，应检查：
  1. 是否最终 payload 中缺少 provider.require_parameters=true
  2. 是否最终 payload 没有优先路由到 Anthropic provider
  3. 是否 fallback 到了不支持 cache_control 的 provider
  4. 是否 cache_control 被 provider 忽略
  5. 是否相同稳定前缀落到了不同 provider，导致缓存无法命中

验证：
- 对 claude-opus-4-7 的最终 OpenRouter payload 应至少包含：

{
  "model": "anthropic/claude-opus-4.7",
  "provider": {
    "order": ["anthropic"],
    "require_parameters": true
  },
  "reasoning": {
    "enabled": true
  },
  "verbosity": "xhigh"
}

- 如果使用最高缓存稳定模式，则 payload 可包含：

{
  "provider": {
    "only": ["anthropic"],
    "require_parameters": true
  }
}

- 确认 OpenRouter 响应没有因为 provider 限制导致 model unavailable。
- 如果 only 模式导致不可用，应回退到 order 模式。

POST /v1/chat/completions 缓存适配：
- 这是 OpenAI 兼容接口，但允许透传 OpenRouter 扩展字段。
- 对 claude- 模型：
  - 保留请求体顶层 cache_control。
  - 保留 messages[].content[] 中每个 content block 的 cache_control。
  - 保留 tools[] 中每个 tool 的 cache_control。
  - 如果 tools 存在且没有任何 tool 带 cache_control，可以在最后一个 tool 上自动添加：
    cache_control: { type: "ephemeral" }
  - 如果 messages 是字符串 content，不要强行改写为 content block，除非需要插入显式 block-level cache_control。
  - 如果需要显式缓存系统提示词或大段上下文，把 content 转为数组块格式。

示例：

{
  "role": "system",
  "content": [
    {
      "type": "text",
      "text": "稳定系统提示词或大段上下文",
      "cache_control": { "type": "ephemeral" }
    }
  ]
}

- 动态内容、时间戳、用户当前问题不要放进被 cache_control 标记的稳定前缀里。

POST /v1/messages 缓存适配：
- 接受 Anthropic Messages 原生格式中的：
  - 顶层 cache_control
  - system content block 上的 cache_control
  - messages[].content[] block 上的 cache_control
  - tools[] 上的 cache_control

- 转换到 OpenRouter OpenAI-compatible 上游请求时：
  - 顶层 cache_control 原样保留。
  - Anthropic system 字符串如无显式 cache_control，可转换成 OpenAI system message。
  - Anthropic system 数组块必须转换为 OpenAI system message 的 content block 数组，并保留每个 block 的 cache_control。
  - Anthropic messages[].content[] 的 cache_control 必须保留。
  - Anthropic tools[].cache_control 必须保留。
  - 如果 tools 存在且没有 cache_control，可在最后一个 tool 上自动添加 cache_control。

示例：Anthropic Messages 输入：

{
  "model": "claude-opus-4-7",
  "max_tokens": 4096,
  "cache_control": { "type": "ephemeral" },
  "system": [
    {
      "type": "text",
      "text": "这里是稳定系统提示词",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "当前问题"
    }
  ]
}

转换为 OpenRouter 上游 OpenAI-compatible 请求：

{
  "model": "anthropic/claude-opus-4.7",
  "cache_control": { "type": "ephemeral" },
  "reasoning": { "enabled": true },
  "verbosity": "xhigh",
  "provider": {
    "order": ["anthropic"],
    "require_parameters": true
  },
  "messages": [
    {
      "role": "system",
      "content": [
        {
          "type": "text",
          "text": "这里是稳定系统提示词",
          "cache_control": { "type": "ephemeral" }
        }
      ]
    },
    {
      "role": "user",
      "content": "当前问题"
    }
  ],
  "max_tokens": 4096
}

响应 usage 映射：
- 如果 OpenRouter / Anthropic 返回以下 usage 字段，必须保留并映射：
  - cache_creation_input_tokens
  - cache_read_input_tokens
  - cache_creation
  - prompt_tokens_details.cached_tokens
  - prompt_tokens_details.cache_write_tokens

OpenAI 兼容响应中：
- usage.prompt_tokens 正常保留。
- usage.completion_tokens 正常保留。
- usage.total_tokens 正常保留。
- usage.prompt_tokens_details.cached_tokens 正常保留。
- usage.prompt_tokens_details.cache_write_tokens 正常保留。
- 如果存在 cache_read_input_tokens，可以映射到 prompt_tokens_details.cached_tokens。
- 如果存在 cache_creation_input_tokens，可以映射到 prompt_tokens_details.cache_write_tokens。
- 同时保留原始扩展字段，便于前端或日志查看缓存效果。

Anthropic Messages 响应中：
- usage.input_tokens
- usage.output_tokens
- usage.cache_creation_input_tokens
- usage.cache_read_input_tokens
- usage.cache_creation

流式响应：
- 流式时，最终 usage chunk 或 message_start / message_delta 中如果包含 cache_creation_input_tokens、cache_read_input_tokens、prompt_tokens_details.cached_tokens，也要保留。
- 不要因为 stream=true 而丢弃缓存统计。

缓存失效注意事项：
- 修改 tools 定义会使整个缓存失效。
- 修改 system 会使 system 和 messages 缓存失效。
- 修改 tool_choice 会影响 messages 缓存。
- 修改 thinking / reasoning 参数会影响 messages 缓存。
- 对 Claude Opus 4.7，保持 reasoning.enabled 和 verbosity 在同一会话中稳定，避免缓存频繁失效。
- 不要在缓存前缀中插入时间戳、随机 ID、当前请求 ID、动态用户上下文等会变化的内容。
- 大段稳定上下文、系统提示词、RAG 文档、工具定义适合缓存。
- 当前用户问题、临时变量、会变的上下文不适合缓存。

验证缓存：
1. 第一次请求长上下文 Claude Opus 4.7：
   - usage.prompt_tokens_details.cache_write_tokens 应大于 0
   - 或 usage.cache_creation_input_tokens 应大于 0
2. 5 分钟内用相同稳定前缀再次请求：
   - usage.prompt_tokens_details.cached_tokens 应大于 0
   - 或 usage.cache_read_input_tokens 应大于 0
3. 如果两者都为 0：
   - 检查 prompt 是否少于模型最小缓存 token 数
   - 检查 cache_control 是否在转换过程中被丢弃
   - 检查 provider 是否没有路由到支持 cache_control 的 Anthropic provider
   - 检查 system/tools/messages 的稳定前缀是否每次完全一致

【Tool Call 支持】

OpenAI Chat Completions 输入：
- tools 原格式透传给 OpenRouter。
- tool_choice 原格式透传给 OpenRouter。
- function.parameters 必须保留。
- 函数 arguments 必须保持字符串 JSON。

Anthropic Messages 输入转换为 OpenAI Chat Completions：
- Anthropic tools[]：

{
  "name": "get_weather",
  "description": "Get weather",
  "input_schema": {
    "type": "object",
    "properties": {}
  }
}

转换为 OpenAI tools[]：

{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get weather",
    "parameters": {
      "type": "object",
      "properties": {}
    }
  }
}

- Anthropic tool_choice 映射：
  - { "type": "auto" } → "auto"
  - { "type": "any" } → "required"
  - { "type": "tool", "name": "xxx" } → { "type": "function", "function": { "name": "xxx" } }
  - undefined → undefined

OpenAI Chat Completions 响应转换为 Anthropic Messages：
- OpenAI tool_calls[] 转换为 Anthropic content[] 中的 tool_use 块：

{
  "type": "tool_use",
  "id": "<tool_call_id>",
  "name": "<function_name>",
  "input": {}
}

- function.arguments 需要 JSON.parse。
- 如果 JSON.parse 失败：
  - input 使用 {}
  - 或保留 raw_arguments 字段用于调试
  - 不要让整个请求 500

Anthropic Messages 请求中的消息转换：
- role: "user" 且 content 包含 tool_result：
  - 转换为 OpenAI role: "tool"
  - tool_call_id 来自 tool_use_id
  - content 为 tool_result 的 content 文本或 JSON 字符串
- assistant content 中的 tool_use：
  - 转换为 assistant.tool_calls
  - input JSON.stringify 为 function.arguments

OpenAI messages 转 Anthropic Messages：
- role: "tool" → Anthropic user message content block:
  {
    "type": "tool_result",
    "tool_use_id": "<tool_call_id>",
    "content": "<tool result>"
  }
- assistant.tool_calls → Anthropic assistant content block:
  {
    "type": "tool_use",
    "id": "<tool_call_id>",
    "name": "<function name>",
    "input": {}
  }

finish_reason / stop_reason 映射：
- OpenAI finish_reason: "tool_calls" → Anthropic stop_reason: "tool_use"
- Anthropic stop_reason: "tool_use" → OpenAI finish_reason: "tool_calls"
- stop → end_turn / stop
- length → max_tokens
- content_filter → stop 或 content_filter，尽量保留原始字段

【POST /v1/chat/completions 非流式】

非流式 stream=false 或未设置 stream：
- 调用 OpenRouter Chat Completions 非流式接口。
- 返回 OpenAI Chat Completions 标准 JSON。
- Claude 模型也必须返回 OpenAI 兼容格式。
- 工具调用、usage、finish_reason 必须正确映射。
- cache usage 字段必须保留。
- reasoning 字段不要合并进普通 content。

上游响应如果已经是 OpenAI Chat Completions 格式：
- 尽量原样返回。
- 但要把 model 字段从 OpenRouter 模型 ID 改回用户请求的对外模型 ID。
- 例如 anthropic/claude-opus-4.7 → claude-opus-4-7。
- 如有必要，保留 upstream_model 字段用于调试，但不要破坏 OpenAI 标准格式。

【POST /v1/chat/completions 流式】

stream=true 时：
- 设置响应头：
  - Content-Type: text/event-stream
  - Cache-Control: no-cache
  - Connection: keep-alive
  - X-Accel-Buffering: no

- 调用 res.flushHeaders()。

- 上游使用 OpenRouter Chat Completions 流式接口。

- 对外输出 OpenAI Chat Completions SSE 格式：
  - data: {...}
  - data: [DONE]

- 每块输出后调用 res.flush()，如果 res.flush 存在。

- 每 5 秒发送 keepalive：
  : keepalive

- req.on("close") 时 clearInterval。
- 使用 try/finally 防止连接关闭时抛出 500。
- 如果客户端已关闭，不要继续写 response。

流式 chunk 处理：
- 如果上游返回 OpenAI 标准 chunk：
  - 直接透传或轻微修正 model 字段。
- 必须处理：
  - choices[].delta.content
  - choices[].delta.tool_calls
  - choices[].finish_reason
  - usage
  - reasoning delta / thinking delta，如果存在，不要拼进 content

特别检查并修复：
- 检查是否存在“流式模式完全没有文本内容，只有末尾 token 统计块”的问题。
- 常见原因是事件名写错，例如监听 contentBlockDelta，但实际事件是 content_block_delta。
- 但在本项目里，上游是 OpenRouter Chat Completions，不应写死 Anthropic SDK 事件名。
- 应该解析 OpenRouter 实际 SSE：
  - 每行以 data: 开头
  - data: [DONE] 结束
  - JSON chunk 中优先读取 choices[].delta.content
  - 同时兼容 choices[].message.content
  - 同时兼容 content_delta / text_delta / delta.text 等可能字段
- 不允许因为事件字段命名差异导致文本 delta 丢失。
- 如果 OpenRouter 返回的 chunk 中有 delta.content，必须立即输出。
- 如果 OpenRouter 返回的 chunk 中有 tool_calls delta，必须转换并输出。
- 如果 OpenRouter 返回 usage-only chunk，不要误认为没有内容；但不能只输出 usage 而丢弃前面的文本。

【POST /v1/messages：Anthropic Messages 原生兼容接口】

重要：
- 这是本服务对外暴露的 Anthropic Messages 兼容接口。
- 上游仍然只能调用 OpenRouter Chat Completions。
- 不要调用上游 /v1/messages。
- 不要使用 Anthropic SDK。

鉴权：
- 验证 Authorization: Bearer tzcnb 或 x-api-key: tzcnb。
- 失败返回 401。

接受 Anthropic Messages API 原生请求格式：
- model
- system
- messages
- tools
- tool_choice
- max_tokens
- stream
- thinking
- reasoning
- cache_control
- metadata
- temperature
- top_p
- top_k
- stop_sequences

处理流程：
1. 验证 token。
2. 读取 Anthropic Messages 请求体。
3. 将外部 model 映射为 OpenRouter model。
4. 将 Anthropic Messages 请求转换为 OpenAI Chat Completions 请求。
5. 应用 Claude Opus 4.7 自适应思考适配。
6. 应用 Claude prompt caching 适配。
7. 调用 callOpenRouterChatCompletions。
8. 如果 stream=false：
   - 将 OpenAI Chat Completions 响应转换为 Anthropic Message JSON。
9. 如果 stream=true：
   - 将 OpenAI Chat Completions SSE 转换为 Anthropic Messages SSE 事件序列。

【Anthropic Messages → OpenAI Chat Completions 请求转换】

system 转换：
- 如果 system 是字符串：
  - 转为 OpenAI system message：
    { role: "system", content: system }
- 如果 system 是数组 content blocks：
  - 转为 OpenAI system message：
    { role: "system", content: convertedBlocks }
  - 必须保留每个 block 的 cache_control。

messages 转换：
- Anthropic role: "user" → OpenAI role: "user"
- Anthropic role: "assistant" → OpenAI role: "assistant"

content 转换：
- 字符串 content 直接保留。
- content block 数组逐块转换：
  - { type: "text", text } → { type: "text", text }
  - 保留 cache_control
  - image block 按 OpenAI 兼容 image_url 或 OpenRouter 支持格式转换
  - tool_use → assistant.tool_calls
  - tool_result → role: "tool"

tool_use 转 OpenAI assistant.tool_calls：
Anthropic：

{
  "type": "tool_use",
  "id": "toolu_123",
  "name": "get_weather",
  "input": {
    "city": "Tokyo"
  }
}

OpenAI：

{
  "id": "toolu_123",
  "type": "function",
  "function": {
    "name": "get_weather",
    "arguments": "{\"city\":\"Tokyo\"}"
  }
}

tool_result 转 OpenAI tool message：
Anthropic：

{
  "type": "tool_result",
  "tool_use_id": "toolu_123",
  "content": "sunny"
}

OpenAI：

{
  "role": "tool",
  "tool_call_id": "toolu_123",
  "content": "sunny"
}

max_tokens：
- Anthropic max_tokens → OpenAI max_tokens
- 如果同时有 max_completion_tokens，优先保留用户显式字段，但不要重复冲突。

stop_sequences：
- Anthropic stop_sequences → OpenAI stop

tools：
- input_schema → function.parameters
- 保留 description
- 保留 cache_control

tool_choice：
- Anthropic auto → OpenAI auto
- Anthropic any → OpenAI required
- Anthropic tool name → OpenAI function name

metadata：
- 可放入 OpenRouter metadata
- 不要破坏标准字段

【Claude Opus 4.7 在 /v1/messages 中的转换规则】

用户 Anthropic 原生请求：

{
  "model": "claude-opus-4-7",
  "max_tokens": 4096,
  "thinking": {
    "type": "adaptive"
  },
  "messages": [
    { "role": "user", "content": "你好" }
  ]
}

转换为 OpenRouter OpenAI-compatible 上游请求：

{
  "model": "anthropic/claude-opus-4.7",
  "max_tokens": 4096,
  "reasoning": {
    "enabled": true
  },
  "verbosity": "xhigh",
  "messages": [
    { "role": "user", "content": "你好" }
  ]
}

如果用户没有传 thinking/reasoning：
- 对 claude-opus-4-7 默认注入 reasoning.enabled=true
- 默认注入 verbosity="xhigh"

如果用户传 thinking.type="adaptive"：
- 转 reasoning.enabled=true
- 删除 thinking

如果用户传 thinking.type="enabled" + budget_tokens：
- 转 reasoning.enabled=true
- 删除 thinking
- 删除 budget_tokens

如果用户传 reasoning.max_tokens：
- 删除 max_tokens
- 保留 reasoning.enabled=true，除非用户显式 enabled=false

如果用户传 reasoning.effort：
- 删除 effort
- 可映射到 verbosity

如果用户显式 thinking.type="disabled" 或 reasoning.enabled=false：
- 不自动开启 reasoning
- 仍可保留用户显式 verbosity

【OpenAI Chat Completions 响应 → Anthropic Message 响应转换】

非流式 /v1/messages 返回格式：

{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-4-7",
  "content": [
    {
      "type": "text",
      "text": "..."
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0
  }
}

转换规则：
- choices[0].message.content → content: [{ type: "text", text }]
- choices[0].message.tool_calls → content 中追加 tool_use 块
- choices[0].finish_reason:
  - stop → end_turn
  - length → max_tokens
  - tool_calls → tool_use
  - content_filter → stop
- usage.prompt_tokens → usage.input_tokens
- usage.completion_tokens → usage.output_tokens
- usage.prompt_tokens_details.cached_tokens → usage.cache_read_input_tokens
- usage.prompt_tokens_details.cache_write_tokens → usage.cache_creation_input_tokens
- model 改回对外 model ID

tool_calls 转 Anthropic tool_use：
OpenAI：

{
  "id": "call_123",
  "type": "function",
  "function": {
    "name": "get_weather",
    "arguments": "{\"city\":\"Tokyo\"}"
  }
}

Anthropic：

{
  "type": "tool_use",
  "id": "call_123",
  "name": "get_weather",
  "input": {
    "city": "Tokyo"
  }
}

JSON parse 失败时：
- input 使用 {}
- 可加 raw_arguments
- 不要 500

【/v1/messages 流式：合成 Anthropic SSE】

当用户请求 POST /v1/messages 且 stream=true：
- 对外返回 Anthropic Messages SSE 事件序列。
- 内部仍调用 OpenRouter Chat Completions stream=true。
- 把 OpenAI chunks 转成 Anthropic SSE。

响应头：
- Content-Type: text/event-stream
- Cache-Control: no-cache
- Connection: keep-alive
- X-Accel-Buffering: no

调用 res.flushHeaders()。

必须输出事件序列：

1. message_start

event: message_start
data: {
  "type": "message_start",
  "message": {
    "id": "msg_xxx",
    "type": "message",
    "role": "assistant",
    "model": "claude-opus-4-7",
    "content": [],
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 0,
      "output_tokens": 0
    }
  }
}

2. content_block_start

当第一次收到文本 delta 时，输出：

event: content_block_start
data: {
  "type": "content_block_start",
  "index": 0,
  "content_block": {
    "type": "text",
    "text": ""
  }
}

3. content_block_delta

每次收到 choices[].delta.content 时，输出：

event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "text_delta",
    "text": "<增量文本>"
  }
}

4. 工具调用块

如果收到 OpenAI tool_calls delta：
- 为每个 tool call 分配 content block index。
- 第一次出现工具调用时输出：

event: content_block_start
data: {
  "type": "content_block_start",
  "index": 1,
  "content_block": {
    "type": "tool_use",
    "id": "call_xxx",
    "name": "tool_name",
    "input": {}
  }
}

- arguments 增量输出：

event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 1,
  "delta": {
    "type": "input_json_delta",
    "partial_json": "<arguments 增量>"
  }
}

- 工具调用结束时输出 content_block_stop。

5. content_block_stop

文本块结束时：

event: content_block_stop
data: {
  "type": "content_block_stop",
  "index": 0
}

6. message_delta

结束前输出：

event: message_delta
data: {
  "type": "message_delta",
  "delta": {
    "stop_reason": "end_turn",
    "stop_sequence": null
  },
  "usage": {
    "output_tokens": 0
  }
}

如果 finish_reason 为 tool_calls：
- stop_reason 应为 tool_use

7. message_stop

event: message_stop
data: {
  "type": "message_stop"
}

8. ping / keepalive

每 5 秒发送：

event: ping
data: {"type":"ping"}

或：

: keepalive

req.on("close") 时清理 interval。

必须确认：
- 有 message_start。
- 有 content_block_start。
- 有 content_block_delta。
- 有 text_delta。
- 有 content_block_stop。
- 有 message_delta。
- 有 message_stop。
- 文本内容不能丢失。
- 工具调用 arguments 不能丢失。
- usage 和缓存统计尽量保留。

【流式无文本问题专项修复】

必须检验是否有以下错误：
- 流式模式完全没有输出文本内容
- 只有末尾 token 统计块
- content delta 被 reasoning delta 覆盖
- 只处理 usage chunk，不处理 choices[].delta.content
- 监听了错误的事件名，例如 contentBlockDelta，但实际是 content_block_delta
- 把 OpenRouter SSE 当成 Anthropic SDK event emitter 来处理

本项目上游是 OpenRouter Chat Completions，因此正确做法是：
- 解析 SSE data 行
- 对每个 JSON chunk：
  - 优先读取 choices[].delta.content
  - 其次兼容 choices[].message.content
  - 兼容 delta.text / text_delta / content_delta
  - 处理 choices[].delta.tool_calls
  - 处理 usage
- 不要写死 Anthropic SDK 的事件名。
- 不要使用 contentBlockDelta 驼峰事件监听。
- 不要使用 anthropic.messages.stream()。
- 不要使用 messages.stream().finalMessage()。
- 因为 Replit OpenRouter 不提供 /v1/messages，上游没有 Anthropic SDK stream。

【错误处理】

OpenRouter 调用失败：
- 如果上游返回 JSON error，透传合理错误。
- OpenAI 兼容接口返回 OpenAI 风格 error：
  {
    "error": {
      "message": "...",
      "type": "server_error",
      "code": "..."
    }
  }
- Anthropic Messages 接口返回 Anthropic 风格 error：
  {
    "type": "error",
    "error": {
      "type": "api_error",
      "message": "..."
    }
  }

流式中途错误：
- 如果还没发送任何 token，可返回正常错误状态。
- 如果已经开始 SSE：
  - OpenAI 接口输出 error SSE 或 finish_reason error chunk
  - Anthropic 接口输出 event: error
- 不要抛未捕获异常导致进程崩溃。
- req close 后不要继续写入。

【Express body limit】

文件：artifacts/api-server/src/app.ts

确保包含：

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use("/api", router);
app.use("/v1", proxyRouter);

如果已有 /api router，不要破坏原有功能。
新增 import proxyRouter：

import proxyRouter from "./routes/proxy";

根据项目现有 tsconfig 和路径风格调整。

【artifact.toml】

文件：artifacts/api-server/.replit-artifact/artifact.toml

要求：
- paths 数组加入 "/v1"。
- 必须通过 verifyAndReplaceArtifactToml 更新。
- 不要直接手动编辑 artifact.toml。
- 保留原有 paths。
- 只追加 "/v1"。

【依赖安装】

在 artifacts/api-server/package.json dependencies 中加入：

"openai": "^6"

说明：
- 因为所有模型统一走 OpenRouter OpenAI 兼容上游，不再需要 @anthropic-ai/sdk。
- 如果代码中已有 @anthropic-ai/sdk 且不再使用，请移除。
- 推荐使用 fetch 实现上游调用，以确保 cache_control、reasoning、verbosity、provider 等 OpenRouter 扩展字段不会被 SDK 类型过滤。
- 如果运行环境没有 fetch，使用 undici 或项目已有 HTTP client。

【前端门户】

用 createArtifact 创建前端门户：

createArtifact({
  artifactType: "react-vite",
  slug: "api-portal",
  previewPath: "/",
  title: "API Portal"
})

App.tsx 功能：
- 纯内联样式。
- 深色主题 hsl(222,47%,11%)。
- 无外部 UI 库依赖。
- 不使用 shadcn。
- 不使用 Tailwind。
- 不使用外部图标库。
- 所有样式写在组件内。

页面内容：

1. 顶部 Header
- 图标 + 标题。
- 标题：OpenRouter API Portal
- 副标题：OpenAI & Anthropic compatible reverse proxy on Replit
- 在线状态指示器。
- fetch(/api/healthz) 检测。
- 绿/红点 + 光晕效果。
- 如果 /api/healthz 不存在，可以 fallback 检测 /v1/models，但必须带 x-api-key: tzcnb。

2. Connection Details 区块
显示：
- Base URL：window.location.origin
- OpenAI Base URL：window.location.origin + "/v1"
- Anthropic Base URL：window.location.origin + "/v1"
- Authorization Header：
  Authorization: Bearer tzcnb
- x-api-key：
  x-api-key: tzcnb

每项都提供复制按钮。

不要显示上游 OpenRouter API Key。
不要显示任何 AI_INTEGRATIONS_* secret。

3. API Endpoints 区块

列出三个端点：
- GET /v1/models
- POST /v1/chat/completions
- POST /v1/messages

显示内容：
- METHOD badge：
  - GET 绿色
  - POST 紫色
- 完整 URL
- 接口类型标签：
  - OpenAI 蓝色
  - Anthropic 橙色
  - Both 灰色
- 复制按钮
- 说明文字区分两种接口格式。

说明重点：
- /v1/chat/completions：OpenAI-compatible request/response format
- /v1/messages：Anthropic Messages-compatible external API; internally converted to OpenRouter Chat Completions
- /v1/models：local model list

4. Available Models 区块

Grid 布局，每个 model 显示：
- ID
- provider 标签：
  - OpenAI 蓝色
  - Anthropic 橙色
- 对 Claude Opus 4.7 额外显示：
  - Adaptive Thinking
  - Prompt Caching
  - OpenRouter upstream

模型：
- gpt-5.5
- claude-opus-4-7
- claude-opus-4-6
- claude-sonnet-4-6
- claude-haiku-4-5

5. CherryStudio 4 步设置指引

步骤样式：
- 圆形序号
- 渐变色
- 标题 + 描述

步骤内容：
1. 新建供应商
   - 在 CherryStudio 中添加自定义供应商。
2. 选择接口类型
   - 可选 OpenAI 或 Anthropic 提供商类型。
   - 选择 OpenAI 时使用 /v1/chat/completions。
   - 选择 Anthropic 时使用 /v1/messages。
3. 填写连接信息
   - Base URL：页面显示的 Base URL + /v1
   - API Key：tzcnb
4. 选择模型并测试
   - 推荐 claude-opus-4-7
   - 或 gpt-5.5

6. Quick Test 区块

提供 curl 示例，代码块带语法高亮色，整体可复制。

示例一：模型列表

curl "$BASE_URL/v1/models" \
  -H "Authorization: Bearer tzcnb"

示例二：OpenAI 兼容 Chat Completions 非流式

curl "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer tzcnb" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-7",
    "messages": [
      { "role": "user", "content": "你好，简单介绍一下你自己" }
    ],
    "stream": false
  }'

示例三：OpenAI 兼容 Chat Completions 流式

curl -N "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer tzcnb" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-7",
    "messages": [
      { "role": "user", "content": "测试流式输出，请连续输出三句话" }
    ],
    "stream": true
  }'

示例四：Anthropic Messages 原生接口非流式

curl "$BASE_URL/v1/messages" \
  -H "x-api-key: tzcnb" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-7",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": "你好，简单介绍一下你自己"
      }
    ]
  }'

示例五：Anthropic Messages 原生接口流式

curl -N "$BASE_URL/v1/messages" \
  -H "x-api-key: tzcnb" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-7",
    "max_tokens": 1024,
    "stream": true,
    "messages": [
      {
        "role": "user",
        "content": "测试 Anthropic Messages 流式，请连续输出三句话"
      }
    ]
  }'

示例六：缓存测试

curl "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer tzcnb" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-7",
    "cache_control": { "type": "ephemeral" },
    "messages": [
      {
        "role": "system",
        "content": "这里放置足够长且稳定的系统提示词或 RAG 文档内容"
      },
      {
        "role": "user",
        "content": "基于上面的内容回答一个问题"
      }
    ],
    "stream": false
  }'

7. 复制按钮
- 使用 navigator.clipboard.writeText。
- 提供 fallback：
  - 创建 textarea
  - document.execCommand("copy")
  - 移除 textarea
- 复制后显示 "Copied!" 状态 2 秒。

8. Footer
显示技术栈说明：
- Replit
- OpenRouter upstream
- OpenAI-compatible API
- Anthropic Messages-compatible API
- Prompt Caching
- Claude Opus 4.7 Adaptive Thinking
- pnpm monorepo

【发布】

重启 workflow：
- artifacts/api-server: API Server
- artifacts/api-portal: web

确保两个服务都能启动。

【验证】

1. Bearer Token 成功：

curl localhost:80/v1/models \
  -H "Authorization: Bearer tzcnb"

应返回模型列表。

2. x-api-key 成功：

curl localhost:80/v1/models \
  -H "x-api-key: tzcnb"

应返回模型列表。

3. 无 Token 失败：

curl localhost:80/v1/models

应返回 401。

4. 错误 Token 失败：

curl localhost:80/v1/models \
  -H "Authorization: Bearer wrong"

应返回 401。

5. 验证 OpenAI 兼容非流式：

curl localhost:80/v1/chat/completions \
  -H "Authorization: Bearer tzcnb" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-7",
    "messages": [
      { "role": "user", "content": "测试非流式输出" }
    ],
    "stream": false
  }'

应返回 OpenAI Chat Completions 格式 JSON，且 choices[0].message.content 有文本。

6. 验证 OpenAI 兼容流式：

curl -N localhost:80/v1/chat/completions \
  -H "Authorization: Bearer tzcnb" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-7",
    "messages": [
      { "role": "user", "content": "测试流式输出，请连续输出三句话" }
    ],
    "stream": true
  }'

必须确认：
- 流式过程中有文本 delta 输出。
- 不能只有最后的 token 统计块。
- 如发现只有 usage 没有文本，立即检查 SSE chunk 解析逻辑并修复。
- 不要检查 Anthropic SDK 事件名，因为上游不是 Anthropic SDK。
- 应检查 OpenRouter Chat Completions SSE 的 choices[].delta.content。

7. 验证 Anthropic Messages 非流式：

curl localhost:80/v1/messages \
  -H "x-api-key: tzcnb" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-7",
    "max_tokens": 1024,
    "messages": [
      { "role": "user", "content": "测试 Anthropic Messages 非流式" }
    ]
  }'

应返回 Anthropic Message 格式 JSON：
- type: "message"
- role: "assistant"
- content[] 中有 text
- usage.input_tokens / usage.output_tokens 存在或合理映射

8. 验证 Anthropic Messages 流式：

curl -N localhost:80/v1/messages \
  -H "x-api-key: tzcnb" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-7",
    "max_tokens": 1024,
    "stream": true,
    "messages": [
      { "role": "user", "content": "测试 Anthropic Messages 流式，请连续输出三句话" }
    ]
  }'

必须确认：
- 有 message_start。
- 有 content_block_start。
- 有 content_block_delta。
- 有 text_delta。
- 有 content_block_stop。
- 有 message_delta。
- 有 message_stop。
- 文本内容不能丢失。

9. 验证 Claude Opus 4.7 自适应思考：

对 claude-opus-4-7 的上游请求必须包含：
- model: "anthropic/claude-opus-4.7"
- reasoning: { enabled: true }
- verbosity: "xhigh"

并且不得包含：
- thinking.budget_tokens
- thinking: { type: "enabled" }
- reasoning.effort
- reasoning.max_tokens

10. 验证缓存：

第一次请求长上下文：
- usage.prompt_tokens_details.cache_write_tokens > 0
- 或 usage.cache_creation_input_tokens > 0

第二次请求相同稳定前缀：
- usage.prompt_tokens_details.cached_tokens > 0
- 或 usage.cache_read_input_tokens > 0

如果缓存字段始终为 0：
- 检查 prompt 是否太短。
- 检查 cache_control 是否被转换时丢弃。
- 检查 provider 是否没有路由到支持 cache_control 的 Anthropic provider。
- 检查稳定前缀是否每次完全一致。

11. 验证工具调用：

使用 /v1/chat/completions 测试 tools：
- 模型应能返回 tool_calls。
- tool_calls[].function.arguments 应为 JSON 字符串。
- finish_reason 应为 tool_calls。

使用 /v1/messages 测试 tools：
- Anthropic tools input_schema 应转换为 OpenAI function.parameters。
- OpenAI tool_calls 应转换回 Anthropic tool_use。
- stop_reason 应为 tool_use。

12. 验证上游端点：

检查代码中不得出现：
- /v1/messages 作为上游 URL
- /api/v1/messages 作为上游 URL
- anthropic.messages.create
- anthropic.messages.stream
- messages.stream().finalMessage()
- @anthropic-ai/sdk

只允许上游生成接口：
- /chat/completions
- /v1/chat/completions
- /api/v1/chat/completions

【最终操作】

完成后：
- presentArtifact({ artifactId: "artifacts/api-portal" })
- suggestDeploy()