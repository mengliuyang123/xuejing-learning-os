import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { z } from "zod";
import {
  type AgentCard,
  type Block,
  type CalendarUpdatedCard,
  type DataChartCardData,
  type GoalPlan,
  type InteractiveCheckCard,
  type Lesson,
  type MasteryUpdateCard,
  type Memory,
  type MemoryCategory,
  type MemorySavedCard,
  type OnboardingSurveyCardData,
  type PriorKnowledgeLevel,
  type RoadmapStagesCardData,
  type Store,
  type TrackCreatedCard,
  type TrackDepth,
  available,
  buildActiveRecallCard,
  categoryLabel,
  computeMasteryUpdate,
  dueReviews,
  focusLesson,
  formatDayWithWeekday,
  free,
  getActiveMemories,
  getActiveTrack,
  getAllLessons,
  getLessonById,
  getMissedSessions,
  getTracks,
  isRemedialBlock,
  offset,
  parseMemoryConstraint,
  parseMemoryExpiry,
  time,
  weekdayLabel,
} from "../../../lib/learning";
import { computeLearnerStatus, learnerStatusLabel } from "../../../lib/pedagogy";
import {
  MAX_DYNAMIC_LESSONS,
  MIN_DYNAMIC_LESSONS,
  TRACK_DEPTH_LABELS,
  adaptTrackContractsFromAssessment,
  normalizeKnowledgeGraphTopology,
  normalizeLessonGoalFields,
  recommendLessonCount,
  reconcileTrackUnitsAndSchedule,
  resolveGraphNeighborsForLesson,
  scheduleTrackUnitsInOrder,
  validateTrackUnits,
} from "../../../lib/curriculum-planner";
import { syncGoalPlanToCurriculumBlueprint } from "../../../lib/curriculum-blueprint";
import {
  analyzeScheduleFeasibility,
  extractMemoryPreferences,
  findFreeWindows,
  generateBatchRescheduleOptions,
  generateRescheduleOptions,
  getWakingBounds,
  isWithinSleep,
} from "../../../lib/scheduler";
import {
  StateVersionConflictError,
  getChatThreadMetaFromDb,
  getLlmTaskFromDb,
  getTrackResearchPackageFromDb,
  loadStoreFromDb,
  saveStoreToDb,
  updateChatThreadSummaryInDb,
  upsertLlmTaskInDb,
} from "../../../lib/db";
import {
  getExerciseById,
  listAttemptsForLesson,
  listPendingPlanDrafts,
  registerExercise,
  startLearningSession,
} from "../../../lib/learning-engine";
import {
  classifyTaskType,
  estimateTextTokens,
  isContextOverflowError,
  prepareContextForLLM,
  resolveModelContextBudget,
} from "../../../lib/context-manager";
import {
  AgentTraceRecorder,
  type StateChangeSpec,
} from "../../../lib/agent-trace";
import {
  prepareLessonInDepth,
  triggerRollingPrewarmForNextLesson,
} from "../../../lib/topic-researcher";
import {
  type ResearchPackage,
  runResearchPlanner,
} from "../../../lib/research-planner";
import { runTeachingPlanner } from "../../../lib/teaching-planner";
import { DEFAULT_LEARNOS_CAPABILITIES } from "../../../lib/activity-registry";
import { getTeachingSkillRegistry } from "../../../lib/skill-loader";
import { runVisualExplainer } from "../../../lib/visual-explainer";
import { deepseekWebFetch } from "../../../lib/web-research";
import {
  registerServerTaskController,
  unregisterServerTaskController,
} from "../../../lib/server-task-registry";
import { searchVisualResources } from "../../../lib/visual-search";
import {
  formatStoreContextForLLM,
  resolveLanguageModel,
} from "../../../lib/ai-config";
import {
  buildDeepSeekCallConfig,
  extractDeepSeekUsageSummary,
} from "../../../lib/deepseek-config";
import type { ClientModelConfig } from "../../../lib/model-config";

export type AttachedContext =
  | { type: "lesson"; lessonId: string; title: string; mastery: number }
  | { type: "block"; blockId: string; title: string; day: string; start: number; minutes: number };

function scheduleUnitsIntoSlots(
  units: Lesson[],
  existingBlocks: Block[],
  day: string,
  opts: {
    startMin: number;
    endMin: number;
    dailyMinutes: number;
    scheduleSettings?: Store["scheduleSettings"];
  },
): Block[] {
  const placed: Block[] = [];
  const allBlocks = [...existingBlocks];
  const waking = getWakingBounds(opts.scheduleSettings);
  const startFloor = Math.max(waking.wakeStart, opts.startMin);
  const endCap = Math.min(waking.wakeEnd, opts.endMin);

  let dayCursor = 0;
  let usedToday = 0;
  let searchStart = startFloor;

  for (const unit of units) {
    let placedSlot: { day: string; start: number } | null = null;
    for (let attempt = 0; attempt < 21; attempt++) {
      const targetDay = offset(day, dayCursor);
      if (usedToday + unit.minutes > opts.dailyMinutes && usedToday > 0) {
        dayCursor += 1;
        usedToday = 0;
        searchStart = startFloor;
        continue;
      }
      for (let m = searchStart; m + unit.minutes <= endCap; m += 15) {
        if (
          !isWithinSleep(m, unit.minutes, opts.scheduleSettings) &&
          free(allBlocks, targetDay, m, unit.minutes)
        ) {
          placedSlot = { day: targetDay, start: m };
          searchStart = m + unit.minutes + 15;
          usedToday += unit.minutes;
          break;
        }
      }
      if (placedSlot) break;
      dayCursor += 1;
      usedToday = 0;
      searchStart = startFloor;
    }

    if (placedSlot) {
      const block: Block = {
        id: `blk-${crypto.randomUUID().slice(0, 8)}`,
        day: placedSlot.day,
        start: placedSlot.start,
        minutes: unit.minutes,
        title: unit.title,
        kind: "学习",
        lesson: unit.id,
      };
      placed.push(block);
      allBlocks.push(block);
    }
  }

  return placed;
}

export type TestStreamSpec = {
  chunks: string[];
  chunkDelayMs?: number;
  reasoningChunks?: string[];
  failAfterChunks?: number;
  errorMessage?: string;
};

