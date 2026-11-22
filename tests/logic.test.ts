import test from "node:test";
import assert from "node:assert/strict";
import {
  initial,
  demoInitial,
  migrateStore,
  computeMasteryUpdate,
  computeFSRSReviewUpdate,
  buildDecisionTrace,
  getTracks,
  getActiveTrack,
  focusLesson,
  getMissedSessions,
  getMissingPrerequisites,
  hasPrerequisiteCycle,
  lessons,
  offset,
  parseMemoryConstraint,
  parseMemoryExpiry,
  isMemoryExpired,
  getActiveMemories,
  weekdayLabel,
  formatDayWithWeekday,
  isRemedialBlock,
} from "../lib/learning";
import {
  clearAllDataInDb,
  clearAuditLogsInDb,
  closeDbForTesting,
  deleteChatThreadFromDb,
  getChatThreadFromDb,
  getDbInfo,
  getLatestLlmTaskForThreadFromDb,
  getLlmTaskFromDb,
  listAuditFromDb,
  listLlmTasksFromDb,
  loadStoreFromDb,
  markStaleRunningTasksInterruptedInDb,
  recordAgentRunToDb,
  saveChatThreadToDb,
  saveStoreToDb,
  upsertLlmTaskInDb,
  type LLMTaskRecord,
} from "../lib/db";
import {
  LLMTaskManager,
  type LLMTaskStorageAdapter,
  type LLMTaskStreamAdapter,
} from "../lib/llm-task-manager";
import { searchVisualResources } from "../lib/visual-search";
import {
  computeLearnerStatus,
  decidePedagogicalPlan,
} from "../lib/pedagogy";
import {
  updateBKT,
  computeRetrievability,
  reviewFSRS,
  previewFSRSRatings,
  buildRetentionCurve,
} from "../lib/bkt-fsrs";
import { layoutKnowledgeGraph } from "../lib/graph";
import {
  analyzeScheduleFeasibility,
  extractMemoryPreferences,
  findFreeWindows,
  generateBatchRescheduleOptions,
  generateRescheduleOptions,
  isWithinSleep,
  postponeDependentBlocks,
  recalibrateForOvertime,
  scheduleDueReviews,
} from "../lib/scheduler";
import { demoUnits } from "../lib/goal-plan";
import { getLabForLesson, evaluateLabSubmission } from "../lib/labs";
import {
  exportBlocksToICS,
  exportWorkspaceJSON,
  parseWorkspaceBackup,
} from "../lib/ics";

const DAY = "2026-11-21";

test("initial(DAY) starts 100% empty and safe for zero-state testing", () => {
  const empty = initial(DAY);
  assert.equal(empty.blocks.length, 0);
  assert.equal(empty.memories.length, 0);
  assert.equal(getTracks(empty).length, 0);
  assert.equal(getActiveTrack(empty), null);
  assert.equal(focusLesson(empty), null);
  const trace = buildDecisionTrace(empty, DAY);
  assert.ok(trace.summary.length > 0);
  assert.equal(findFreeWindows(empty.blocks, DAY).length, 1);
  assert.equal(generateRescheduleOptions(empty, DAY).options.length, 0);
});

test("migrateStore upgrades v1 store without losing mastery/blocks/memories", () => {
  const v1 = {
    mastery: { json: 90, api: 85, tools: 62, react: 0, recovery: 0 },
    blocks: demoInitial(DAY).blocks,
    memories: [
      { id: "m1", label: "学习目标", text: "学会 SQL" },
      { id: "m2", label: "学习偏好", text: "晚上 8 点后学习，不超过 30 分钟" },
    ],
    decision: "old summary",
  };
  const migrated = migrateStore(v1, DAY);
  assert.ok(migrated);
  assert.equal(migrated.memories[0].category, "goal");
  assert.equal(migrated.memories[1].constraint?.preferredStart, 1200);
  assert.equal(migrated.memories[1].constraint?.maxSessionMinutes, 30);
  assert.ok(migrated.masteryMeta?.json?.nextReviewDay);
  assert.ok(migrated.decisionTrace?.factors.length);
});

test("BKT Bayes update increases probability on correct and decreases on wrong", () => {
  const ok = updateBKT(0.5, true);
  const bad = updateBKT(0.65, false);
  assert.ok(ok.pPosterior > 0.5);
  assert.ok(ok.pNext > ok.pPosterior);
  assert.ok(bad.pPosterior < 0.65);
  assert.ok(bad.score < 65);
});

