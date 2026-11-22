import type { ClientModelConfig } from "./model-config";

export type KnowledgeAcquisitionMode =
  | "auto_web"
  | "quick_draft"
  | "user_materials";

export type LearningDomain =
  | "programming"
  | "math"
  | "humanities"
  | "general";

export type WebSearchResult = {
  rerank_score: number;
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  site_name: string | null;
  site_icon: string | null;
  date: string | null;
  authority: number;
};

export type ResearchSourceRef = {
  url: string;
  title: string;
  siteName: string | null;
  authority: number;
  rerankScore: number;
  date: string | null;
  retrievedAt: string;
  excerpt: string;
  origin: "deepseek_search" | "deepseek_fetch" | "user_material";
};

export type WebSearchErrorCode =
  | "NO_DEEPSEEK_KEY"
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "INSUFFICIENT_BALANCE"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR";

export class WebResearchError extends Error {
  readonly code: WebSearchErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    code: WebSearchErrorCode,
    message: string,
    opts: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "WebResearchError";
    this.code = code;
    this.status = opts.status;
    this.retryable = Boolean(opts.retryable);
  }
}

export type FetchLike = typeof fetch;

const DEFAULT_DEEPSEEK_TOOLS_BASE = "https://api.deepseek.com";
const MAX_QUERY_CHARS = 128;
const MAX_URL_CHARS = 8192;
const MAX_STORED_EXCERPT_CHARS = 3200;

/**
 * Resolves a DeepSeek API key suitable for DeepSeek Search / Fetch APIs:
 * 1. Explicit DEEPSEEK_API_KEY env var
 * 2. Active client config targeting DeepSeek
 * 3. Server OPENAI_API_KEY when OPENAI_BASE_URL points to DeepSeek
 */
export function resolveDeepSeekToolsAuth(
  clientConfig?: ClientModelConfig | null,
): { apiKey: string; baseUrl: string } | null {
  const baseUrl = (
    process.env.DEEPSEEK_TOOLS_BASE_URL || DEFAULT_DEEPSEEK_TOOLS_BASE
  ).replace(/\/+$/, "");

  if (process.env.DEEPSEEK_API_KEY?.trim()) {
    return { apiKey: process.env.DEEPSEEK_API_KEY.trim(), baseUrl };
  }

  if (
    clientConfig?.apiKey?.trim() &&
    (clientConfig.provider === "deepseek" ||
      /deepseek/i.test(clientConfig.baseUrl || ""))
  ) {
    return { apiKey: clientConfig.apiKey.trim(), baseUrl };
  }

  if (
    process.env.OPENAI_API_KEY?.trim() &&
    /deepseek/i.test(process.env.OPENAI_BASE_URL || "")
  ) {
    return { apiKey: process.env.OPENAI_API_KEY.trim(), baseUrl };
  }

  return null;
}

export function clampSearchQuery(raw: string): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return Array.from(cleaned).slice(0, MAX_QUERY_CHARS).join("");
}

