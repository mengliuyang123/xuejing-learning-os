import type { LanguageModelV3Usage } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";

export type DeepSeekThinkingMode = "auto" | "enabled" | "disabled";
export type DeepSeekReasoningEffort = "low" | "high" | "max";

export type DeepSeekTaskProfile =
  | "fast_ping"
  | "structured_fast"
  | "structured_deep"
  | "curriculum_planning"
  | "react_research"
  | "tutor_chat";

export type DeepSeekModelSpec = {
  id: string;
  version: string;
  contextWindow: number;
  maxOutputTokens: number;
  defaultThinkingEnabled: boolean;
  defaultReasoningEffort: DeepSeekReasoningEffort;
  supportsVision: boolean;
  supportsJsonMode: boolean;
  supportsToolCalls: boolean;
  /** Safe working budget for LearnOS rolling context manager */
  recommendedWorkingBudget: number;
};

/**
 * Official DeepSeek API model specifications (from api-docs.deepseek.com pricing & thinking_mode docs).
 */
export const DEEPSEEK_MODEL_SPECS: Record<string, DeepSeekModelSpec> = {
  "deepseek-flash": {
    id: "deepseek-flash",
    version: "DeepSeek-V4.1-Flash-1017",
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    defaultThinkingEnabled: true,
    defaultReasoningEffort: "high",
    supportsVision: true,
    supportsJsonMode: true,
    supportsToolCalls: true,
    recommendedWorkingBudget: 64_000,
  },
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    version: "DeepSeek-V4-Pro-0813",
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    defaultThinkingEnabled: true,
    defaultReasoningEffort: "high",
    supportsVision: false,
    supportsJsonMode: true,
    supportsToolCalls: true,
    recommendedWorkingBudget: 64_000,
  },
  "deepseek-chat": {
    id: "deepseek-chat",
    version: "DeepSeek Legacy Chat",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    defaultThinkingEnabled: false,
    defaultReasoningEffort: "high",
    supportsVision: false,
    supportsJsonMode: true,
    supportsToolCalls: true,
    recommendedWorkingBudget: 24_000,
  },
  "deepseek-reasoner": {
    id: "deepseek-reasoner",
    version: "DeepSeek Legacy Reasoner",
    contextWindow: 128_000,
    maxOutputTokens: 64_000,
    defaultThinkingEnabled: true,
    defaultReasoningEffort: "high",
    supportsVision: false,
    supportsJsonMode: true,
    supportsToolCalls: true,
    recommendedWorkingBudget: 24_000,
  },
};

export function getDeepSeekModelSpec(modelId?: string): DeepSeekModelSpec | null {
  const id = (modelId || "").trim().toLowerCase();
  if (!id) return null;
  if (DEEPSEEK_MODEL_SPECS[id]) return DEEPSEEK_MODEL_SPECS[id];
  if (id.includes("deepseek-v4-flash") || id.includes("deepseek-flash")) {
    return DEEPSEEK_MODEL_SPECS["deepseek-flash"];
  }
  if (id.includes("deepseek-v4-pro")) {
    return DEEPSEEK_MODEL_SPECS["deepseek-v4-pro"];
  }
  if (id.includes("deepseek-reasoner")) {
    return DEEPSEEK_MODEL_SPECS["deepseek-reasoner"];
  }
  if (id.includes("deepseek")) {
    return DEEPSEEK_MODEL_SPECS["deepseek-flash"];
  }
  return null;
}

export function isDeepSeekProvider(params: {
  providerName?: string | null;
  baseUrl?: string | null;
  modelId?: string | null;
}): boolean {
  const p = (params.providerName || "").toLowerCase();
  const u = (params.baseUrl || "").toLowerCase();
  const m = (params.modelId || "").toLowerCase();
  if (p === "deepseek" || p.startsWith("deepseek.")) return true;
  if (u.includes("api.deepseek.com") || u.includes("deepseek.com")) return true;
  // Avoid hijacking OpenRouter/Gateway routes unless explicitly targeting deepseek base URL or provider
  if (
    !u &&
    (p === "" || p === "openai-compatible") &&
    m.startsWith("deepseek")
  ) {
    return true;
  }
  return false;
}