test("FSRS-4.5 retrievability, 4-grade interval ordering, and retention curve", () => {
  const rAtS = computeRetrievability(5, 5);
  assert.ok(Math.abs(rAtS - 0.9) < 0.001, "R(S, S) should equal 90%");

  const previews = previewFSRSRatings({ stabilityDays: 2, difficulty: 5, lapses: 0 }, 2);
  assert.equal(previews.length, 4);
  assert.equal(previews[0].intervalDays, 1);
  assert.ok(previews[2].intervalDays > previews[1].intervalDays);
  assert.ok(previews[3].intervalDays >= previews[2].intervalDays);

  const lapse = reviewFSRS({ stabilityDays: 6, difficulty: 5, lapses: 0 }, 1, 3);
  assert.equal(lapse.lapses, 1);
  assert.ok(lapse.stabilityDays < 6);

  const curve = buildRetentionCurve(3, 0, 10);
  assert.equal(curve.length, 11);
  assert.equal(curve[0].retention, 100);
  assert.ok(curve[10].retention < curve[0].retention);
});

test("layoutKnowledgeGraph lays out both built-in and custom branching DAGs", () => {
  const s = demoInitial(DAY);
  const builtinLayout = layoutKnowledgeGraph(lessons, s);
  assert.equal(builtinLayout.nodes.length, 5);
  assert.equal(builtinLayout.edges.length, 5);
  assert.ok(builtinLayout.layerCount >= 3);
  for (const n of builtinLayout.nodes) {
    assert.ok(n.x >= 10 && n.x <= 90);
    assert.ok(n.y >= 10 && n.y <= 90);
  }

  const sqlDemo = demoUnits("我想学 SQL 分析订单");
  assert.equal(sqlDemo.units.length, 4);
  const sqlLessons = sqlDemo.units.map((u, i) => ({
    ...u,
    id: `sql-${i}`,
    subtitle: sqlDemo.title,
    minutes: 20,
    requires: (u.requiresIndices || []).map((idx) => `sql-${idx}`),
  }));
  const sqlLayout = layoutKnowledgeGraph(sqlLessons, s);
  assert.equal(sqlLayout.nodes.length, 4);
  assert.equal(sqlLayout.layerCount, 3);
  assert.equal(sqlLayout.edges.length, 4);
});

test("findFreeWindows detects real gaps between blocks", () => {
  const s = demoInitial(DAY);
  const windows = findFreeWindows(s.blocks, DAY);
  assert.ok(windows.length >= 3);
  const midMorning = windows.find((w) => w.start === 645 && w.end === 720);
  assert.ok(midMorning);
  assert.equal(midMorning.minutes, 75);
});

test("generateRescheduleOptions and generateBatchRescheduleOptions produce ranked multi-option plans", () => {
  const s = demoInitial(DAY);
  s.memories.unshift({
    id: "strict-pref",
    label: "时间约束",
    category: "constraint",
    text: "习惯晚上 8 点后学习，每次不超过 30 分钟",
    constraint: parseMemoryConstraint("习惯晚上 8 点后学习，每次不超过 30 分钟"),
  });

  const prefs = extractMemoryPreferences(s.memories);
  assert.equal(prefs.preferredStart, 1200);
  assert.equal(prefs.maxSessionMinutes, 30);

  const single = generateRescheduleOptions(s, DAY, { blockId: "focus" });
  assert.ok(single.options.length >= 2);
  const splitOpt = single.options.find((o) =>
    o.changes.some((c) => c.newSlots.length === 2),
  );
  assert.ok(splitOpt, "Expected a split-session option for 45m block under 30m cap");

  // Multi-day batch reschedule clearing day+1 and day+2
  const blocked = [offset(DAY, 1), offset(DAY, 2)];
  const batch = generateBatchRescheduleOptions(s, DAY, blocked, "明后两天出差避让");
  assert.ok(batch.options.length >= 2);
  for (const opt of batch.options) {
    assert.equal(opt.changes.length, 2);
    for (const c of opt.changes) {
      assert.ok(!blocked.includes(c.newSlots[0].day));
    }
  }
});

test("computeMasteryUpdate and computeFSRSReviewUpdate update mastery and unlock downstream nodes", () => {
  const s = demoInitial(DAY);
  const tools = lessons.find((l) => l.id === "tools")!;
  const res = computeMasteryUpdate(s, tools, true, DAY);
  assert.equal(res.before, 62);
  assert.ok(res.after >= 80);
  assert.equal(res.unlocked.length, 2);
  assert.ok(res.nextReviewDay > DAY);

  const review = computeFSRSReviewUpdate(s, lessons[0], 4, DAY);
  assert.ok(review.nextIntervalDays >= 5);

  const trace = buildDecisionTrace(s, DAY);
  assert.equal(trace.targetLessonId, "tools");
  assert.ok(trace.factors.length >= 3);
});