export async function POST(request: Request) {
  const {
    taskId: incomingTaskId,
    threadId: incomingThreadId,
    messages,
    state,
    day,
    activeTrackId,
    attachedContext,
    clientModelConfig,
    testStreamSpec,
  } = (await request.json()) as {
    taskId?: string;
    threadId?: string;
    messages: UIMessage[];
    state: Store;
    day: string;
    activeTrackId?: string;
    attachedContext?: AttachedContext | null;
    clientModelConfig?: ClientModelConfig;
    testStreamSpec?: TestStreamSpec;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "消息不能为空" }, { status: 400 });
  }

  const taskId = incomingTaskId || `task-${crypto.randomUUID().slice(0, 10)}`;
  const threadId = incomingThreadId || "agent-main";
  const serverCtrl = registerServerTaskController(taskId);
  void threadId;

  const lastUserRawText =
    messages
      .at(-1)
      ?.parts.filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim() || "";

  const resolvedTestSpec: TestStreamSpec | undefined =
    testStreamSpec ||
    (lastUserRawText.startsWith("[E2E_STREAM_TEST]")
      ? {
          reasoningChunks: [
            "正在分析学习者当前的 Java 先修图谱与掌握度状态…\n",
            "准备分阶段输出 JVM 内存区域、代码示例与掌握度练习。",
          ],
          chunks: [
            "### 第一部分：JVM 内存模型总览\n\nJava 虚拟机在执行程序时会把内存划分为 **堆（Heap）**、**虚拟机栈（JVM Stack）** 与 **元空间（Metaspace）**。\n\n",
            "### 第二部分：代码示例与栈帧执行\n\n```java\npublic class MemoryDemo {\n    public static void main(String[] args) {\n        int localValue = 42;\n        String greeting = new String(\"Hello JVM\");\n        System.out.println(greeting + \" : \" + localValue);\n    }\n}\n```\n\n",
            "### 第三部分：对象存活判定与可达性分析\n\n垃圾收集器通过 **GC Roots** 进行可达性分析，自动回收不再被引用的堆对象。\n\n",
            "### 第四部分：后台流式任务完成确认\n\n即使在生成中途切换到「时间规划」或「知识图谱」页面，本段增量内容依然在后台持续流式写入 SQLite 并实时同步。",
          ],
          chunkDelayMs: 480,
        }
      : undefined);

  // Deterministic multi-chunk streaming path for E2E & lifecycle tests
  if (resolvedTestSpec && Array.isArray(resolvedTestSpec.chunks)) {
    const delayMs = Math.max(10, resolvedTestSpec.chunkDelayMs ?? 120);
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        try {
          writer.write({ type: "start", messageId: `asst-${taskId}` });
          if (resolvedTestSpec.reasoningChunks?.length) {
            writer.write({ type: "reasoning-start", id: "r1" });
            for (const rc of resolvedTestSpec.reasoningChunks) {
              if (serverCtrl.signal.aborted) break;
              await new Promise((r) => setTimeout(r, delayMs));
              if (serverCtrl.signal.aborted) break;
              writer.write({ type: "reasoning-delta", id: "r1", delta: rc });
            }
            writer.write({ type: "reasoning-end", id: "r1" });
          }

          writer.write({ type: "text-start", id: "t1" });
          for (let i = 0; i < resolvedTestSpec.chunks.length; i++) {
            if (serverCtrl.signal.aborted) break;
            await new Promise((r) => setTimeout(r, delayMs));
            if (serverCtrl.signal.aborted) break;
            if (
              resolvedTestSpec.failAfterChunks !== undefined &&
              i >= resolvedTestSpec.failAfterChunks
            ) {
              throw new Error(
                resolvedTestSpec.errorMessage || "模拟流式生成中途失败",
              );
            }
            writer.write({
              type: "text-delta",
              id: "t1",
              delta: resolvedTestSpec.chunks[i],
            });
          }
          writer.write({ type: "text-end", id: "t1" });
          writer.write({ type: "finish" });
        } finally {
          unregisterServerTaskController(taskId);
        }
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  const resolved = resolveLanguageModel(clientModelConfig);
  if (!resolved) {
    unregisterServerTaskController(taskId);
    return Response.json(
      {
        code: "NO_API_KEY",
        error:
          "尚未配置大模型 API Key。请点击右上角「模型设置」填入可用的 API Key 并测试连接后，再开始真实交互。",
      },
      { status: 401 },
    );
  }

  // Request-scoped mutable state hydrated from client + SQLite authoritative store
  // so multi-step ReAct tools observe previous tool mutations and persist atomically to SQLite.
  const dbSnapshot = (() => {
    try {
      return loadStoreFromDb(day);
    } catch {
      return null;
    }
  })();
  const useDbPlans =
    (!state.goalPlans || state.goalPlans.length === 0) &&
    Boolean(dbSnapshot?.goalPlans?.length);
  const useDbBlocks =
    (!state.blocks || state.blocks.length === 0) &&
    Boolean(dbSnapshot?.blocks?.length);

  let workingState: Store = {
    ...state,
    // Always track the authoritative SQLite stateVersion so consecutive multi-tool writes
    // inside a single ReAct run never trip optimistic locking against a stale client version.
    stateVersion: dbSnapshot?.stateVersion,
    activeTrackId:
      activeTrackId || state.activeTrackId || dbSnapshot?.activeTrackId,
    goalPlans: [
      ...(useDbPlans ? dbSnapshot!.goalPlans || [] : state.goalPlans || []),
    ],
    blocks: [...(useDbBlocks ? dbSnapshot!.blocks || [] : state.blocks || [])],
    memories: [
      ...(state.memories && state.memories.length > 0
        ? state.memories
        : dbSnapshot?.memories || []),
    ],
    mastery: { ...(dbSnapshot?.mastery || {}), ...(state.mastery || {}) },
    masteryMeta: {
      ...(dbSnapshot?.masteryMeta || {}),
      ...(state.masteryMeta || {}),
    },
  };
  let latestTurnResearchPackage: ResearchPackage | null = null;

  function persistWorkingState(trigger: string, summary: string) {
    try {
      const saved = saveStoreToDb(workingState, { trigger, summary });
      workingState = { ...workingState, stateVersion: saved.stateVersion };
    } catch (err) {
      if (err instanceof StateVersionConflictError) {
        // Section 14.3: Re-read latest authoritative SQLite state and merge request mutations
        // rather than blindly overwriting concurrent writes with a stale snapshot.
        const latest = loadStoreFromDb(day);
        const mergedPlanMap = new Map<string, GoalPlan>();
        for (const p of latest.goalPlans || []) mergedPlanMap.set(p.id, p);
        for (const p of workingState.goalPlans || []) mergedPlanMap.set(p.id, p);

        const mergedBlockMap = new Map<string, Block>();
        for (const b of latest.blocks) mergedBlockMap.set(b.id, b);
        for (const b of workingState.blocks) mergedBlockMap.set(b.id, b);

        const mergedMemoryMap = new Map<string, Memory>();
        for (const m of latest.memories) mergedMemoryMap.set(m.id, m);
        for (const m of workingState.memories) mergedMemoryMap.set(m.id, m);

        const mergedStore: Store = {
          ...latest,
          ...workingState,
          stateVersion: latest.stateVersion,
          goalPlans: [...mergedPlanMap.values()],
          blocks: [...mergedBlockMap.values()],
          memories: [...mergedMemoryMap.values()],
          mastery: { ...latest.mastery, ...workingState.mastery },
          masteryMeta: {
            ...(latest.masteryMeta || {}),
            ...(workingState.masteryMeta || {}),
          },
        };
        const retrySaved = saveStoreToDb(mergedStore, {
          trigger,
          summary,
          expectedVersion: latest.stateVersion,
        });
        workingState = {
          ...mergedStore,
          stateVersion: retrySaved.stateVersion,
        };
        return;
      }
      console.error("[api/agent] persistWorkingState failed:", err);
      throw err;
    }
  }

  const userPromptText =
    messages
      .at(-1)
      ?.parts.filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim() || "";

  const runId = "run-" + crypto.randomUUID().slice(0, 10);

  // ---- Tool Executors (deterministic math/scheduling + real LLM inputs) ----

  function execReadWorkspaceState() {
    const tracks = getTracks(workingState);
    const activeTrack = getActiveTrack(workingState);
    const focus = activeTrack ? focusLesson(workingState, activeTrack.id) : null;
    const due = dueReviews(workingState, day);
    const missed = getMissedSessions(workingState, day);
    const feasibility = analyzeScheduleFeasibility(workingState, day, 7);
    const activeMemories = getActiveMemories(workingState.memories, day);
    const upcomingBlocks = workingState.blocks
      .filter((b) => b.day >= day && b.day <= offset(day, 6))
      .sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start)
      .slice(0, 24)
      .map((b) => ({
        id: b.id,
        day: b.day,
        dayWithWeekday: formatDayWithWeekday(b.day),
        weekday: weekdayLabel(b.day),
        start: time(b.start),
        end: time(b.start + b.minutes),
        startMinutes: b.start,
        minutes: b.minutes,
        title: b.title,
        kind: b.kind,
        sessionType: b.lesson
          ? isRemedialBlock(b)
            ? "补救/复习课"
            : "正课"
          : b.kind,
        lessonId: b.lesson,
        done: Boolean(b.done),
        locked: Boolean(b.locked),
      }));

    return {
      today: day,
      todayWithWeekday: formatDayWithWeekday(day),
      todayWeekday: weekdayLabel(day),
      tracks: tracks.map((t) => ({
        id: t.id,
        title: t.title,
        goal: t.goal,
        units: t.units.map((u) => ({
          id: u.id,
          title: u.title,
          minutes: u.minutes,
          mastery: workingState.mastery[u.id] ?? 0,
          status: learnerStatusLabel(computeLearnerStatus(workingState, u.id, day)),
          available: available(workingState, u),
          requires: u.requires,
          nextReviewDay: workingState.masteryMeta?.[u.id]?.nextReviewDay,
        })),
      })),
      recommendedFocus: focus
        ? { id: focus.id, title: focus.title, mastery: workingState.mastery[focus.id] ?? 0 }
        : null,
      dueReviews: due.map((r) => ({
        lessonId: r.lesson.id,
        title: r.lesson.title,
        retrievability: r.retrievability,
        mastery: r.mastery,
      })),
      missedSessions: missed.map((b) => ({
        id: b.id,
        day: b.day,
        start: time(b.start),
        title: b.title,
        minutes: b.minutes,
      })),
      feasibility7Days: {
        feasible: feasibility.feasible,
        requiredMinutes: feasibility.requiredMinutes,
        availableMinutes: feasibility.availableMinutes,
        deficitMinutes: feasibility.deficitMinutes,
      },
      upcomingBlocks,
      activeMemories: activeMemories.slice(0, 15).map((m) => ({
        id: m.id,
        category: m.category,
        label: m.label,
        text: m.text,
        expiresAt: m.expiresAt,
      })),
      sleepProtection: workingState.scheduleSettings
        ? `${time(workingState.scheduleSettings.sleepStart)}–${time(workingState.scheduleSettings.sleepEnd)}`
        : "23:00–07:00",
    };
  }

  function execFindCalendarWindows(targetDays?: string[]) {
    const daysToScan =
      targetDays && targetDays.length
        ? targetDays.slice(0, 7)
        : [day, offset(day, 1), offset(day, 2)];
    return {
      windowsByDay: daysToScan.map((d) => ({
        day: d,
        dayWithWeekday: formatDayWithWeekday(d),
        weekday: weekdayLabel(d),
        freeWindows: findFreeWindows(
          workingState.blocks,
          d,
          480,
          1380,
          20,
          workingState.scheduleSettings,
        ).map((w) => ({
          start: time(w.start),
          end: time(w.end),
          startMinutes: w.start,
          minutes: w.minutes,
        })),
      })),
    };
  }

  function execSaveMemory(args: {
    action?: "add" | "update" | "remove";
    category: MemoryCategory;
    text: string;
    reason?: string;
    targetId?: string;
    expiresAt?: string;
  }): MemorySavedCard {
    const cleanText = args.text.trim();
    const normNew = cleanText.toLowerCase().replace(/\s+/g, " ");
    const duplicate =
      (!args.action || args.action === "add") && !args.targetId
        ? workingState.memories.find(
            (m) =>
              (m.category || "preference") === args.category &&
              m.text.trim().toLowerCase().replace(/\s+/g, " ") === normNew,
          )
        : undefined;
    const action = duplicate ? "update" : args.action || "add";
    const constraint = parseMemoryConstraint(cleanText);
    const expiresAt = args.expiresAt || parseMemoryExpiry(cleanText, day);
    const memoryId =
      args.targetId ||
      duplicate?.id ||
      "mem-" + crypto.randomUUID().slice(0, 8);

    const card: MemorySavedCard = {
      kind: "memory_saved",
      memoryId,
      action,
      category: args.category,
      label: categoryLabel(args.category),
      text: cleanText,
      reason: args.reason,
      constraint,
      expiresAt,
      source: "agent",
      confidence: 0.92,
    };

    if (action === "remove") {
      workingState = {
        ...workingState,
        memories: workingState.memories.filter((m) => m.id !== memoryId),
      };
    } else {
      const entry: Memory = {
        id: memoryId,
        category: args.category,
        label: card.label,
        text: cleanText,
        constraint,
        expiresAt,
        source: "agent",
        confidence: 0.92,
        createdAt: day,
      };
      const existing =
        workingState.memories.find((m) => m.id === memoryId) ||
        (args.category === "goal"
          ? workingState.memories.find((m) => m.category === "goal")
          : undefined);
      workingState = {
        ...workingState,
        memories: existing
          ? workingState.memories.map((m) => (m.id === existing.id ? entry : m))
          : [entry, ...workingState.memories],
      };
    }
    persistWorkingState("Agent 自主记忆", `${card.label}：${cleanText.slice(0, 60)}`);
    return card;
  }

  type CreateTrackUnitInput = {
    chapterTitle?: string;
    chapterSummary?: string;
    sectionTitle?: string;
    sectionSummary?: string;
    title: string;
    concept: string;
    objective?: string;
    completionCriteria?: string;
    example?: string;
    minutes?: number;
    requiresIndices?: number[];
    practiceType?: "code" | "text";
    practiceLanguage?: string;
    practicePrompt?: string;
    starterCode?: string;
  };

  function execCreateLearningTrack(args: {
    title: string;
    goal: string;
    days?: number;
    dailyMinutes?: number;
    startMinutes?: number;
    endMinutes?: number;
    depth?: TrackDepth;
    scopeNote?: string;
    priorKnowledge?: PriorKnowledgeLevel;
    chapters?: Array<{
      title: string;
      summary?: string;
      sections?: Array<{
        title: string;
        summary?: string;
        units: CreateTrackUnitInput[];
      }>;
      units?: CreateTrackUnitInput[];
    }>;
    units?: CreateTrackUnitInput[];
  }): TrackCreatedCard | { error: string } {
    const prefs = extractMemoryPreferences(workingState.memories, day);
    const waking = getWakingBounds(workingState.scheduleSettings);
    const startMin = Math.max(
      waking.wakeStart,
      args.startMinutes ?? prefs.preferredStart ?? 1140,
    );
    const endMin = Math.min(
      waking.wakeEnd,
      args.endMinutes ?? prefs.preferredEnd ?? 1350,
    );
    const dailyMinutes = args.dailyMinutes ?? prefs.maxSessionMinutes ?? 60;
    const planId = `track-${crypto.randomUUID().slice(0, 8)}`;

    // Support both nested `chapters -> sections -> units` and flat `units` with `chapterTitle` & `sectionTitle`
    const flattenedUnits: CreateTrackUnitInput[] = [];
    if (Array.isArray(args.chapters) && args.chapters.length > 0) {
      for (const ch of args.chapters) {
        const chTitle = ch.title?.trim();
        const chSummary = ch.summary?.trim();
        if (Array.isArray(ch.sections) && ch.sections.length > 0) {
          for (const sec of ch.sections) {
            const secTitle = sec.title?.trim();
            const secSummary = sec.summary?.trim();
            for (const u of sec.units || []) {
              flattenedUnits.push({
                ...u,
                chapterTitle: u.chapterTitle?.trim() || chTitle,
                chapterSummary: u.chapterSummary?.trim() || chSummary,
                sectionTitle: u.sectionTitle?.trim() || secTitle,
                sectionSummary: u.sectionSummary?.trim() || secSummary,
              });
            }
          }
        }
        if (Array.isArray(ch.units) && ch.units.length > 0) {
          for (const u of ch.units) {
            flattenedUnits.push({
              ...u,
              chapterTitle: u.chapterTitle?.trim() || chTitle,
              chapterSummary: u.chapterSummary?.trim() || chSummary,
            });
          }
        }
      }
    }
    if (Array.isArray(args.units) && args.units.length > 0) {
      for (const u of args.units) {
        flattenedUnits.push(u);
      }
    }

    if (flattenedUnits.length === 0) {
      return {
        error: "建轨校验未通过：请至少提供 1 节课程节点（可通过 units 或 chapters.sections.units 传入）。",
      };
    }

    const rawIds = flattenedUnits.map(
      (_, idx) => `${planId}-u${idx + 1}`,
    );

    const rawUnits: Lesson[] = flattenedUnits.map((u, idx) => {
      const requires = (u.requiresIndices || [])
        .filter((r) => Number.isInteger(r) && r >= 0 && r < flattenedUnits.length)
        .map((r) => rawIds[r]);
      return normalizeLessonGoalFields({
        id: rawIds[idx],
        title: u.title.trim(),
        subtitle: u.concept.trim().slice(0, 40),
        minutes: Math.max(15, Math.min(90, u.minutes ?? 30)),
        requires,
        concept: u.concept.trim(),
        objective: u.objective?.trim(),
        completionCriteria: u.completionCriteria?.trim(),
        example: u.example?.trim() || "",
        question: "",
        choices: [],
        answer: 0,
        feedback: "",
        practiceType: u.practiceType,
        practiceLanguage: u.practiceLanguage?.trim() || undefined,
        practicePrompt: u.practicePrompt?.trim() || undefined,
        starterCode: u.starterCode,
        stageTitle: u.chapterTitle?.trim() || undefined,
        stageSubtitle: u.chapterSummary?.trim() || undefined,
        moduleTitle: u.sectionTitle?.trim() || undefined,
        moduleSubtitle: u.sectionSummary?.trim() || undefined,
      });
    });

    // Prevent over-serialized 1D stick graphs: normalize into authentic multi-stage branching/converging DAG
    const units: Lesson[] = normalizeKnowledgeGraphTopology(rawUnits);

    const validation = validateTrackUnits(units, { strictGoalFields: true });
    if (!validation.ok) {
      return {
        error: `建轨校验未通过：${validation.errors.join("；")}`,
      };
    }

    const sizing = recommendLessonCount({
      goal: args.goal,
      days: args.days,
      dailyMinutes,
      depth: args.depth,
      scopeNote: args.scopeNote,
      priorKnowledge: args.priorKnowledge,
    });

    const slots = scheduleTrackUnitsInOrder(units, workingState.blocks, day, {
      startMin,
      endMin,
      dailyMinutes,
      scheduleSettings: workingState.scheduleSettings,
    });

    const rawPlan: GoalPlan = {
      id: planId,
      version: `${planId}-v1`,
      goal: args.goal.trim(),
      title: args.title.trim(),
      days: args.days ?? Math.max(3, Math.ceil(units.length * 1.5)),
      daily: dailyMinutes,
      start: startMin,
      depth: args.depth ?? sizing.depth,
      scopeNote: args.scopeNote?.trim() || undefined,
      priorKnowledge: args.priorKnowledge ?? sizing.priorKnowledge,
      blueprintVersion: 1,
      units,
      slots,
    };

    // Resolve track-level ResearchPackage (from current turn or SQLite cache) & unify GoalPlan with CurriculumBlueprint
    const trackResearchPkg: ResearchPackage | null = (() => {
      if (latestTurnResearchPackage) return latestTurnResearchPackage;
      try {
        const row = getTrackResearchPackageFromDb({
          goal: rawPlan.goal,
          topic: rawPlan.title,
        });
        if (row?.pkg && typeof row.pkg === "object") {
          return row.pkg as ResearchPackage;
        }
      } catch {}
      return null;
    })();

    const { plan } = syncGoalPlanToCurriculumBlueprint({
      plan: rawPlan,
      researchPackageId: trackResearchPkg?.id,
      mastery: workingState.mastery,
    });

    const nextMastery = { ...workingState.mastery };
    for (const u of plan.units) nextMastery[u.id] ??= 0;

    workingState = {
      ...workingState,
      activeTrackId: plan.id,
      goalPlans: [...(workingState.goalPlans || []), plan],
      blocks: [...workingState.blocks, ...slots],
      mastery: nextMastery,
    };
    persistWorkingState(
      "Agent 建轨排课",
      `创建学习轨道「${plan.title}」（${TRACK_DEPTH_LABELS[plan.depth || "standard"]} · ${plan.units.length} 节微课 · 蓝图 v${plan.blueprintVersion ?? 1}）并排入 ${slots.length} 个日程时段`,
    );

    // Non-blocking background deep preparation of Lesson 1 right after track creation:
    // Consumes the unified Knowledge Graph LessonContract & reuses the track's global ResearchPackage!
    if (plan.units[0] && resolved?.model) {
      const firstUnit = plan.units[0];
      void prepareLessonInDepth({
        lesson: firstUnit,
        trackId: plan.id,
        trackTitle: plan.title,
        trackGoal: plan.goal,
        trackUnits: plan.units,
        blueprintId: plan.blueprintId,
        blueprintVersion: plan.blueprintVersion ?? 1,
        contract: firstUnit.contract,
        researchPackageId: plan.researchPackageId,
        trackResearchPackage: trackResearchPkg,
        reuseTrackResearch: true,
        masteryMap: nextMastery,
        learnerLevel: plan.priorKnowledge || "intermediate",
        mode: "auto_web",
        model: resolved.model,
        clientConfig: clientModelConfig,
      }).catch((err) => {
        console.error("[api/agent] background Lesson 1 prepare failed:", err);
      });
    }

    const slotDescriptions = slots
      .map(
        (s) =>
          `${s.day}（${formatDayWithWeekday(s.day)}）${time(s.start)}–${time(s.start + s.minutes)}（${s.minutes}分钟·正课）《${s.title}》`,
      )
      .join("；");

    return {
      kind: "track_created",
      plan,
      note:
        slots.length > 0
          ? `已为你创建「${plan.title}」（${TRACK_DEPTH_LABELS[plan.depth || "standard"]} · ${units.length} 节先修微课），排期如下：${slotDescriptions}`
          : `已为你创建「${plan.title}」（${TRACK_DEPTH_LABELS[plan.depth || "standard"]} · ${units.length} 节先修微课），近期日程较满，可在日历中微调排期。`,
    };
  }

  function execManageCalendarBlock(args: {
    action: "add" | "update" | "delete" | "complete";
    blockId?: string;
    title?: string;
    day?: string;
    startMinutes?: number;
    minutes?: number;
    kind?: Block["kind"];
    locked?: boolean;
    lessonId?: string;
  }): CalendarUpdatedCard | { error: string } {
    if (args.action === "delete" || args.action === "complete") {
      const target = workingState.blocks.find((b) => b.id === args.blockId);
      if (!target) return { error: "未找到对应的日程块，请先读取最新工作区状态确认 blockId。" };
      if (args.action === "delete") {
        workingState = {
          ...workingState,
          blocks: workingState.blocks.filter((b) => b.id !== target.id),
        };
        const delSummary = `已删除 ${target.day.slice(5)} ${time(target.start)} 的「${target.title}」`;
        persistWorkingState("Agent 日程操作", delSummary);
        return {
          kind: "calendar_updated",
          action: "delete",
          block: target,
          summary: delSummary,
        };
      } else {
        const updated = { ...target, done: true };
        workingState = {
          ...workingState,
          blocks: workingState.blocks.map((b) => (b.id === target.id ? updated : b)),
        };
        const doneSummary = `已标记完成「${updated.title}」`;
        persistWorkingState("Agent 日程操作", doneSummary);
        return {
          kind: "calendar_updated",
          action: "complete",
          block: updated,
          summary: doneSummary,
        };
      }
    }

    if (args.action === "update") {
      const target = workingState.blocks.find((b) => b.id === args.blockId);
      if (!target) return { error: "未找到对应的日程块。" };
      const nextDay = args.day || target.day;
      const nextStart = args.startMinutes ?? target.start;
      const nextMin = args.minutes ?? target.minutes;
      const nextKind = args.kind || target.kind;
      if (
        (nextKind === "学习" || nextKind === "复习") &&
        isWithinSleep(nextStart, nextMin, workingState.scheduleSettings)
      ) {
        return { error: "该时段触及睡眠保护红线，请换到清醒时段。" };
      }
      const others = workingState.blocks.filter((b) => b.id !== target.id);
      if (!free(others, nextDay, nextStart, nextMin)) {
        return { error: `${nextDay} ${time(nextStart)} 存在时间冲突，请改用 propose_reschedule 或选择空档。` };
      }
      const updated: Block = {
        ...target,
        day: nextDay,
        start: nextStart,
        minutes: nextMin,
        title: args.title?.trim() || target.title,
        kind: nextKind,
        locked: args.locked ?? target.locked,
      };
      workingState = {
        ...workingState,
        blocks: [...others, updated],
      };
      const updSummary = `已调整「${updated.title}」至 ${updated.day.slice(5)} ${time(updated.start)}（${updated.minutes}分钟）`;
      persistWorkingState("Agent 日程操作", updSummary);
      return {
        kind: "calendar_updated",
        action: "update",
        block: updated,
        summary: updSummary,
      };
    }

    // add
    const targetDay = args.day || day;
    const startMin = args.startMinutes ?? 1140;
    const minutes = Math.max(15, Math.min(360, args.minutes ?? 45));
    const kind = args.kind || "工作";
    const title = (args.title || "新日程").trim();
    if (
      (kind === "学习" || kind === "复习") &&
      isWithinSleep(startMin, minutes, workingState.scheduleSettings)
    ) {
      return { error: "该时段在睡眠保护红线内，不能排入学习/复习。" };
    }
    if (!free(workingState.blocks, targetDay, startMin, minutes)) {
      return { error: `${targetDay} ${time(startMin)}–${time(startMin + minutes)} 与现有日程冲突，可调用 propose_reschedule 生成重排方案。` };
    }
    const created: Block = {
      id: `blk-${crypto.randomUUID().slice(0, 8)}`,
      day: targetDay,
      start: startMin,
      minutes,
      title,
      kind,
      lesson: args.lessonId,
      locked: args.locked ?? (kind === "工作" || kind === "生活"),
    };
    workingState = {
      ...workingState,
      blocks: [...workingState.blocks, created],
    };
    const addSummary = `已添加 ${created.day.slice(5)} ${time(created.start)}「${created.title}」（${created.minutes}分钟）`;
    persistWorkingState("Agent 日程操作", addSummary);
    return {
      kind: "calendar_updated",
      action: "add",
      block: created,
      summary: addSummary,
    };
  }

  function execRecordAssessment(args: {
    lessonId: string;
    correct: boolean;
    skip?: boolean;
    summary: string;
    checkMode?: string;
    strength?: string;
    misconception?: string;
    keyTakeaway?: string;
  }): MasteryUpdateCard | { error: string } {
    const lesson = getLessonById(workingState, args.lessonId);
    if (!lesson) {
      return { error: `未找到 lessonId=${args.lessonId}，请先读取工作区状态确认真实 ID。` };
    }

    const attemptId = `assess-${crypto.randomUUID().slice(0, 8)}`;
    const prevStability =
      workingState.masteryMeta?.[lesson.id]?.stabilityDays ?? 1.0;

    if (args.skip) {
      // Section 12.2: Self-reported familiarity / skip MUST NOT forge verified mastery = 95%.
      // Record self_reported_familiarity while preserving verified mastery unchanged,
      // and invite a quick diagnostic verification quiz if the user wants verified mastery.
      const before = workingState.mastery[lesson.id] ?? 0;
      const prevMeta = workingState.masteryMeta?.[lesson.id];
      const nextMeta = {
        stabilityDays: prevMeta?.stabilityDays ?? 1.0,
        nextReviewDay: prevMeta?.nextReviewDay ?? offset(day, 3),
        attempts: prevMeta?.attempts ?? 0,
        pKnown: prevMeta?.pKnown,
        difficulty: prevMeta?.difficulty,
        lapses: prevMeta?.lapses,
        reps: prevMeta?.reps,
        fsrsState: prevMeta?.fsrsState,
        lastReviewDay: prevMeta?.lastReviewDay,
        lastResult: prevMeta?.lastResult,
        updatedAt: new Date().toISOString(),
        masteryOrigin: "self_reported" as const,
      };
      workingState = {
        ...workingState,
        masteryMeta: {
          ...(workingState.masteryMeta || {}),
          [lesson.id]: nextMeta,
        },
      };
      persistWorkingState(
        "Agent 记录自报熟悉（未验证）",
        `已记录「${lesson.title}」为自报熟悉，未伪造已验证掌握度（保持 ${before}%）`,
      );
      return {
        kind: "mastery_update",
        attemptId,
        lessonId: lesson.id,
        lessonTitle: lesson.title,
        correct: false,
        skip: true,
        before,
        after: before,
        nextReviewDay: nextMeta.nextReviewDay,
        unlockedTitles: [],
        summary: `${args.summary}（已标注为「自报熟悉·未验证」，不会直接写入正式掌握度；如需正式解锁后续课程，请完成 1 道快速诊断题。）`,
        checkMode: args.checkMode || "自报熟悉（未验证）",
        stabilityBefore: prevStability,
        stabilityAfter: nextMeta.stabilityDays,
        diagnostic:
          args.strength || args.misconception || args.keyTakeaway
            ? {
                strength: args.strength,
                misconception: args.misconception,
                keyTakeaway: args.keyTakeaway,
              }
            : undefined,
        nextSteps: [
          {
            label: `进行 1 题快速诊断验证「${lesson.title}」`,
            prompt: `请为「${lesson.title}」调用 present_interactive_check 出 1 道快速诊断题，验证通过后再更新我的正式掌握度。`,
            targetLessonId: lesson.id,
          },
          {
            label: "在知识图谱查看状态",
            prompt: "",
            targetLessonId: lesson.id,
            openGraph: true,
          },
        ],
      };
    }

    const calc = computeMasteryUpdate(workingState, lesson, args.correct, day);
    const nextMasteryMap = { ...workingState.mastery, [lesson.id]: calc.after };

    // Downstream Loop #4 (测验反哺图谱): Version-update unmastered downstream contracts
    // while 100% preserving mastered lessons & history.
    const adaptedPlans = (workingState.goalPlans || []).map((p) => {
      if (!p.units.some((u) => u.id === lesson.id)) return p;
      const adapted = adaptTrackContractsFromAssessment(p, {
        assessedLessonId: lesson.id,
        correct: args.correct,
        masteryAfter: calc.after,
        misconceptionNote: args.misconception,
        masteryMap: nextMasteryMap,
      });
      if (adapted.updatedLessonIds.length > 0) {
        return syncGoalPlanToCurriculumBlueprint({
          plan: adapted.plan,
          mastery: nextMasteryMap,
        }).plan;
      }
      return adapted.plan;
    });

    workingState = {
      ...workingState,
      goalPlans: adaptedPlans,
      mastery: nextMasteryMap,
      masteryMeta: { ...(workingState.masteryMeta || {}), [lesson.id]: calc.meta },
    };
    persistWorkingState(
      "Agent 掌握度评估",
      `更新「${lesson.title}」掌握度：${calc.before}% → ${calc.after}%`,
    );

    if (args.correct && resolved?.model) {
      const owningTrack = adaptedPlans.find((p) =>
        p.units.some((u) => u.id === lesson.id),
      );
      if (owningTrack) {
        void triggerRollingPrewarmForNextLesson({
          track: owningTrack,
          currentLessonId: lesson.id,
          masteryMap: nextMasteryMap,
          model: resolved.model,
          clientConfig: clientModelConfig,
        }).catch(() => {});
      }
    }

    const nextCandidate =
      calc.unlocked[0] ||
      getAllLessons(workingState).find(
        (u) =>
          u.id !== lesson.id &&
          available(workingState, u) &&
          (workingState.mastery[u.id] ?? 0) < 80,
      );

    return {
      kind: "mastery_update",
      attemptId,
      lessonId: lesson.id,
      lessonTitle: lesson.title,
      correct: args.correct,
      before: calc.before,
      after: calc.after,
      nextReviewDay: calc.nextReviewDay,
      unlockedTitles: calc.unlocked.map((u) => u.title),
      summary: args.summary,
      checkMode: args.checkMode,
      stabilityBefore: prevStability,
      stabilityAfter: calc.meta.stabilityDays,
      diagnostic:
        args.strength || args.misconception || args.keyTakeaway
          ? {
              strength: args.strength,
              misconception: args.misconception,
              keyTakeaway: args.keyTakeaway,
            }
          : undefined,
      remediationTriggered: calc.needsRemediation,
      nextSteps: args.correct
        ? [
            ...(nextCandidate
              ? [
                  {
                    label: `继续学习：${nextCandidate.title}`,
                    prompt: `我已经掌握了「${lesson.title}」，请带我学习下一节「${nextCandidate.title}」，配合 Mermaid 图解与多样化互动练习。`,
                    targetLessonId: nextCandidate.id,
                  },
                ]
              : []),
            {
              label: "动手代码实战题",
              prompt: `请针对「${lesson.title}」出一道动手写代码或修复 Bug 的练习题（mode: "code"，附带 starterCode 与 expectedOutput）。`,
              targetLessonId: lesson.id,
            },
            {
              label: "代码填空巩固",
              prompt: `请针对「${lesson.title}」出一道代码/概念填空题（mode: "fill_blank"）检验我的主动回忆。`,
              targetLessonId: lesson.id,
            },
            {
              label: "FSRS 主动回忆闪卡",
              prompt: `请为「${lesson.title}」（lessonId: ${lesson.id}）启动一张 FSRS 主动回忆闪卡（start_active_recall）。`,
              targetLessonId: lesson.id,
            },
            {
              label: "在知识图谱查看状态跃迁",
              prompt: "",
              targetLessonId: lesson.id,
              openGraph: true,
            },
          ]
        : [
            {
              label: "用代码填空拆解薄弱点",
              prompt: `我对「${lesson.title}」刚才那道题理解还不透彻，请换个直观类比拆解，并出一道带引导提示的代码/概念填空题（mode: "fill_blank"）帮我过关。`,
              targetLessonId: lesson.id,
            },
            {
              label: "用流程排序梳理步骤",
              prompt: `请用 Mermaid 图帮我梳理「${lesson.title}」的执行步骤，再出一道步骤排序题（mode: "order_steps"）让我排列正确顺序。`,
              targetLessonId: lesson.id,
            },
            {
              label: "在知识图谱定位此节点",
              prompt: "",
              targetLessonId: lesson.id,
              openGraph: true,
            },
          ],
    };
  }

  const existingThreadMeta = getChatThreadMetaFromDb(threadId);
  const taskType = classifyTaskType(userPromptText, attachedContext);
  const contextBrief = formatStoreContextForLLM(workingState, day, {
    taskType,
  });
  const attachedNote = attachedContext
    ? attachedContext.type === "lesson"
      ? `\n【用户当前在右侧选中的上下文】知识节点：「${attachedContext.title}」（lessonId: ${attachedContext.lessonId}，当前掌握度 ${attachedContext.mastery}%）`
      : `\n【用户当前在右侧选中的上下文】日程块：「${attachedContext.title}」（blockId: ${attachedContext.blockId}，${attachedContext.day} ${time(attachedContext.start)}，${attachedContext.minutes}分钟）`
    : "";

  const focusedLessonIdForSession =
    attachedContext?.type === "lesson"
      ? attachedContext.lessonId
      : taskType === "learn"
        ? focusLesson(workingState, workingState.activeTrackId)?.id || null
        : null;

  // CTX-19 & TUTOR-03: Inject bounded excerpt of ONLY the currently focused lesson's actual content & example code
  const currentLessonBodyNote = (() => {
    if (!focusedLessonIdForSession || taskType === "chat") return "";
    const curLesson = getLessonById(workingState, focusedLessonIdForSession);
    if (!curLesson) return "";
    const parts: string[] = [
      `\n【当前课程实际正文与示例代码（严禁在逐行讲解时擅自改写为其他厂商 SDK 或其他代码）】`,
      `- 课程标题：${curLesson.title}`,
    ];
    if (curLesson.concept) {
      const c = curLesson.concept.trim();
      const excerpt =
        c.length <= 1600
          ? c
          : `${c.slice(0, 1000)}\n…[正文已按预算省略中间 ${c.length - 1500} 字]…\n${c.slice(-500)}`;
      parts.push(`- 课程核心讲解片段：\n${excerpt}`);
    }
    if (curLesson.example) {
      const ex = curLesson.example.trim();
      parts.push(
        `- 页面当前展示的实际示例代码：\n\`\`\`\n${ex.slice(0, 900)}\n\`\`\``,
      );
    }
    if (curLesson.starterCode) {
      parts.push(
        `- 动手练习初始代码：\n\`\`\`\n${curLesson.starterCode.trim().slice(0, 600)}\n\`\`\``,
      );
    }
    const owningPlan = (workingState.goalPlans || []).find((p) =>
      p.units.some((u) => u.id === curLesson.id),
    );
    const neighborhood = owningPlan
      ? resolveGraphNeighborsForLesson(owningPlan.units, curLesson.id, {
          blueprintVersion: owningPlan.blueprintVersion ?? 1,
          mastery: workingState.mastery,
        })
      : null;
    const contract = neighborhood?.contract ?? curLesson.contract;
    if (contract) {
      parts.push(
        `- 知识图谱边界契约（v${contract.blueprintVersion} · 第 ${neighborhood?.positionIndex ?? 1}/${neighborhood?.totalUnits ?? 1} 课）：`,
        `  · 承接前置：${contract.assumedPrior.join("；")}`,
        `  · 本节聚焦范围（inScope）：${contract.inScope.join("；")}`,
        `  · 本节推进步：${contract.progressionStep}`,
        contract.deferredTo.length > 0
          ? `  · 留待后续节点（严禁在当前答疑中越界抢讲后续章节的完整实现）：${contract.deferredTo
              .map((d) => `《${d.targetLessonTitle}》`)
              .join("、")}`
          : "  · 本节为图谱收官节点",
      );
    }
    return parts.join("\n");
  })();

  const sharedSessionNote = (() => {
    if (!focusedLessonIdForSession || taskType === "chat") return "";
    try {
      const attempts = listAttemptsForLesson(focusedLessonIdForSession).slice(
        0,
        2,
      );
      const drafts = listPendingPlanDrafts(focusedLessonIdForSession);
      const lines: string[] = [
        `\n【共享 Learning Session State（权威事实，严禁凭空篡改或编造）】`,
        `- 当前课程 lessonId: ${focusedLessonIdForSession}`,
      ];
      if (attempts.length > 0) {
        const latest = attempts[0];
        lines.push(
          `- 最近一次确定性评分记录 attemptId=${latest.attempt_id}（grader=${latest.grader_version}）：得分 ${latest.score} 分，correct=${latest.correct}，errorType=${latest.error_type}`,
        );
        lines.push(
          `- 用户实际提交答案：${JSON.stringify(latest.submitted_answer)}`,
        );
        if (latest.position_matches) {
          lines.push(
            `- 逐位比对事实：${JSON.stringify(latest.position_matches)}`,
          );
        }
        if (latest.correct_answer !== null && latest.correct_answer !== undefined) {
          lines.push(
            `- 权威标准答案：${JSON.stringify(latest.correct_answer)}`,
          );
        }
      }
      if (drafts.length > 0) {
        lines.push(
          `- 待用户确认的补救排期草案（尚未改动日历）：${drafts[0].summary}`,
        );
      }
      return lines.join("\n");
    } catch {
      return "";
    }
  })();

  const skillRegistry = getTeachingSkillRegistry();
  const compactSkillCatalog = skillRegistry.getCompactCatalogForSystemPrompt();
  const focusedConsecutiveFailures = focusedLessonIdForSession
    ? (workingState.masteryMeta?.[focusedLessonIdForSession]?.consecutiveFailures ?? 0)
    : 0;
  const loadedOnDemandSkills = skillRegistry.resolveOnDemandSkills({
    userRequest: userPromptText,
    consecutiveFailures: focusedConsecutiveFailures,
  });
  const onDemandSkillsPrompt =
    skillRegistry.formatLoadedSkillsPrompt(loadedOnDemandSkills);

  const staticTutorSystemPrompt = `你是「学径」的学习助手与 AI 导师。你的定位是附着在确定性学习内核（课堂工作台、Assessment Engine、Learner Model BKT/FSRS、日历排程）之上的辅助导师。

系统控制边界（必须严格遵守）：
1. **职责分离**：
   - **Learn 主工作台**拥有课程执行、练习作答与确定性评分控制权；**Assessment Engine** 负责客观判分；**Learner Model** 负责 BKT 掌握度与 FSRS 计算；**Planner** 负责排期草案与日历变更。
   - **你（AI Tutor）负责**：摸底与建轨规划、辅助讲解与类比、调用 \`visual_explainer\` 生成可分步揭示的高清图解（Mermaid / 原生 SVG / 交互槽位）、提供分级提示、基于**权威评分事实**精准解释错因、以及生成候选互动练习（由 Learn 承载唯一作答入口）。
   - **严禁**：严禁在回复中自行编造 BKT 掌握度或 FSRS 复习日期；严禁忽视「逐位比对事实」去臆测用户把某一步排在了第几位；严禁把一次答题失败说成「已自动改动未来全部日程」（补救排期先生成 Plan Draft 等待用户在 Learn/Planner 确认）；**严禁在未成功调用 \`present_interactive_check\` 工具的情况下，编造 \`ex-xxxx\` 题号或宣称「已生成并同步到 Learn」**；**当用户要求逐行讲解当前课程代码时，必须严格逐行讲解上下文给出的页面实际示例代码，严禁擅自替换为其他厂商 SDK（如 DashScope/qwen 等）**。
2. **分阶段工作原则**：
   - **阶段 A（摸底询问）**：用户首次提出学习目标但未说明基础、目的或每日时间时，只用 1–2 句回应并调用 \`present_onboarding_survey\`，不要直接塞整节课。
   - **阶段 B（主题研究 → 自由分章建轨排课）**：用户提交摸底（或已明确基础与目标）后，**默认先调用 \`research_learning_topic\`（\`mode="auto_web"\`；若用户提供了参考链接或笔记则传入 \`userUrls\`/\`userNotes\` 并使用 \`mode="user_materials"\`；若用户明确选择了「快速开始」才用 \`mode="quick_draft"\`）**，基于检索到的权威资料与常见坑点，再调用 \`save_memory\` + \`create_learning_track\` 创建知识路径与无冲突日程，2–3 句说明计划并引导用户在 Learn 中开始第一节课（严禁在建轨同条消息里吐出整节课和练习题；详细深度教程将在用户进入 Learn 时按需逐课生成并缓存）。**章节层级与课程节数完全由你自由发挥（拒绝写死节数或固定阶段模板）**：完全依据该学科的真实知识体系、目标复杂度、已有基础与时间规划自由决定总课时数（多少节都可以，1 至 ${MAX_DYNAMIC_LESSONS} 节不设死板套路），并按 **「大章节（\`chapterTitle\` / \`chapters\`）→ 小章节（\`sectionTitle\` / \`sections\`）→ 课时（\`units\`）」** 自由组织多级章节结构（严禁套用千篇一律的“阶段一/二/三/四”固定命名，必须为每个大章节和小章节赋予贴合该领域专业脉络的真实名称，并通过 \`requiresIndices\` 构建包含并行分支与汇聚节点的真实先修 DAG）。每节课必须提供明确的 \`objective\`（学习目标）和 \`completionCriteria\`（完成条件）。当用户要求调整已有轨道的范围、深度或增减章节/课时时，调用 \`adjust_track_scope\`（自动保留已掌握历史并平滑更新排程）。若检索结果显示信息不足或降级为快速生成，务必如实提示待核验之处，不要把搜索结果当成绝对事实。
   - **阶段 C（辅助讲解、可视化图解与生成唯一练习）**：当用户请求讲解、类比、图解或动态出题时，围绕主教材提供补充解释；需要画流程图、原理示意图、数学/几何/物理/历史结构图时，**优先调用 \`visual_explainer\`**（自动按课缓存、严格安全净化并同步到当前课程的 Learn 主工作台，绝不跨课串图）；需要出互动题/提高难度/换题型时**必须真实调用 \`present_interactive_check\`**（系统会自动去重并同步到 Learn 唯一练习区），引导用户在 **Learn 练习区** 完成提交与确定性评分，不要在聊天中要求用户用自然语言回复答案来算分。
   - **阶段 D（基于客观评分解释错因）**：当用户请你解释刚才的评分结果时，**必须 100% 依据上下文中「最近一次确定性评分记录」与「逐位比对事实」**，准确指出具体错位、原理解析与改进思路；除非是开放式主观题且用户明确请求你按 Rubric 评定，否则不要重复调用 \`record_learning_assessment\` 覆盖确定性引擎的评分。
   - **阶段 E（重排必须先给草案）**：遇到加班、冲突或改期请求时，必须先调用 \`propose_reschedule\`（务必传入准确的 \`conflictDay\`）或 \`propose_batch_reschedule\` 生成待用户确认的重排草案，严禁跳过确认直接调用 \`manage_calendar_block\` 挪动已有课程。
3. **多样化互动题必须携带确定性判分标准（供 Learn 离线/无 LLM 直接判分）**：
   - **\`order_steps\`（流程排序）**：必须同时传入打乱后的 \`steps\` 与权威正确顺序 \`correctStepsOrder\`！
   - **\`choice\`（单选）**：必须传入 \`choices\` 与 0-based \`correctChoiceIndex\`；**严禁习惯性把正确选项固定放在 B（下标 1）**，正确选项位置必须随机分布在 A/B/C/D（0/1/2/3），选项文本不要带 "A. "/"B. " 前缀，\`explanation\` 直接解释正确选项的原理而不要写死“选 B”（系统注册时也会对选项进行随机打乱并重映射 \`correctChoiceIndex\`）。
   - **\`multi_choice\`（多选）**：必须传入 \`choices\` 与 \`correctChoiceIndices\`（同样不要带 "A. " 前缀，随机分布正确选项位置）。
   - **\`fill_blank\`（填空）**：每个 \`blanks\` 槽位必须传入 \`answer\`。
   - **\`code\` / \`short_answer\`**：传入 \`rubricPoints\`（2–4 条可检查要点）与 \`expectedOutput\`。
4. **先观测再行动**：需要了解图谱、日程或记忆时先调用 \`read_workspace_state\` / \`find_calendar_windows\`；需要帮用户切入某课会话时调用 \`start_learning_session\`。
5. **日期与星期必须 100% 原样引用上下文或工具返回值**，严禁自行推算星期几。
6. 保持诚实、有据可查，使用简体中文。${compactSkillCatalog ? `\n\n${compactSkillCatalog}` : ""}`;

  const dynamicWorkspaceContext = `当前工作区实时摘要：\n${contextBrief}${attachedNote}${currentLessonBodyNote}${sharedSessionNote}${onDemandSkillsPrompt}`;
  const systemPrompt = `${staticTutorSystemPrompt}\n\n${dynamicWorkspaceContext}`;

  const deepSeekTutorCallCfg = buildDeepSeekCallConfig("tutor_chat", {
    isDeepSeek: resolved.isDeepSeek,
    modelId: resolved.modelId,
    taskType,
    userThinkingMode: resolved.thinkingMode,
    userReasoningEffort: resolved.reasoningEffort,
    latestReminderDay: day,
  });

  // DeepSeek Thinking Mode + Tools requires preserving historical reasoning_content across turns (thinking_mode.md#tool-calls)
  const preserveReasoning =
    resolved.isDeepSeek && deepSeekTutorCallCfg.thinkingEnabled;

  const ESTIMATED_TOOL_SCHEMA_TOKENS = 2600;
  const modelContextBudget = resolveModelContextBudget(
    resolved.modelId,
    clientModelConfig?.contextWindowTokens,
  );
  const preparedCtx = prepareContextForLLM({
    messages,
    taskType,
    systemPromptTokens: estimateTextTokens(systemPrompt),
    toolSchemaTokens: ESTIMATED_TOOL_SCHEMA_TOKENS,
    existingSummary: existingThreadMeta?.summary,
    existingSummaryCount: existingThreadMeta?.summaryMsgCount,
    maxContextTokens: modelContextBudget,
    compactionThresholdRatio: 0.7,
    recentTurnsToKeepFullTools: 2,
    recentTurnsToKeepOnCompaction: 3,
    preserveReasoning,
  });

  if (preparedCtx.summaryUpdated && preparedCtx.threadSummary) {
    try {
      updateChatThreadSummaryInDb(
        threadId,
        preparedCtx.threadSummary,
        preparedCtx.summaryCoveredCount,
      );
    } catch {}
  }

  const buildDynamicContextNote = (
    summary: string | null,
    coveredCount: number,
  ) =>
    summary
      ? `${dynamicWorkspaceContext}\n\n【早期对话滚动摘要（系统已自动压缩前 ${coveredCount} 条早期消息；最新知识图谱、日程与长期记忆已由上方实时同步）】\n${summary}`
      : dynamicWorkspaceContext;

  const buildEffectiveSystemPrompt = (
    summary: string | null,
    coveredCount: number,
  ) => `${staticTutorSystemPrompt}\n\n${buildDynamicContextNote(summary, coveredCount)}`;

  const effectiveSystemPrompt = buildEffectiveSystemPrompt(
    preparedCtx.threadSummary,
    preparedCtx.summaryCoveredCount,
  );
  const effectiveDynamicContext = buildDynamicContextNote(
    preparedCtx.threadSummary,
    preparedCtx.summaryCoveredCount,
  );

  const AVAILABLE_TOOL_NAMES = [
    "read_workspace_state",
    "find_calendar_windows",
    "research_learning_topic",
    "fetch_reference_url",
    "plan_teaching_move",
    "create_learning_track",
    "adjust_track_scope",
    "manage_calendar_block",
    "propose_reschedule",
    "propose_batch_reschedule",
    "present_learning_roadmap",
    "present_onboarding_survey",
    "present_data_chart",
    "visual_explainer",
    "search_visual_resource",
    "present_interactive_check",
    "record_learning_assessment",
    "start_active_recall",
    "save_memory",
  ];

  const trace = new AgentTraceRecorder({
    runId,
    conversationId: threadId,
    userId: "local-desktop-user",
    route: "agent",
    provider: resolved.providerName,
    model: resolved.modelId,
    modelLabel: resolved.label,
    userPrompt: userPromptText,
  });

  trace.recordRunStarted({
    message_count: messages.length,
    sent_message_count: preparedCtx.messagesForLLM.length,
    context_compaction: preparedCtx.stats,
    active_track_id: workingState.activeTrackId || null,
    day,
    attached_context: attachedContext ?? null,
  });

  let stepIteration = 1;
  trace.startModelRequest({
    iteration: stepIteration,
    messageCount: preparedCtx.messagesForLLM.length,
    availableTools: AVAILABLE_TOOL_NAMES,
    attachedContext: attachedContext ?? null,
  });

  // Opt-in real multi-tool E2E verification path (runs actual tool executors + AgentTraceRecorder + SQLite)
  if (lastUserRawText.startsWith("[E2E_TRACE_TEST]")) {
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        try {
          writer.write({ type: "start", messageId: `asst-${taskId}` });

          const memArgs = {
            action: "add" as const,
            category: "goal" as const,
            text: "目标：14天系统掌握 Java 后端核心，每晚 20:00 后学习 45 分钟",
            reason: "用户明确说明学习目标与时间约束",
          };
          const tc1Id = `tc-mem-${crypto.randomUUID().slice(0, 6)}`;
          const tc2Id = `tc-trk-${crypto.randomUUID().slice(0, 6)}`;
          const trackArgs = {
            title: "Java 后端核心速通",
            goal: "掌握 Java 类与对象、集合框架与 JVM 内存模型",
            days: 14,
            dailyMinutes: 45,
            startMinutes: 1200,
            endMinutes: 1320,
            units: [
              {
                title: "类与对象内存模型",
                concept: "理解栈帧局部变量与堆内存对象引用的关系。",
                minutes: 30,
              },
              {
                title: "List 与 HashMap 底层机制",
                concept: "掌握 ArrayList 动态扩容与 HashMap 哈希冲突处理。",
                minutes: 40,
                requiresIndices: [0],
              },
              {
                title: "JVM 垃圾回收与可达性分析",
                concept: "理解 GC Roots 与分代回收策略。",
                minutes: 40,
                requiresIndices: [0, 1],
              },
            ],
          };

          trace.recordModelResponse({
            iteration: 1,
            text: "我先记住你的目标与时间偏好，并为你构建 Java 学习轨道与无冲突日程。",
            finishReason: "tool-calls",
            usage: null,
            requestedToolCalls: [
              { toolCallId: tc1Id, toolName: "save_memory", input: memArgs },
              {
                toolCallId: tc2Id,
                toolName: "create_learning_track",
                input: trackArgs,
              },
            ],
          });

          const memOut = await trace.wrapToolExecution({
            toolCallId: tc1Id,
            toolName: "save_memory",
            args: memArgs,
            execute: () => execSaveMemory(memArgs),
            captureStateChanges: (res): StateChangeSpec[] =>
              res.kind === "memory_saved"
                ? [
                    {
                      entityType: "memory",
                      entityId: res.memoryId,
                      action: "create",
                      beforeState: null,
                      afterState: {
                        id: res.memoryId,
                        category: res.category,
                        label: res.label,
                        text: res.text,
                      },
                    },
                  ]
                : [],
          });
          writer.write({
            type: "tool-input-available",
            toolCallId: tc1Id,
            toolName: "save_memory",
            input: memArgs,
          });
          writer.write({
            type: "tool-output-available",
            toolCallId: tc1Id,
            output: memOut,
          });

          const beforeTrackCount = (workingState.goalPlans || []).length;
          const beforeBlockCount = workingState.blocks.length;
          const trackOut = await trace.wrapToolExecution({
            toolCallId: tc2Id,
            toolName: "create_learning_track",
            args: trackArgs,
            execute: () => execCreateLearningTrack(trackArgs),
            captureStateChanges: (res): StateChangeSpec[] =>
              "kind" in res && res.kind === "track_created"
                ? [
                    {
                      entityType: "learning_track",
                      entityId: res.plan.id,
                      action: "create",
                      beforeState: { trackCount: beforeTrackCount },
                      afterState: {
                        trackCount: beforeTrackCount + 1,
                        trackId: res.plan.id,
                        title: res.plan.title,
                        unitCount: res.plan.units.length,
                      },
                    },
                    {
                      entityType: "study_plan",
                      entityId: res.plan.id,
                      action: "create",
                      beforeState: { totalBlocks: beforeBlockCount },
                      afterState: {
                        totalBlocks: workingState.blocks.length,
                        addedSlots: res.plan.slots.map((b) => ({
                          id: b.id,
                          day: b.day,
                          start: time(b.start),
                          minutes: b.minutes,
                          title: b.title,
                        })),
                      },
                    },
                  ]
                : [],
          });
          writer.write({
            type: "tool-input-available",
            toolCallId: tc2Id,
            toolName: "create_learning_track",
            input: trackArgs,
          });
          writer.write({
            type: "tool-output-available",
            toolCallId: tc2Id,
            output: trackOut,
          });

          // Round 2: present_interactive_check + record_learning_assessment
          await new Promise((r) => setTimeout(r, 200));
          stepIteration = 2;
          trace.startModelRequest({
            iteration: 2,
            messageCount: messages.length + 2,
            availableTools: AVAILABLE_TOOL_NAMES,
          });

          const firstLesson =
            "kind" in trackOut && trackOut.kind === "track_created"
              ? trackOut.plan.units[0]
              : workingState.goalPlans?.at(-1)?.units[0];
          if (!firstLesson) {
            throw new Error("未能获取初始课程节点");
          }
          const tc3Id = `tc-chk-${crypto.randomUUID().slice(0, 6)}`;
          const checkArgs = {
            mode: "fill_blank" as const,
            lessonId: firstLesson.id,
            lessonTitle: firstLesson.title,
            language: "java",
            prompt: "补全下方 Java 代码，在堆上创建一个 `User` 对象并打印其 `name` 属性：",
            starterCode: `User u = ___1___ User("Alice");\nSystem.out.___2___(u.name);`,
            blanks: [
              { id: "blank-1", label: "空 (1) 实例化关键字", answer: "new" },
              { id: "blank-2", label: "空 (2) 打印方法", answer: "println" },
            ],
            explanation: "`new` 关键字在堆内存分配对象空间，`System.out.println` 负责换行输出。",
          };

          const tc4Id = `tc-assess-${crypto.randomUUID().slice(0, 6)}`;
          const assessArgs = {
            lessonId: firstLesson.id,
            correct: true,
            checkMode: "代码填空",
            summary: "准确区分堆对象实例化关键字与控制台打印方法。",
            strength: "正确写出 new 实例化与 println 输出方法。",
            keyTakeaway: "引用变量在栈帧中，new 出来的对象实体在堆内存中。",
          };

          trace.recordModelResponse({
            iteration: 2,
            text: "已为你生成第一课的代码填空题，并记录了摸底诊断评估。",
            finishReason: "tool-calls",
            usage: null,
            requestedToolCalls: [
              {
                toolCallId: tc3Id,
                toolName: "present_interactive_check",
                input: checkArgs,
              },
              {
                toolCallId: tc4Id,
                toolName: "record_learning_assessment",
                input: assessArgs,
              },
            ],
          });

          const checkOut = await trace.wrapToolExecution({
            toolCallId: tc3Id,
            toolName: "present_interactive_check",
            args: checkArgs,
            execute: () => ({
              kind: "interactive_check" as const,
              checkId: `chk-${crypto.randomUUID().slice(0, 8)}`,
              ...checkArgs,
            }),
          });
          writer.write({
            type: "tool-input-available",
            toolCallId: tc3Id,
            toolName: "present_interactive_check",
            input: checkArgs,
          });
          writer.write({
            type: "tool-output-available",
            toolCallId: tc3Id,
            output: checkOut,
          });

          const assessOut = await trace.wrapToolExecution({
            toolCallId: tc4Id,
            toolName: "record_learning_assessment",
            args: assessArgs,
            execute: () => execRecordAssessment(assessArgs),
            captureStateChanges: (res): StateChangeSpec[] =>
              "kind" in res && res.kind === "mastery_update"
                ? [
                    {
                      entityType: "learning_state",
                      entityId: res.lessonId,
                      action: "update",
                      beforeState: {
                        mastery: res.before,
                        stabilityDays: res.stabilityBefore ?? null,
                      },
                      afterState: {
                        mastery: res.after,
                        stabilityDays: res.stabilityAfter ?? null,
                        nextReviewDay: res.nextReviewDay,
                        unlockedTitles: res.unlockedTitles,
                      },
                    },
                    {
                      entityType: "assessment_record",
                      entityId: res.attemptId,
                      action: "create",
                      beforeState: null,
                      afterState: {
                        attemptId: res.attemptId,
                        lessonId: res.lessonId,
                        correct: res.correct,
                        checkMode: res.checkMode,
                        summary: res.summary,
                      },
                    },
                  ]
                : [],
          });
          writer.write({
            type: "tool-input-available",
            toolCallId: tc4Id,
            toolName: "record_learning_assessment",
            input: assessArgs,
          });
          writer.write({
            type: "tool-output-available",
            toolCallId: tc4Id,
            output: assessOut,
          });

          // Final Round 3: Final Response
          stepIteration = 3;
          trace.startModelRequest({
            iteration: 3,
            messageCount: messages.length + 4,
            availableTools: AVAILABLE_TOOL_NAMES,
          });
          const finalText = `已为你完成 **Java 后端核心速通** 建轨、时间约束记忆写入、首节代码填空题出题与掌握度评估更新。\n\n- 已写入长期记忆与 3 节先修微课\n- 第一课「${firstLesson.title}」已准备好互动练习，请在上方卡片中作答。`;
          trace.recordModelResponse({
            iteration: 3,
            text: finalText,
            finishReason: "stop",
            usage: null,
            requestedToolCalls: [],
          });

          writer.write({ type: "text-start", id: "t1" });
          writer.write({ type: "text-delta", id: "t1", delta: finalText });
          writer.write({ type: "text-end", id: "t1" });
          writer.write({ type: "finish" });

          trace.recordRunCompleted({
            finalResponse: finalText,
            stepCount: 3,
            reasoningChars: 0,
          });
        } catch (err) {
          trace.recordRunFailed({
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        } finally {
          unregisterServerTaskController(taskId);
        }
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  const agentTools = {
      read_workspace_state: tool({
        description:
          "读取当前真实工作区状态：所有学习轨道、知识图谱节点掌握度与先修状态、未来 7 天日程、错课、可行性负荷与有效长期记忆。",
        inputSchema: z.object({}),
        execute: async (input, options) =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "read_workspace_state",
            args: input,
            execute: () => execReadWorkspaceState(),
          }),
      }),
      find_calendar_windows: tool({
        description:
          "扫描指定日期（YYYY-MM-DD 数组）的真实无冲突空闲时间窗口，自动遵守睡眠红线与已锁定日程。",
        inputSchema: z.object({
          days: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
        }),
        execute: async (input, options) =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "find_calendar_windows",
            args: input,
            execute: () => execFindCalendarWindows(input.days),
          }),
      }),
      research_learning_topic: tool({
        description:
          "高层主题研究工具：自动通过 DeepSeek 联网检索权威学习资料并缓存至本机 SQLite（支持 auto_web 自动检索、quick_draft 快速生成、user_materials 指定资料），输出核心概念、先修建议、常见误区、来源引用与待核验标注，供建轨与深度教学消费。",
        inputSchema: z.object({
          topic: z.string().min(1).describe("要研究的学习主题或课程概念"),
          goal: z.string().optional().describe("学习者的完整目标描述"),
          learnerLevel: z
            .enum(["beginner", "intermediate", "advanced"])
            .optional()
            .describe("学习者当前水平，决定研究深度与先修铺垫"),
          mode: z
            .enum(["auto_web", "quick_draft", "user_materials"])
            .optional()
            .describe("知识获取模式，默认 auto_web"),
          userUrls: z
            .array(z.string())
            .max(3)
            .optional()
            .describe("用户提供的参考网页 URL 列表（可选）"),
          userNotes: z
            .string()
            .optional()
            .describe("用户粘贴的教材片段或笔记（可选）"),
          forceRefresh: z
            .boolean()
            .optional()
            .describe("是否忽略本地缓存强制重新联网检索"),
        }),
        execute: async (input, options) =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "research_learning_topic",
            args: input,
            execute: async () => {
              const res = await runResearchPlanner({
                request: {
                  goal: input.goal || input.topic,
                  topic: input.topic,
                  learnerLevel: input.learnerLevel || "intermediate",
                  researchPurpose: "curriculum",
                  mode: input.mode || "auto_web",
                  userUrls: input.userUrls,
                  userNotes: input.userNotes,
                  forceRefresh: input.forceRefresh,
                  budget: {
                    maxSteps: 4,
                    maxSearches: 3,
                    maxFetches: 2,
                    maxTokens: 10000,
                  },
                },
                identity: { runId },
                model: resolved?.model ?? null,
                modelLabel: resolved?.label,
                providerName: resolved?.providerName,
                clientConfig: clientModelConfig,
                abortSignal: options?.abortSignal,
              });
              latestTurnResearchPackage = res.package;
              return res.package;
            },
          }),
      }),
      plan_teaching_move: tool({
        description:
          "调用混合自适应 Teaching Planner：严格依据真实作答证据、掌握度、先修解锁状态与可用能力决定下一步教学动作，并向 Learn 注册经过校验的教学活动或唯一练习。",
        inputSchema: z.object({
          lessonId: z.string().min(1),
          userRequest: z.string().optional(),
          availableMinutes: z.number().int().min(5).max(180).optional(),
          userSelfReportedMastery: z.boolean().optional(),
        }),
        execute: async (input, options) =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "plan_teaching_move",
            args: input,
            execute: async () => {
              const lesson = getLessonById(workingState, input.lessonId);
              if (!lesson) {
                return { error: `未找到课程 ${input.lessonId}` };
              }
              const track = (workingState.goalPlans || []).find((p) =>
                p.units.some((u) => u.id === lesson.id),
              );
              const neighborhood = track
                ? resolveGraphNeighborsForLesson(track.units, lesson.id, {
                    blueprintVersion: track.blueprintVersion ?? 1,
                    mastery: workingState.mastery,
                  })
                : null;
              const { session } = startLearningSession({
                lessonId: lesson.id,
                trackId: track?.id,
                day,
              });
              const attempts = listAttemptsForLesson(lesson.id).slice(0, 5);
              const meta = workingState.masteryMeta?.[lesson.id];
              return await runTeachingPlanner({
                context: {
                  goalId: track?.id || "local-goal",
                  trackId: track?.id,
                  lessonId: lesson.id,
                  lessonTitle: lesson.title,
                  learningSessionId: session.learning_session_id,
                  currentOutcome: lesson.objective || lesson.title,
                  knowledgeContext: {
                    concept: lesson.concept,
                    objective: lesson.objective,
                    completionCriteria: lesson.completionCriteria,
                    hasPreparedContent: true,
                    contract: neighborhood?.contract ?? lesson.contract,
                    nextLessonTitle:
                      neighborhood?.directSuccessors[0]?.title ||
                      neighborhood?.laterUnits[0]?.title,
                    trackPosition: neighborhood
                      ? `${neighborhood.positionIndex}/${neighborhood.totalUnits}`
                      : undefined,
                  },
                  learnerEvidence: {
                    recentAttempts: attempts.map((a) => ({
                      attemptId: a.attempt_id,
                      correct: a.correct,
                      score: a.score,
                      errorType: a.error_type,
                      feedback: a.feedback,
                    })),
                    misconceptions: attempts
                      .filter((a) => !a.correct && a.feedback)
                      .map((a) => a.feedback),
                    masteryEstimate: workingState.mastery[lesson.id] ?? 0,
                    masteryOrigin: meta?.masteryOrigin,
                    consecutiveFailures: meta?.consecutiveFailures ?? 0,
                  },
                  prerequisitesMet: available(workingState, lesson),
                  userRequest: input.userRequest,
                  userSelfReportedMastery: input.userSelfReportedMastery,
                  availableCapabilities: DEFAULT_LEARNOS_CAPABILITIES,
                  availableMinutes: input.availableMinutes,
                },
                lesson,
                identity: {
                  runId,
                  trackId: track?.id,
                  lessonId: lesson.id,
                  learningSessionId: session.learning_session_id,
                },
                model: resolved?.model ?? null,
                modelLabel: resolved?.label,
                providerName: resolved?.providerName,
                abortSignal: options?.abortSignal,
              });
            },
          }),
      }),
      fetch_reference_url: tool({
        description:
          "抓取单个用户指定的参考网页，提取有界 Markdown 摘录与标题用于备课或答疑（不整站复制）。",
        inputSchema: z.object({
          url: z.string().min(8).describe("HTTP/HTTPS 网页地址"),
        }),
        execute: async (input, options) =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "fetch_reference_url",
            args: input,
            execute: async () => {
              try {
                return await deepseekWebFetch({
                  url: input.url,
                  clientConfig: clientModelConfig,
                  abortSignal: options?.abortSignal,
                });
              } catch (err) {
                return {
                  error:
                    err instanceof Error ? err.message : "网页读取失败",
                };
              }
            },
          }),
      }),
      create_learning_track: tool({
        description:
          "根据学科真实知识架构、用户目标与基础自由设计课程体系（课程总节数完全自由，不设固定节数模板；支持按「大章节 chapterTitle / chapters → 小章节 sectionTitle / sections → 课时 units」构建两级或多级目录与无环 DAG 先修图谱），并自动按拓扑顺序排入无冲突日历空档。",
        inputSchema: z.object({
          title: z.string().describe("轨道简称，例如：Python · Agent 评测实战"),
          goal: z.string().describe("完整学习目标描述"),
          depth: z
            .enum(["crash", "standard", "deep"])
            .optional()
            .describe("深度定位：crash（速通聚焦）、standard（实战标准）、deep（系统深入），仅代表深度风格，不限制具体节数与章节划分"),
          scopeNote: z
            .string()
            .optional()
            .describe("学习范围说明（如：聚焦某模块、跳过已掌握基础）"),
          priorKnowledge: z
            .enum(["beginner", "intermediate", "advanced"])
            .optional()
            .describe("用户当前基础水平"),
          days: z.number().int().min(1).max(180).optional(),
          dailyMinutes: z.number().int().min(15).max(240).optional(),
          startMinutes: z
            .number()
            .int()
            .min(420)
            .max(1350)
            .optional()
            .describe("偏好开始时间（午夜后分钟数，如 19:30 = 1170）"),
          endMinutes: z
            .number()
            .int()
            .min(480)
            .max(1380)
            .optional()
            .describe("硬结束边界（午夜后分钟数，如 22:30 = 1350）"),
          chapters: z
            .array(
              z.object({
                title: z
                  .string()
                  .describe("大章节标题（由你根据学科自由命名，如：第一章 · LLM 通信底座与消息协议）"),
                summary: z
                  .string()
                  .optional()
                  .describe("本大章节解决的核心问题与目标说明"),
                sections: z
                  .array(
                    z.object({
                      title: z
                        .string()
                        .describe("小章节标题（由你自由划分，如：1.1 无状态消息流与上下文窗口）"),
                      summary: z.string().optional(),
                      units: z.array(
                        z.object({
                          title: z.string(),
                          objective: z.string().optional(),
                          completionCriteria: z.string().optional(),
                          concept: z.string(),
                          example: z.string().optional(),
                          minutes: z.number().int().min(15).max(90).optional(),
                          requiresIndices: z
                            .array(z.number().int().min(0))
                            .optional()
                            .describe("先修课程在全局拉平后的 0-based 课时下标列表，必须构成无环 DAG"),
                          practiceType: z.enum(["code", "text"]).optional(),
                          practiceLanguage: z.string().optional(),
                          practicePrompt: z.string().optional(),
                          starterCode: z.string().optional(),
                        }),
                      ),
                    }),
                  )
                  .optional(),
              }),
            )
            .optional()
            .describe("可选的多级嵌套结构（大章节 -> 小章节 -> 课时）；也可以直接在下方 units 数组中通过 chapterTitle 和 sectionTitle 指定所属大章节与小章节"),
          units: z
            .array(
              z.object({
                chapterTitle: z
                  .string()
                  .optional()
                  .describe("所属大章节标题（由你根据学科逻辑自由命名，如：第一章 · 大模型通信底座与运行时直觉；禁止使用写死模板）"),
                chapterSummary: z
                  .string()
                  .optional()
                  .describe("本大章节的阶段目标或核心主线简述"),
                sectionTitle: z
                  .string()
                  .optional()
                  .describe("所属小章节/子专题标题（由你自由划分，如：1.1 请求生命周期与上下文窗口）"),
                sectionSummary: z
                  .string()
                  .optional()
                  .describe("本小章节概要说明"),
                title: z.string().describe("具体课时标题"),
                objective: z
                  .string()
                  .optional()
                  .describe("本课明确的学习目标（学完后能理解或做到什么）"),
                completionCriteria: z
                  .string()
                  .optional()
                  .describe("本课可检查的完成条件（如何验证已过关）"),
                concept: z.string().describe("核心知识点简述（1-2 句）"),
                example: z.string().optional().describe("简短真实示例或代码片段"),
                minutes: z.number().int().min(15).max(90).optional(),
                requiresIndices: z
                  .array(z.number().int().min(0))
                  .optional()
                  .describe("先修课程在 units 数组中的下标列表，必须构成无环 DAG（支持并行分支与汇聚）"),
                practiceType: z
                  .enum(["code", "text"])
                  .optional()
                  .describe("本课动手练习最适合的输入形态：写代码/JSON/SQL用 code，原理解释/设计思考用 text"),
                practiceLanguage: z
                  .string()
                  .optional()
                  .describe("当 practiceType=code 时的编程语言，如 python/typescript/java/json/sql"),
                practicePrompt: z
                  .string()
                  .optional()
                  .describe("针对本课定制的具体动手练习题目要求"),
                starterCode: z
                  .string()
                  .optional()
                  .describe("当 practiceType=code 时的简短起始代码骨架"),
              }),
            )
            .max(MAX_DYNAMIC_LESSONS)
            .optional(),
        }),
        execute: async (input, options) => {
          const beforeTrackCount = (workingState.goalPlans || []).length;
          const beforeBlockCount = workingState.blocks.length;
          return trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "create_learning_track",
            args: input,
            execute: () => execCreateLearningTrack(input),
            captureStateChanges: (res): StateChangeSpec[] => {
              if (!res || !("kind" in res) || res.kind !== "track_created") {
                return [];
              }
              return [
                {
                  entityType: "learning_track",
                  entityId: res.plan.id,
                  action: "create",
                  beforeState: { trackCount: beforeTrackCount },
                  afterState: {
                    trackCount: beforeTrackCount + 1,
                    trackId: res.plan.id,
                    title: res.plan.title,
                    depth: res.plan.depth,
                    unitCount: res.plan.units.length,
                    units: res.plan.units.map((u) => ({
                      id: u.id,
                      stageTitle: u.stageTitle,
                      moduleTitle: u.moduleTitle,
                      title: u.title,
                      objective: u.objective,
                      completionCriteria: u.completionCriteria,
                      minutes: u.minutes,
                      requires: u.requires,
                    })),
                  },
                },
                {
                  entityType: "study_plan",
                  entityId: res.plan.id,
                  action: "create",
                  beforeState: { totalBlocks: beforeBlockCount },
                  afterState: {
                    totalBlocks: workingState.blocks.length,
                    addedSlots: res.plan.slots.map((b) => ({
                      id: b.id,
                      day: b.day,
                      start: time(b.start),
                      minutes: b.minutes,
                      title: b.title,
                    })),
                  },
                },
              ];
            },
          });
        },
      }),
      adjust_track_scope: tool({
        description:
          "调整已有学习轨道的范围、深度、大章节/小章节或课程数量（支持追加带 chapterTitle/sectionTitle 的新课或精简未学课程），自动校验无环先修依赖并保护已掌握记录与已完成日程。",
        inputSchema: z.object({
          trackId: z.string().optional().describe("目标轨道 ID，省略则操作当前活跃轨道"),
          depth: z.enum(["crash", "standard", "deep"]).optional(),
          scopeNote: z.string().optional(),
          days: z.number().int().min(1).max(180).optional(),
          dailyMinutes: z.number().int().min(15).max(240).optional(),
          removeLessonIds: z
            .array(z.string())
            .optional()
            .describe("需要精简移除的未掌握课程 ID 列表（已掌握课程受保护）"),
          appendUnits: z
            .array(
              z.object({
                chapterTitle: z
                  .string()
                  .optional()
                  .describe("所属大章节标题（可归入已有大章节或新建大章节）"),
                chapterSummary: z.string().optional(),
                sectionTitle: z
                  .string()
                  .optional()
                  .describe("所属小章节标题（可归入已有小章节或新建小章节）"),
                title: z.string(),
                concept: z.string(),
                objective: z.string().optional(),
                completionCriteria: z.string().optional(),
                example: z.string().optional(),
                minutes: z.number().int().min(15).max(90).optional(),
                requires: z.array(z.string()).optional(),
                practiceType: z.enum(["code", "text"]).optional(),
                practiceLanguage: z.string().optional(),
                practicePrompt: z.string().optional(),
                starterCode: z.string().optional(),
              }),
            )
            .optional(),
        }),
        execute: async (input, options) => {
          const targetId = input.trackId || workingState.activeTrackId;
          if (!targetId) {
            return { error: "当前没有可调整的活跃学习轨道。" };
          }
          const beforePlan = (workingState.goalPlans || []).find(
            (p) => p.id === targetId,
          );
          const beforeCount = beforePlan?.units.length ?? 0;
          return trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "adjust_track_scope",
            args: { ...input, trackId: targetId },
            execute: () => {
              try {
                const res = reconcileTrackUnitsAndSchedule(workingState, {
                  trackId: targetId,
                  day,
                  depth: input.depth,
                  scopeNote: input.scopeNote,
                  days: input.days,
                  dailyMinutes: input.dailyMinutes,
                  appendUnits: input.appendUnits,
                  removeLessonIds: input.removeLessonIds,
                });
                const { plan: syncedPlan } = syncGoalPlanToCurriculumBlueprint({
                  plan: res.plan,
                  mastery: res.store.mastery,
                });
                workingState = {
                  ...res.store,
                  goalPlans: (res.store.goalPlans || []).map((p) =>
                    p.id === syncedPlan.id ? syncedPlan : p,
                  ),
                };
                persistWorkingState("Agent 调整范围与深度", workingState.decision);

                // Automatically refresh/prewarm the first unmastered focus lesson against the new blueprintVersion
                const nextFocus = focusLesson(workingState, syncedPlan.id);
                if (nextFocus && resolved?.model) {
                  void prepareLessonInDepth({
                    lesson: nextFocus,
                    trackId: syncedPlan.id,
                    trackTitle: syncedPlan.title,
                    trackGoal: syncedPlan.goal,
                    trackUnits: syncedPlan.units,
                    blueprintId: syncedPlan.blueprintId,
                    blueprintVersion: syncedPlan.blueprintVersion ?? 1,
                    contract: nextFocus.contract,
                    researchPackageId: syncedPlan.researchPackageId,
                    reuseTrackResearch: true,
                    masteryMap: workingState.mastery,
                    learnerLevel: syncedPlan.priorKnowledge || "intermediate",
                    mode: "auto_web",
                    model: resolved.model,
                    clientConfig: clientModelConfig,
                  }).catch(() => {});
                }

                return {
                  kind: "track_created" as const,
                  plan: syncedPlan,
                  note: `${workingState.decision}（蓝图升级至 v${syncedPlan.blueprintVersion ?? 1}，新增排期 ${res.newlyScheduledBlocks.length} 节，100% 保护已掌握课程 ${res.preservedMasteredIds.length} 节）`,
                } satisfies TrackCreatedCard;
              } catch (err) {
                return {
                  error: err instanceof Error ? err.message : "调整轨道范围失败",
                };
              }
            },
            captureStateChanges: (res): StateChangeSpec[] => {
              if (!res || !("kind" in res) || res.kind !== "track_created") {
                return [];
              }
              return [
                {
                  entityType: "learning_track",
                  entityId: res.plan.id,
                  action: "update",
                  beforeState: { unitCount: beforeCount, depth: beforePlan?.depth },
                  afterState: {
                    unitCount: res.plan.units.length,
                    depth: res.plan.depth,
                    scopeNote: res.plan.scopeNote,
                  },
                },
              ];
            },
          });
        },
      }),
      manage_calendar_block: tool({
        description:
          "直接对日历日程块执行新增、修改时间、删除或标记完成操作（会自动校验冲突与睡眠保护红线）。",
        inputSchema: z.object({
          action: z.enum(["add", "update", "delete", "complete"]),
          blockId: z.string().optional(),
          title: z.string().optional(),
          day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          startMinutes: z.number().int().min(0).max(1425).optional(),
          minutes: z.number().int().min(15).max(360).optional(),
          kind: z.enum(["学习", "复习", "工作", "生活"]).optional(),
          locked: z.boolean().optional(),
          lessonId: z.string().optional(),
        }),
        execute: async (input, options) => {
          const prevBlock = input.blockId
            ? workingState.blocks.find((b) => b.id === input.blockId) || null
            : null;
          return trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "manage_calendar_block",
            args: input,
            execute: () => execManageCalendarBlock(input),
            captureStateChanges: (res): StateChangeSpec[] => {
              if (!res || !("kind" in res) || res.kind !== "calendar_updated") {
                return [];
              }
              return [
                {
                  entityType: "study_plan",
                  entityId: res.block.id,
                  action:
                    input.action === "delete"
                      ? "delete"
                      : input.action === "add"
                        ? "create"
                        : "update",
                  beforeState: prevBlock
                    ? {
                        day: prevBlock.day,
                        start: time(prevBlock.start),
                        minutes: prevBlock.minutes,
                        title: prevBlock.title,
                        done: Boolean(prevBlock.done),
                      }
                    : null,
                  afterState:
                    input.action === "delete"
                      ? null
                      : {
                          day: res.block.day,
                          start: time(res.block.start),
                          minutes: res.block.minutes,
                          title: res.block.title,
                          done: Boolean(res.block.done),
                        },
                },
              ];
            },
          });
        },
      }),
      propose_reschedule: tool({
        description:
          "当遇到临时插会/加班冲突或用户某时段没空时，生成 2-3 套无冲突、严格遵守先修顺序的重排对比方案草案（绝不直接修改日历，需用户点击确认）。务必准确传入 conflictDay（YYYY-MM-DD）避免误放到今天。",
        inputSchema: z.object({
          blockId: z.string().optional(),
          earliestMinutes: z.number().int().min(420).max(1350).optional(),
          conflictDay: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("冲突发生的确切日期 YYYY-MM-DD，默认当天"),
          conflictTitle: z.string().optional(),
          conflictStartMinutes: z.number().int().min(420).max(1350).optional(),
          conflictDurationMinutes: z.number().int().min(15).max(360).optional(),
        }),
        execute: async (input, options) =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "propose_reschedule",
            args: input,
            execute: () => {
              const effectiveDay = input.conflictDay || day;
              const insertEvent =
                input.conflictTitle && input.conflictStartMinutes !== undefined
                  ? {
                      day: effectiveDay,
                      start: input.conflictStartMinutes,
                      minutes: input.conflictDurationMinutes || 60,
                      title: input.conflictTitle,
                      kind: "工作" as const,
                    }
                  : undefined;
              const res = generateRescheduleOptions(workingState, effectiveDay, {
                blockId: input.blockId,
                earliest: input.earliestMinutes,
                insertEvent,
              });
              if (!res.options.length) {
                return { error: res.reason || "近期没有可重排的未完成学习日程。" };
              }
              return {
                kind: "reschedule",
                title: res.targetTitle,
                reason: res.reason,
                options: res.options,
              } satisfies AgentCard;
            },
            captureStateChanges: (res): StateChangeSpec[] => {
              if (!res || !("kind" in res) || res.kind !== "reschedule") {
                return [];
              }
              return [
                {
                  entityType: "schedule_replanning",
                  entityId: res.options[0]?.id || "reschedule-proposal",
                  action: "propose",
                  beforeState: { target: res.title, reason: res.reason },
                  afterState: {
                    optionCount: res.options.length,
                    options: res.options.map((o) => ({
                      id: o.id,
                      label: o.label,
                      summary: o.summary,
                      changes: o.changes.length,
                    })),
                  },
                },
              ];
            },
          }),
      }),
      propose_batch_reschedule: tool({
        description:
          "跨日批量重排：当用户未来一天或多天出差/繁忙时，批量把这些天内的学习任务安全挪到其他日期。",
        inputSchema: z.object({
          blockedDays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
          reasonLabel: z.string().optional(),
        }),
        execute: async (input, options) =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "propose_batch_reschedule",
            args: input,
            execute: () => {
              const res = generateBatchRescheduleOptions(
                workingState,
                day,
                input.blockedDays,
                input.reasonLabel || "日程繁忙",
              );
              if (!res.options.length) {
                return { error: res.reason };
              }
              return {
                kind: "reschedule",
                title: res.targetTitle,
                reason: res.reason,
                options: res.options,
              } satisfies AgentCard;
            },
            captureStateChanges: (res): StateChangeSpec[] => {
              if (!res || !("kind" in res) || res.kind !== "reschedule") {
                return [];
              }
              return [
                {
                  entityType: "schedule_replanning",
                  entityId: res.options[0]?.id || "batch-reschedule",
                  action: "propose",
                  beforeState: { blockedDays: input.blockedDays, reason: res.reason },
                  afterState: {
                    optionCount: res.options.length,
                    options: res.options.map((o) => ({
                      id: o.id,
                      label: o.label,
                      summary: o.summary,
                      changes: o.changes.length,
                    })),
                  },
                },
              ];
            },
          }),
      }),
      present_learning_roadmap: tool({
        description:
          "渲染带图标的四阶段结构化学习路线卡片（如 第一阶段：基础 → 第二阶段：核心能力 → 第三阶段：实际应用 → 第四阶段：实战项目）。",
        inputSchema: z.object({
          title: z.string().describe("例如：Python 学习路线"),
          stages: z
            .array(
              z.object({
                stageTitle: z
                  .string()
                  .describe("例如：第一阶段：Python 基础（第 1–2 周）"),
                topics: z
                  .string()
                  .describe("例如：变量、数字、文字、条件判断、循环、列表。"),
                icon: z.enum(["book", "code", "table", "rocket"]).optional(),
              }),
            )
            .min(2)
            .max(5),
        }),
        execute: async (input, options): Promise<RoadmapStagesCardData> =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "present_learning_roadmap",
            args: input,
            execute: () => ({
              kind: "roadmap_stages" as const,
              ...input,
            }),
          }),
      }),
      present_onboarding_survey: tool({
        description:
          "当用户提出学习某门新技能但尚未说明基础和目的时，渲染「我想先了解你的情况」交互式单选问卷卡（2-3 个单选问题 + 一键开始课程按钮）。",
        inputSchema: z.object({
          topic: z.string().describe("学习主题名称，如 Python"),
          title: z.string().optional().describe("默认为：我想先了解你的情况"),
          questions: z
            .array(
              z.object({
                id: z.string(),
                question: z.string().describe("例如：1. 你目前的 Python 水平？"),
                options: z.array(z.string()).min(2).max(4),
              }),
            )
            .min(2)
            .max(4),
          ctaLabel: z.string().optional().describe("例如：开始我的 Python 课程"),
          footerNote: z
            .string()
            .optional()
            .describe("例如：根据你的选择，我会调整学习内容，采用每次一个知识点、一个例子、一道练习题的教学方式。"),
        }),
        execute: async (input, options): Promise<OnboardingSurveyCardData> =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "present_onboarding_survey",
            args: input,
            execute: () => ({
              kind: "onboarding_survey" as const,
              surveyId: `srv-${crypto.randomUUID().slice(0, 8)}`,
              title: input.title || "我想先了解你的情况",
              footerNote:
                input.footerNote ||
                "根据你的选择，我会调整学习内容，采用每次一个知识点、一个例子、一道练习题的教学方式。",
              ...input,
            }),
          }),
      }),
      present_data_chart: tool({
        description:
          "在讲解中渲染「数据示例表格 + 散点图/折线图一体卡」（如训练数据：学习时间 vs 考试成绩，上半部分展示数据表，下半部分展示直观坐标图）。",
        inputSchema: z.object({
          title: z.string().describe("例如：训练数据示例"),
          xHeader: z.string().describe("自变量列名，如：学习时间 (小时)"),
          yHeader: z.string().describe("因变量列名，如：考试成绩"),
          points: z
            .array(
              z.object({
                xLabel: z.string(),
                xValue: z.number(),
                yValue: z.number(),
              }),
            )
            .min(3)
            .max(10),
          chartType: z.enum(["scatter", "line"]).optional(),
          caption: z
            .string()
            .optional()
            .describe("底部图注，例如：示例数据：学习时间与考试成绩呈线性关系。"),
        }),
        execute: async (input, options): Promise<DataChartCardData> =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "present_data_chart",
            args: input,
            execute: () => ({
              kind: "data_chart" as const,
              ...input,
            }),
          }),
      }),
      visual_explainer: tool({
        description:
          "为当前课程生成或注册高清、安全、可分步揭示的可视化讲解（Level 1 Mermaid 结构图由 beautiful-mermaid 渲染；Level 2 原生净化 SVG 自由矢量画布支持 var(--ve-*) 亮暗语义色与 data-step=\"1..N\" 分步揭示；Level 3 受控交互组件支持 timeline 可点击演进时间线与 parameter_explorer 参数联动模拟/实时数学曲线）。自动按 (lessonId + contractVersion + conceptId + visualType) 缓存，严格遵循 LessonContract 不剧透后继章节，并绑定到当前课程的课堂工作台（绝不跨课串图，也不修改 BKT 掌握度）。",
        inputSchema: z.object({
          lessonId: z
            .string()
            .optional()
            .describe("绑定的课程 ID，省略则自动绑定当前聚焦课程"),
          conceptId: z
            .string()
            .optional()
            .describe("本图聚焦的核心概念名称或标识，用于确定性缓存键"),
          title: z.string().min(2).describe("图解标题"),
          summary: z
            .string()
            .optional()
            .describe("一句话说明这张图解帮助理解什么直觉或机制"),
          caption: z.string().optional().describe("底部简短图注（可选）"),
          visualType: z
            .enum(["mermaid", "svg", "interactive_widget"])
            .describe(
              "可视化画布层级：mermaid（流程/状态/时序/类/ER/XY图）、svg（自由矢量/几何/光学/空间/架构分层/比喻图景）、interactive_widget（时间线/参数探索槽位）",
            ),
          mermaid: z
            .string()
            .optional()
            .describe("当 visualType=mermaid 时的 Mermaid 源码"),
          svg: z
            .string()
            .optional()
            .describe(
              "当 visualType=svg 时的纯矢量 <svg viewBox=\"...\" xmlns=\"http://www.w3.org/2000/svg\">...</svg>，推荐使用 var(--ve-*) 主题变量与 data-step=\"1..N\" 标注分步元素（禁止 script/foreignObject/on*/外链）",
            ),
          widget: z
            .object({
              widgetType: z.enum(["timeline", "parameter_explorer"]),
              config: z.record(z.string(), z.unknown()),
            })
            .optional()
            .describe("当 visualType=interactive_widget 时的受控组件参数"),
          steps: z
            .array(
              z.object({
                stepNumber: z.number().int().min(1),
                title: z.string().min(1),
                explanation: z.string().min(2),
                highlightIds: z.array(z.string().min(1)).optional(),
                mermaid: z.string().optional(),
              }),
            )
            .optional()
            .describe(
              "可选的分步揭示数组（如 1/4 → 4/4）：在 SVG 中自动联动对应 data-step / highlightIds，在 Mermaid 中可附带递进子图",
            ),
          forceRefresh: z
            .boolean()
            .optional()
            .describe("是否跳过同版本缓存强制重新生成"),
        }),
        execute: async (input, options) =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "visual_explainer",
            args: input,
            execute: async () => {
              const resolvedLessonId =
                input.lessonId ||
                focusedLessonIdForSession ||
                "general-lesson";
              const targetLesson = getLessonById(workingState, resolvedLessonId);
              const owningTrack = (workingState.goalPlans || []).find((p) =>
                p.units.some((u) => u.id === resolvedLessonId),
              );
              const neighborhood = owningTrack
                ? resolveGraphNeighborsForLesson(
                    owningTrack.units,
                    resolvedLessonId,
                    {
                      blueprintVersion: owningTrack.blueprintVersion ?? 1,
                      mastery: workingState.mastery,
                    },
                  )
                : null;
              const contract =
                neighborhood?.contract ?? targetLesson?.contract ?? null;
              const contractVersion =
                contract?.blueprintVersion ?? owningTrack?.blueprintVersion ?? 1;

              const veRes = await runVisualExplainer({
                lessonId: resolvedLessonId,
                lessonTitle: targetLesson?.title,
                conceptId: input.conceptId || input.title,
                conceptSummary: targetLesson?.concept,
                title: input.title,
                summary: input.summary,
                caption: input.caption,
                visualType: input.visualType,
                mermaid: input.mermaid,
                svg: input.svg,
                widget: input.widget,
                steps: input.steps,
                contract,
                contractVersion,
                userRequest: userPromptText,
                forceRefresh: input.forceRefresh,
                persistActivity: true,
                availableCapabilities: DEFAULT_LEARNOS_CAPABILITIES,
                model: resolved?.model ?? null,
                abortSignal: options?.abortSignal,
              });
              return veRes.card;
            },
          }),
      }),
      search_visual_resource: tool({
        description:
          "检索真实百科视觉图片与矢量概念结构图（含维基百科图片检索、来源链接、放大预览与本机缓存），用于辅助讲解复杂概念。",
        inputSchema: z.object({
          query: z.string().describe("要检索图片或生成图解的核心概念名称"),
          keyPoints: z
            .array(z.string())
            .max(4)
            .optional()
            .describe("该概念的 2-4 个关键步骤或组成部分"),
        }),
        execute: async (input, options) =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "search_visual_resource",
            args: input,
            execute: () =>
              searchVisualResources(input.query, input.keyPoints || []),
          }),
      }),
      start_learning_session: tool({
        description:
          "调用统一 Lesson Session Controller 启动或恢复某节课的学习会话（不绕过业务控制器），返回 session、当前练习与最近评分记录。",
        inputSchema: z.object({
          lessonId: z.string(),
          mode: z.enum(["learn", "practice", "assess", "review"]).optional(),
        }),
        execute: async (input, options) =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "start_learning_session",
            args: input,
            execute: () =>
              startLearningSession({
                lessonId: input.lessonId,
                mode: input.mode,
                day,
              }),
          }),
      }),
      present_interactive_check: tool({
        description:
          "为当前课程注册一道唯一的交互式练习并同步到 Learn 练习区（自动去重，严禁重复出相同题目）。必须传入确定性判分答案（如 order_steps 的 correctStepsOrder、choice 的 correctChoiceIndex、multi_choice 的 correctChoiceIndices、fill_blank 的 blanks[].answer），供 Learn 确定性评分引擎离线判分。",
        inputSchema: z.object({
          mode: z.enum([
            "fill_blank",
            "code",
            "order_steps",
            "multi_choice",
            "short_answer",
            "choice",
          ]),
          lessonId: z.string().optional(),
          lessonTitle: z.string().optional(),
          prompt: z.string().describe("清晰具体的题目或动手任务要求（支持 Markdown）"),
          choices: z
            .array(z.string())
            .min(2)
            .max(6)
            .optional()
            .describe("mode=choice 或 multi_choice 时的选项列表"),
          correctChoiceIndex: z
            .number()
            .int()
            .min(0)
            .max(5)
            .optional()
            .describe("mode=choice 时正确选项的 0-based 下标"),
          correctChoiceIndices: z
            .array(z.number().int().min(0).max(5))
            .optional()
            .describe("mode=multi_choice 时所有正确选项的 0-based 下标数组"),
          blanks: z
            .array(
              z.object({
                id: z.string().describe("例如 blank-1"),
                label: z.string().optional().describe("例如 空 (1) 或 返回类型"),
                placeholder: z.string().optional(),
                answer: z.string().optional().describe("参考标准答案"),
              }),
            )
            .max(5)
            .optional()
            .describe("mode=fill_blank 时的填空槽位列表"),
          steps: z
            .array(z.string())
            .min(3)
            .max(6)
            .optional()
            .describe("mode=order_steps 时打乱顺序的待排序步骤列表"),
          correctStepsOrder: z
            .array(z.string())
            .min(3)
            .max(6)
            .optional()
            .describe("mode=order_steps 时的权威正确顺序列表（与 steps 元素一致），供确定性引擎逐位判分"),
          starterCode: z
            .string()
            .optional()
            .describe("mode=code 或 fill_blank 时的初始代码骨架（填空可用 ___1___ 标记）"),
          expectedOutput: z
            .string()
            .optional()
            .describe("mode=code 时的期望输出或验收标准"),
          rubricPoints: z
            .array(z.string())
            .max(4)
            .optional()
            .describe("mode=short_answer 或 code 时的考察要点/自检清单"),
          language: z
            .string()
            .optional()
            .describe("代码语言，如 java / python / sql / typescript / cpp"),
          hint: z.string().optional().describe("可选的启发式提示（折叠展示）"),
          explanation: z
            .string()
            .optional()
            .describe("提交后在卡片内即时展示的简明参考解析"),
        }),
        execute: async (input, options): Promise<InteractiveCheckCard> =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "present_interactive_check",
            args: input,
            execute: () => {
              const resolvedLessonId =
                input.lessonId ||
                focusedLessonIdForSession ||
                "general-lesson";
              const reg = registerExercise({
                lessonId: resolvedLessonId,
                mode: input.mode,
                prompt: input.prompt,
                spec: {
                  lessonTitle: input.lessonTitle,
                  choices: input.choices,
                  correctChoiceIndex: input.correctChoiceIndex,
                  correctChoiceIndices: input.correctChoiceIndices,
                  blanks: input.blanks,
                  steps: input.steps,
                  correctStepsOrder: input.correctStepsOrder,
                  starterCode: input.starterCode,
                  expectedOutput: input.expectedOutput,
                  rubricPoints: input.rubricPoints,
                  language: input.language,
                  hint: input.hint,
                  explanation: input.explanation,
                },
                source: "tutor_candidate",
                shuffleChoices: true,
              });
              return {
                kind: "interactive_check" as const,
                checkId: reg.exercise.exercise_id,
                exerciseId: reg.exercise.exercise_id,
                deduplicated: reg.deduplicated,
                lessonId: resolvedLessonId,
                ...input,
                choices: reg.exercise.spec.choices ?? input.choices,
                correctChoiceIndex:
                  reg.exercise.spec.correctChoiceIndex ??
                  input.correctChoiceIndex,
                correctChoiceIndices:
                  reg.exercise.spec.correctChoiceIndices ??
                  input.correctChoiceIndices,
                steps: reg.exercise.spec.steps ?? input.steps,
                explanation:
                  reg.exercise.spec.explanation ?? input.explanation,
              };
            },
          }),
      }),
      record_learning_assessment: tool({
        description:
          "在评估完用户的真实作答（填空/代码/步骤排序/多选/费曼简答/单选）后，调用此工具通过 BKT + ts-fsrs 算法更新掌握度、稳定期与下次复习日期，并输出三维诊断反馈卡（掌握亮点、薄弱点纠正、核心记忆锚点）。",
        inputSchema: z.object({
          lessonId: z.string(),
          correct: z.boolean().describe("用户本次是否达标"),
          skip: z
            .boolean()
            .optional()
            .describe("用户已熟练掌握此节、直接跳过标记已掌握时设为 true"),
          checkMode: z
            .string()
            .optional()
            .describe("本次评估的题型名称，如 代码填空 / 动手编程 / 流程排序 / 费曼简答 / 多选辨析"),
          summary: z.string().describe("一句话总体评估结论，将写入学习记录"),
          strength: z
            .string()
            .optional()
            .describe("用户本次作答中理解准确或写得好的亮点"),
          misconception: z
            .string()
            .optional()
            .describe("若存在错误或遗漏，指出具体薄弱点与正确写法对比"),
          keyTakeaway: z
            .string()
            .optional()
            .describe("一句话核心记忆锚点或实战口诀"),
        }),
        execute: async (input, options) =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "record_learning_assessment",
            args: input,
            execute: () => execRecordAssessment(input),
            captureStateChanges: (res): StateChangeSpec[] => {
              if (!res || !("kind" in res) || res.kind !== "mastery_update") {
                return [];
              }
              return [
                {
                  entityType: "learning_state",
                  entityId: res.lessonId,
                  action: "update",
                  beforeState: {
                    mastery: res.before,
                    stabilityDays: res.stabilityBefore ?? null,
                  },
                  afterState: {
                    mastery: res.after,
                    stabilityDays: res.stabilityAfter ?? null,
                    nextReviewDay: res.nextReviewDay,
                    unlockedTitles: res.unlockedTitles,
                    remediationTriggered: Boolean(res.remediationTriggered),
                  },
                },
                {
                  entityType: "assessment_record",
                  entityId: res.attemptId,
                  action: "create",
                  beforeState: null,
                  afterState: {
                    attemptId: res.attemptId,
                    lessonId: res.lessonId,
                    lessonTitle: res.lessonTitle,
                    correct: res.correct,
                    checkMode: res.checkMode || "未提供",
                    summary: res.summary,
                    diagnostic: res.diagnostic || null,
                  },
                },
              ];
            },
          }),
      }),
      start_active_recall: tool({
        description:
          "启动一张 FSRS 四档主动回忆闪卡（忘记/困难/良好/容易），用于复习巩固已学知识点。",
        inputSchema: z.object({
          lessonId: z.string(),
          customQuestion: z.string().optional().describe("由你现场定制的主动回忆提问"),
          customAnswer: z.string().optional().describe("对应的核心要点解析"),
        }),
        execute: async (input, options) =>
          trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "start_active_recall",
            args: input,
            execute: () => {
              const lesson = getLessonById(workingState, input.lessonId);
              if (!lesson) return { error: "未找到对应知识点。" };
              const card = buildActiveRecallCard(workingState, lesson, day);
              if (input.customQuestion) card.question = input.customQuestion;
              if (input.customAnswer) card.answerConcept = input.customAnswer;
              return card;
            },
          }),
      }),
      save_memory: tool({
        description:
          "静默写入、更新或移除用户长期记忆/临时约束（如偏好时间段、单次时长、出差等临时安排）。临时安排必须提供 expiresAt (YYYY-MM-DD)。",
        inputSchema: z.object({
          action: z.enum(["add", "update", "remove"]).optional(),
          category: z.enum(["goal", "preference", "constraint", "weakness", "record"]),
          text: z.string(),
          reason: z.string().optional(),
          targetId: z.string().optional(),
          expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
        execute: async (input, options) => {
          const prevMem = input.targetId
            ? workingState.memories.find((m) => m.id === input.targetId) || null
            : null;
          return trace.wrapToolExecution({
            toolCallId: options?.toolCallId,
            toolName: "save_memory",
            args: input,
            execute: () => execSaveMemory(input),
            captureStateChanges: (res): StateChangeSpec[] => {
              if (!res || res.kind !== "memory_saved") return [];
              return [
                {
                  entityType: "memory",
                  entityId: res.memoryId,
                  action:
                    res.action === "remove"
                      ? "delete"
                      : res.action === "update"
                        ? "update"
                        : "create",
                  beforeState: prevMem
                    ? {
                        id: prevMem.id,
                        category: prevMem.category,
                        label: prevMem.label,
                        text: prevMem.text,
                        expiresAt: prevMem.expiresAt || null,
                      }
                    : null,
                  afterState:
                    res.action === "remove"
                      ? null
                      : {
                          id: res.memoryId,
                          category: res.category,
                          label: res.label,
                          text: res.text,
                          expiresAt: res.expiresAt || null,
                        },
                },
              ];
            },
          });
        },
      }),
  };

  // Layer 3: Run streamText with automatic context_length_exceeded aggressive compaction & retry fallback
  const createManagedStream = async (
    sysPrompt: string,
    dynamicContext: string,
    msgsForModel: UIMessage[],
    isRetryAttempt: boolean,
  ) => {
    let overflowDetected = false;
    // Strip dangling incomplete tool parts from prior interrupted/truncated turns so convertToModelMessages
    // never emits orphaned tool_calls without matching tool_results (which causes 400 errors on next turn).
    const cleanMsgsForModel: UIMessage[] = msgsForModel.map((msg) => {
      if (msg.role !== "assistant" || !Array.isArray(msg.parts)) return msg;
      const filteredParts = msg.parts.filter((part) => {
        if (!part || typeof part !== "object") return false;
        const p = part as { type?: string; state?: string };
        if (
          typeof p.type === "string" &&
          (p.type.startsWith("tool-") || p.type === "dynamic-tool")
        ) {
          return p.state === "output-available" || p.state === "output-error";
        }
        return true;
      });
      return filteredParts.length === msg.parts.length
        ? msg
        : { ...msg, parts: filteredParts };
    });
    const modelMessages = await convertToModelMessages(cleanMsgsForModel);

    // DeepSeek KV Disk Cache Prefix Optimization (kv_cache.md + tool_calls.md):
    // Keep the top `system` prompt 100% static across turns so [static system + historical messages]
    // achieves high KV cache hits (50x cheaper input tokens!), and pass the dynamic workspace
    // snapshot via `deepseek_dynamic_context` so transformDeepSeekRequestBody places it cleanly
    // right before the latest `user` message without triggering AI SDK mid-message system warnings.
    const hasUserMessage = modelMessages.some((m) => m.role === "user");
    const useDeepSeekPrefixSplit =
      resolved.isDeepSeek && Boolean(dynamicContext.trim()) && hasUserMessage;
    const finalSystemPrompt = useDeepSeekPrefixSplit
      ? staticTutorSystemPrompt
      : sysPrompt;
    const stepCallCfg = useDeepSeekPrefixSplit
      ? buildDeepSeekCallConfig("tutor_chat", {
          isDeepSeek: true,
          modelId: resolved.modelId,
          taskType,
          userThinkingMode: resolved.thinkingMode,
          userReasoningEffort: resolved.reasoningEffort,
          latestReminderDay: day,
          dynamicContextSystem: dynamicContext,
        })
      : deepSeekTutorCallCfg;

    const streamRes = streamText({
      model: resolved.model,
      system: finalSystemPrompt,
      messages: modelMessages,
      tools: agentTools,
      stopWhen: stepCountIs(10),
      maxOutputTokens: stepCallCfg.maxOutputTokens,
      temperature: stepCallCfg.temperature,
      providerOptions: stepCallCfg.providerOptions as Parameters<
        typeof streamText
      >[0]["providerOptions"],
      abortSignal: serverCtrl.signal,
      onStepFinish: ({ text, reasoningText, finishReason, usage, toolCalls }) => {
        const usageSummary = extractDeepSeekUsageSummary(usage);
        trace.recordModelResponse({
          iteration: stepIteration,
          text: text || "",
          reasoningText: reasoningText || undefined,
          finishReason: finishReason || "未提供",
          usage: usage
            ? {
                ...(usage as unknown as Record<string, unknown>),
                ...(usageSummary
                  ? {
                      cacheReadTokens: usageSummary.cacheReadTokens,
                      cacheMissTokens: usageSummary.cacheMissTokens,
                      cacheHitRate: usageSummary.cacheHitRate,
                      reasoningTokens: usageSummary.reasoningTokens,
                    }
                  : {}),
              }
            : null,
          requestedToolCalls: toolCalls.map((tc) => ({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          })),
        });
        if (toolCalls.length > 0) {
          stepIteration += 1;
          trace.startModelRequest({
            iteration: stepIteration,
            messageCount: msgsForModel.length + stepIteration,
            availableTools: AVAILABLE_TOOL_NAMES,
          });
        }
      },
      onFinish: ({ steps, reasoningText, text }) => {
        if (overflowDetected && !isRetryAttempt) return;
        unregisterServerTaskController(taskId);
        try {
          const nowIso = new Date().toISOString();
          const trimmedText = (text || "").trim();
          const hadAnyToolCall = steps.some(
            (st) => (st.toolCalls?.length ?? 0) > 0,
          );
          const isEmptyPseudoComplete = !trimmedText && !hadAnyToolCall;

          // GEN-06 / GEN-07 / AGENT-18: Detect fabricated exercise IDs claimed without tool execution
          const claimedIds = Array.from(
            trimmedText.matchAll(/\bex-[a-f0-9]{6,12}\b/gi),
          ).map((m) => m[0]);
          const unverifiedClaimedId = claimedIds.find(
            (id) => !getExerciseById(id),
          );

          const existingTask = getLlmTaskFromDb(taskId);
          if (existingTask && existingTask.status === "running") {
            if (isEmptyPseudoComplete) {
              upsertLlmTaskInDb(
                {
                  ...existingTask,
                  modelLabel: resolved.label,
                  status: "failed",
                  errorMessage:
                    "模型返回空响应（未生成任何文本或工具调用），请重试。",
                  updatedAt: nowIso,
                  completedAt: nowIso,
                },
                true,
              );
            } else {
              const finalText = unverifiedClaimedId
                ? `${trimmedText}\n\n> ⚠️ **系统一致性校验提醒**：回复中提到的题号 \`${unverifiedClaimedId}\` 未通过 \`present_interactive_check\` 落库到 SQLite，Learn 练习区尚未更新，请重试生成题目。`
                : text;
              const finalAssistant: UIMessage =
                existingTask.assistantMessage &&
                existingTask.assistantMessage.parts.length > 0 &&
                !unverifiedClaimedId
                  ? existingTask.assistantMessage
                  : {
                      id: `asst-${taskId}`,
                      role: "assistant",
                      parts: [
                        ...(reasoningText
                          ? [{ type: "reasoning" as const, text: reasoningText }]
                          : []),
                        ...(finalText
                          ? [{ type: "text" as const, text: finalText }]
                          : []),
                      ],
                    };
              upsertLlmTaskInDb(
                {
                  ...existingTask,
                  modelLabel: resolved.label,
                  status: "completed",
                  assistantMessage: finalAssistant,
                  updatedAt: nowIso,
                  completedAt: nowIso,
                },
                true,
              );
            }
          }

          if (isEmptyPseudoComplete) {
            trace.recordRunFailed({
              errorMessage: "模型返回空响应（EMPTY_MODEL_RESPONSE）",
              cancelled: false,
            });
          } else {
            trace.recordRunCompleted({
              finalResponse: unverifiedClaimedId
                ? `${trimmedText}\n[UNVERIFIED_EXERCISE_CLAIM:${unverifiedClaimedId}]`
                : text || "",
              stepCount: steps.length,
              reasoningChars: reasoningText?.length ?? 0,
            });
          }
        } catch {}
      },
      onError: ({ error }) => {
        if (!isRetryAttempt && isContextOverflowError(error)) {
          overflowDetected = true;
          return;
        }
        unregisterServerTaskController(taskId);
        try {
          const nowIso = new Date().toISOString();
          const msg =
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : JSON.stringify(error);
          const isCancelled =
            serverCtrl.signal.aborted || /abort|cancel/i.test(msg);
          const existingTask = getLlmTaskFromDb(taskId);
          if (existingTask && existingTask.status === "running") {
            upsertLlmTaskInDb(
              {
                ...existingTask,
                modelLabel: resolved.label,
                status: isCancelled ? "cancelled" : "failed",
                errorMessage: isCancelled
                  ? "用户手动取消生成"
                  : msg.slice(0, 400),
                updatedAt: nowIso,
                completedAt: nowIso,
              },
              true,
            );
          }
          trace.recordRunFailed({
            errorMessage: msg.slice(0, 400),
            cancelled: isCancelled,
          });
        } catch {}
      },
    });

    return { streamRes, wasOverflow: () => overflowDetected };
  };

  const formatReadableStreamError = (error: unknown): string => {
    const raw =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error || "");
    if (isContextOverflowError(raw)) {
      return `上下文超出当前模型窗口限制（${raw.slice(0, 120)}），请压缩会话历史或开启新对话后重试。`;
    }
    if (/(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network|socket|connect)/i.test(raw)) {
      return "无法连接到模型服务（网络离线或端点不可达）。本地课程阅读、练习评分与日历仍可正常离线使用。";
    }
    if (/(402|insufficient.?balance)/i.test(raw)) {
      return "模型账户余额不足（HTTP 402），请检查对应服务商余额后重试。";
    }
    if (/(429|rate limit|too many requests|quota)/i.test(raw)) {
      return "模型服务触发限流（HTTP 429），请稍候片刻后点击重试。";
    }
    if (/(500|502|503|504|internal server error|bad gateway|service unavailable)/i.test(raw)) {
      return "上游模型服务暂时异常（HTTP 5xx），请稍后点击重试。";
    }
    if (/(401|403|unauthorized|invalid api key)/i.test(raw)) {
      return "模型 API Key 鉴权失败（HTTP 401/403），请在右上角「模型设置」检查密钥配置。";
    }
    if (/(abort|cancel)/i.test(raw)) {
      return "用户已手动取消本次生成。";
    }
    return raw ? `模型调用失败：${raw.slice(0, 220)}` : "模型调用失败，请检查网络连接或模型配置后重试。";
  };

  const outerStream = createUIMessageStream({
    execute: async ({ writer }) => {
      const pumpStream = async (
        uiStream: ReadableStream,
        interceptOverflow: boolean,
      ): Promise<"ok" | "overflow"> => {
        const reader = uiStream.getReader();
        let sawMeaningfulContent = false;
        let sawError = false;
        const pendingToolCallIds = new Set<string>();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && typeof value === "object") {
              const chunk = value as {
                type?: string;
                delta?: string;
                toolCallId?: string;
                errorText?: string;
              };
              const t = chunk.type || "";
              if (t === "text-delta" && chunk.delta?.trim()) {
                sawMeaningfulContent = true;
              } else if (
                t === "tool-input-start" ||
                t === "tool-input-available"
              ) {
                sawMeaningfulContent = true;
                if (chunk.toolCallId) pendingToolCallIds.add(chunk.toolCallId);
              } else if (
                t === "tool-output-available" ||
                t === "tool-output-error"
              ) {
                sawMeaningfulContent = true;
                if (chunk.toolCallId) {
                  pendingToolCallIds.delete(chunk.toolCallId);
                }
              } else if (t.startsWith("tool-")) {
                sawMeaningfulContent = true;
              } else if (t === "error") {
                sawError = true;
                if (
                  interceptOverflow &&
                  isContextOverflowError(chunk.errorText)
                ) {
                  return "overflow";
                }
              }
            }
            writer.write(value);
          }
          // Flush any dangling tool calls left unfinished (e.g. model hit finish_reason="length" mid-JSON)
          // so the UI never spins forever on unexecuted tool calls.
          if (pendingToolCallIds.size > 0 && !serverCtrl.signal.aborted) {
            for (const danglingId of pendingToolCallIds) {
              writer.write({
                type: "tool-output-error",
                toolCallId: danglingId,
                errorText:
                  "模型输出达到上限或流提前中断，工具参数未完整送达。请点击「重新生成」重试。",
              });
            }
          }
          // TASK-17: Never report silent empty stream as successful completion
          if (!sawMeaningfulContent && !sawError && !serverCtrl.signal.aborted) {
            writer.write({
              type: "error",
              errorText: "模型返回空响应（未生成任何文本或工具调用），请点击重试。",
            });
          }
          return "ok";
        } catch (err) {
          if (interceptOverflow && isContextOverflowError(err)) {
            return "overflow";
          }
          throw err;
        } finally {
          reader.releaseLock();
        }
      };

      const first = await createManagedStream(
        effectiveSystemPrompt,
        effectiveDynamicContext,
        preparedCtx.messagesForLLM,
        false,
      );
      const outcome = await pumpStream(
        first.streamRes.toUIMessageStream({
          onError: formatReadableStreamError,
        }),
        true,
      );

      if (outcome === "overflow" || first.wasOverflow()) {
        // Automatic aggressive compaction & single retry on context_length_exceeded
        const aggressiveCtx = prepareContextForLLM({
          messages,
          taskType,
          systemPromptTokens: estimateTextTokens(systemPrompt),
          toolSchemaTokens: ESTIMATED_TOOL_SCHEMA_TOKENS,
          maxContextTokens: Math.max(1500, Math.floor(modelContextBudget * 0.5)),
          existingSummary: preparedCtx.threadSummary,
          existingSummaryCount: preparedCtx.summaryCoveredCount,
          aggressive: true,
          preserveReasoning,
        });
        if (aggressiveCtx.threadSummary) {
          try {
            updateChatThreadSummaryInDb(
              threadId,
              aggressiveCtx.threadSummary,
              aggressiveCtx.summaryCoveredCount,
            );
          } catch {}
        }
        stepIteration += 1;
        trace.startModelRequest({
          iteration: stepIteration,
          messageCount: aggressiveCtx.messagesForLLM.length,
          availableTools: AVAILABLE_TOOL_NAMES,
          attachedContext: {
            overflowRetry: true,
            compactionStats: aggressiveCtx.stats,
          },
        });
        const retryPrompt = buildEffectiveSystemPrompt(
          aggressiveCtx.threadSummary,
          aggressiveCtx.summaryCoveredCount,
        );
        const retryDynamicContext = buildDynamicContextNote(
          aggressiveCtx.threadSummary,
          aggressiveCtx.summaryCoveredCount,
        );
        const second = await createManagedStream(
          retryPrompt,
          retryDynamicContext,
          aggressiveCtx.messagesForLLM,
          true,
        );
        await pumpStream(
          second.streamRes.toUIMessageStream({
            onError: formatReadableStreamError,
          }),
          false,
        );
      }
    },
  });

  return createUIMessageStreamResponse({ stream: outerStream });
}