export function isDeepSeekModelInstance(
  model?: LanguageModel | string | null,
): boolean {
  if (!model) return false;
  if (typeof model === "string") {
    return /^deepseek(\/|-)/i.test(model.trim());
  }
  const obj = model as { provider?: string; modelId?: string };
  if (typeof obj.provider === "string" && /^deepseek(\.|$)/i.test(obj.provider)) {
    return true;
  }
  return false;
}

export function extractModelIdFromInstance(
  model?: LanguageModel | string | null,
): string | undefined {
  if (!model) return undefined;
  if (typeof model === "string") return model;
  const obj = model as { modelId?: string };
  return typeof obj.modelId === "string" ? obj.modelId : undefined;
}

export function normalizeDeepSeekBaseUrl(rawUrl?: string | null): string {
  const trimmed = (rawUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "https://api.deepseek.com";
  return trimmed;
}

const WEEKDAY_ZH = [
  "星期日",
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
];

/**
 * Formats DeepSeek's official `latest_reminder` message content:
 * `<date>,<weekday>,<location>,<platform>,<language>`
 * Example: `2026-11-21,星期六,,Web,中文`
 */
export function formatDeepSeekLatestReminder(
  day: string,
  opts: {
    location?: string;
    platform?: "Web" | "App";
    language?: string;
  } = {},
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((day || "").trim());
  if (!match) return null;
  const dt = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (Number.isNaN(dt.getTime())) return null;
  const weekday = WEEKDAY_ZH[dt.getUTCDay()];
  const location = (opts.location || "").replace(/[\r\n]/g, "").trim();
  const platform = opts.platform || "Web";
  const language = opts.language || "中文";
  return `${day},${weekday},${location},${platform},${language}`;
}

export type DeepSeekCallConfig = {
  thinkingEnabled: boolean;
  reasoningEffort?: DeepSeekReasoningEffort;
  jsonMode: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  /** Ready to spread into AI SDK `providerOptions` (only populated when DeepSeek is active) */
  providerOptions?: {
    deepseek: Record<string, unknown>;
  };
};

/**
 * Builds optimal, DeepSeek-doc-compliant call parameters for a given LearnOS task profile.
 * Non-DeepSeek models receive clean portable defaults without any DeepSeek-specific `providerOptions`.
 */
export function buildDeepSeekCallConfig(
  profile: DeepSeekTaskProfile,
  opts: {
    isDeepSeek: boolean;
    modelId?: string;
    taskType?: "learn" | "plan" | "chat";
    userThinkingMode?: DeepSeekThinkingMode;
    userReasoningEffort?: DeepSeekReasoningEffort;
    latestReminderDay?: string;
    dynamicContextSystem?: string;
    maxOutputTokensOverride?: number;
  },
): DeepSeekCallConfig {
  const userMode = opts.userThinkingMode || "auto";
  const userEffort = opts.userReasoningEffort;
  const spec = opts.isDeepSeek ? getDeepSeekModelSpec(opts.modelId) : null;

  let thinkingEnabled = false;
  let reasoningEffort: DeepSeekReasoningEffort | undefined;
  let jsonMode = false;
  let temperature: number | undefined;
  // Omit maxOutputTokens by default so DeepSeek / provider uses the model's native full output limit
  let maxOutputTokens: number | undefined = undefined;

  switch (profile) {
    case "fast_ping":
      thinkingEnabled = false;
      jsonMode = false;
      temperature = 0;
      maxOutputTokens = 32;
      break;

    case "structured_fast":
      thinkingEnabled = false;
      jsonMode = true;
      temperature = 0.2;
      break;

    case "structured_deep":
      thinkingEnabled = false;
      jsonMode = true;
      temperature = 0.35;
      break;

    case "curriculum_planning":
      // Deep DAG planning benefits from light reasoning unless user explicitly disabled thinking.
      if (userMode === "disabled") {
        thinkingEnabled = false;
        temperature = 0.25;
      } else {
        thinkingEnabled = true;
        reasoningEffort = userEffort || "low";
      }
      jsonMode = true;
      break;

    case "react_research":
      if (userMode === "disabled") {
        thinkingEnabled = false;
        temperature = 0.2;
      } else {
        thinkingEnabled = true;
        reasoningEffort = userEffort || "low";
      }
      jsonMode = false;
      break;

    case "tutor_chat":
      if (userMode === "disabled") {
        thinkingEnabled = false;
        temperature = opts.taskType === "plan" ? 0.3 : 0.6;
      } else if (userMode === "enabled") {
        thinkingEnabled = true;
        reasoningEffort = userEffort || "high";
      } else {
        // Auto mode: snappy "low" effort for free chat, "high" effort for deep teaching & scheduling
        thinkingEnabled = true;
        reasoningEffort =
          userEffort || (opts.taskType === "chat" ? "low" : "high");
      }
      jsonMode = false;
      break;
  }

  if (
    typeof opts.maxOutputTokensOverride === "number" &&
    Number.isFinite(opts.maxOutputTokensOverride) &&
    opts.maxOutputTokensOverride > 0
  ) {
    maxOutputTokens = opts.maxOutputTokensOverride;
  }

  if (spec && typeof maxOutputTokens === "number" && maxOutputTokens > spec.maxOutputTokens) {
    maxOutputTokens = spec.maxOutputTokens;
  }

  if (!opts.isDeepSeek) {
    return {
      thinkingEnabled,
      reasoningEffort,
      jsonMode,
      temperature,
      maxOutputTokens,
    };
  }

  const deepseekOpts: Record<string, unknown> = {
    thinking: { type: thinkingEnabled ? "enabled" : "disabled" },
  };
  if (thinkingEnabled && reasoningEffort) {
    // AI SDK openai-compatible maps `reasoningEffort` -> `reasoning_effort`
    deepseekOpts.reasoningEffort = reasoningEffort;
  }
  if (jsonMode) {
    deepseekOpts.response_format = { type: "json_object" };
  }
  if (opts.latestReminderDay) {
    const reminder = formatDeepSeekLatestReminder(opts.latestReminderDay);
    if (reminder) {
      deepseekOpts.deepseek_latest_reminder = reminder;
    }
  }
  if (opts.dynamicContextSystem?.trim()) {
    deepseekOpts.deepseek_dynamic_context = opts.dynamicContextSystem.trim();
  }

  return {
    thinkingEnabled,
    reasoningEffort,
    jsonMode,
    // DeepSeek ignores temperature in thinking mode — keep it undefined so request body stays clean
    temperature: thinkingEnabled ? undefined : temperature,
    maxOutputTokens,
    providerOptions: {
      deepseek: deepseekOpts,
    },
  };
}

/**
 * Determines whether a DeepSeek request body has Thinking Mode active.
 * Note: `deepseek-flash` and `deepseek-v4-pro` enable thinking mode BY DEFAULT when `thinking` is omitted!
 */
export function isThinkingActiveInRequestBody(
  body: Record<string, unknown>,
): boolean {
  const thinking = body.thinking as { type?: string } | undefined;
  if (thinking?.type === "disabled") return false;
  if (thinking?.type === "enabled") return true;
  const modelId = String(body.model || "").toLowerCase();
  const spec = getDeepSeekModelSpec(modelId);
  return spec ? spec.defaultThinkingEnabled : false;
}

/**
 * Request body middleware wired into `createOpenAICompatible({ transformRequestBody })`
 * ONLY when targeting DeepSeek APIs.
 *
 * Enforces every official DeepSeek Chat Completions contract:
 * 1. Thinking Mode parameter hygiene (strip ignored temperature/penalties; clamp/strip top_p; strip reasoning_effort when disabled).
 * 2. Multi-turn Tool Calls `reasoning_content` guard (prevents DeepSeek HTTP 400 when historical assistant messages lack `reasoning_content`).
 * 3. `latest_reminder` message injection strictly immediately before the last `user` message (never between tool_calls and tool results).
 * 4. JSON Mode prompt keyword guard (ensures "json" appears in prompt whenever `response_format.type === "json_object"`).
 */
export function transformDeepSeekRequestBody(
  rawArgs: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...rawArgs };
  const modelId = String(body.model || "").toLowerCase();
  const thinkingActive = isThinkingActiveInRequestBody(body);

  // Extract internal reminder & trailing dynamic context helpers before sending to DeepSeek API
  const latestReminder =
    typeof body.deepseek_latest_reminder === "string"
      ? body.deepseek_latest_reminder.trim()
      : "";
  delete body.deepseek_latest_reminder;

  const dynamicContextSystem =
    typeof body.deepseek_dynamic_context === "string"
      ? body.deepseek_dynamic_context.trim()
      : "";
  delete body.deepseek_dynamic_context;

  // 1. Parameter hygiene per thinking_mode.md
  if (thinkingActive) {
    delete body.temperature;
    delete body.presence_penalty;
    delete body.frequency_penalty;
    if (
      (modelId.includes("flash") || modelId === "") &&
      typeof body.top_p === "number"
    ) {
      // deepseek-flash clamps top_p to [0.95, 1.0] in thinking mode
      body.top_p = Math.min(1.0, Math.max(0.95, body.top_p));
    } else if (modelId.includes("v4-pro")) {
      // deepseek-v4-pro ignores top_p in thinking mode
      delete body.top_p;
    }
  } else {
    delete body.reasoning_effort;
    if (modelId.includes("flash")) {
      // deepseek-flash ignores top_p in non-thinking mode (fixed 1.0)
      delete body.top_p;
    }
  }

  // Clone messages array safely before transforming
  if (Array.isArray(body.messages)) {
    const messages = body.messages.map((m) =>
      m && typeof m === "object"
        ? ({ ...(m as Record<string, unknown>) } as Record<string, unknown>)
        : m,
    ) as Array<Record<string, unknown>>;

    const hasTools =
      Array.isArray(body.tools) &&
      body.tools.length > 0 &&
      body.tool_choice !== "none";

    // 2. Multi-turn Tool Calls + Thinking Mode `reasoning_content` guard (thinking_mode.md#tool-calls)
    if (thinkingActive && hasTools) {
      for (const msg of messages) {
        if (
          msg &&
          msg.role === "assistant" &&
          msg.reasoning_content === undefined
        ) {
          msg.reasoning_content = "";
        }
      }
    }

    // 3. Inject trailing dynamic `system` context & `latest_reminder` strictly before the LAST `user` message
    // (kv_cache.md + tool_calls.md mid-conversation system + latest_reminder.md)
    if (dynamicContextSystem || latestReminder) {
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx >= 0) {
        const toInsert: Array<Record<string, unknown>> = [];
        if (dynamicContextSystem) {
          const alreadyHasDynamic = messages.some(
            (m) => m?.role === "system" && m?.content === dynamicContextSystem,
          );
          if (!alreadyHasDynamic) {
            toInsert.push({ role: "system", content: dynamicContextSystem });
          }
        }
        if (latestReminder) {
          const prev = lastUserIdx > 0 ? messages[lastUserIdx - 1] : null;
          if (!prev || prev.role !== "latest_reminder") {
            toInsert.push({ role: "latest_reminder", content: latestReminder });
          }
        }
        if (toInsert.length > 0) {
          messages.splice(lastUserIdx, 0, ...toInsert);
        }
      }
    }

    // 4. JSON Mode guard (json_mode.md #2): prompt must mention "json"
    const rf = body.response_format as { type?: string } | undefined;
    if (rf?.type === "json_object") {
      const mentionsJson = messages.some((m) => {
        if (typeof m?.content === "string") {
          return /json/i.test(m.content);
        }
        if (Array.isArray(m?.content)) {
          return m.content.some(
            (part) =>
              part &&
              typeof part === "object" &&
              typeof (part as { text?: unknown }).text === "string" &&
              /json/i.test((part as { text: string }).text),
          );
        }
        return false;
      });
      if (!mentionsJson) {
        const sysMsg = messages.find(
          (m) => m?.role === "system" && typeof m.content === "string",
        );
        if (sysMsg) {
          sysMsg.content = `${sysMsg.content}\nPlease output a valid JSON object.`;
        } else {
          messages.unshift({
            role: "system",
            content: "Please output a valid JSON object.",
          });
        }
      }
    }

    body.messages = messages;
  }

  return body;
}