test("hands-on lab evaluator validates JSON and SQL submissions accurately", () => {
  const jsonLab = getLabForLesson(lessons[0]);
  const bad = evaluateLabSubmission(jsonLab, "{invalid}");
  assert.equal(bad.passed, false);
  const good = evaluateLabSubmission(jsonLab, jsonLab.solution);
  assert.equal(good.passed, true);
  assert.equal(good.passedCount, good.totalCount);
});

test("parseMemoryConstraint extracts time ranges, hard end boundary, and split duration", () => {
  const c = parseMemoryConstraint("每晚 19:30–22:30 拆 90+90，22:30 为硬边界");
  assert.ok(c);
  assert.equal(c.preferredStart, 19 * 60 + 30);
  assert.equal(c.preferredEnd, 22 * 60 + 30);
  assert.equal(c.maxSessionMinutes, 90);
});

test("Sprint 1: Pedagogical Policy, 7-state status, cycle check, remediation cascade & auto due-review scheduling", () => {
  const s = demoInitial(DAY);
  assert.equal(hasPrerequisiteCycle(lessons), false);
  assert.equal(
    hasPrerequisiteCycle([
      { ...lessons[0], id: "a", requires: ["b"] },
      { ...lessons[1], id: "b", requires: ["a"] },
    ]),
    true,
  );

  // Missing prerequisites for "react" (requires tools which is 62% < 80%)
  const missing = getMissingPrerequisites(s, lessons[3]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, "tools");

  // 15-min micro-session policy selects retrieval practice
  const microPlan = decidePedagogicalPlan(s, lessons[2], 15, DAY);
  assert.equal(microPlan.activityType, "retrieval_practice");

  // Consecutive failure triggers NEEDS_REMEDIATION + postpones dependent blocks
  s.masteryMeta!.tools = {
    ...s.masteryMeta!.tools,
    consecutiveFailures: 2,
  };
  assert.equal(computeLearnerStatus(s, "tools", DAY), "NEEDS_REMEDIATION");
  const remPlan = decidePedagogicalPlan(s, lessons[2], 30, DAY);
  assert.equal(remPlan.activityType, "remedial");

  const cascaded = postponeDependentBlocks(s, "tools", offset(DAY, 2));
  assert.ok(cascaded.movedTitles.length >= 1);

  // Auto due-review scheduling creates conflict-free waking 15m review blocks
  s.blocks = s.blocks.filter((b) => b.kind !== "复习");
  const rev = scheduleDueReviews(s, DAY);
  assert.ok(rev.newBlocks.length >= 1);
  for (const b of rev.newBlocks) {
    assert.equal(isWithinSleep(b.start, b.minutes, s.scheduleSettings), false);
  }
});

test("Sprint 2: Sleep redline, infeasibility gap report, overtime recalibration & missed session detection", () => {
  const s = demoInitial(DAY);
  assert.equal(isWithinSleep(1390, 30, s.scheduleSettings), true);
  assert.equal(isWithinSleep(600, 45, s.scheduleSettings), false);

  // Scenario D: Missed session in the past
  s.blocks.push({
    id: "missed-1",
    day: offset(DAY, -1),
    start: 1170,
    minutes: 30,
    title: "昨晚未学任务",
    kind: "学习",
    lesson: "tools",
    done: false,
  });
  const missed = getMissedSessions(s, DAY);
  assert.equal(missed.length, 1);
  assert.equal(missed[0].id, "missed-1");

  // Scenario B: Overtime recalibration (planned 25m -> actual 50m)
  const recal = recalibrateForOvertime(s, "tools", 25, 50, DAY);
  assert.ok(recal.newPaceFactor > 1.2);
  assert.ok(recal.adjustedCount >= 1);

  // Test 5: Infeasible week (fill waking hours with locked work blocks)
  const overloaded = demoInitial(DAY);
  overloaded.memories = [
    {
      id: "tight",
      label: "时间约束",
      category: "constraint",
      text: "每晚 20:00–20:30 学习",
      constraint: parseMemoryConstraint("每晚 20:00–20:30 学习"),
    },
  ];
  for (let d = 0; d < 7; d++) {
    overloaded.blocks.push({
      id: `busy-${d}`,
      day: offset(DAY, d),
      start: 1200,
      minutes: 30,
      title: "固定会议",
      kind: "工作",
      locked: true,
    });
  }
  const report = analyzeScheduleFeasibility(overloaded, DAY, 7);
  assert.equal(report.feasible, false);
  assert.ok(report.deficitMinutes > 0);
  assert.equal(report.suggestions.length, 3);
});

