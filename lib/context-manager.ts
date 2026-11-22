import { getToolName, isToolUIPart, type UIMessage } from "ai";

export type ContextTaskType = "learn" | "plan" | "chat";

export type ContextCompactionStats = {
  taskType: ContextTaskType;
  selectedSections: string[];
  originalTokens: number;
  compactedTokens: number;
  toolSchemaTokens: number;
  savedTokens: number;
  savedPct: number;
  foldedToolCount: number;
  rollingCompacted: boolean;
  summaryUsed: boolean;
  inputDegraded: boolean;
  totalMessages: number;
  keptMessages: number;
  budgetTokens: number;
  aggressive: boolean;
};

/**
 * CTX-10 / CTX-17: Resolves a safe context budget based on the active model's context window
 * rather than hardcoding 24,000 tokens for every model.
 */
export function resolveModelContextBudget(
  modelId?: string,
  explicitWindowTokens?: number,
): number {
  if (
    typeof explicitWindowTokens === "number" &&
    Number.isFinite(explicitWindowTokens) &&
    explicitWindowTokens >= 1024
  ) {
    return Math.max(1024, Math.floor(explicitWindowTokens * 0.72));
  }
  const id = (modelId || "").toLowerCase();
  const explicitK = id.match(/(?:^|[-_/:])(\d{1,3})k(?:$|[-_/:])/);
  if (explicitK) {
    const k = Number(explicitK[1]);
    if (Number.isFinite(k) && k >= 2 && k <= 1024) {
      return Math.max(1500, Math.floor(k * 1000 * 0.72));
    }
  }
  if (/gpt-3\.5|4096|small-window|mini-4k/.test(id)) return 2800;
  if (/8192|llama-3-8b|qwen-7b/.test(id)) return 5800;
  if (/16384|16k/.test(id)) return 11500;
  // DeepSeek V4 / V4.1 series support 1M context window — use a generous working budget while keeping latency sharp
  if (/deepseek-(flash|v4)/.test(id)) return 64000;
  if (/deepseek|gpt-4o|claude|gemini|qwen/.test(id)) return 24000;
  return 16000;
}

