import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import {
  type Store,
  available,
  dueReviews,
  focusLesson,
  formatDayWithWeekday,
  getActiveMemories,
  getActiveTrack,
  getMissedSessions,
  getTracks,
  isRemedialBlock,
  offset,
  time,
  weekdayLabel,
} from "./learning";
import {
  analyzeScheduleFeasibility,
  extractMemoryPreferences,
  findFreeWindows,
  getWakingBounds,
} from "./scheduler";
import {
  type ClientModelConfig,
  PROVIDER_PRESETS,
  isClientConfigActive,
} from "./model-config";
import {
  type DeepSeekReasoningEffort,
  type DeepSeekThinkingMode,
  convertDeepSeekUsage,
  isDeepSeekProvider,
  normalizeDeepSeekBaseUrl,
  transformDeepSeekRequestBody,
} from "./deepseek-config";

export function isLiveModelConfigured(): boolean {
  const hasGateway = Boolean(
    process.env.AI_GATEWAY_API_KEY && process.env.ATLAS_MODEL,
  );
  const hasDirect = Boolean(
    (process.env.OPENAI_API_KEY &&
      (process.env.ATLAS_MODEL || process.env.OPENAI_MODEL)) ||
      process.env.DEEPSEEK_API_KEY,
  );
  return hasGateway || hasDirect;
}

export function getServerModelSummary(): {
  configured: boolean;
  providerLabel: string;
  modelId?: string;
} {
  if (process.env.AI_GATEWAY_API_KEY && process.env.ATLAS_MODEL) {
    return {
      configured: true,
      providerLabel: "Vercel AI Gateway (.env)",
      modelId: process.env.ATLAS_MODEL,
    };
  }
  if (
    process.env.OPENAI_API_KEY &&
    (process.env.ATLAS_MODEL || process.env.OPENAI_MODEL)
  ) {
    const isDs = /deepseek/i.test(process.env.OPENAI_BASE_URL || "");
    return {
      configured: true,
      providerLabel: isDs ? "DeepSeek 直连 (.env)" : "OpenAI 兼容直连 (.env)",
      modelId: process.env.ATLAS_MODEL || process.env.OPENAI_MODEL,
    };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      configured: true,
      providerLabel: "DeepSeek 直连 (.env)",
      modelId: process.env.ATLAS_MODEL || "deepseek-flash",
    };
  }
  return { configured: false, providerLabel: "本地多步兜底" };
}

export type ResolvedLanguageModel = {
  model: LanguageModel | string;
  label: string;
  providerName: string;
  modelId: string;
  isDeepSeek: boolean;
  thinkingMode?: DeepSeekThinkingMode;
  reasoningEffort?: DeepSeekReasoningEffort;
};

function createConfiguredOpenAICompatibleProvider(opts: {
  providerName: string;
  baseURL: string;
  apiKey: string;
  modelId: string;
}) {
  const deepseek = isDeepSeekProvider({
    providerName: opts.providerName,
    baseUrl: opts.baseURL,
    modelId: opts.modelId,
  });

  if (deepseek) {
    return {
      isDeepSeek: true,
      effectiveProviderName: "deepseek",
      provider: createOpenAICompatible({
        name: "deepseek",
        baseURL: normalizeDeepSeekBaseUrl(opts.baseURL),
        apiKey: opts.apiKey,
        includeUsage: true,
        transformRequestBody: transformDeepSeekRequestBody,
        convertUsage: (usage) =>
          convertDeepSeekUsage(usage as Record<string, unknown> | null | undefined),
      }),
    };
  }

  return {
    isDeepSeek: false,
    effectiveProviderName: opts.providerName,
    provider: createOpenAICompatible({
      name: opts.providerName,
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
    }),
  };
}

/**
 * Resolves a Vercel AI SDK v6 LanguageModel (or Gateway string) from:
 * 1. Client-provided runtime model config (from Settings Modal), OR
 * 2. Server `.env.local` Vercel AI Gateway (`AI_GATEWAY_API_KEY` + `ATLAS_MODEL`), OR
 * 3. Server `.env.local` OpenAI-compatible direct provider (`OPENAI_API_KEY` + `OPENAI_BASE_URL` + `ATLAS_MODEL`).
 */