/**
 * Custom usage converter for DeepSeek Chat Completions so KV Disk Cache hits
 * (`prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`) and
 * `reasoning_tokens` are accurately mapped into AI SDK v6 `LanguageModelV3Usage`.
 */
export function convertDeepSeekUsage(
  rawUsage: Record<string, unknown> | null | undefined,
): LanguageModelV3Usage {
  if (!rawUsage || typeof rawUsage !== "object") {
    return {
      inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: undefined,
        text: undefined,
        reasoning: undefined,
      },
      raw: undefined,
    };
  }

  const promptTokens =
    typeof rawUsage.prompt_tokens === "number" ? rawUsage.prompt_tokens : 0;
  const completionTokens =
    typeof rawUsage.completion_tokens === "number"
      ? rawUsage.completion_tokens
      : 0;

  const promptDetails = rawUsage.prompt_tokens_details as
    | { cached_tokens?: number | null }
    | undefined;
  const completionDetails = rawUsage.completion_tokens_details as
    | { reasoning_tokens?: number | null }
    | undefined;

  const cacheHitRaw =
    typeof rawUsage.prompt_cache_hit_tokens === "number"
      ? rawUsage.prompt_cache_hit_tokens
      : typeof promptDetails?.cached_tokens === "number"
        ? promptDetails.cached_tokens
        : 0;

  const cacheMissRaw =
    typeof rawUsage.prompt_cache_miss_tokens === "number"
      ? rawUsage.prompt_cache_miss_tokens
      : Math.max(0, promptTokens - cacheHitRaw);

  const reasoningTokens =
    typeof completionDetails?.reasoning_tokens === "number"
      ? completionDetails.reasoning_tokens
      : 0;

  return {
    inputTokens: {
      total: promptTokens,
      noCache: cacheMissRaw,
      cacheRead: cacheHitRaw,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: completionTokens,
      text: Math.max(0, completionTokens - reasoningTokens),
      reasoning: reasoningTokens,
    },
    raw: rawUsage as Record<string, never>,
  };
}

