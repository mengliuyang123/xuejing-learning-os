import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTodaySnapshot,
  detectDayConflicts,
  generateCandidateActivities,
  selectActivitiesForTimeBudget,
} from "../lib/domain-activities";
import {
  type GoalPlan,
  type Lesson,
  type Store,
  emptyStore,
} from "../lib/learning";
import {
  generateBatchRescheduleOptions,
  generateRescheduleOptions,
  validateRescheduleOption,
} from "../lib/scheduler";
import { exportBlocksToICS } from "../lib/ics";

const DAY = "2026-11-21";

function makeLesson(
  id: string,
  title: string,
  requires: string[] = [],
  minutes = 45,
): Lesson {
  return {
    id,
    title,
    subtitle: title,
    minutes,
    requires,
    concept: `${title} 概念`,
    example: "code()",
    question: `${title} 测验`,
    choices: ["A", "B"],
    answer: 0,
    feedback: "解析",
  };
}

function makePlan(
  id: string,
  title: string,
  units: Lesson[],
  archived = false,
): GoalPlan {
  return {
    id,
    version: `${id}-v1`,
    goal: title,
    title,
    days: 7,
    daily: 45,
    start: 1140,
    units,
    slots: [],
    archived,
  };
}

test("Wave 2 (FSRS-15, E2E-015, TODAY-13, TODAY-12, TODAY-16): Due reviews ignore future study blocks, 15m budget rejects 20m remediation, conflicts trigger Today alert, and cross-track reviews aggregate cleanly without archived tracks", () => {
  const ag1 = makeLesson("ag-1", "LLM 调用基础", [], 45);
  const ag2 = makeLesson("ag-2", "Prompt 结构化", ["ag-1"], 45);
  const py1 = makeLesson("py-1", "Python 自动化基础", [], 30);
  const arch1 = makeLesson("arch-1", "已归档旧课", [], 30);

  const store: Store = {
    ...emptyStore(DAY),
    activeTrackId: "tr-py",
    goalPlans: [
      makePlan("tr-ag", "AI Agent 轨道", [ag1, ag2], false),
      makePlan("tr-py", "Python 轨道", [py1], false),
      makePlan("tr-arch", "已归档轨道", [arch1], true),
    ],
    mastery: { "ag-1": 90, "py-1": 0, "arch-1": 85 },
    masteryMeta: {
      "ag-1": {
        stabilityDays: 5,
        nextReviewDay: "2026-11-20",
        lastReviewDay: "2026-11-15",
        attempts: 3,
        masteryOrigin: "verified",
      },
      "arch-1": {
        stabilityDays: 5,
        nextReviewDay: "2026-11-19",
        lastReviewDay: "2026-11-14",
        attempts: 3,
        masteryOrigin: "verified",
      },
      "py-1": {
        stabilityDays: 1,
        nextReviewDay: "2026-11-22",
        attempts: 2,
        consecutiveFailures: 2,
      },
    },
    blocks: [
      // FSRS-15: Future normal '学习' block for ag-1 MUST NOT hide due '复习'
      {
        id: "blk-ag1-study",
        day: "2026-11-27",
        start: 1140,
        minutes: 45,
        title: "LLM 调用基础",
        kind: "学习",
        lesson: "ag-1",
      },
      // TODAY-12: Two overlapping blocks today
      {
        id: "blk-work-today",
        day: DAY,
        start: 1140,
        minutes: 45,
        title: "锁定工作会议",
        kind: "工作",
        locked: true,
      },
      {
        id: "blk-py1-today",
        day: DAY,
        start: 1140,
        minutes: 30,
        title: "Python 自动化基础",
        kind: "学习",
        lesson: "py-1",
      },
    ],
  };

  // FSRS-15: ag-1 due review is candidate (not hidden as 'scheduled') despite future study block
  const allCands = generateCandidateActivities(store, DAY);
  const agRev = allCands.find((a) => a.conceptId === "ag-1" && a.type === "review");
  assert.ok(agRev, "Expected due review candidate for ag-1");
  assert.equal(agRev.status, "candidate");
  assert.equal(agRev.scheduledBlock, undefined);

  // Archived track's due review MUST NOT appear
  assert.equal(
    allCands.some((a) => a.conceptId === "arch-1"),
    false,
  );

  // TODAY-12 & TODAY-16: Snapshot keeps primary recommendation on active track (Python),
  // reports conflict on Today, and surfaces AI Agent due review in crossTrackDueReviews only (excluding archived)
  const snap = buildTodaySnapshot(store, DAY);
  assert.equal(snap.activeTrackId, "tr-py");
  assert.equal(snap.nextBestAction?.trackId, "tr-py");
  assert.equal(snap.todayConflicts.length, 1);
  assert.equal(detectDayConflicts(store.blocks, DAY).length, 1);
  assert.equal(snap.suggestion.kind, "conflict");
  assert.equal(snap.crossTrackDueReviews.length, 1);
  assert.equal(snap.crossTrackDueReviews[0].trackId, "tr-ag");
  assert.equal(snap.crossTrackDueReviews[0].dueCount, 1);

  // E2E-015 / TODAY-13: 15m budget MUST NOT return a 20m unsplittable remediation activity
  const for15m = selectActivitiesForTimeBudget(snap.candidates, 15, "medium");
  assert.equal(
    for15m.every((a) => a.estimatedMinutes <= 15),
    true,
  );
  assert.equal(for15m.length, 0);

  const for30m = selectActivitiesForTimeBudget(snap.candidates, 30, "medium");
  assert.equal(for30m.length, 1);
  assert.equal(for30m[0].estimatedMinutes, 20);
});

