import {
  type Block,
  type Lesson,
  type Store,
  available,
  dueReviews,
  focusLesson,
  getActiveTrack,
  getAllLessons,
  getMissedSessions,
  getTrackForLesson,
  time,
} from "./learning";
import { analyzeScheduleFeasibility, findFreeWindows } from "./scheduler";

export type LearningActivityType =
  | "new_lesson"
  | "review"
  | "practice"
  | "assessment"
  | "remediation";

export interface LearningActivity {
  id: string;
  conceptId: string;
  title: string;
  trackId: string;
  trackTitle: string;
  type: LearningActivityType;
  estimatedMinutes: number;
  priority: number; // 0..100 higher is more urgent
  prerequisiteConceptIds: string[];
  prerequisitesMet: boolean;
  mastery: number;
  retrievability?: number;
  earliestStart?: string;
  deadline?: string;
  scheduledBlock?: {
    blockId: string;
    day: string;
    start: number;
    minutes: number;
  };
  splittable: boolean;
  status: "candidate" | "scheduled" | "done";
  reason: string;
}

export type DomainEventType =
  | "GoalCreated"
  | "AssessmentCompleted"
  | "RemediationTriggered"
  | "CalendarChanged"
  | "PlanVersionCreated"
  | "MemoryUpdated"
  | "ReviewCompleted";

export type DomainEventRecord = {
  eventId: string;
  eventType: DomainEventType;
  entityType: string;
  entityId: string;
  summary: string;
  payload: Record<string, unknown>;
  runId?: string | null;
  createdAt: string;
};

export type TodayProactiveSuggestion = {
  kind: "conflict" | "missed" | "review" | "ready" | "empty";
  title: string;
  detail: string;
  ctaLabel: string;
  targetTab: "calendar" | "study" | "graph" | "audit";
  targetLessonId?: string;
};

export type CrossTrackDueReviewGroup = {
  trackId: string;
  trackTitle: string;
  dueCount: number;
  lowestRetrievability: number;
  items: Array<{
    lessonId: string;
    lessonTitle: string;
    retrievability: number;
    estimatedMinutes: number;
  }>;
};

export type TodayConflictPair = {
  blockA: Block;
  blockB: Block;
};

export type TodayWorkbenchSnapshot = {
  todayMinutes: number;
  completedMinutes: number;
  dueReviewCount: number;
  goalProgressPct: number;
  masteredUnits: number;
  totalUnits: number;
  activeTrackId: string | null;
  activeTrackTitle: string | null;
  nextBestAction: LearningActivity | null;
  candidates: LearningActivity[];
  crossTrackDueReviews: CrossTrackDueReviewGroup[];
  todayConflicts: TodayConflictPair[];
  freeMinutesToday: number;
  todayBlocks: Block[];
  suggestion: TodayProactiveSuggestion;
};

function findUpcomingBlockForLesson(
  blocks: Block[],
  lessonId: string,
  day: string,
  kindFilter?: Block["kind"],
): Block | undefined {
  return blocks
    .filter(
      (b) =>
        b.lesson === lessonId &&
        !b.done &&
        b.day >= day &&
        (!kindFilter || b.kind === kindFilter),
    )
    .sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start)[0];
}

export function detectDayConflicts(blocks: Block[], day: string): TodayConflictPair[] {
  const dayBlocks = blocks
    .filter((b) => b.day === day)
    .sort((a, b) => a.start - b.start);
  const pairs: TodayConflictPair[] = [];
  for (let i = 0; i < dayBlocks.length; i++) {
    for (let j = i + 1; j < dayBlocks.length; j++) {
      const a = dayBlocks[i];
      const b = dayBlocks[j];
      if (a.start < b.start + b.minutes && b.start < a.start + a.minutes) {
        pairs.push({ blockA: a, blockB: b });
      }
    }
  }
  return pairs;
}