test("ICS calendar export and JSON workspace backup roundtrip", () => {
  const s = demoInitial(DAY);
  const ics = exportBlocksToICS(s.blocks);
  assert.ok(ics.includes("BEGIN:VCALENDAR"));
  assert.ok(ics.includes("BEGIN:VEVENT"));
  assert.ok(ics.includes("理解工具调用"));
  assert.ok(ics.includes("END:VCALENDAR"));

  const backup = exportWorkspaceJSON(s);
  const restored = parseWorkspaceBackup(backup, DAY);
  assert.ok(restored);
  assert.equal(restored.blocks.length, s.blocks.length);
  assert.equal(restored.mastery.tools, s.mastery.tools);
});

test("Sprint 3: Memory TTL expiry parsing and scheduler filtering", () => {
  assert.equal(parseMemoryExpiry("明后两天出差，晚上不排课", DAY), offset(DAY, 3));
  assert.equal(parseMemoryExpiry("本周加班较多", DAY), offset(DAY, 7));
  assert.equal(parseMemoryExpiry("未来3天状态不好", DAY), offset(DAY, 3));
  assert.equal(parseMemoryExpiry("每晚 19:30–22:30 学习", DAY), undefined);

  const expiredMem = {
    id: "m-exp",
    label: "时间约束",
    category: "constraint" as const,
    text: "昨晚 20:00-21:00 学习",
    constraint: parseMemoryConstraint("每晚 20:00-21:00 学习"),
    expiresAt: offset(DAY, -1),
    source: "agent" as const,
    confidence: 0.9,
  };
  const activeMem = {
    id: "m-act",
    label: "时间约束",
    category: "constraint" as const,
    text: "每晚 19:30-22:00 学习",
    constraint: parseMemoryConstraint("每晚 19:30-22:00 学习"),
    expiresAt: offset(DAY, 5),
    source: "user" as const,
    confidence: 1.0,
  };

  assert.equal(isMemoryExpired(expiredMem, DAY), true);
  assert.equal(isMemoryExpired(activeMem, DAY), false);
  const active = getActiveMemories([expiredMem, activeMem], DAY);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, "m-act");

  const prefs = extractMemoryPreferences([expiredMem, activeMem], DAY);
  assert.equal(prefs.preferredStart, 19 * 60 + 30);
  assert.equal(prefs.preferredEnd, 22 * 60);
});

test("Sprint 3: Embedded SQLite persistence, auto Plan Diff, chat threads & ReAct audit runs", () => {
  const prevPath = process.env.LEARNOS_DB_PATH;
  process.env.LEARNOS_DB_PATH = ":memory:";
  closeDbForTesting();

  try {
    // 1. Fresh DB loads empty store
    const empty = loadStoreFromDb(DAY);
    assert.equal(empty.blocks.length, 0);
    assert.equal(empty.memories.length, 0);

    // 2. Save store with memories (including TTL/source) & blocks
    const s = demoInitial(DAY);
    s.memories.unshift({
      id: "ttl-mem",
      label: "临时状态",
      category: "constraint",
      text: "本周出差，单次不超过 20 分钟",
      source: "agent",
      confidence: 0.92,
      expiresAt: offset(DAY, 7),
      createdAt: DAY,
    });
    const r1 = saveStoreToDb(s, { trigger: "初始化测试", summary: "写入初始计划" });
    assert.equal(r1.revisionRecorded, true);

    const loaded = loadStoreFromDb(DAY);
    assert.equal(loaded.blocks.length, s.blocks.length);
    assert.equal(loaded.mastery.tools, s.mastery.tools);
    const ttlLoaded = loaded.memories.find((m) => m.id === "ttl-mem");
    assert.ok(ttlLoaded);
    assert.equal(ttlLoaded!.source, "agent");
    assert.equal(ttlLoaded!.expiresAt, offset(DAY, 7));

    // 3. Modify a block + remove a block -> automatic Plan Diff capture
    const mutated = structuredClone(loaded);
    mutated.blocks[0].start += 60;
    const removedTitle = mutated.blocks.pop()!.title;
    const r2 = saveStoreToDb(mutated, { trigger: "ReAct 动态重排" });
    assert.equal(r2.revisionRecorded, true);

    // 4. Persistent Rich Message chat threads (including interactive quiz answer & visual resource cards)
    saveChatThreadToDb("agent-main", "agent", [
      { id: "u1", role: "user", parts: [{ type: "text", text: "你好" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "这是 Mermaid 图解：\n```mermaid\ngraph LR\nA-->B\n```" },
          {
            type: "tool-present_interactive_check",
            toolCallId: "tc-1",
            state: "output-available",
            input: { mode: "choice", prompt: "测试问题" },
            output: {
              kind: "interactive_check",
              checkId: "chk-1",
              mode: "choice",
              prompt: "测试问题",
              choices: ["选项A", "选项B"],
              savedChoiceIndex: 1,
              savedUserAnswer: "B. 选项B",
            },
          },
        ],
      },
    ]);
    const thread = getChatThreadFromDb("agent-main") as Array<{
      id: string;
      parts: Array<{ output?: { savedChoiceIndex?: number } }>;
    }>;
    assert.equal(thread.length, 2);
    assert.equal(thread[1].parts[1].output?.savedChoiceIndex, 1);
    deleteChatThreadFromDb("agent-main");
    assert.equal(getChatThreadFromDb("agent-main").length, 0);

    // 5. ReAct run audit trail & Plan Revision diff inspection
    recordAgentRunToDb({
      runId: "run-test-1",
      route: "agent",
      modelLabel: "deepseek-flash",
      userPrompt: "我想学 Python",
      stepCount: 3,
      latencyMs: 1240,
      reasoningChars: 310,
      toolCalls: [{ toolName: "save_memory", ok: true, summary: "已写入目标记忆" }],
      status: "completed",
      createdAt: new Date().toISOString(),
    });
    const audit = listAuditFromDb();
    assert.equal(audit.runs.length, 1);
    assert.equal(audit.runs[0].modelLabel, "deepseek-flash");
    assert.equal(audit.revisions.length, 2);
    // Latest revision (revisions sorted DESC) should capture moved + removed
    assert.equal(audit.revisions[0].diff.moved.length, 1);
    assert.equal(audit.revisions[0].diff.removed.length, 1);
    assert.equal(audit.revisions[0].diff.removed[0].title, removedTitle);

    const info = getDbInfo();
    assert.equal(info.runCount, 1);
    assert.equal(info.revisionCount, 2);

    clearAuditLogsInDb();
    assert.equal(listAuditFromDb().runs.length, 0);

    clearAllDataInDb();
    assert.equal(loadStoreFromDb(DAY).blocks.length, 0);
  } finally {
    closeDbForTesting();
    if (prevPath === undefined) delete process.env.LEARNOS_DB_PATH;
    else process.env.LEARNOS_DB_PATH = prevPath;
  }
});