export type DeepSeekUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheMissTokens: number;
  cacheHitRate: number;
  reasoningTokens: number;
};

/**
 * Extracts normalized token & KV-cache metrics from AI SDK v6 `usage` objects
 * for Agent Trace & Runtime observability.
 */
export function extractDeepSeekUsageSummary(
  usage: unknown,
): DeepSeekUsageSummary | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;

  const inputObj =
    u.inputTokens && typeof u.inputTokens === "object"
      ? (u.inputTokens as Record<string, unknown>)
      : null;
  const outputObj =
    u.outputTokens && typeof u.outputTokens === "object"
      ? (u.outputTokens as Record<string, unknown>)
      : null;
  const inputDetails =
    u.inputTokenDetails && typeof u.inputTokenDetails === "object"
      ? (u.inputTokenDetails as Record<string, unknown>)
      : null;
  const outputDetails =
    u.outputTokenDetails && typeof u.outputTokenDetails === "object"
      ? (u.outputTokenDetails as Record<string, unknown>)
      : null;
  const raw =
    u.raw && typeof u.raw === "object"
      ? (u.raw as Record<string, unknown>)
      : null;

  const inputTokens =
    typeof u.inputTokens === "number"
      ? u.inputTokens
      : typeof inputObj?.total === "number"
        ? inputObj.total
        : typeof raw?.prompt_tokens === "number"
          ? raw.prompt_tokens
          : 0;

  const outputTokens =
    typeof u.outputTokens === "number"
      ? u.outputTokens
      : typeof outputObj?.total === "number"
        ? outputObj.total
        : typeof raw?.completion_tokens === "number"
          ? raw.completion_tokens
          : 0;

  const cacheReadTokens =
    typeof inputDetails?.cacheReadTokens === "number"
      ? inputDetails.cacheReadTokens
      : typeof inputObj?.cacheRead === "number"
        ? inputObj.cacheRead
        : typeof u.cachedInputTokens === "number"
          ? u.cachedInputTokens
          : typeof raw?.prompt_cache_hit_tokens === "number"
            ? raw.prompt_cache_hit_tokens
            : 0;

  const cacheMissTokens =
    typeof inputDetails?.noCacheTokens === "number"
      ? inputDetails.noCacheTokens
      : typeof inputObj?.noCache === "number"
        ? inputObj.noCache
        : typeof raw?.prompt_cache_miss_tokens === "number"
          ? raw.prompt_cache_miss_tokens
          : Math.max(0, inputTokens - cacheReadTokens);

  const reasoningTokens =
    typeof outputDetails?.reasoningTokens === "number"
      ? outputDetails.reasoningTokens
      : typeof outputObj?.reasoning === "number"
        ? outputObj.reasoning
        : typeof u.reasoningTokens === "number"
          ? u.reasoningTokens
          : 0;

  const cacheHitRate =
    inputTokens > 0 ? Math.round((cacheReadTokens / inputTokens) * 1000) / 10 : 0;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheMissTokens,
    cacheHitRate,
    reasoningTokens,
  };
}