/**
 * Deterministic Domain Engine: generates ranked candidate LearningActivity items
 * from the Knowledge DAG, Learner Model (BKT mastery + lapses), FSRS Review Scheduler,
 * and current Calendar Blocks.
 *
 * - FSRS-15: Due reviews check only upcoming '复习' blocks so a future normal '学习' block never hides a due review.
 * - SCHED-07/09: Locked downstream lessons (prerequisitesMet === false) are never offered as remediation targets.
 * - TODAY-16: Optional trackId scope lets Today focus primary recommendations on the selected track while
 *   archived tracks are automatically excluded via getAllLessons(store).
 */
export function generateCandidateActivities(
  store: Store,
  day: string,
  opts: { trackId?: string } = {},
): LearningActivity[] {
  const activities: LearningActivity[] = [];
  const allLessons = getAllLessons(store); // excludes archived tracks by default
  const dueList = dueReviews(store, day);
  const dueMap = new Map(dueList.map((d) => [d.lesson.id, d]));

  for (const lesson of allLessons) {
    const track = getTrackForLesson(store, lesson.id);
    if (track?.archived) continue;
    const trackId = track?.id || "default";
    if (opts.trackId && trackId !== opts.trackId) continue;
    const trackTitle = track?.title || "学习轨道";
    const mastery = store.mastery[lesson.id] ?? 0;
    const meta = store.masteryMeta?.[lesson.id];
    const prereqsMet = available(store, lesson);
    const upcomingStudy = findUpcomingBlockForLesson(
      store.blocks,
      lesson.id,
      day,
    );
    const upcomingReview = findUpcomingBlockForLesson(
      store.blocks,
      lesson.id,
      day,
      "复习",
    );

    const toScheduled = (blk?: Block) =>
      blk
        ? {
            blockId: blk.id,
            day: blk.day,
            start: blk.start,
            minutes: blk.minutes,
          }
        : undefined;

    const scheduledStudyInfo = toScheduled(upcomingStudy);
    const scheduledReviewInfo = toScheduled(upcomingReview);

    // 1. Remediation activity if consecutive failures >= 2 AND prerequisites are satisfied (SCHED-07/09)
    if ((meta?.consecutiveFailures ?? 0) >= 2 && mastery < 80 && prereqsMet) {
      activities.push({
        id: `act-rem-${lesson.id}`,
        conceptId: lesson.id,
        title: `${lesson.title} · 降难补救微课`,
        trackId,
        trackTitle,
        type: "remediation",
        estimatedMinutes: 20,
        priority: 96,
        prerequisiteConceptIds: lesson.requires,
        prerequisitesMet: true,
        mastery,
        scheduledBlock: scheduledReviewInfo,
        splittable: false,
        status: scheduledReviewInfo ? "scheduled" : "candidate",
        reason: `连续 ${meta?.consecutiveFailures} 次卡壳，建议先用 20 分钟直观类比与填空题补牢前置理解`,
      });
      continue;
    }

    // 2. Due FSRS review activity (FSRS-15: only marked scheduled if an upcoming '复习' block exists)
    const dueItem = dueMap.get(lesson.id);
    if (dueItem) {
      activities.push({
        id: `act-rev-${lesson.id}`,
        conceptId: lesson.id,
        title: `${lesson.title} · 主动回忆复习`,
        trackId,
        trackTitle,
        type: "review",
        estimatedMinutes: 15,
        priority: Math.min(94, 78 + Math.round((100 - dueItem.retrievability) / 3)),
        prerequisiteConceptIds: lesson.requires,
        prerequisitesMet: true,
        mastery,
        retrievability: dueItem.retrievability,
        scheduledBlock: scheduledReviewInfo,
        splittable: false,
        status: scheduledReviewInfo ? "scheduled" : "candidate",
        reason: `FSRS 记忆保持率降至 ${dueItem.retrievability}%，15 分钟主动回忆即可显著延长稳定期`,
      });
      continue;
    }

    // 3. Already mastered -> done (skip unless due)
    if (mastery >= 80) {
      continue;
    }

    // 4. Unlocked in-progress practice/assessment (mastery 35..79)
    if (prereqsMet && mastery >= 35) {
      const isActiveTrack = trackId === store.activeTrackId;
      activities.push({
        id: `act-prac-${lesson.id}`,
        conceptId: lesson.id,
        title: lesson.title,
        trackId,
        trackTitle,
        type: mastery >= 60 ? "assessment" : "practice",
        estimatedMinutes: Math.min(35, Math.max(20, Math.round(lesson.minutes * 0.7))),
        priority: (isActiveTrack ? 86 : 70) + (upcomingStudy?.day === day ? 6 : 0),
        prerequisiteConceptIds: lesson.requires,
        prerequisitesMet: true,
        mastery,
        scheduledBlock: scheduledStudyInfo,
        splittable: lesson.minutes >= 45,
        status: scheduledStudyInfo ? "scheduled" : "candidate",
        reason: `当前掌握度 ${mastery}%，距离解锁下游节点（80%）仅差 ${80 - mastery}%`,
      });
      continue;
    }

    // 5. Unlocked new lesson (mastery < 35)
    if (prereqsMet) {
      const isActiveTrack = trackId === store.activeTrackId;
      activities.push({
        id: `act-new-${lesson.id}`,
        conceptId: lesson.id,
        title: lesson.title,
        trackId,
        trackTitle,
        type: "new_lesson",
        estimatedMinutes: lesson.minutes,
        priority: (isActiveTrack ? 82 : 64) + (upcomingStudy?.day === day ? 8 : 0),
        prerequisiteConceptIds: lesson.requires,
        prerequisitesMet: true,
        mastery,
        scheduledBlock: scheduledStudyInfo,
        splittable: lesson.minutes >= 45,
        status: scheduledStudyInfo ? "scheduled" : "candidate",
        reason:
          lesson.requires.length > 0
            ? "先修条件已满足，可开始新课学习与互动练习"
            : "起始核心节点，适合开启本轨道学习",
      });
    }
  }

  return activities.sort((a, b) => b.priority - a.priority);
}