test("Rich Visual Resource search returns schematic/encyclopedia items and caches results", async () => {
  const first = await searchVisualResources("ReAct Agent Loop", [
    "Reason 推理",
    "Act 调用工具",
    "Observe 观测结果",
  ]);
  assert.equal(first.kind, "visual_resource");
  assert.ok(first.items.length >= 1);
  assert.ok(first.items[0].imageUrl.length > 10);

  const second = await searchVisualResources("ReAct Agent Loop");
  assert.equal(second.items[0].cached, true);
});

test("Authoritative weekday formatting and main vs remedial lesson classification", () => {
  // 2026-11-21 is Saturday (周六), never Friday (周五)
  assert.equal(weekdayLabel("2026-11-21"), "周六");
  assert.equal(formatDayWithWeekday("2026-11-21"), "11月21日 周六");
  assert.equal(weekdayLabel("2026-11-22"), "周日");
  assert.equal(weekdayLabel("2026-11-23"), "周一");

  assert.equal(
    isRemedialBlock({ kind: "复习", title: "理解工具调用 · 降难补救微课" }),
    true,
  );
  assert.equal(
    isRemedialBlock({ kind: "学习", title: "理解工具调用" }),
    false,
  );
});

test("parseMemoryConstraint ignores non-clock phrases like '学过一点语法' or '1 小时以上'", () => {
  const c1 = parseMemoryConstraint(
    "Java 起点：学过一点语法但写不出完整程序；每天可投入 1 小时以上",
  );
  assert.equal(c1, undefined);

  const c2 = parseMemoryConstraint("每晚 20:00 后开始学习，单次不超过 45 分钟");
  assert.ok(c2);
  assert.equal(c2!.preferredStart, 20 * 60);
  assert.equal(c2!.maxSessionMinutes, 45);
});

function createSqliteStorageAdapterForTest(): LLMTaskStorageAdapter {
  return {
    async saveTask(task, syncChatThread = true) {
      upsertLlmTaskInDb(task, syncChatThread);
    },
    async loadThread(threadId) {
      return {
        messages: getChatThreadFromDb(threadId) as import("ai").UIMessage[],
        latestTask: getLatestLlmTaskForThreadFromDb(threadId),
        tasks: listLlmTasksFromDb(threadId, 10),
      };
    },
    async loadTask(taskId) {
      return getLlmTaskFromDb(taskId);
    },
    async cancelServerTask() {},
    async saveThreadMessages(threadId, messages) {
      saveChatThreadToDb(threadId, "agent", messages);
    },
    async clearThread(threadId) {
      deleteChatThreadFromDb(threadId);
    },
  };
}