function truncateOversizedUserMessage(
  msg: UIMessage,
  maxTokensForMessage: number,
): { msg: UIMessage; degraded: boolean } {
  const curTokens = estimateMessageTokens(msg);
  if (curTokens <= maxTokensForMessage) {
    return { msg, degraded: false };
  }
  // Preserve head + tail markers so user's opening intent and ending markers remain intact
  const maxChars = Math.max(240, Math.floor(maxTokensForMessage * 1.35));
  const headChars = Math.max(120, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(80, Math.floor(maxChars * 0.35));
  const nextParts = (msg.parts || []).map((p) => {
    if (p.type === "text" && p.text.length > maxChars) {
      const omitted = p.text.length - headChars - tailChars;
      return {
        ...p,
        text: `${p.text.slice(0, headChars)}\n\n[系统预算保护：单条消息超出上下文窗口，已省略中间约 ${omitted} 字并保留首尾关键内容]\n\n${p.text.slice(-tailChars)}`,
      };
    }
    return p;
  });
  return {
    msg: { ...msg, parts: nextParts },
    degraded: true,
  };
}

/**
 * Classifies an incoming turn into a domain task mode ("learn" | "plan" | "chat")
 * so the Context Builder selects the most relevant workspace sections and records
 * its selection transparently in the Context Inspector.
 */
export function classifyTaskType(
  userText: string,
  attachedContext?: { type?: string } | null,
): ContextTaskType {
  if (attachedContext?.type === "block") return "plan";
  if (attachedContext?.type === "lesson") return "learn";
  const text = (userText || "").trim();
  if (
    /(日历|日程|排期|重排|改期|加班|出差|没空|时间冲突|今天安排|下周计划|移到|推迟|每天.*小时|每晚.*点)/i.test(
      text,
    )
  ) {
    return "plan";
  }
  if (
    /(学习|讲解|第一课|下一课|出题|测验|填空|代码|复习|闪卡|掌握度|作答|原理|图解|Mermaid|概念|Bug)/i.test(
      text,
    )
  ) {
    return "learn";
  }
  return "chat";
}

export function getSelectedSectionsForTask(taskType: ContextTaskType): string[] {
  if (taskType === "learn") {
    return [
      "当前用户问题",
      "当前课程与教学大纲",
      "相关先修知识与 BKT/FSRS 掌握状态",
      "最近完整对话窗口",
      "早期对话滚动摘要（按需）",
    ];
  }
  if (taskType === "plan") {
    return [
      "当前用户问题",
      "候选学习活动队列 (LearningActivity)",
      "未来 7 天日历与空闲窗口",
      "睡眠红线与长期时间约束记忆",
      "负荷可行性与错课检测",
    ];
  }
  return [
    "当前用户问题",
    "精简工作区状态摘要",
    "有效长期记忆",
    "最近完整对话窗口",
  ];
}

export type PreparedLLMContext = {
  messagesForLLM: UIMessage[];
  threadSummary: string | null;
  summaryUpdated: boolean;
  summaryCoveredCount: number;
  stats: ContextCompactionStats;
};

/**
 * Approximates token count for mixed Chinese (CJK) and English/code/JSON text.
 * CJK characters average ~1.5 chars/token; ASCII/JSON averages ~3.8 chars/token.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1;
    }
  }
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 3.8);
}

export function estimateMessageTokens(msg: UIMessage): number {
  let total = 8; // role + framing overhead
  for (const part of msg.parts || []) {
    if (part.type === "text" || part.type === "reasoning") {
      total += estimateTextTokens(part.text || "");
    } else if (isToolUIPart(part)) {
      total += 16;
      if ("input" in part && part.input !== undefined) {
        try {
          total += estimateTextTokens(JSON.stringify(part.input));
        } catch {}
      }
      if ("output" in part && part.output !== undefined) {
        try {
          total += estimateTextTokens(JSON.stringify(part.output));
        } catch {}
      }
    }
  }
  return total;
}

export function estimateMessagesTokens(messages: UIMessage[]): number {
  let sum = 0;
  for (const m of messages) {
    sum += estimateMessageTokens(m);
  }
  return sum;
}

/**
 * Produces a concise semantic one-line summary for any historical tool output
 * so old bulky JSON payloads are folded without losing execution history.
 */
export function summarizeToolOutput(toolName: string, output: unknown): string {
  if (!output || typeof output !== "object") {
    return `[已执行 ${toolName}]`;
  }
  const obj = output as Record<string, unknown>;

  if (typeof obj._folded === "boolean" && typeof obj.summary === "string") {
    return obj.summary;
  }

  if (typeof obj.error === "string" && !obj.kind) {
    return `[已执行 ${toolName}（未成功）：${obj.error.slice(0, 60)}]`;
  }

  switch (toolName) {
    case "read_workspace_state":
      return "[已执行 read_workspace_state：已读取当时工作区快照，最新图谱/日程/记忆请以系统提示词为准]";
    case "find_calendar_windows":
      return "[已执行 find_calendar_windows：已扫描当时空闲日历窗口]";
    case "research_learning_topic": {
      const topic = String(obj.topic || "学习主题");
      const mode = String(obj.effectiveMode || obj.mode || "auto_web");
      const srcCount = Array.isArray(obj.sourceRefs)
        ? obj.sourceRefs.length
        : Array.isArray(obj.sources)
          ? obj.sources.length
          : 0;
      const conceptCount = Array.isArray(obj.concepts) ? obj.concepts.length : 0;
      const cacheHit = obj.cacheHit ? "（命中本地缓存）" : "";
      return `[已执行 research_learning_topic：完成「${topic}」研究（${mode}，提炼 ${conceptCount} 个概念、${srcCount} 条来源）${cacheHit}]`;
    }
    case "plan_teaching_move": {
      const action = String(obj.action || "explain");
      const objective = String(obj.objective || "");
      return `[已执行 plan_teaching_move：动作=${action}，目标=${objective.slice(0, 60)}]`;
    }
    case "fetch_reference_url": {
      const title = String(obj.title || obj.url || "参考网页");
      return `[已执行 fetch_reference_url：读取「${title}」摘录]`;
    }
    case "create_learning_track":
    case "adjust_track_scope": {
      const plan = obj.plan as
        | { title?: string; units?: unknown[]; slots?: unknown[] }
        | undefined;
      return `[已执行 ${toolName}：「${plan?.title || "学习轨道"}」，共 ${plan?.units?.length ?? 0} 节课、排入 ${plan?.slots?.length ?? 0} 个日程]`;
    }
    case "manage_calendar_block":
      return `[已执行 manage_calendar_block：${String(obj.summary || "已更新日历")}]`;
    case "propose_reschedule":
    case "propose_batch_reschedule": {
      const opts = Array.isArray(obj.options) ? obj.options.length : 0;
      return `[已执行 ${toolName}：生成 ${opts} 套重排方案（目标：${String(obj.title || "日程")}）]`;
    }
    case "present_onboarding_survey": {
      const answered = obj.savedSelections ? "，用户已完成选择" : "";
      return `[已执行 present_onboarding_survey：展示「${String(obj.topic || "摸底")}」问卷${answered}]`;
    }
    case "present_interactive_check": {
      const mode = String(obj.mode || "choice");
      const title = String(obj.lessonTitle || "互动练习");
      const ans = obj.savedUserAnswer
        ? `（已作答：${String(obj.savedUserAnswer).slice(0, 50)}）`
        : "（待作答）";
      return `[已执行 present_interactive_check：${mode} 题「${title}」${ans}]`;
    }
    case "record_learning_assessment": {
      const title = String(obj.lessonTitle || "知识点");
      const before = obj.before ?? "?";
      const after = obj.after ?? "?";
      const ok = obj.correct ? "达标" : "需巩固";
      return `[已执行 record_learning_assessment：「${title}」${ok}，掌握度 ${before}% → ${after}%]`;
    }
    case "save_memory":
      return `[已执行 save_memory：${String(obj.action || "add")} ${String(obj.category || "memory")}「${String(obj.text || "").slice(0, 50)}」]`;
    case "search_visual_resource": {
      const items = Array.isArray(obj.items) ? obj.items.length : 0;
      return `[已执行 search_visual_resource：检索「${String(obj.query || "")}」视觉图解（${items} 项）]`;
    }
    case "present_learning_roadmap": {
      const stages = Array.isArray(obj.stages) ? obj.stages.length : 0;
      return `[已执行 present_learning_roadmap：展示「${String(obj.title || "学习路线")}」（${stages} 阶段）]`;
    }
    case "present_data_chart":
      return `[已执行 present_data_chart：展示数据图「${String(obj.title || "")}」]`;
    case "start_active_recall":
      return `[已执行 start_active_recall：启动「${String(obj.title || "")}」FSRS 主动回忆闪卡]`;
    default:
      return `[已执行 ${toolName}：历史结果已折叠]`;
  }
}

function findTurnStartIndex(messages: UIMessage[], keepRecentTurns: number): number {
  if (keepRecentTurns <= 0) return messages.length;
  let userTurnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen += 1;
      if (userTurnsSeen >= keepRecentTurns) {
        return i;
      }
    }
  }
  return 0;
}