test("Wave 2 (E2E-013, AGENT-08, PLAN-10): Reschedule rejects missing blockId, respects conflictDay & prereq topology order, and ICS handles exact midnight & custom timezone", () => {
  const u4 = makeLesson("u4", "第四课：Function Calling", [], 45);
  const u5 = makeLesson("u5", "第五课：ReAct 循环", ["u4"], 45);
  const store: Store = {
    ...emptyStore(DAY),
    activeTrackId: "tr-ag",
    goalPlans: [makePlan("tr-ag", "AI Agent", [u4, u5])],
    mastery: { u4: 0, u5: 0 },
    blocks: [
      {
        id: "blk-u4",
        day: "2026-11-24",
        start: 1170,
        minutes: 45,
        title: "第四课：Function Calling",
        kind: "学习",
        lesson: "u4",
      },
      {
        id: "blk-u5",
        day: "2026-11-25",
        start: 1200,
        minutes: 45,
        title: "第五课：ReAct 循环",
        kind: "学习",
        lesson: "u5",
      },
    ],
  };

  // AGENT-08: missing blockId returns empty options with explicit reason (never falls back to u4!)
  const missingRes = generateRescheduleOptions(store, DAY, {
    blockId: "missing-e2e-id",
  });
  assert.equal(missingRes.options.length, 0);
  assert.match(missingRes.reason, /missing-e2e-id/);

  // E2E-013: batch rescheduling 11-25 MUST NOT move u5 earlier than u4 (11-24 20:15)
  const batch = generateBatchRescheduleOptions(
    store,
    DAY,
    ["2026-11-25"],
    "临时加班",
  );
  assert.ok(batch.options.length > 0);
  for (const opt of batch.options) {
    assert.equal(validateRescheduleOption(store, opt).ok, true);
    for (const c of opt.changes) {
      for (const ns of c.newSlots) {
        assert.equal(
          ns.day > "2026-11-24" || (ns.day === "2026-11-24" && ns.start >= 1215),
          true,
          `u5 must not be moved ahead of u4 (got ${ns.day} ${ns.start})`,
        );
      }
    }
  }

  // validateRescheduleOption rejects an artificial option moving u5 to 11-21 ahead of u4
  const badCheck = validateRescheduleOption(store, {
    id: "bad-early",
    label: "今日提前抢学",
    summary: "违规提前",
    score: 90,
    tags: [],
    changes: [
      {
        blockId: "blk-u5",
        title: "第五课：ReAct 循环",
        lesson: "u5",
        oldDay: "2026-11-25",
        oldStart: 1200,
        oldMinutes: 45,
        newSlots: [{ day: "2026-11-21", start: 1220, minutes: 45 }],
      },
    ],
  });
  assert.equal(badCheck.ok, false);

  // PLAN-10: 22:30 + 90m ends cleanly at nextDay 00:00:00 (not 23:59:00), respects timezone param
  const ics = exportBlocksToICS(
    [
      {
        id: "blk-midnight",
        day: "2026-11-22",
        start: 1350, // 22:30
        minutes: 90, // ends 24:00 -> 2026-11-23 00:00
        title: "深夜复盘",
        kind: "生活",
      },
    ],
    "Asia/Singapore",
  );
  assert.ok(ics.includes("X-WR-TIMEZONE:Asia/Singapore"));
  assert.ok(ics.includes("DTSTART;TZID=Asia/Singapore:20261122T223000"));
  assert.ok(ics.includes("DTEND;TZID=Asia/Singapore:20261123T000000"));
});