function createMockSseStreamAdapter(
  resolver: (params: {
    taskId: string;
    threadId: string;
    requestPayload: Record<string, unknown>;
  }) => {
    chunks: string[];
    chunkDelayMs: number;
    failAfterChunks?: number;
    errorMessage?: string;
  },
): LLMTaskStreamAdapter {
  return async ({ taskId, threadId, requestPayload, signal }) => {
    const spec = resolver({ taskId, threadId, requestPayload });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: Record<string, unknown>) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(obj)}\n\n`),
          );
        };
        const sleep = (ms: number) =>
          new Promise<void>((res, rej) => {
            if (signal.aborted) {
              rej(new Error("aborted"));
              return;
            }
            const t = setTimeout(res, ms);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                rej(new Error("aborted"));
              },
              { once: true },
            );
          });

        try {
          send({ type: "start", messageId: `asst-${taskId}` });
          send({ type: "text-start", id: "txt-1" });
          for (let i = 0; i < spec.chunks.length; i++) {
            await sleep(spec.chunkDelayMs);
            if (
              typeof spec.failAfterChunks === "number" &&
              i >= spec.failAfterChunks
            ) {
              send({
                type: "error",
                errorText: spec.errorMessage || "模拟网络流中断错误",
              });
              controller.close();
              return;
            }
            send({
              type: "text-delta",
              id: "txt-1",
              delta: spec.chunks[i],
            });
          }
          send({ type: "text-end", id: "txt-1" });
          send({ type: "finish" });
          controller. enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          try {
            controller.close();
          } catch {}
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

test("LLMTaskManager: switching routes (unsubscribe & re-subscribe) mid-stream keeps task running and persists to SQLite", async () => {
  const prevPath = process.env.LEARNOS_DB_PATH;
  process.env.LEARNOS_DB_PATH = ":memory:";
  closeDbForTesting();

  try {
    const tm = new LLMTaskManager({
      storage: createSqliteStorageAdapterForTest(),
      streamAdapter: createMockSseStreamAdapter(() => ({
        chunks: [
          "第一段：Java 与 JVM 跨平台原理。\n\n",
          "第二段：类与对象的内存模型。\n\n",
          "第三段：第一课动手练习与总结。",
        ],
        chunkDelayMs: 45,
      })),
    });

    const chatViewEvents: string[] = [];
    let unsubChatView: (() => void) | null = null;

    // 1. User is on Chat page and subscribes
    const firstChunkReceived = new Promise<void>((resolve) => {
      unsubChatView = tm.subscribe(
        (ev) => {
          if (ev.task?.previewText) {
            chatViewEvents.push(ev.task.previewText);
            if (ev.task.previewText.includes("第一段")) {
              resolve();
            }
          }
        },
        { threadId: "agent-main" },
      );
    });

    const started = await tm.start({
      threadId: "agent-main",
      userText: "我要学习 Java",
      modelLabel: "deepseek-chat",
    });
    assert.equal(started.status, "running");

    // Wait for chunk 1 to arrive on Chat page
    await firstChunkReceived;

    // 2. User immediately switches to Calendar page -> Chat page unmounts and ONLY unsubscribes!
    (unsubChatView as (() => void) | null)?.();

    // Task MUST still be running in the background
    assert.equal(tm.getStatus("agent-main").isRunning, true);
    assert.equal(tm.getStatus("agent-main").status, "running");

    // Wait while on Calendar page so chunk 2 streams in the background
    await new Promise((r) => setTimeout(r, 60));

    // 3. User returns to Chat page -> inspects existing content and re-subscribes for remaining chunks
    const midStreamStatus = tm.getStatus("agent-main");
    assert.ok(
      midStreamStatus.previewText.includes("第一段") &&
        midStreamStatus.previewText.includes("第二段"),
      "Returning to Chat page must immediately show chunks generated while on Calendar page",
    );

    const returnedViewPreviews: string[] = [];
    const unsubReturnedView = tm.subscribe(
      (ev) => {
        if (ev.task?.previewText) {
          returnedViewPreviews.push(ev.task.previewText);
        }
      },
      { threadId: "agent-main" },
    );

    // Wait for stream completion
    const completed = await tm.waitForCompletion(started.taskId, 5000);
    unsubReturnedView();

    assert.ok(completed);
    assert.equal(completed!.status, "completed");
    assert.ok(completed!.previewText.includes("第一段"));
    assert.ok(completed!.previewText.includes("第二段"));
    assert.ok(completed!.previewText.includes("第三段"));
    assert.ok(
      returnedViewPreviews.some((p) => p.includes("第三段")),
      "Re-subscribed Chat page must continue receiving subsequent incremental chunks",
    );

    // 4. Verify SQLite persistence of both llm_tasks and chat_threads
    const dbTask = getLlmTaskFromDb(started.taskId);
    assert.ok(dbTask);
    assert.equal(dbTask!.status, "completed");
    assert.ok(dbTask!.completedAt);

    const dbThread = getChatThreadFromDb("agent-main") as import("ai").UIMessage[];
    assert.equal(dbThread.length, 2);
    assert.equal(dbThread[0].role, "user");
    assert.equal(dbThread[1].role, "assistant");
  } finally {
    closeDbForTesting();
    if (prevPath === undefined) delete process.env.LEARNOS_DB_PATH;
    else process.env.LEARNOS_DB_PATH = prevPath;
  }
});

test("LLMTaskManager: concurrent tasks across multiple threads run independently without event cross-talk", async () => {
  const prevPath = process.env.LEARNOS_DB_PATH;
  process.env.LEARNOS_DB_PATH = ":memory:";
  closeDbForTesting();

  try {
    const tm = new LLMTaskManager({
      storage: createSqliteStorageAdapterForTest(),
      streamAdapter: createMockSseStreamAdapter(({ threadId }) => ({
        chunks:
          threadId === "thread-alpha"
            ? ["Alpha-Chunk-1 ", "Alpha-Chunk-2"]
            : ["Beta-Chunk-1 ", "Beta-Chunk-2"],
        chunkDelayMs: 30,
      })),
    });

    const alphaEvents: string[] = [];
    const betaEvents: string[] = [];

    const unsubAlpha = tm.subscribe(
      (ev) => {
        alphaEvents.push(`${ev.threadId}:${ev.task?.previewText || ""}`);
      },
      { threadId: "thread-alpha" },
    );
    const unsubBeta = tm.subscribe(
      (ev) => {
        betaEvents.push(`${ev.threadId}:${ev.task?.previewText || ""}`);
      },
      { threadId: "thread-beta" },
    );

    const [tAlpha, tBeta] = await Promise.all([
      tm.start({ threadId: "thread-alpha", userText: "Alpha question" }),
      tm.start({ threadId: "thread-beta", userText: "Beta question" }),
    ]);

    assert.equal(tm.getStatus().activeTasks.length, 2);

    const [doneAlpha, doneBeta] = await Promise.all([
      tm.waitForCompletion(tAlpha.taskId, 5000),
      tm.waitForCompletion(tBeta.taskId, 5000),
    ]);

    unsubAlpha();
    unsubBeta();

    assert.equal(doneAlpha?.status, "completed");
    assert.equal(doneBeta?.status, "completed");
    assert.equal(doneAlpha?.previewText, "Alpha-Chunk-1 Alpha-Chunk-2");
    assert.equal(doneBeta?.previewText, "Beta-Chunk-1 Beta-Chunk-2");

    // Verify zero cross-talk between thread subscribers
    assert.ok(alphaEvents.every((e) => e.startsWith("thread-alpha:")));
    assert.ok(betaEvents.every((e) => e.startsWith("thread-beta:")));
  } finally {
    closeDbForTesting();
    if (prevPath === undefined) delete process.env.LEARNOS_DB_PATH;
    else process.env.LEARNOS_DB_PATH = prevPath;
  }
});

test("LLMTaskManager: explicit cancel aborts task, preserves partial output, and marks status cancelled in SQLite", async () => {
  const prevPath = process.env.LEARNOS_DB_PATH;
  process.env.LEARNOS_DB_PATH = ":memory:";
  closeDbForTesting();

  try {
    const tm = new LLMTaskManager({
      storage: createSqliteStorageAdapterForTest(),
      streamAdapter: createMockSseStreamAdapter(() => ({
        chunks: ["Part-1 ", "Part-2 ", "Part-3 ", "Part-4"],
        chunkDelayMs: 50,
      })),
    });

    const firstChunkReady = new Promise<void>((resolve) => {
      const unsub = tm.subscribe((ev) => {
        if (ev.task?.previewText.includes("Part-1")) {
          unsub();
          resolve();
        }
      });
    });

    const task = await tm.start({
      threadId: "thread-cancel",
      userText: "生成长篇分析",
    });
    await firstChunkReady;

    const cancelledOk = await tm.cancel(task.taskId);
    assert.equal(cancelledOk, true);
    const cancelledStatus = tm.getStatus(task.taskId);
    assert.equal(cancelledStatus.status, "cancelled");
    assert.ok(cancelledStatus.previewText.includes("Part-1"));
    assert.ok(!cancelledStatus.previewText.includes("Part-4"));

    const dbTask = getLlmTaskFromDb(task.taskId);
    assert.equal(dbTask?.status, "cancelled");
  } finally {
    closeDbForTesting();
    if (prevPath === undefined) delete process.env.LEARNOS_DB_PATH;
    else process.env.LEARNOS_DB_PATH = prevPath;
  }
});

test("LLMTaskManager: failed stream records error in SQLite and retry() recovers cleanly", async () => {
  const prevPath = process.env.LEARNOS_DB_PATH;
  process.env.LEARNOS_DB_PATH = ":memory:";
  closeDbForTesting();

  try {
    let shouldFail = true;
    const tm = new LLMTaskManager({
      storage: createSqliteStorageAdapterForTest(),
      streamAdapter: createMockSseStreamAdapter(() =>
        shouldFail
          ? {
              chunks: ["Partial-Before-Error ", "Unreached"],
              chunkDelayMs: 25,
              failAfterChunks: 1,
              errorMessage: "模拟上游网关超时",
            }
          : {
              chunks: ["重试后第一段 ", "重试后第二段（完整成功）"],
              chunkDelayMs: 25,
            },
      ),
    });

    const initialTask = await tm.start({
      threadId: "thread-retry",
      userText: "讲解 BKT 贝叶斯知识追踪",
    });

    const failedSnap = await tm.waitForCompletion(initialTask.taskId, 5000);
    assert.equal(failedSnap?.status, "failed");
    assert.match(failedSnap?.errorMessage || "", /模拟上游网关超时/);
    assert.equal(getLlmTaskFromDb(initialTask.taskId)?.status, "failed");

    // Flip adapter to succeed and retry
    shouldFail = false;
    const retriedTask = await tm.retry("thread-retry");
    assert.ok(retriedTask);
    const recovered = await tm.waitForCompletion(retriedTask!.taskId, 5000);
    assert.equal(recovered?.status, "completed");
    assert.equal(
      recovered?.previewText,
      "重试后第一段 重试后第二段（完整成功）",
    );

    const dbThread = getChatThreadFromDb("thread-retry");
    assert.equal(
      dbThread.length,
      2,
      "Retry must not duplicate the user prompt message",
    );
  } finally {
    closeDbForTesting();
    if (prevPath === undefined) delete process.env.LEARNOS_DB_PATH;
    else process.env.LEARNOS_DB_PATH = prevPath;
  }
});

test("SQLite crash recovery marks stale running tasks as interrupted and re-hydrates accurately", async () => {
  const prevPath = process.env.LEARNOS_DB_PATH;
  process.env.LEARNOS_DB_PATH = ":memory:";
  closeDbForTesting();

  try {
    // 1. Simulate a task that was persisted as 'running' right before app crash/quit
    const crashedTask: LLMTaskRecord = {
      taskId: "task-crashed-001",
      threadId: "agent-main",
      status: "running",
      userPrompt: "在关闭窗口前发起的长生成",
      modelLabel: "deepseek-chat",
      requestPayload: {},
      baseMessages: [
        {
          id: "u-1",
          role: "user",
          parts: [{ type: "text", text: "在关闭窗口前发起的长生成" }],
        },
      ],
      assistantMessage: {
        id: "a-1",
        role: "assistant",
        parts: [{ type: "text", text: "已经生成到一半的持久化内容…" }],
      },
      createdAt: "2026-11-21T03:00:00.000Z",
      updatedAt: "2026-11-21T03:00:05.000Z",
    };
    upsertLlmTaskInDb(crashedTask, true);
    assert.equal(getLlmTaskFromDb("task-crashed-001")?.status, "running");

    // 2. On next app boot, markStaleRunningTasksInterruptedInDb runs with empty in-process task set
    const interruptedCount = markStaleRunningTasksInterruptedInDb(new Set());
    assert.equal(interruptedCount, 1);

    const afterBoot = getLlmTaskFromDb("task-crashed-001");
    assert.equal(
      afterBoot?.status,
      "interrupted",
      "Crash-leftover tasks must never fake a running status",
    );

    // 3. New LLMTaskManager instance hydrates from SQLite and restores partial content + interrupted status
    const freshTm = new LLMTaskManager({
      storage: createSqliteStorageAdapterForTest(),
    });
    const hydratedMsgs = await freshTm.hydrateThread("agent-main");
    assert.equal(hydratedMsgs.length, 2);
    const status = freshTm.getStatus("agent-main");
    assert.equal(status.status, "interrupted");
    assert.equal(status.isRunning, false);
    assert.equal(status.previewText, "已经生成到一半的持久化内容…");
  } finally {
    closeDbForTesting();
    if (prevPath === undefined) delete process.env.LEARNOS_DB_PATH;
    else process.env.LEARNOS_DB_PATH = prevPath;
  }
});