export function resolveLanguageModel(
  clientConfig?: ClientModelConfig | null,
): ResolvedLanguageModel | null {
  const userThinkingMode = clientConfig?.thinkingMode;
  const userReasoningEffort = clientConfig?.reasoningEffort;

  // 1. Runtime client settings override
  if (isClientConfigActive(clientConfig)) {
    const cfg = clientConfig!;
    const modelId = cfg.modelId!.trim();
    const apiKey = cfg.apiKey!.trim();

    if (cfg.provider === "gateway") {
      const provider = createOpenAICompatible({
        name: "vercel-ai-gateway",
        baseURL: cfg.baseUrl?.trim() || "https://ai-gateway.vercel.sh/v1",
        apiKey,
      });
      return {
        model: provider.chatModel(modelId),
        label: `AI Gateway (${modelId})`,
        providerName: "vercel-ai-gateway",
        modelId,
        isDeepSeek: false,
      };
    }

    const preset = PROVIDER_PRESETS.find((p) => p.id === cfg.provider);
    const baseURL =
      cfg.baseUrl?.trim() ||
      preset?.defaultBaseUrl ||
      "https://api.openai.com/v1";

    const built = createConfiguredOpenAICompatibleProvider({
      providerName: cfg.provider,
      baseURL,
      apiKey,
      modelId,
    });
    return {
      model: built.provider.chatModel(modelId),
      label: `${preset?.name || built.effectiveProviderName} (${modelId})`,
      providerName: built.effectiveProviderName,
      modelId,
      isDeepSeek: built.isDeepSeek,
      thinkingMode: userThinkingMode,
      reasoningEffort: userReasoningEffort,
    };
  }

  // 2. Server .env.local Vercel AI Gateway
  if (process.env.AI_GATEWAY_API_KEY && process.env.ATLAS_MODEL) {
    return {
      model: process.env.ATLAS_MODEL,
      label: `Vercel AI Gateway (${process.env.ATLAS_MODEL})`,
      providerName: "vercel-ai-gateway",
      modelId: process.env.ATLAS_MODEL,
      isDeepSeek: false,
    };
  }

  // 3. Server .env.local OpenAI-compatible direct provider (OpenAI / DeepSeek / Gemini / Ollama)
  const directKey = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY;
  const directModel =
    process.env.ATLAS_MODEL ||
    process.env.OPENAI_MODEL ||
    (process.env.DEEPSEEK_API_KEY ? "deepseek-flash" : undefined);
  if (directKey && directModel) {
    const baseUrl =
      process.env.OPENAI_BASE_URL ||
      (process.env.DEEPSEEK_API_KEY && !process.env.OPENAI_API_KEY
        ? "https://api.deepseek.com"
        : "https://api.openai.com/v1");
    const detectedName = /deepseek/i.test(baseUrl)
      ? "deepseek"
      : /dashscope/i.test(baseUrl)
        ? "qwen"
        : /generativelanguage/i.test(baseUrl)
          ? "gemini"
          : /openrouter/i.test(baseUrl)
            ? "openrouter"
            : /11434|ollama/i.test(baseUrl)
              ? "ollama"
              : "openai-compatible";

    const built = createConfiguredOpenAICompatibleProvider({
      providerName: detectedName,
      baseURL: baseUrl,
      apiKey: directKey,
      modelId: directModel,
    });
    return {
      model: built.provider.chatModel(directModel),
      label: `${built.effectiveProviderName} (${directModel})`,
      providerName: built.effectiveProviderName,
      modelId: directModel,
      isDeepSeek: built.isDeepSeek,
      thinkingMode: userThinkingMode,
      reasoningEffort: userReasoningEffort,
    };
  }

  return null;
}

/**
 * Formats key store context into a concise structured prompt block so Live LLMs
 * genuinely respect the user's active goal, BKT/FSRS mastery state, memories, and calendar.
 */
