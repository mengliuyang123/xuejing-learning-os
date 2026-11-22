import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adjustTrackScopeInDb,
  closeDbForTesting,
  loadStoreFromDb,
  saveStoreToDb,
} from "../lib/db";
import {
  normalizeLessonGoalFields,
  recommendLessonCount,
  reconcileTrackUnitsAndSchedule,
  validateTrackUnits,
} from "../lib/curriculum-planner";
import { type GoalPlan, type Lesson, emptyStore } from "../lib/learning";
import {
  REFERENCE_SIX_TRACK_ID,
  createReferenceSixLessonStore,
  createReferenceSixLessonTrack,
} from "./fixtures/reference-six-lesson-track";

const DAY = "2026-11-21";

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "learnos-e2e001-"));
  process.env.LEARNOS_DB_PATH = join(dir, "test.sqlite");
  return {
    cleanup() {
      closeDbForTesting();
      delete process.env.LEARNOS_DB_PATH;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

test("E2E-001 (AC #1, #2): Lesson count adapts dynamically by goal, prior knowledge, deadline, depth, and dependency count — never forcing 6 lessons", () => {
  // 1. Focused short-deadline crash goal for advanced learner -> small count (1-3)
  const crash = recommendLessonCount({
    goal: "周末速通修复一个 SQL 慢查询索引单点问题",
    priorKnowledge: "advanced",
    days: 2,
    dailyMinutes: 45,
    depth: "crash",
  });
  assert.ok(crash.recommended >= 1 && crash.recommended <= 3, `Expected 1-3, got ${crash.recommended}`);
  assert.notEqual(crash.recommended, 6);

  // 2. Deep long-horizon goal for beginner -> >6 lessons (8-12)
  const deep = recommendLessonCount({
    goal: "零基础系统深入掌握分布式架构、存储引擎、一致性协议、观测审计与生产高可用实战",
    priorKnowledge: "beginner",
    days: 30,
    dailyMinutes: 60,
    depth: "deep",
  });
  assert.ok(deep.recommended >= 8 && deep.recommended <= 14, `Expected 8-14, got ${deep.recommended}`);
  assert.notEqual(deep.recommended, 6);

  // 3. Tight time budget compresses a deep goal down to realistic count
  const tightBudget = recommendLessonCount({
    goal: "系统学习 Rust 异步运行时与网络编程",
    priorKnowledge: "intermediate",
    days: 2,
    dailyMinutes: 35,
    depth: "deep",
    avgLessonMinutes: 35,
  });
  assert.equal(tightBudget.recommended, 2);

  // 4. Prerequisite dependency floor ensures count respects dependency chain
  const depHeavy = recommendLessonCount({
    goal: "理解分布式共识",
    priorKnowledge: "intermediate",
    depth: "standard",
    dependencyCount: 7,
  });
  assert.ok(depHeavy.recommended >= 8, `Expected >=8 due to 7 dependencies, got ${depHeavy.recommended}`);
});

test("E2E-001 (AC #4, #5): Validates DAG acyclicity, dangling prerequisites, self-dependencies, and explicit objective + completionCriteria", () => {
  const mk = (id: string, title: string, requires: string[], withGoals = true): Lesson => ({
    id,
    title,
    subtitle: title,
    minutes: 30,
    requires,
    concept: `${title} 核心概念`,
    objective: withGoals ? `掌握 ${title}` : undefined,
    completionCriteria: withGoals ? `通过 ${title} 测验且掌握度 ≥ 80%` : undefined,
    example: "example()",
    question: "",
    choices: [],
    answer: 0,
    feedback: "",
  });

  // Cycle rejected
  const cyclic = validateTrackUnits(
    [mk("a", "课 A", ["b"]), mk("b", "课 B", ["a"])],
    { strictGoalFields: true },
  );
  assert.equal(cyclic.ok, false);
  assert.ok(cyclic.errors.some((e) => e.includes("循环依赖")));

  // Dangling prerequisite rejected
  const dangling = validateTrackUnits(
    [mk("a", "课 A", []), mk("b", "课 B", ["missing-id"])],
    { strictGoalFields: true },
  );
  assert.equal(dangling.ok, false);
  assert.ok(dangling.errors.some((e) => e.includes("不存在的先修课程")));

  // Strict goal fields check catches missing objective / completionCriteria
  const missingGoals = validateTrackUnits([mk("a", "课 A", [], false)], {
    strictGoalFields: true,
  });
  assert.equal(missingGoals.ok, false);
  assert.equal(missingGoals.errors.length, 2);

  // normalizeLessonGoalFields fills explicit objective & completionCriteria cleanly
  const normalized = normalizeLessonGoalFields(mk("a", "课 A", [], false));
  assert.ok(normalized.objective && normalized.objective.length > 0);
  assert.ok(
    normalized.completionCriteria && normalized.completionCriteria.length > 0,
  );
  const valid = validateTrackUnits([normalized], { strictGoalFields: true });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.topologicalOrder, ["a"]);
});

test("E2E-001 (AC #6): Standard regression fixture stably generates and persists fixed 6-lesson reference curriculum", () => {
  const env = makeTempDb();
  try {
    const { plan } = createReferenceSixLessonTrack(DAY);
    assert.equal(plan.units.length, 6);
    assert.equal(plan.slots.length, 6);
    for (const u of plan.units) {
      assert.ok(u.objective && u.objective.trim().length > 0);
      assert.ok(u.completionCriteria && u.completionCriteria.trim().length > 0);
    }
    const validation = validateTrackUnits(plan.units, { strictGoalFields: true });
    assert.equal(validation.ok, true);
    assert.equal(validation.topologicalOrder.length, 6);

    const store = createReferenceSixLessonStore(DAY);
    saveStoreToDb(store, { trigger: "fixture-seed" });
    const reloaded = loadStoreFromDb(DAY);
    const reloadedTrack = reloaded.goalPlans?.find(
      (p) => p.id === REFERENCE_SIX_TRACK_ID,
    );
    assert.ok(reloadedTrack);
    assert.equal(reloadedTrack.units.length, 6);
    assert.equal(reloadedTrack.depth, "standard");
    assert.equal(reloadedTrack.scopeNote, "自动化回归固定 6 节参考课程");
  } finally {
    env.cleanup();
  }
});

test("E2E-001 (AC #3, #7): Adjusting track scope/depth (expanding 6 -> 8 and narrowing 8 -> 4) preserves mastered state, completed blocks, locked blocks, and other tracks", () => {
  const env = makeTempDb();
  try {
    const baseStore = createReferenceSixLessonStore(DAY);
    // Add a second independent track + a completed block + a locked block
    const otherLesson: Lesson = normalizeLessonGoalFields({
      id: "other-u1",
      title: "SQL 聚合分析",
      subtitle: "GROUP BY",
      minutes: 30,
      requires: [],
      concept: "按维度聚合统计",
      example: "SELECT COUNT(*) FROM orders;",
      question: "",
      choices: [],
      answer: 0,
      feedback: "",
    });
    const otherPlan: GoalPlan = {
      id: "track-other-sql",
      version: "track-other-sql-v1",
      goal: "SQL 快速复习",
      title: "SQL 速通",
      days: 3,
      daily: 30,
      start: 1140,
      depth: "crash",
      units: [otherLesson],
      slots: [],
    };
    const otherBlock = {
      id: "blk-other-1",
      day: "2026-11-28",
      start: 1140,
      minutes: 30,
      title: "SQL 聚合分析",
      kind: "学习" as const,
      lesson: "other-u1",
    };

    // Mark first lesson mastered (92%) and its block completed; lock second block
    baseStore.mastery["ref-u1-llm-api"] = 92;
    baseStore.masteryMeta = {
      "ref-u1-llm-api": {
        stabilityDays: 6,
        nextReviewDay: "2026-11-27",
        attempts: 3,
        masteryOrigin: "verified",
      },
    };
    const firstBlockId = baseStore.blocks[0].id;
    const secondBlockId = baseStore.blocks[1].id;
    baseStore.blocks[0] = { ...baseStore.blocks[0], done: true };
    baseStore.blocks[1] = { ...baseStore.blocks[1], locked: true };
    baseStore.goalPlans = [...(baseStore.goalPlans || []), otherPlan];
    baseStore.blocks.push(otherBlock);

    saveStoreToDb(baseStore, { trigger: "seed-multi-track" });

    // 1. Expand from 6 lessons -> 8 lessons (deep mode)
    const expanded = adjustTrackScopeInDb({
      trackId: REFERENCE_SIX_TRACK_ID,
      day: DAY,
      depth: "deep",
      scopeNote: "增加生产部署评测与多 Agent 协作两节深度课程",
      days: 14,
      appendUnits: [
        {
          id: "ref-u7-eval",
          title: "Agent 自动化评测与回归基准",
          concept: "构建离线数据集与多维评测指标",
          objective: "建立可复现的 Agent 评测集与回归门禁",
          completionCriteria: "编写至少 5 条评测用例并验证通过率指标",
          minutes: 45,
          requires: ["ref-u6-memory-rag"],
        },
        {
          id: "ref-u8-multi-agent",
          title: "多 Agent 协作与任务编排",
          concept: "拆分规划、执行与审校角色降低单体复杂度",
          objective: "设计带边界隔离的 Planner-Executor-Reviewer 协作流",
          completionCriteria: "完成一次角色分工与错误兜底设计测验",
          minutes: 45,
          requires: ["ref-u7-eval"],
        },
      ],
    });

    const expandedTrack = expanded.store.goalPlans?.find(
      (p) => p.id === REFERENCE_SIX_TRACK_ID,
    );
    assert.ok(expandedTrack);
    assert.equal(expandedTrack.units.length, 8);
    assert.equal(expandedTrack.depth, "deep");
    assert.equal(expanded.addedLessonIds.length, 2);
    assert.equal(expanded.newlyScheduledBlocks.length, 2);
    // Mastered lesson & completed/locked blocks untouched
    assert.equal(expanded.store.mastery["ref-u1-llm-api"], 92);
    assert.equal(
      expanded.store.blocks.find((b) => b.id === firstBlockId)?.done,
      true,
    );
    assert.equal(
      expanded.store.blocks.find((b) => b.id === secondBlockId)?.locked,
      true,
    );
    // Other track completely untouched
    assert.ok(expanded.store.blocks.some((b) => b.id === "blk-other-1"));

    // 2. Narrow scope from 8 lessons -> 4 lessons (trying to remove mastered u1 must be protected!)
    const narrowed = adjustTrackScopeInDb({
      trackId: REFERENCE_SIX_TRACK_ID,
      day: DAY,
      depth: "crash",
      scopeNote: "时间收紧，聚焦前 4 节核心工程闭环",
      removeLessonIds: [
        "ref-u1-llm-api", // MASTERED -> MUST BE PROTECTED!
        "ref-u5-react-loop",
        "ref-u6-memory-rag",
        "ref-u7-eval",
        "ref-u8-multi-agent",
      ],
    });

    const narrowedTrack = narrowed.store.goalPlans?.find(
      (p) => p.id === REFERENCE_SIX_TRACK_ID,
    );
    assert.ok(narrowedTrack);
    // u1 was protected (mastered >= 80), while u5..u8 were trimmed -> 4 lessons remain
    assert.equal(narrowedTrack.units.length, 4);
    assert.ok(narrowedTrack.units.some((u) => u.id === "ref-u1-llm-api"));
    assert.equal(narrowedTrack.depth, "crash");
    assert.equal(narrowed.removedLessonIds.length, 4);
    assert.equal(narrowed.removedFutureBlockIds.length, 4);
    // Mastered state, completed block, locked block, and other track all preserved!
    assert.equal(narrowed.store.mastery["ref-u1-llm-api"], 92);
    assert.equal(
      narrowed.store.blocks.find((b) => b.id === firstBlockId)?.done,
      true,
    );
    assert.equal(
      narrowed.store.blocks.find((b) => b.id === secondBlockId)?.locked,
      true,
    );
    assert.ok(narrowed.store.blocks.some((b) => b.id === "blk-other-1"));
    assert.equal(
      validateTrackUnits(narrowedTrack.units, { strictGoalFields: true }).ok,
      true,
    );

    // 3. Direct pure reconciliation with a 2-lesson track also works cleanly
    const twoLessonRes = reconcileTrackUnitsAndSchedule(
      {
        ...emptyStore(DAY),
        activeTrackId: otherPlan.id,
        goalPlans: [otherPlan],
        blocks: [otherBlock],
        mastery: { "other-u1": 0 },
      },
      {
        trackId: otherPlan.id,
        day: DAY,
        appendUnits: [
          {
            title: "SQL 窗口函数实战",
            concept: "ROW_NUMBER 与分区汇总",
            minutes: 30,
          },
        ],
      },
    );
    assert.equal(twoLessonRes.plan.units.length, 2);
    assert.equal(twoLessonRes.newlyScheduledBlocks.length, 1);
  } finally {
    env.cleanup();
  }
});

test("Multi-tool ReAct persistence regression: consecutive saveStoreToDb calls advancing stateVersion persist memories + track + blocks cleanly", () => {
  const env = makeTempDb();
  try {
    // Simulate freshly reset empty DB (version 0)
    let working = loadStoreFromDb(DAY);
    assert.equal(working.stateVersion ?? 0, 0);

    // Step 1: save_memory #1
    working = {
      ...working,
      memories: [
        {
          id: "mem-1",
          label: "学习偏好",
          category: "preference",
          text: "早上 07:00-09:00 每天 45 分钟",
          createdAt: DAY,
        },
      ],
    };
    const r1 = saveStoreToDb(working, { trigger: "Agent 自主记忆", summary: "m1" });
    working = { ...working, stateVersion: r1.stateVersion };

    // Step 2: save_memory #2
    working = {
      ...working,
      memories: [
        ...working.memories,
        {
          id: "mem-2",
          label: "学习目标",
          category: "goal",
          text: "AI Agent 速通 3 节",
          createdAt: DAY,
        },
      ],
    };
    const r2 = saveStoreToDb(working, { trigger: "Agent 自主记忆", summary: "m2" });
    working = { ...working, stateVersion: r2.stateVersion };

    // Step 3: create_learning_track (3 lessons, crash depth)
    const { plan, slots } = createReferenceSixLessonTrack(DAY);
    const threeUnits = plan.units.slice(0, 3);
    const threeSlots = slots.slice(0, 3);
    const threePlan: GoalPlan = {
      ...plan,
      id: "track-crash-3",
      depth: "crash",
      units: threeUnits,
      slots: threeSlots,
    };
    working = {
      ...working,
      activeTrackId: threePlan.id,
      goalPlans: [threePlan],
      blocks: threeSlots,
    };
    const r3 = saveStoreToDb(working, { trigger: "Agent 建轨排课", summary: "3 节速通" });
    working = { ...working, stateVersion: r3.stateVersion };

    assert.equal(r1.stateVersion, 1);
    assert.equal(r2.stateVersion, 2);
    assert.equal(r3.stateVersion, 3);

    const reloaded = loadStoreFromDb(DAY);
    assert.equal(reloaded.stateVersion, 3);
    assert.equal(reloaded.memories.length, 2);
    assert.equal(reloaded.goalPlans?.length, 1);
    assert.equal(reloaded.goalPlans?.[0].units.length, 3);
    assert.equal(reloaded.blocks.length, 3);
  } finally {
    env.cleanup();
  }
});