/**
 * Layer 1: Folds tool outputs & reasoning from turns older than the last `keepRecentTurns` turns.
 * Typically cuts 60%–80% of context bloat while preserving full semantic history.
 */
export function foldOldToolOutputs(
  messages: UIMessage[],
  keepRecentTurns = 2,
  opts: { preserveReasoning?: boolean } = {},
): { messages: UIMessage[]; foldedToolCount: number } {
  const cutoffIdx = findTurnStartIndex(messages, keepRecentTurns);
  if (cutoffIdx <= 0) {
    return { messages, foldedToolCount: 0 };
  }

  let foldedToolCount = 0;
  const result = messages.map((msg, idx) => {
    if (idx >= cutoffIdx || msg.role !== "assistant") {
      return msg;
    }

    let changed = false;
    const nextParts: UIMessage["parts"] = [];

    for (const part of msg.parts || []) {
      // DeepSeek thinking mode + tools requires preserving historical reasoning_content across turns
      if (part.type === "reasoning" && !opts.preserveReasoning) {
        changed = true;
        continue;
      }

      if (isToolUIPart(part) && part.state === "output-available") {
        const toolName = getToolName(part);
        const summary = summarizeToolOutput(toolName, part.output);
        foldedToolCount += 1;
        changed = true;

        let compactInput = part.input;
        try {
          const rawInput = JSON.stringify(part.input);
          if (rawInput && rawInput.length > 360) {
            compactInput = { _folded: true, summary: `${rawInput.slice(0, 220)}…` };
          }
        } catch {}

        nextParts.push({
          ...part,
          input: compactInput,
          output: {
            _folded: true,
            summary,
          },
        } as UIMessage["parts"][number]);
      } else {
        nextParts.push(part);
      }
    }

    if (!changed) return msg;
    return {
      ...msg,
      parts: nextParts,
    };
  });

  return { messages: result, foldedToolCount };
}