export function formatStoreContextForLLM(
  s: Store,
  day: string,
  opts: { taskType?: "learn" | "plan" | "chat" } = {},
): string {
  const taskType = opts.taskType;
  const waking = getWakingBounds(s.scheduleSettings);

  // MEM-09: For unrelated general chat, avoid injecting learning goals/preferences/background memories
  if (taskType === "chat") {
    return [
      `当前日期：${day}（${formatDayWithWeekday(day)}，星期：${weekdayLabel(day)}）`,
      `睡眠保护硬红线：${time(waking.wakeEnd)}–${time(waking.wakeStart)}`,
      `说明：当前为自由对话模式，未注入个人学习目标与偏好记忆；如用户提出学习或排程请求，可调用 read_workspace_state 获取完整工作区状态。`,
    ].join("\n");
  }

  const active = getActiveTrack(s);
  const focus = active ? focusLesson(s, active.id) : null;
  const activeMemories = getActiveMemories(s.memories, day);
  const prefs = extractMemoryPreferences(activeMemories, day);
  const freeToday = findFreeWindows(
    s.blocks,
    day,
    480,
    1380,
    15,
    s.scheduleSettings,
  );
  const reviews = dueReviews(s, day);
  const missed = getMissedSessions(s, day);
  const feasibility = analyzeScheduleFeasibility(s, day, 7);

  const memoryLines = activeMemories
    .filter((m) => m.category !== "record")
    .slice(0, 8)
    .map(
      (m) =>
        `- [${m.label}${m.expiresAt ? ` · 有效期至 ${m.expiresAt}` : ""}] ${m.text}`,
    )
    .join("\n");

  const trackList = getTracks(s);
  const trackSummary = trackList.length
    ? trackList
        .map((t) => {
          const done = t.units.filter((u) => (s.mastery[u.id] ?? 0) >= 80).length;
          return `- ${t.title}（${done}/${t.units.length} 已掌握${t.id === active?.id ? " · 当前活跃" : ""}）`;
        })
        .join("\n")
    : "- 暂无学习目标轨道";

  const unitSummary = active
    ? active.units
        .map(
          (u) =>
            `  · ${u.title} (${u.id}): BKT掌握度 ${s.mastery[u.id] ?? 0}%，状态=${
              (s.mastery[u.id] ?? 0) >= 80
                ? "已掌握"
                : available(s, u)
                  ? "可学习"
                  : "待解锁"
            }`,
        )
        .join("\n")
    : "  · 尚未创建课程节点";

  const freeText = freeToday
    .map((w) => `${time(w.start)}–${time(w.end)}(${w.minutes}m)`)
    .join("、");

  const upcomingScheduleLines = s.blocks
    .filter((b) => b.day >= day && b.day <= offset(day, 6))
    .sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start)
    .slice(0, 18)
    .map((b) => {
      const tag = b.lesson
        ? isRemedialBlock(b)
          ? "补救/复习课"
          : "正课"
        : b.kind;
      return `  · ${b.day}（${formatDayWithWeekday(b.day)}）${time(b.start)}–${time(b.start + b.minutes)}（${b.minutes}分钟）[${tag}] ${b.title}${b.done ? " (已完成)" : ""}`;
    })
    .join("\n");

  return [
    `当前日期：${day}（${formatDayWithWeekday(day)}，星期：${weekdayLabel(day)}）`,
    active && focus
      ? `当前活跃轨道：${active.title}（推荐下一课：${focus.title}）`
      : "当前活跃轨道：暂无（用户尚未创建学习目标）",
    `全部学习轨道：\n${trackSummary}`,
    `当前轨道节点状态：\n${unitSummary}`,
    `已排日程表（提及日期、星期、时间时必须严格以此为准，严禁自行推算星期几）：\n${upcomingScheduleLines || "  · 暂无已排日程"}`,
    `今日（${formatDayWithWeekday(day)}）剩余空闲窗口：${freeText || "全天均可自由安排"}`,
    `FSRS 高遗忘风险/到期复习项：${
      reviews.length
        ? reviews
            .map(
              (r) =>
                `${r.lesson.title}(掌握度 ${r.mastery}% / 保持率 ${r.retrievability}%)`,
            )
            .join("、")
        : "暂无"
    }`,
    `睡眠保护硬红线：${time(waking.wakeEnd)}–${time(waking.wakeStart)}（严禁在此期间排课）`,
    `未来 7 天负荷评估：${feasibility.summary}`,
    `前期未完成错课数：${missed.length} 项${missed.length ? `（${missed.map((b) => b.title).join("、")}）` : ""}`,
    `生效排程约束：${prefs.summary}`,
    `用户长期记忆：\n${memoryLines || "- 暂无"}`,
  ].join("\n");
}