export function validateFetchUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > MAX_URL_CHARS) {
    throw new WebResearchError(
      "INVALID_REQUEST",
      "URL 为空或超过 8192 字符上限。",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WebResearchError("INVALID_REQUEST", `无效的 URL：${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebResearchError(
      "INVALID_REQUEST",
      "仅支持 HTTP 或 HTTPS 网页地址。",
    );
  }
  if (!parsed.hostname) {
    throw new WebResearchError("INVALID_REQUEST", "URL 缺少有效主机名。");
  }
  if (parsed.username || parsed.password) {
    throw new WebResearchError(
      "INVALID_REQUEST",
      "安全限制：不允许在抓取 URL 中携带用户名或密码。",
    );
  }
  return parsed.toString();
}

function classifyHttpError(status: number, bodyText: string): WebResearchError {
  let apiMsg = "";
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } };
    apiMsg = parsed.error?.message || "";
  } catch {
    apiMsg = bodyText.slice(0, 160);
  }

  if (status === 400 || status === 413) {
    return new WebResearchError(
      "INVALID_REQUEST",
      apiMsg || `检索请求参数不合法 (HTTP ${status})`,
      { status, retryable: false },
    );
  }
  if (status === 401) {
    return new WebResearchError(
      "UNAUTHORIZED",
      apiMsg || "DeepSeek API Key 无效或缺失 (HTTP 401)",
      { status, retryable: false },
    );
  }
  if (status === 402) {
    return new WebResearchError(
      "INSUFFICIENT_BALANCE",
      apiMsg || "DeepSeek 账号余额不足，无法执行联网检索 (HTTP 402)",
      { status, retryable: false },
    );
  }
  if (status === 403) {
    return new WebResearchError(
      "FORBIDDEN",
      apiMsg || "目标网页被安全策略拒绝抓取 (HTTP 403)",
      { status, retryable: false },
    );
  }
  if (status === 404) {
    return new WebResearchError(
      "NOT_FOUND",
      apiMsg || "未能提取可用网页内容 (HTTP 404)",
      { status, retryable: false },
    );
  }
  if (status === 408) {
    return new WebResearchError(
      "TIMEOUT",
      apiMsg || "联网检索请求超时 (HTTP 408)",
      { status, retryable: true },
    );
  }
  if (status === 429) {
    return new WebResearchError(
      "RATE_LIMITED",
      apiMsg || "触发 DeepSeek 检索/抓取 QPS 限速 (HTTP 429)",
      { status, retryable: true },
    );
  }
  if (status >= 500) {
    return new WebResearchError(
      "UPSTREAM_ERROR",
      apiMsg || `联网检索服务暂时不可用 (HTTP ${status})`,
      { status, retryable: true },
    );
  }
  return new WebResearchError(
    "UPSTREAM_ERROR",
    apiMsg || `未知响应错误 (HTTP ${status})`,
    { status, retryable: false },
  );
}

async function postJsonWithRetry<T>(opts: {
  url: string;
  apiKey: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchLike;
  abortSignal?: AbortSignal;
}): Promise<T> {
  const fetchFn = opts.fetchImpl || fetch;
  const maxRetries = opts.maxRetries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15000;
  let lastError: WebResearchError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await fetchFn(opts.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(opts.payload),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        const err = classifyHttpError(res.status, text);
        if (!err.retryable || attempt === maxRetries) {
          throw err;
        }
        lastError = err;
      } else {
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new WebResearchError(
            "UPSTREAM_ERROR",
            "联网接口返回了非 JSON 内容。",
            { status: res.status, retryable: false },
          );
        }
      }
    } catch (err) {
      if (err instanceof WebResearchError) {
        if (!err.retryable || attempt === maxRetries) throw err;
        lastError = err;
      } else {
        const isAbort =
          err instanceof Error &&
          (err.name === "AbortError" || /abort/i.test(err.message));
        const wrapped = new WebResearchError(
          isAbort ? "TIMEOUT" : "NETWORK_ERROR",
          isAbort
            ? "联网检索请求超时。"
            : err instanceof Error
              ? err.message
              : "网络请求失败。",
          { retryable: !opts.abortSignal?.aborted },
        );
        if (!wrapped.retryable || attempt === maxRetries) throw wrapped;
        lastError = wrapped;
      }
    } finally {
      clearTimeout(timer);
      opts.abortSignal?.removeEventListener("abort", onAbort);
    }

    // Bounded exponential backoff for 408 / 429 / 5xx / transient network errors
    const backoffMs = 250 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, backoffMs));
  }

  throw (
    lastError ||
    new WebResearchError("UPSTREAM_ERROR", "联网检索重试后仍失败。")
  );
}

/**
 * DeepSeek Search API: POST https://api.deepseek.com/v1/tools/search
 */
export async function deepseekWebSearch(opts: {
  query: string;
  count?: number;
  oriQuestion?: string;
  needContent?: boolean;
  localization?: string;
  clientConfig?: ClientModelConfig | null;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<{
  query: string;
  results: WebSearchResult[];
  retrievedAt: string;
}> {
  const query = clampSearchQuery(opts.query);
  if (!query) {
    throw new WebResearchError("INVALID_REQUEST", "搜索词不能为空。");
  }

  const resolvedAuth =
    opts.apiKey?.trim()
      ? {
          apiKey: opts.apiKey.trim(),
          baseUrl: (opts.baseUrl || DEFAULT_DEEPSEEK_TOOLS_BASE).replace(
            /\/+$/,
            "",
          ),
        }
      : resolveDeepSeekToolsAuth(opts.clientConfig);

  if (!resolvedAuth) {
    throw new WebResearchError(
      "NO_DEEPSEEK_KEY",
      "未检测到可用的 DeepSeek API Key，将自动切换为快速生成模式。",
      { retryable: false },
    );
  }

  const count = Math.max(1, Math.min(50, Math.round(opts.count ?? 6)));
  const payload: Record<string, unknown> = {
    query,
    count,
    need_content: Boolean(opts.needContent),
  };
  const ori = opts.oriQuestion ? clampSearchQuery(opts.oriQuestion) : "";
  if (ori) payload.ori_question = ori;
  if (opts.localization?.trim()) payload.localization = opts.localization.trim();

  const data = await postJsonWithRetry<{ results?: unknown[] }>({
    url: `${resolvedAuth.baseUrl}/v1/tools/search`,
    apiKey: resolvedAuth.apiKey,
    payload,
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
    fetchImpl: opts.fetchImpl,
    abortSignal: opts.abortSignal,
  });

  const retrievedAt = new Date().toISOString();
  const rawList = Array.isArray(data?.results) ? data.results : [];
  const results: WebSearchResult[] = rawList
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((r) => ({
      rerank_score: Number(r.rerank_score ?? 0),
      title: String(r.title ?? "").trim(),
      url: String(r.url ?? "").trim(),
      snippet: String(r.snippet ?? "").trim(),
      summary: String(r.summary ?? "").trim(),
      content: String(r.content ?? "").slice(0, MAX_STORED_EXCERPT_CHARS),
      site_name: r.site_name != null ? String(r.site_name) : null,
      site_icon: r.site_icon != null ? String(r.site_icon) : null,
      date: r.date != null ? String(r.date) : null,
      authority: Number.isFinite(Number(r.authority)) ? Number(r.authority) : -1,
    }))
    .filter((r) => Boolean(r.url && r.title));

  // Rank authoritative and high-rerank results first
  results.sort((a, b) => {
    const aScore = (a.authority >= 3 ? 1.2 : a.authority >= 2 ? 0.5 : 0) + a.rerank_score;
    const bScore = (b.authority >= 3 ? 1.2 : b.authority >= 2 ? 0.5 : 0) + b.rerank_score;
    return bScore - aScore;
  });

  return { query, results, retrievedAt };
}

/**
 * DeepSeek Fetch API: POST https://api.deepseek.com/v1/tools/fetch
 * Extracts bounded excerpts & metadata rather than storing full site mirrors.
 */
export async function deepseekWebFetch(opts: {
  url: string;
  maxExcerptChars?: number;
  clientConfig?: ClientModelConfig | null;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<{
  url: string;
  title: string;
  excerpt: string;
  truncated: boolean;
  retrievedAt: string;
}> {
  const validUrl = validateFetchUrl(opts.url);
  const resolvedAuth =
    opts.apiKey?.trim()
      ? {
          apiKey: opts.apiKey.trim(),
          baseUrl: (opts.baseUrl || DEFAULT_DEEPSEEK_TOOLS_BASE).replace(
            /\/+$/,
            "",
          ),
        }
      : resolveDeepSeekToolsAuth(opts.clientConfig);

  if (!resolvedAuth) {
    throw new WebResearchError(
      "NO_DEEPSEEK_KEY",
      "未检测到可用的 DeepSeek API Key，无法抓取网页。",
      { retryable: false },
    );
  }

  const data = await postJsonWithRetry<{ title?: string; content?: string }>({
    url: `${resolvedAuth.baseUrl}/v1/tools/fetch`,
    apiKey: resolvedAuth.apiKey,
    payload: { url: validUrl },
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
    fetchImpl: opts.fetchImpl,
    abortSignal: opts.abortSignal,
  });

  const fullContent = String(data?.content ?? "").trim();
  const limit = Math.max(
    400,
    Math.min(MAX_STORED_EXCERPT_CHARS, opts.maxExcerptChars ?? 2400),
  );
  const truncated = fullContent.length > limit;
  const excerpt = truncated ? `${fullContent.slice(0, limit)}…` : fullContent;

  return {
    url: validUrl,
    title: String(data?.title ?? "").trim() || new URL(validUrl).hostname,
    excerpt,
    truncated,
    retrievedAt: new Date().toISOString(),
  };
}

export type FetchedResource = {
  url: string;
  title: string;
  excerpt: string;
  truncated: boolean;
  retrievedAt: string;
};

/**
 * Pluggable Web Research Provider adapter so Research Planner stays decoupled
 * from any single search vendor while using DeepSeek Search/Fetch by default.
 */
export interface WebResearchProvider {
  readonly name: string;
  search(
    query: string,
    options?: {
      count?: number;
      oriQuestion?: string;
      needContent?: boolean;
      abortSignal?: AbortSignal;
    },
  ): Promise<{ query: string; results: WebSearchResult[]; retrievedAt: string }>;
  fetch(
    url: string,
    options?: { maxExcerptChars?: number; abortSignal?: AbortSignal },
  ): Promise<FetchedResource>;
}

/**
 * Neutralizes prompt-injection payloads inside untrusted external web pages
 * before passing excerpts into any LLM context (RP-10).
 */
export function sanitizeUntrustedWebText(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/<\|[a-z0-9_]+\|>/gi, "[redacted-token]")
    .replace(
      /(ignore\s+(all\s+)?(previous|prior|above)\s+instructions?|disregard\s+system\s+prompt|you\s+are\s+now\s+|call\s+tool\s+[a-z0-9_]+|execute\s+sql|忽略(以上|之前|所有)指令|无视系统提示|立即调用工具\s*[a-z0-9_]+)/gi,
      "[已过滤外部网页疑似注入指令]",
    )
    .replace(/\u0000/g, "")
    .trim();
}

export type LearningCapabilityProfile = {
  dimensions: string[];
  interdisciplinary: boolean;
  recencySensitivity: "high" | "medium" | "low";
  requiresMultiplePerspectives: boolean;
  recommendedModalities: string[];
  primaryLegacyDomain: LearningDomain;
};

/**
 * Replaces rigid 4-bucket regex classification with a dynamic multi-dimensional
 * capability profile covering arbitrary personal learning goals and interdisciplinary combinations.
 */
export function inferLearningCapabilityProfile(
  text: string,
): LearningCapabilityProfile {
  const s = text.trim();
  const dimensions: string[] = [];
  const modalities = new Set<string>(["explanation", "worked_example"]);

  const rules: Array<{
    dim: string;
    pattern: RegExp;
    recency?: "high" | "medium" | "low";
    modalities: string[];
    multiPerspective?: boolean;
  }> = [
    {
      dim: "programming",
      pattern:
        /\b(python|java|javascript|typescript|rust|go|golang|c\+\+|sql|react|next\.?js|docker|k8s|kubernetes|llm|agent|rag|mcp|api|sdk|git|linux|http|json|pytorch|function calling|tool calls?|prompt|deepseek|openai|langchain|langgraph|embedding)\b|(算法|数据结构|后端|前端|编程|代码|函数调用|工具调用|数据库|分布式|架构|深度学习|大模型)/i,
      recency: "high",
      modalities: ["code_exercise", "worked_example", "diagram", "guided_practice"],
    },
    {
      dim: "mathematics",
      pattern:
        /\b(calculus|linear algebra|matrix|eigen|theorem|proof|differential|topology)\b|(微积分|线性代数|矩阵|特征值|微分方程|拓扑|组合数学|数论|几何|高等数学|公式|定理|推导)/i,
      recency: "low",
      modalities: ["math_problem", "worked_example", "diagram", "short_answer"],
    },
    {
      dim: "statistics_probability",
      pattern:
        /\b(probability|statistics|bayes|regression|distribution|hypothesis|variance)\b|(概率论|条件概率|贝叶斯|数理统计|统计回归|回归分析|假设检验|方差|正态分布)/i,
      recency: "low",
      modalities: ["math_problem", "worked_example", "diagram", "multiple_choice"],
    },
    {
      dim: "economics_business",
      pattern:
        /\b(economics|macroeconomics|microeconomics|finance|accounting|marketing|strategy|management)\b|(经济|宏观|微观|金融|会计|商业|管理|财务|市场营销|博弈论)/i,
      recency: "medium",
      modalities: ["worked_example", "short_answer", "essay", "diagram"],
      multiPerspective: true,
    },
    {
      dim: "data_visualization",
      pattern:
        /\b(data analysis|data science|visualization|pandas|matplotlib|tableau|chart)\b|(数据分析|可视化|图表|数据科学)/i,
      recency: "medium",
      modalities: ["code_exercise", "diagram", "project"],
    },
    {
      dim: "history_humanities",
      pattern:
        /\b(history|philosophy|literature|sociology|psychology|historical|renaissance|revolution)\b|(历史|哲学|文学|史学|朝代|唐朝|宋朝|明清|工业革命|文艺复兴|近代史|世界史|思想史|社会学|伦理学|心理学|史料|批判性阅读)/i,
      recency: "low",
      modalities: ["reading", "diagram", "essay", "short_answer", "order_steps"],
      multiPerspective: true,
    },
    {
      dim: "photography_visual_arts",
      pattern:
        /\b(photography|camera|exposure|aperture|shutter|iso|portrait|composition|lighting|design|drawing|painting)\b|(摄影|相机|人像|曝光|光圈|快门|构图|布光|景深|调色|绘画|素描|设计|色彩)/i,
      recency: "low",
      modalities: ["diagram", "worked_example", "guided_practice", "project", "multiple_choice"],
    },
    {
      dim: "language_learning",
      pattern:
        /\b(english|japanese|french|spanish|german|grammar|vocabulary|ielts|toefl|speaking|listening)\b|(英语|日语|法语|德语|语法|词汇|口语|听力|雅思|托福|翻译|写作)/i,
      recency: "low",
      modalities: ["flashcard", "fill_blank", "reading", "short_answer"],
    },
    {
      dim: "natural_sciences",
      pattern:
        /\b(physics|chemistry|biology|medicine|anatomy|genetics|quantum|thermodynamics)\b|(物理|化学|生物|医学|解剖|遗传|量子|热力学|有机化学)/i,
      recency: "medium",
      modalities: ["diagram", "worked_example", "math_problem", "multiple_choice"],
    },
    {
      dim: "music_theory",
      pattern:
        /\b(music theory|chord|harmony|rhythm|piano|guitar|melody)\b|(乐理|和弦|和声|节奏|钢琴|吉他|编曲|视唱)/i,
      recency: "low",
      modalities: ["diagram", "guided_practice", "flashcard", "project"],
    },
  ];

  let recencyRank = 0; // 0=low, 1=medium, 2=high
  let requiresMultiplePerspectives = false;

  for (const r of rules) {
    if (r.pattern.test(s)) {
      dimensions.push(r.dim);
      for (const m of r.modalities) modalities.add(m);
      if (r.recency === "high") recencyRank = Math.max(recencyRank, 2);
      else if (r.recency === "medium") recencyRank = Math.max(recencyRank, 1);
      if (r.multiPerspective) requiresMultiplePerspectives = true;
    }
  }

  if (dimensions.length === 0) {
    dimensions.push("general_skill");
    modalities.add("guided_practice");
    modalities.add("short_answer");
  }

  const primaryLegacyDomain: LearningDomain = dimensions.includes("programming")
    ? "programming"
    : dimensions.includes("mathematics") ||
        dimensions.includes("statistics_probability")
      ? "math"
      : dimensions.includes("history_humanities")
        ? "humanities"
        : "general";

  return {
    dimensions,
    interdisciplinary: dimensions.length >= 2,
    recencySensitivity:
      recencyRank === 2 ? "high" : recencyRank === 1 ? "medium" : "low",
    requiresMultiplePerspectives,
    recommendedModalities: [...modalities],
    primaryLegacyDomain,
  };
}

export function createDeepSeekWebResearchProvider(opts: {
  clientConfig?: ClientModelConfig | null;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
} = {}): WebResearchProvider {
  return {
    name: "deepseek",
    async search(query, searchOpts) {
      const res = await deepseekWebSearch({
        query,
        count: searchOpts?.count ?? 6,
        oriQuestion: searchOpts?.oriQuestion,
        needContent: searchOpts?.needContent,
        abortSignal: searchOpts?.abortSignal,
        clientConfig: opts.clientConfig,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        fetchImpl: opts.fetchImpl,
      });
      return {
        ...res,
        results: res.results.map((r) => ({
          ...r,
          title: sanitizeUntrustedWebText(r.title),
          snippet: sanitizeUntrustedWebText(r.snippet),
          summary: sanitizeUntrustedWebText(r.summary),
          content: sanitizeUntrustedWebText(r.content),
        })),
      };
    },
    async fetch(url, fetchOpts) {
      const res = await deepseekWebFetch({
        url,
        maxExcerptChars: fetchOpts?.maxExcerptChars,
        abortSignal: fetchOpts?.abortSignal,
        clientConfig: opts.clientConfig,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        fetchImpl: opts.fetchImpl,
      });
      return {
        ...res,
        title: sanitizeUntrustedWebText(res.title),
        excerpt: sanitizeUntrustedWebText(res.excerpt),
      };
    },
  };
}

/**
 * Legacy helper retained for backwards compatibility — delegates to inferLearningCapabilityProfile.
 */
export function classifyLearningDomain(text: string): LearningDomain {
  return inferLearningCapabilityProfile(text).primaryLegacyDomain;
}

export function searchResultToSourceRef(
  r: WebSearchResult,
  retrievedAt: string,
): ResearchSourceRef {
  return {
    url: r.url,
    title: r.title,
    siteName: r.site_name,
    authority: r.authority,
    rerankScore: r.rerank_score,
    date: r.date,
    retrievedAt,
    excerpt: (r.summary || r.snippet || r.content || "").slice(0, 600),
    origin: "deepseek_search",
  };
}