/**
 * Layer 2: Deterministic incremental rolling summarizer that condenses earlier messages
 * into a concise, structured `thread_summary` persisted in SQLite.
 */
export function buildRollingSummary(
  previousSummary: string | null | undefined,
  messagesToCondense: UIMessage[],
  maxSummaryChars = 1600,
): string {
  const lines: string[] = [];
  if (previousSummary && previousSummary.trim()) {
    lines.push(previousSummary.trim());
  }

  for (const msg of messagesToCondense) {
    if (msg.role === "user") {
      const txt = (msg.parts || [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (txt) {
        lines.push(`- 用户：${txt.slice(0, 140)}${txt.length > 140 ? "…" : ""}`);
      }
    } else if (msg.role === "assistant") {
      const toolNotes: string[] = [];
      const textParts: string[] = [];
      for (const p of msg.parts || []) {
        if (isToolUIPart(p) && p.state === "output-available") {
          toolNotes.push(summarizeToolOutput(getToolName(p), p.output));
        } else if (p.type === "text" && p.text.trim()) {
          textParts.push(p.text.replace(/\s+/g, " ").trim());
        }
      }
      if (toolNotes.length > 0) {
        lines.push(`- 助手工具：${toolNotes.join("；")}`);
      }
      if (textParts.length > 0) {
        const merged = textParts.join(" ");
        lines.push(
          `- 助手要点：${merged.slice(0, 140)}${merged.length > 140 ? "…" : ""}`,
        );
      }
    }
  }

  const combined = lines.join("\n").trim();
  if (combined.length <= maxSummaryChars) {
    return combined;
  }
  // Keep the most recent summary lines within budget while preserving the opening context line
  const split = combined.split("\n");
  const head = split[0];
  const tailLines: string[] = [];
  let charBudget = maxSummaryChars - head.length - 40;
  for (let i = split.length - 1; i >= 1; i--) {
    if (split[i].length + 1 <= charBudget) {
      tailLines.unshift(split[i]);
      charBudget -= split[i].length + 1;
    } else {
      break;
    }
  }
  return [head, "…（更早轮次已折叠）", ...tailLines].join("\n");
}

/**
 * Full 3-layer Context Manager pipeline before `streamText`:
 * 1. Fold historical tool outputs beyond recent 2 turns (60%–80% reduction)
 * 2. Trigger rolling compaction into `thread_summary` when >70% context budget (or aggressive fallback)
 * 3. Always keep the latest turns intact so current turn reasoning stays sharp
 */
export function prepareContextForLLM(params: {
  messages: UIMessage[];
  taskType?: ContextTaskType;
  systemPromptTokens?: number;
  toolSchemaTokens?: number;
  existingSummary?: string | null;
  existingSummaryCount?: number;
  maxContextTokens?: number;
  compactionThresholdRatio?: number;
  recentTurnsToKeepFullTools?: number;
  recentTurnsToKeepOnCompaction?: number;
  aggressive?: boolean;
  /** Preserve historical reasoning parts (required for DeepSeek Thinking Mode + Tools multi-turn calls) */
  preserveReasoning?: boolean;
}): PreparedLLMContext {
  const taskType: ContextTaskType = params.taskType || "chat";
  const selectedSections = getSelectedSectionsForTask(taskType);
  const budgetTokens = params.maxContextTokens ?? 24000;
  const thresholdRatio = params.compactionThresholdRatio ?? 0.7;
  const sysTokens = params.systemPromptTokens ?? 0;
  const toolSchemaTokens = params.toolSchemaTokens ?? 0;
  const fixedOverhead = sysTokens + toolSchemaTokens;
  const aggressive = Boolean(params.aggressive);

  const originalTokens = estimateMessagesTokens(params.messages);

  // Layer 1: Fold old tool outputs
  const { messages: folded, foldedToolCount } = foldOldToolOutputs(
    params.messages,
    aggressive ? 1 : (params.recentTurnsToKeepFullTools ?? 2),
    { preserveReasoning: Boolean(params.preserveReasoning) },
  );

  // CTX-11 / FAIL-21: Pre-flight single-message budget protection before calling model
  const maxForSingleTurn = Math.max(
    400,
    budgetTokens - fixedOverhead - 300,
  );
  let inputDegraded = false;
  const guardedFolded = folded.map((m, idx) => {
    if (idx === folded.length - 1 && m.role === "user") {
      const res = truncateOversizedUserMessage(m, maxForSingleTurn);
      if (res.degraded) inputDegraded = true;
      return res.msg;
    }
    return m;
  });

  const afterFoldTokens = estimateMessagesTokens(guardedFolded);
  const thresholdTokens = Math.floor(budgetTokens * thresholdRatio);

  // Layer 2: Rolling compaction if over threshold (including toolSchemaTokens! CTX-18)
  const needsCompaction =
    aggressive ||
    (guardedFolded.length > 4 &&
      fixedOverhead + afterFoldTokens > thresholdTokens);

  if (!needsCompaction) {
    const summaryUsed = Boolean(params.existingSummary?.trim());
    const savedTokens = Math.max(0, originalTokens - afterFoldTokens);
    return {
      messagesForLLM: guardedFolded,
      threadSummary: params.existingSummary?.trim() || null,
      summaryUpdated: false,
      summaryCoveredCount: params.existingSummaryCount ?? 0,
      stats: {
        taskType,
        selectedSections,
        originalTokens,
        compactedTokens: afterFoldTokens,
        toolSchemaTokens,
        savedTokens,
        savedPct:
          originalTokens > 0
            ? Math.round((savedTokens / originalTokens) * 100)
            : 0,
        foldedToolCount,
        rollingCompacted: false,
        summaryUsed,
        inputDegraded,
        totalMessages: params.messages.length,
        keptMessages: guardedFolded.length,
        budgetTokens,
        aggressive,
      },
    };
  }

  const keepTurns = aggressive
    ? 1
    : (params.recentTurnsToKeepOnCompaction ?? 3);
  let splitIdx = findTurnStartIndex(guardedFolded, keepTurns);
  if (splitIdx <= 0 && guardedFolded.length > 2) {
    splitIdx = Math.max(1, guardedFolded.length - 2);
  }

  const earlyMessages = guardedFolded.slice(0, splitIdx);
  const recentMessages = guardedFolded.slice(splitIdx);

  const prevCovered = Math.min(
    params.existingSummaryCount ?? 0,
    earlyMessages.length,
  );
  const newlyCovered =
    prevCovered > 0 && params.existingSummary
      ? earlyMessages.slice(prevCovered)
      : earlyMessages;

  const threadSummary = buildRollingSummary(
    prevCovered > 0 ? params.existingSummary : null,
    newlyCovered,
    aggressive ? 900 : 1600,
  );

  // If aggressive mode or still over budget, compress non-last recent messages
  const stillOverBudget =
    fixedOverhead +
      estimateMessagesTokens(recentMessages) +
      estimateTextTokens(threadSummary) >
    budgetTokens;

  const finalRecent =
    aggressive || stillOverBudget
      ? recentMessages.map((m, idx) => {
          if (idx === recentMessages.length - 1) return m;
          return {
            ...m,
            parts: (m.parts || []).map((p) =>
              p.type === "text" && p.text.length > 600
                ? { ...p, text: `${p.text.slice(0, 600)}…[已压缩]` }
                : p,
            ),
          };
        })
      : recentMessages;

  const compactedTokens =
    estimateMessagesTokens(finalRecent) + estimateTextTokens(threadSummary);
  const savedTokens = Math.max(0, originalTokens - compactedTokens);

  return {
    messagesForLLM: finalRecent,
    threadSummary,
    summaryUpdated: earlyMessages.length > 0,
    summaryCoveredCount: earlyMessages.length,
    stats: {
      taskType,
      selectedSections,
      originalTokens,
      compactedTokens,
      toolSchemaTokens,
      savedTokens,
      savedPct:
        originalTokens > 0
          ? Math.round((savedTokens / originalTokens) * 100)
          : 0,
      foldedToolCount,
      rollingCompacted: true,
      summaryUsed: Boolean(threadSummary),
      inputDegraded,
      totalMessages: params.messages.length,
      keptMessages: finalRecent.length,
      budgetTokens,
      aggressive,
    },
  };
}

/**
 * Layer 3 helper: detects provider context-length overflow errors so the server
 * can automatically compact context aggressively and retry instead of surfacing a raw error.
 */
export function isContextOverflowError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : JSON.stringify(err || "");
  return /(context_length_exceeded|maximum context length|context window|too many tokens|prompt is too long|token limit|input.*too long|exceeds.*context)/i.test(
    msg,
  );
}