/**
 * Joint Time + Content Activity Selector (E2E-015 / TODAY-13):
 * Strictly respects the available time budget — never silently recommends a 20m unsplittable
 * activity inside a 15m window. Splittable lessons are explicitly sliced down to fit the budget.
 */
export function selectActivitiesForTimeBudget(
  candidates: LearningActivity[],
  availableMinutes: number,
  energy: "high" | "medium" | "low" = "medium",
): LearningActivity[] {
  const scored = candidates
    .filter((c) => c.prerequisitesMet)
    .map((c) => {
      let fitScore = c.priority;
      if (c.estimatedMinutes <= availableMinutes) {
        fitScore += 20;
      } else if (c.splittable && availableMinutes >= 15) {
        fitScore += 4;
      } else {
        fitScore -= 60;
      }

      if (availableMinutes <= 20) {
        if (c.type === "review") fitScore += 18;
        if (c.type === "remediation" && c.estimatedMinutes <= availableMinutes) {
          fitScore += 18;
        }
      } else if (availableMinutes <= 35) {
        if (c.type === "practice" || c.type === "assessment" || c.estimatedMinutes <= 35) {
          fitScore += 12;
        }
      } else if (availableMinutes >= 50) {
        if (c.type === "new_lesson" || c.type === "practice") fitScore += 10;
      }

      if (energy === "low") {
        if (c.type === "review" || c.type === "remediation") fitScore += 15;
        if (c.type === "new_lesson" && c.estimatedMinutes >= 45) fitScore -= 12;
      }

      return { activity: c, fitScore };
    })
    .sort((a, b) => b.fitScore - a.fitScore);

  const selected: LearningActivity[] = [];
  let remaining = availableMinutes;
  for (const item of scored) {
    if (item.activity.estimatedMinutes <= remaining) {
      selected.push(item.activity);
      remaining -= item.activity.estimatedMinutes;
      if (remaining < 15 || selected.length >= 3) break;
    } else if (
      selected.length === 0 &&
      item.activity.splittable &&
      remaining >= 15
    ) {
      // Explicitly slice splittable lesson to fit exact time budget
      selected.push({
        ...item.activity,
        id: `${item.activity.id}-slice-${remaining}m`,
        title: `${item.activity.title}（${remaining} 分钟微学习片段）`,
        estimatedMinutes: remaining,
        reason: `已按你的 ${remaining} 分钟空闲窗口拆分为首段微学习，避免超时。`,
      });
      remaining = 0;
      break;
    }
  }

  return selected;
}