/**
 * Formats DeepSeek HTTP error codes (error_codes.md) into clear Chinese diagnostics.
 */
export function formatDeepSeekApiError(err: unknown): string {
  const rawMsg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "模型接口调用失败";
  const status =
    typeof (err as { statusCode?: unknown })?.statusCode === "number"
      ? ((err as { statusCode: number }).statusCode as number)
      : typeof (err as { status?: unknown })?.status === "number"
        ? ((err as { status: number }).status as number)
        : undefined;

  if (status === 401 || /\b401\b|invalid.*api.?key|unauthorized/i.test(rawMsg)) {
    return `DeepSeek 认证失败 (401)：请检查 API Key 是否有效。(${rawMsg.slice(0, 140)})`;
  }
  if (status === 402 || /\b402\b|insufficient.*balance/i.test(rawMsg)) {
    return "DeepSeek 账户余额不足 (402)：请前往 platform.deepseek.com 确认或充值余额。";
  }
  if (status === 422 || /\b422\b/.test(rawMsg)) {
    return `DeepSeek 请求参数错误 (422)：${rawMsg.slice(0, 180)}`;
  }
  if (status === 429 || /\b429\b|rate.?limit/i.test(rawMsg)) {
    return "DeepSeek 请求频率或并发达到上限 (429)：请稍后重试。";
  }
  if (status === 503 || /\b503\b/.test(rawMsg)) {
    return "DeepSeek 服务器当前繁忙 (503)：请稍后重试。";
  }
  if (status === 400 || /\b400\b/.test(rawMsg)) {
    return `DeepSeek 请求格式错误 (400)：${rawMsg.slice(0, 200)}`;
  }
  return rawMsg;
}