/**
 * Computes the complete Today Execution Workbench snapshot directly from Domain State
 * (zero dependence on chat history!).
 */
export function buildTodaySnapshot(
  store: Store,
  day: string,
): TodayWorkbenchSnapshot {
  const activeTrack = getActiveTrack(store);
  const allLessons = getAllLessons(store);
  const trackUnits = activeTrack ? activeTrack.units : allLessons;
  const masteredUnits = trackUnits.filter(
    (u) => (store.mastery[u.id] ?? 0) >= 80,
  ).length;
  const totalUnits = trackUnits.length;
  const goalProgressPct =
    totalUnits > 0 ? Math.round((masteredUnits / totalUnits) * 100) : 0;

  const todayBlocks = store.blocks
    .filter((b) => b.day === day)
    .sort((a, b) => a.start - b.start);
  const todayConflicts = detectDayConflicts(store.blocks, day);
  const todayLearningBlocks = todayBlocks.filter(
    (b) => b.kind === "学习" || b.kind === "复习",
  );
  const todayMinutes = todayLearningBlocks.reduce(
    (sum, b) => sum + b.minutes,
    0,
  );
  const completedMinutes = todayLearningBlocks
    .filter((b) => b.done)
    .reduce((sum, b) => sum + b.minutes, 0);

  // Active (non-archived) due reviews split by active track vs other active tracks (TODAY-16)
  const allActiveReviews = dueReviews(store, day).filter((r) => {
    const tr = getTrackForLesson(store, r.lesson.id);
    return !tr?.archived;
  });
  const activeTrackReviews = activeTrack
    ? allActiveReviews.filter((r) =>
        activeTrack.units.some((u) => u.id === r.lesson.id),
      )
    : allActiveReviews;

  const crossTrackGroupMap = new Map<string, CrossTrackDueReviewGroup>();
  if (activeTrack) {
    for (const r of allActiveReviews) {
      const tr = getTrackForLesson(store, r.lesson.id);
      if (!tr || tr.archived || tr.id === activeTrack.id) continue;
      const existing = crossTrackGroupMap.get(tr.id);
      const item = {
        lessonId: r.lesson.id,
        lessonTitle: r.lesson.title,
        retrievability: r.retrievability,
        estimatedMinutes: 15,
      };
      if (existing) {
        existing.dueCount += 1;
        existing.lowestRetrievability = Math.min(
          existing.lowestRetrievability,
          r.retrievability,
        );
        existing.items.push(item);
      } else {
        crossTrackGroupMap.set(tr.id, {
          trackId: tr.id,
          trackTitle: tr.title,
          dueCount: 1,
          lowestRetrievability: r.retrievability,
          items: [item],
        });
      }
    }
  }
  const crossTrackDueReviews = [...crossTrackGroupMap.values()];

  // Scope primary Today recommendations strictly to activeTrack (TODAY-16)
  const candidates = generateCandidateActivities(store, day, {
    trackId: activeTrack?.id,
  });
  const freeWindows = findFreeWindows(
    store.blocks,
    day,
    480,
    1380,
    15,
    store.scheduleSettings,
  );
  const freeMinutesToday = freeWindows.reduce((sum, w) => sum + w.minutes, 0);

  // Pick next best action strictly from current active track
  let nextBestAction: LearningActivity | null = candidates[0] || null;
  if (!nextBestAction && activeTrack) {
    const focus = focusLesson(store, activeTrack.id);
    if (focus) {
      nextBestAction = {
        id: `act-focus-${focus.id}`,
        conceptId: focus.id,
        title: focus.title,
        trackId: activeTrack.id,
        trackTitle: activeTrack.title,
        type: "new_lesson",
        estimatedMinutes: focus.minutes,
        priority: 80,
        prerequisiteConceptIds: focus.requires,
        prerequisitesMet: available(store, focus),
        mastery: store.mastery[focus.id] ?? 0,
        splittable: focus.minutes >= 45,
        status: "candidate",
        reason: "当前活跃学习轨道推荐下一课",
      };
    }
  }

  // Deterministic proactive suggestion (strictly grounded in real domain state)
  const missed = getMissedSessions(store, day);
  const feasibility = analyzeScheduleFeasibility(store, day, 7);

  let suggestion: TodayProactiveSuggestion;
  if (totalUnits === 0 && store.blocks.length === 0) {
    suggestion = {
      kind: "empty",
      title: "还没有设定学习目标",
      detail:
        "告诉 Agent 你想掌握的技能和每天可用时间，系统会自动构建知识图谱先修路径并为你排入无冲突日程。",
      ctaLabel: "设定第一个学习目标",
      targetTab: "study",
    };
  } else if (todayConflicts.length > 0) {
    const first = todayConflicts[0];
    suggestion = {
      kind: "conflict",
      title: `今日存在 ${todayConflicts.length} 处日程时间冲突`,
      detail: `「${first.blockA.title}」（${time(first.blockA.start)}–${time(first.blockA.start + first.blockA.minutes)}）与「${first.blockB.title}」（${time(first.blockB.start)}–${time(first.blockB.start + first.blockB.minutes)}）时间重叠，建议前往 Planner 调整或生成重排方案。`,
      ctaLabel: "去 Planner 解决冲突",
      targetTab: "calendar",
    };
  } else if (missed.length > 0) {
    suggestion = {
      kind: "missed",
      title: `检测到 ${missed.length} 节前期未完成课程`,
      detail: `「${missed[0].title}」尚未完成。建议在时间规划页一键重排或压缩为 15 分钟微复习，避免积压。`,
      ctaLabel: "去时间规划重排",
      targetTab: "calendar",
    };
  } else if (!feasibility.feasible) {
    suggestion = {
      kind: "conflict",
      title: "未来 7 天学习负荷偏高",
      detail: feasibility.summary,
      ctaLabel: "查看可行性与重排方案",
      targetTab: "calendar",
    };
  } else if (activeTrackReviews.length > 0) {
    suggestion = {
      kind: "review",
      title: `${activeTrackReviews.length} 个知识点已进入 FSRS 最佳复习窗口`,
      detail: `「${activeTrackReviews[0].lesson.title}」当前记忆保持率 ${activeTrackReviews[0].retrievability}%，建议优先用 15 分钟完成主动回忆巩固。`,
      ctaLabel: "立即开始复习",
      targetTab: "study",
      targetLessonId: activeTrackReviews[0].lesson.id,
    };
  } else {
    const nextSlot = todayLearningBlocks.find((b) => !b.done);
    suggestion = {
      kind: "ready",
      title: "当前学习与时间计划运行顺畅",
      detail: nextSlot
        ? `今日下一项安排：${time(nextSlot.start)}–${time(nextSlot.start + nextSlot.minutes)}「${nextSlot.title}」，所有约束均已验证无冲突。`
        : "本周计划无时间冲突，可随时查看计划变更 Diff 或推进下一节课程。",
      ctaLabel: "查看计划变更 Diff",
      targetTab: "audit",
    };
  }

  return {
    todayMinutes,
    completedMinutes,
    dueReviewCount: activeTrackReviews.length,
    goalProgressPct,
    masteredUnits,
    totalUnits,
    activeTrackId: activeTrack?.id || null,
    activeTrackTitle: activeTrack?.title || null,
    nextBestAction,
    candidates,
    crossTrackDueReviews,
    todayConflicts,
    freeMinutesToday,
    todayBlocks,
    suggestion,
  };
}
