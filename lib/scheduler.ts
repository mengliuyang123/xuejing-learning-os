import {
  type Block,
  type Memory,
  type MemoryConstraint,
  type RescheduleChange,
  type RescheduleOption,
  type ScheduleSettings,
  type Store,
  DEFAULT_SCHEDULE_SETTINGS,
  dueReviews,
  findSlot,
  free,
  getActiveMemories,
  getAllLessons,
  getLessonById,
  offset,
  parseMemoryConstraint,
  time,
  today,
} from "./learning";

/**
 * Computes the earliest (day, start) allowed for a lesson block so it NEVER gets moved
 * ahead of any unmet prerequisite lesson's scheduled time (E2E-013 / SCHED-07).
 */
export function getEarliestPrereqFloor(
  s: Store,
  blocks: Block[],
  lessonId?: string,
): { minDay: string; minStart: number } | null {
  if (!lessonId) return null;
  const lesson = getLessonById(s, lessonId);
  if (!lesson || !lesson.requires.length) return null;

  // Transitive closure of unmet prerequisites
  const unmet = new Set<string>();
  const queue = [...lesson.requires];
  while (queue.length > 0) {
    const reqId = queue.shift()!;
    if (unmet.has(reqId)) continue;
    if ((s.mastery[reqId] ?? 0) >= 80) continue;
    unmet.add(reqId);
    const reqLesson = getLessonById(s, reqId);
    if (reqLesson) {
      for (const parent of reqLesson.requires) queue.push(parent);
    }
  }
  if (unmet.size === 0) return null;

  let floorDay = "";
  let floorEnd = 0;
  for (const b of blocks) {
    if (!b.lesson || !unmet.has(b.lesson) || b.done) continue;
    const end = b.start + b.minutes;
    if (!floorDay || b.day > floorDay || (b.day === floorDay && end > floorEnd)) {
      floorDay = b.day;
      floorEnd = end;
    }
  }
  return floorDay ? { minDay: floorDay, minStart: floorEnd } : null;
}

export function violatesPrereqOrder(
  s: Store,
  blocks: Block[],
  lessonId: string | undefined,
  candidateDay: string,
  candidateStart: number,
): boolean {
  const floor = getEarliestPrereqFloor(s, blocks, lessonId);
  if (!floor) return false;
  if (candidateDay < floor.minDay) return true;
  if (candidateDay === floor.minDay && candidateStart < floor.minStart) return true;
  return false;
}

export function validateRescheduleOption(
  s: Store,
  opt: RescheduleOption,
): { ok: boolean; reason?: string } {
  const changedIds = new Set(opt.changes.map((c) => c.blockId));
  const simulated: Block[] = s.blocks.filter((b) => !changedIds.has(b.id));
  if (opt.insertEvent) simulated.push(opt.insertEvent);

  for (const c of opt.changes) {
    for (const slot of c.newSlots) {
      simulated.push({
        id: `${c.blockId}-${slot.day}-${slot.start}`,
        title: slot.title || c.title,
        day: slot.day,
        start: slot.start,
        minutes: slot.minutes,
        kind: "学习",
        lesson: c.lesson,
      });
    }
  }

  for (const c of opt.changes) {
    if (!c.lesson) continue;
    for (const slot of c.newSlots) {
      if (violatesPrereqOrder(s, simulated, c.lesson, slot.day, slot.start)) {
        return {
          ok: false,
          reason: `无法将「${c.title}」提前至 ${slot.day} ${time(slot.start)}：其未完成的先修课程排期晚于该时段，违反知识依赖顺序。`,
        };
      }
    }
  }
  return { ok: true };
}

export function getWakingBounds(settings?: ScheduleSettings): {
  wakeStart: number;
  wakeEnd: number;
} {
  const s = settings || DEFAULT_SCHEDULE_SETTINGS;
  const wakeStart = Math.max(300, Math.min(720, s.sleepEnd));
  const wakeEnd = Math.max(wakeStart + 240, Math.min(1440, s.sleepStart));
  return { wakeStart, wakeEnd };
}

export function isLockedBlock(b: Block): boolean {
  return Boolean(b.locked || b.done || !b.lesson);
}

export function isWithinSleep(
  start: number,
  minutes: number,
  settings?: ScheduleSettings,
): boolean {
  const { wakeStart, wakeEnd } = getWakingBounds(settings);
  return start < wakeStart || start + minutes > wakeEnd;
}

export type FreeWindow = {
  day: string;
  start: number;
  end: number;
  minutes: number;
};

export type MergedPreferences = {
  preferredPeriod?: "morning" | "afternoon" | "evening";
  preferredStart?: number;
  preferredEnd?: number;
  maxSessionMinutes?: number;
  sourceMemoryIds: string[];
  summary: string;
};

/**
 * Extracts active scheduling constraints from the user's long-term memories.
 * Newer memories take precedence over older ones.
 */
export function extractMemoryPreferences(
  memories: Memory[],
  day = today(),
): MergedPreferences {
  let preferredPeriod: MemoryConstraint["preferredPeriod"];
  let preferredStart: number | undefined;
  let preferredEnd: number | undefined;
  let maxSessionMinutes: number | undefined;
  const sourceMemoryIds: string[] = [];

  for (const m of getActiveMemories(memories, day)) {
    if (m.category === "record") continue;
    const c = m.constraint || parseMemoryConstraint(m.text);
    if (!c) continue;
    let used = false;
    if (c.preferredPeriod && !preferredPeriod) {
      preferredPeriod = c.preferredPeriod;
      used = true;
    }
    if (c.preferredStart !== undefined && preferredStart === undefined) {
      preferredStart = c.preferredStart;
      used = true;
    }
    if (c.preferredEnd !== undefined && preferredEnd === undefined) {
      preferredEnd = c.preferredEnd;
      used = true;
    }
    if (c.maxSessionMinutes !== undefined && maxSessionMinutes === undefined) {
      maxSessionMinutes = c.maxSessionMinutes;
      used = true;
    }
    if (used) sourceMemoryIds.push(m.id);
  }

  const parts: string[] = [];
  if (preferredStart !== undefined && preferredEnd !== undefined) {
    parts.push(`偏好 ${time(preferredStart)}–${time(preferredEnd)}（硬截止 ${time(preferredEnd)}）`);
  } else if (preferredStart !== undefined) {
    parts.push(`偏好 ${time(preferredStart)} 后学习`);
  } else if (preferredPeriod) {
    parts.push(
      `偏好${{ morning: "上午", afternoon: "下午", evening: "晚间" }[preferredPeriod]}学习`,
    );
  }
  if (preferredStart === undefined && preferredEnd !== undefined) {
    parts.push(`硬截止 ${time(preferredEnd)}`);
  }
  if (maxSessionMinutes) {
    parts.push(`单次上限 ${maxSessionMinutes} 分钟`);
  }

  return {
    preferredPeriod,
    preferredStart,
    preferredEnd,
    maxSessionMinutes,
    sourceMemoryIds,
    summary: parts.length ? parts.join(" · ") : "未设置特殊时间约束",
  };
}

/**
 * Returns explicit free windows (>= minMinutes) within a day's waking window.
 */
export function findFreeWindows(
  blocks: Block[],
  day: string,
  dayStart = 480, // 08:00
  dayEnd = 1350, // 22:30
  minMinutes = 15,
  settings?: ScheduleSettings,
): FreeWindow[] {
  const waking = getWakingBounds(settings);
  const effStart = Math.max(dayStart, waking.wakeStart);
  const effEnd = Math.min(dayEnd, waking.wakeEnd);
  const sorted = blocks
    .filter((b) => b.day === day)
    .sort((a, b) => a.start - b.start);

  const windows: FreeWindow[] = [];
  let cursor = effStart;

  for (const b of sorted) {
    const bStart = Math.max(effStart, b.start);
    const bEnd = Math.min(effEnd, b.start + b.minutes);
    if (bStart - cursor >= minMinutes) {
      windows.push({
        day,
        start: cursor,
        end: bStart,
        minutes: bStart - cursor,
      });
    }
    cursor = Math.max(cursor, bEnd);
  }

  if (effEnd - cursor >= minMinutes) {
    windows.push({
      day,
      start: cursor,
      end: effEnd,
      minutes: effEnd - cursor,
    });
  }

  return windows;
}

function hasBufferAround(
  blocks: Block[],
  day: string,
  start: number,
  minutes: number,
  ignore: Set<string>,
  buffer = 15,
) {
  return blocks.every(
    (b) =>
      ignore.has(b.id) ||
      b.day !== day ||
      start + minutes + buffer <= b.start ||
      start >= b.start + b.minutes + buffer,
  );
}

function scoreSlot(
  day: string,
  baseDay: string,
  start: number,
  minutes: number,
  blocks: Block[],
  ignore: Set<string>,
  prefs: MergedPreferences,
): { score: number; tags: string[] } {
  let score = 78;
  const tags: string[] = [];

  if (day === baseDay) {
    score += 8;
    tags.push("今日完成");
  } else {
    tags.push("顺延次日");
  }

  if (prefs.preferredStart !== undefined) {
    const dist = Math.abs(start - prefs.preferredStart);
    if (start >= prefs.preferredStart && dist <= 90) {
      score += 12;
      tags.push("匹配偏好时段");
    } else if (dist <= 180) {
      score += 4;
    }
  } else if (prefs.preferredPeriod) {
    const match =
      (prefs.preferredPeriod === "morning" && start >= 480 && start < 720) ||
      (prefs.preferredPeriod === "afternoon" && start >= 810 && start < 1080) ||
      (prefs.preferredPeriod === "evening" && start >= 1140 && start <= 1320);
    if (match) {
      score += 10;
      tags.push("符合精力时段");
    }
  }

  if (hasBufferAround(blocks, day, start, minutes, ignore, 15)) {
    score += 6;
    tags.push("前后留有缓冲");
  }

  if (prefs.maxSessionMinutes && minutes > prefs.maxSessionMinutes) {
    score -= 10;
    tags.push(`略超单次上限(${prefs.maxSessionMinutes}m)`);
  }

  return { score: Math.min(99, Math.max(50, score)), tags };
}

export type RescheduleRequest = {
  blockId?: string;
  earliest?: number;
  insertEvent?: {
    title: string;
    day: string;
    start: number;
    minutes: number;
    kind: Block["kind"];
  };
};

/**
 * Generates 2-3 ranked, explainable reschedule options respecting calendar conflicts
 * and long-term memory constraints (including optional split-session strategy).
 */
export function generateRescheduleOptions(
  s: Store,
  day: string,
  req: RescheduleRequest = {},
): { options: RescheduleOption[]; targetTitle: string; reason: string } {
  const prefs = extractMemoryPreferences(s.memories);

  // Case A: Inserting a conflicting fixed event (e.g. "下午临时加会 1 小时")
  let insertedBlock: Block | undefined;
  let workingBlocks = [...s.blocks];
  let targets: Block[] = [];

  if (req.insertEvent) {
    insertedBlock = {
      id: "inserted-" + crypto.randomUUID().slice(0, 8),
      ...req.insertEvent,
    };
    const clashes = s.blocks.filter(
      (b) =>
        !b.done &&
        b.lesson &&
        !free([b], insertedBlock!.day, insertedBlock!.start, insertedBlock!.minutes),
    );
    workingBlocks = [
      ...s.blocks.filter((b) => !clashes.includes(b)),
      insertedBlock,
    ];
    targets = clashes;
  }

  if (!targets.length) {
    if (req.blockId) {
      const specific = s.blocks.find((b) => b.id === req.blockId && !b.done);
      if (!specific) {
        return {
          options: [],
          targetTitle: "未找到指定的待重排日程块",
          reason: `未找到未完成的日程块 blockId=${req.blockId}，已拒绝回退修改其他课程。`,
        };
      }
      targets = [specific];
    } else {
      const targetSearchDay = req.insertEvent?.day || day;
      const fallback = s.blocks
        .filter((b) => b.day >= targetSearchDay && !b.done && b.lesson)
        .sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start)[0];
      if (fallback) targets = [fallback];
    }
  }

  if (!targets.length) {
    return {
      options: [],
      targetTitle: "暂无待调整的学习日程",
      reason: "今天及未来日程中暂无未完成的学习任务。",
    };
  }

  const primary = targets[0];
  const ignore = new Set(targets.map((t) => t.id));
  const options: RescheduleOption[] = [];
  const seenKeys = new Set<string>();

  const waking = getWakingBounds(s.scheduleSettings);
  const endLimit = Math.min(waking.wakeEnd, prefs.preferredEnd ?? waking.wakeEnd);

  function tryBuildSingleOption(
    id: string,
    label: string,
    startDay: string,
    earliestStart: number,
    extraNote: string,
  ) {
    const tempBlocks = [...workingBlocks];
    const changes: RescheduleChange[] = [];
    let totalScore = 0;
    const tagSet = new Set<string>();

    for (const t of targets) {
      const floor = getEarliestPrereqFloor(s, tempBlocks, t.lesson);
      let effDay = startDay;
      let effStart = Math.max(waking.wakeStart, earliestStart);
      if (floor) {
        if (effDay < floor.minDay) {
          effDay = floor.minDay;
          effStart = Math.max(waking.wakeStart, floor.minStart);
        } else if (effDay === floor.minDay && effStart < floor.minStart) {
          effStart = floor.minStart;
        }
      }
      const slot = findSlot(
        tempBlocks,
        effDay,
        effStart,
        t.minutes,
        ignore,
        endLimit,
      );
      if (!slot) return;
      if (violatesPrereqOrder(s, tempBlocks, t.lesson, slot.day, slot.start)) {
        return;
      }
      const { score, tags } = scoreSlot(
        slot.day,
        day,
        slot.start,
        t.minutes,
        tempBlocks,
        ignore,
        prefs,
      );
      totalScore += score;
      tags.forEach((tg) => tagSet.add(tg));
      tempBlocks.push({ ...t, day: slot.day, start: slot.start });
      changes.push({
        blockId: t.id,
        title: t.title,
        lesson: t.lesson,
        oldDay: t.day,
        oldStart: t.start,
        oldMinutes: t.minutes,
        newSlots: [{ day: slot.day, start: slot.start, minutes: t.minutes }],
      });
    }

    const key = changes
      .map((c) => `${c.blockId}:${c.newSlots.map((n) => `${n.day}@${n.start}`).join(",")}`)
      .join("|");
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    options.push({
      id,
      label,
      summary: extraNote,
      score: Math.round(totalScore / targets.length),
      tags: [...tagSet].slice(0, 3),
      changes,
      insertEvent: insertedBlock,
    });
  }

  // Option 1: Requested time or preferred memory window today
  const requestedStart =
    req.earliest ??
    (insertedBlock
      ? insertedBlock.start + insertedBlock.minutes
      : prefs.preferredStart ?? Math.max(primary.start + 30, 900));

  tryBuildSingleOption(
    "opt-primary",
    req.earliest !== undefined ? "按指定时段顺延" : "记忆偏好优先方案",
    primary.day,
    requestedStart,
    req.earliest !== undefined
      ? `从 ${time(requestedStart)} 起寻找首个无冲突连续空档，完整保留 ${primary.minutes} 分钟。`
      : `优先贴合你的长期记忆（${prefs.summary}），避免打断工作与生活安排。`,
  );

  // Option 2: Preferred evening slot (if not already picked) or nearest afternoon slot
  const altStart =
    prefs.preferredStart !== undefined && Math.abs(prefs.preferredStart - requestedStart) > 60
      ? prefs.preferredStart
      : requestedStart < 1140
        ? 1170
        : 600;
  tryBuildSingleOption(
    "opt-alt-today",
    altStart >= 1140 ? "晚间专注时段" : "当日备选空档",
    primary.day,
    altStart,
    altStart >= 1140
      ? "改至晚间低干扰时段完成，白天保持工作节奏连贯。"
      : "选择当天另一段可用空档，尽量在今日闭环。",
  );

  // Option 3: Split-session strategy (great when primary >= 30m or exceeds maxSessionMinutes)
  const shouldOfferSplit =
    targets.length === 1 &&
    (primary.minutes >= 30 ||
      (prefs.maxSessionMinutes !== undefined &&
        primary.minutes > prefs.maxSessionMinutes));

  if (shouldOfferSplit) {
    const part1Min = prefs.maxSessionMinutes
      ? Math.min(prefs.maxSessionMinutes, Math.ceil(primary.minutes / 2))
      : Math.ceil(primary.minutes / 2);
    const part2Min = primary.minutes - part1Min;
    if (part1Min >= 15 && part2Min >= 10) {
      const slot1 = findSlot(
        workingBlocks,
        primary.day,
        Math.max(480, requestedStart),
        part1Min,
        ignore,
        1350,
      );
      if (slot1) {
        const withSlot1: Block[] = [
          ...workingBlocks,
          { ...primary, id: primary.id + "-p1", ...slot1, minutes: part1Min },
        ];
        const slot2 = findSlot(
          withSlot1,
          slot1.day,
          slot1.start + part1Min + 20,
          part2Min,
          ignore,
          1350,
        );
        if (slot2) {
          const splitKey = `${primary.id}:split:${slot1.day}@${slot1.start}+${slot2.day}@${slot2.start}`;
          if (!seenKeys.has(splitKey)) {
            seenKeys.add(splitKey);
            options.push({
              id: "opt-split",
              label: "拆分两段微学习",
              summary: `将 ${primary.minutes} 分钟拆分为 ${part1Min} 分钟（概念与示例）+ ${part2Min} 分钟（练习巩固），降低单次认知负荷。`,
              score:
                prefs.maxSessionMinutes && primary.minutes > prefs.maxSessionMinutes
                  ? 95
                  : 86,
              tags: ["拆分减负", "适配碎片空档", "符合记忆上限"].slice(
                0,
                prefs.maxSessionMinutes ? 3 : 2,
              ),
              changes: [
                {
                  blockId: primary.id,
                  title: primary.title,
                  lesson: primary.lesson,
                  oldDay: primary.day,
                  oldStart: primary.start,
                  oldMinutes: primary.minutes,
                  newSlots: [
                    {
                      day: slot1.day,
                      start: slot1.start,
                      minutes: part1Min,
                      title: `${primary.title}（上 · 概念）`,
                    },
                    {
                      day: slot2.day,
                      start: slot2.start,
                      minutes: part2Min,
                      title: `${primary.title}（下 · 练习）`,
                    },
                  ],
                },
              ],
              insertEvent: insertedBlock,
            });
          }
        }
      }
    }
  }

  // Option 4: Next morning fallback (if fewer than 3 options)
  if (options.length < 3) {
    tryBuildSingleOption(
      "opt-tomorrow",
      "移至次日上午",
      offset(primary.day, 1),
      540,
      "今天日程紧凑，顺延至明天上午精力充沛时段学习。",
    );
  }

  options.sort((a, b) => b.score - a.score);

  return {
    options: options.slice(0, 3),
    targetTitle: insertedBlock
      ? `为「${insertedBlock.title}」腾出时间并重排`
      : `重排「${primary.title}」`,
    reason: `已结合你的日历空档与长期记忆（${prefs.summary}），生成 ${Math.min(3, options.length)} 个无冲突候选方案。悬停卡片可在日历中实时预览。`,
  };
}

/**
 * Multi-day batch rescheduler: moves all unfinished learning/review blocks off
 * `blockedDays` (e.g. business trip / exam crunch) onto available days nearby.
 */
export function generateBatchRescheduleOptions(
  s: Store,
  baseDay: string,
  blockedDays: string[],
  reasonLabel = "出差/繁忙日避让",
): { options: RescheduleOption[]; targetTitle: string; reason: string } {
  const blockedSet = new Set(blockedDays);
  const prefs = extractMemoryPreferences(s.memories);

  const affected = s.blocks
    .filter((b) => !b.done && b.lesson && blockedSet.has(b.day))
    .sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start);

  if (!affected.length) {
    return {
      options: [],
      targetTitle: `${reasonLabel} · 无需批量移动`,
      reason: `所选日期（${blockedDays.map((d) => d.slice(5)).join("、")}）内没有待完成的学习任务。`,
    };
  }

  const ignore = new Set(affected.map((b) => b.id));
  const candidateDays = Array.from({ length: 10 }, (_, i) =>
    offset(baseDay, i),
  ).filter((d) => !blockedSet.has(d));

  function buildStrategy(
    id: string,
    label: string,
    summary: string,
    daysOrder: string[],
    preferredStart: number,
    spreadAcrossDays: boolean,
  ): RescheduleOption | null {
    const tempBlocks = s.blocks.filter((b) => !ignore.has(b.id));
    const changes: RescheduleChange[] = [];
    const usedDays = new Set<string>();

    for (const b of affected) {
      let chosen: { day: string; start: number } | null = null;
      const ordered = spreadAcrossDays
        ? [
            ...daysOrder.filter((d) => !usedDays.has(d)),
            ...daysOrder.filter((d) => usedDays.has(d)),
          ]
        : daysOrder;

      for (const d of ordered) {
        for (let m = preferredStart; m + b.minutes <= 1350; m += 10) {
          if (
            free(tempBlocks, d, m, b.minutes) &&
            !violatesPrereqOrder(s, tempBlocks, b.lesson, d, m)
          ) {
            chosen = { day: d, start: m };
            break;
          }
        }
        if (!chosen) {
          for (let m = 540; m + b.minutes <= 1350; m += 10) {
            if (
              free(tempBlocks, d, m, b.minutes) &&
              !violatesPrereqOrder(s, tempBlocks, b.lesson, d, m)
            ) {
              chosen = { day: d, start: m };
              break;
            }
          }
        }
        if (chosen) break;
      }
      if (!chosen) return null;
      usedDays.add(chosen.day);
      tempBlocks.push({ ...b, day: chosen.day, start: chosen.start });
      changes.push({
        blockId: b.id,
        title: b.title,
        lesson: b.lesson,
        oldDay: b.day,
        oldStart: b.start,
        oldMinutes: b.minutes,
        newSlots: [{ day: chosen.day, start: chosen.start, minutes: b.minutes }],
      });
    }

    return {
      id,
      label,
      summary,
      score: spreadAcrossDays ? 94 : 88,
      tags: spreadAcrossDays
        ? ["跨日均衡分散", "避开繁忙日", `共重排 ${affected.length} 项`]
        : ["尽早顺延补齐", "匹配偏好时段", `共重排 ${affected.length} 项`],
      changes,
    };
  }

  const prefStart = prefs.preferredStart ?? 1170;
  const afterBlocked = candidateDays.filter((d) => d > blockedDays.at(-1)!);
  const options: RescheduleOption[] = [];

  const optSpread = buildStrategy(
    "batch-spread",
    "跨日均衡分散方案",
    `将 ${affected.length} 项学习分散到非繁忙日，每天最多安排 1 项以防疲劳，并优先贴合 ${time(prefStart)} 后时段。`,
    [...afterBlocked, ...candidateDays.filter((d) => !afterBlocked.includes(d))],
    prefStart,
    true,
  );
  if (optSpread) options.push(optSpread);

  const optCompact = buildStrategy(
    "batch-compact",
    "回归后紧凑补齐",
    `集中安排在 ${afterBlocked[0]?.slice(5) || "次日"} 起最近可用空档，快速追上原定学习节奏。`,
    [...afterBlocked, ...candidateDays],
    540,
    false,
  );
  if (optCompact) options.push(optCompact);

  const optPreload = buildStrategy(
    "batch-today",
    "今日提前抢学",
    `优先将部分任务前移至今天（${baseDay.slice(5)}）空闲时段完成，减少返程后堆积压力。`,
    candidateDays,
    prefStart,
    false,
  );
  if (optPreload && optPreload.changes.some((c) => c.newSlots[0].day === baseDay)) {
    options.push(optPreload);
  }

  return {
    options: options.slice(0, 3),
    targetTitle: `${reasonLabel} · 批量重排 ${affected.length} 项学习`,
    reason: `已避开 ${blockedDays.map((d) => d.slice(5)).join("、")}，并结合长期记忆（${prefs.summary}）规划无冲突跨日方案。`,
  };
}

/**
 * Automatically schedules 15-minute micro-review sessions into conflict-free waking slots
 * for any ts-fsrs due reviews that do not yet have an upcoming review block.
 */
export function scheduleDueReviews(
  s: Store,
  day: string,
): { newBlocks: Block[]; skipped: string[] } {
  const due = dueReviews(s, day);
  const prefs = extractMemoryPreferences(s.memories);
  const waking = getWakingBounds(s.scheduleSettings);
  const endLimit = Math.min(waking.wakeEnd, prefs.preferredEnd ?? waking.wakeEnd);
  const preferredStart = Math.max(waking.wakeStart, prefs.preferredStart ?? 540);

  const existing = [...s.blocks];
  const newBlocks: Block[] = [];
  const skipped: string[] = [];

  for (const item of due) {
    const alreadyScheduled = existing.some(
      (b) =>
        !b.done &&
        b.day >= day &&
        b.lesson === item.lesson.id &&
        b.kind === "复习",
    );
    if (alreadyScheduled) continue;

    // Prefer user's preferred time window first, then any waking slot in next 3 days
    let slot = findSlot(existing, day, preferredStart, 15, undefined, endLimit);
    if (!slot) {
      slot = findSlot(existing, day, waking.wakeStart, 15, undefined, waking.wakeEnd);
    }
    if (!slot) {
      skipped.push(item.lesson.title);
      continue;
    }
    const block: Block = {
      id: `review-${item.lesson.id}-${slot.day}`,
      day: slot.day,
      start: slot.start,
      minutes: 15,
      title: `${item.lesson.title} · 间隔复习`,
      kind: "复习",
      lesson: item.lesson.id,
    };
    existing.push(block);
    newBlocks.push(block);
  }

  return { newBlocks, skipped };
}

/**
 * Scenario C Cascade: when a lesson needs remediation (e.g. consecutive failures),
 * pushes any scheduled downstream blocks that depend on `failedLessonId` to after `minAfterDay`
 * so the calendar never violates prerequisite order.
 */
export function postponeDependentBlocks(
  s: Store,
  failedLessonId: string,
  minAfterDay: string,
): { blocks: Block[]; movedTitles: string[] } {
  const allLessons = getAllLessons(s);
  // Collect all direct and transitive dependents of failedLessonId
  const dependents = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of allLessons) {
      if (dependents.has(l.id)) continue;
      if (
        l.requires.includes(failedLessonId) ||
        l.requires.some((r) => dependents.has(r))
      ) {
        dependents.add(l.id);
        changed = true;
      }
    }
  }

  if (!dependents.size) return { blocks: s.blocks, movedTitles: [] };

  const waking = getWakingBounds(s.scheduleSettings);
  const prefs = extractMemoryPreferences(s.memories);
  const startPref = Math.max(waking.wakeStart, prefs.preferredStart ?? 1140);
  const endLimit = Math.min(waking.wakeEnd, prefs.preferredEnd ?? waking.wakeEnd);

  let blocks = [...s.blocks];
  const movedTitles: string[] = [];

  const toMove = blocks
    .filter(
      (b) =>
        !b.done &&
        !b.locked &&
        b.lesson &&
        dependents.has(b.lesson) &&
        b.day <= minAfterDay,
    )
    .sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start);

  for (const b of toMove) {
    const slot = findSlot(
      blocks,
      offset(minAfterDay, 1),
      startPref,
      b.minutes,
      b.id,
      endLimit,
    );
    if (!slot) continue;
    blocks = blocks.map((x) => (x.id === b.id ? { ...x, ...slot } : x));
    movedTitles.push(`${b.title} → ${slot.day.slice(5)} ${time(slot.start)}`);
  }

  return { blocks, movedTitles };
}

export type FeasibilityReport = {
  feasible: boolean;
  horizonDays: number;
  availableMinutes: number;
  requiredMinutes: number;
  deficitMinutes: number;
  utilizationPct: number;
  summary: string;
  suggestions: Array<{
    id: "extend_deadline" | "protect_reviews_only" | "compress_micro";
    label: string;
    detail: string;
  }>;
};

/**
 * Exact 7-day Feasibility & Deficit Analyzer (Test 5: Infeasible Plan Report).
 * Respects sleep protection, locked blocks, and user time-window preferences.
 */
export function analyzeScheduleFeasibility(
  s: Store,
  day: string,
  horizonDays = 7,
): FeasibilityReport {
  const waking = getWakingBounds(s.scheduleSettings);
  const prefs = extractMemoryPreferences(s.memories);
  const winStart =
    prefs.preferredStart !== undefined
      ? Math.max(waking.wakeStart, prefs.preferredStart)
      : waking.wakeStart;
  const winEnd =
    prefs.preferredEnd !== undefined
      ? Math.min(waking.wakeEnd, prefs.preferredEnd)
      : waking.wakeEnd;

  // Fixed (non-learning or locked) blocks consume available time
  const fixedOnly = s.blocks.filter((b) => isLockedBlock(b));

  let availableMinutes = 0;
  for (let d = 0; d < horizonDays; d++) {
    const date = offset(day, d);
    const windows = findFreeWindows(
      fixedOnly,
      date,
      winStart,
      winEnd,
      15,
      s.scheduleSettings,
    );
    availableMinutes += windows.reduce((sum, w) => sum + w.minutes, 0);
  }

  // Required = unfinished learning/review blocks in horizon + unscheduled due reviews
  const scheduledRequired = s.blocks
    .filter(
      (b) =>
        !b.done &&
        Boolean(b.lesson) &&
        b.day >= day &&
        b.day < offset(day, horizonDays),
    )
    .reduce((sum, b) => sum + b.minutes, 0);

  const unscheduledReviews = dueReviews(s, day).filter(
    (r) =>
      !s.blocks.some(
        (b) => !b.done && b.day >= day && b.lesson === r.lesson.id && b.kind === "复习",
      ),
  ).length;

  const requiredMinutes = scheduledRequired + unscheduledReviews * 15;
  const deficitMinutes = Math.max(0, requiredMinutes - availableMinutes);
  const feasible = deficitMinutes === 0;
  const utilizationPct =
    availableMinutes > 0
      ? Math.min(200, Math.round((requiredMinutes / availableMinutes) * 100))
      : requiredMinutes > 0
        ? 200
        : 0;

  const availH = (availableMinutes / 60).toFixed(1);
  const reqH = (requiredMinutes / 60).toFixed(1);
  const defH = (deficitMinutes / 60).toFixed(1);

  const summary = feasible
    ? `未来 ${horizonDays} 天有效学习空档 ${availH} 小时，计划需 ${reqH} 小时（负荷 ${utilizationPct}%），全部硬约束可满足。`
    : `未来 ${horizonDays} 天仅剩 ${availH} 小时可用空档，但当前学习与复习共需 ${reqH} 小时（缺口 ${defH} 小时）。绝不侵占睡眠或固定日程，建议选择减负方案。`;

  return {
    feasible,
    horizonDays,
    availableMinutes,
    requiredMinutes,
    deficitMinutes,
    utilizationPct,
    summary,
    suggestions: feasible
      ? []
      : [
          {
            id: "extend_deadline",
            label: "延长计划周期 +7 天",
            detail: "将超出负荷的新课顺延至下周，保持原有深度不缩水。",
          },
          {
            id: "protect_reviews_only",
            label: "本周优先保复习，推迟新课",
            detail: "先守住 FSRS 到期复习防遗忘，把未开始的新课全部顺延。",
          },
          {
            id: "compress_micro",
            label: "切换 20 分钟微学习模式",
            detail: "将超长新课压缩为 20 分钟核心微单元，确保在当前空档内可完成。",
          },
        ],
  };
}

/**
 * Scenario B: Overtime Recalibration.
 * Updates personal paceFactor when actual duration exceeds planned duration,
 * scales remaining uncompleted sessions, and shifts overlapping blocks cleanly.
 */
export function recalibrateForOvertime(
  s: Store,
  lessonId: string,
  plannedMinutes: number,
  actualMinutes: number,
  day: string,
): {
  newPaceFactor: number;
  updatedBlocks: Block[];
  adjustedCount: number;
  summary: string;
} {
  const ratio = Math.min(2.0, Math.max(0.7, actualMinutes / Math.max(10, plannedMinutes)));
  const prevFactor = s.paceFactor ?? 1.0;
  const newPaceFactor = Number(
    Math.min(1.8, Math.max(0.8, prevFactor * 0.5 + ratio * 0.5)).toFixed(2),
  );

  const waking = getWakingBounds(s.scheduleSettings);
  const prefs = extractMemoryPreferences(s.memories);
  const endLimit = Math.min(waking.wakeEnd, prefs.preferredEnd ?? waking.wakeEnd);
  const cap = prefs.maxSessionMinutes ?? 90;

  let blocks = [...s.blocks];
  let adjustedCount = 0;

  const upcoming = blocks
    .filter(
      (b) =>
        !b.done &&
        !b.locked &&
        b.kind === "学习" &&
        b.lesson &&
        b.lesson !== lessonId &&
        b.day >= day,
    )
    .sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start);

  for (const b of upcoming) {
    const scaled = Math.min(
      cap,
      Math.max(15, Math.round((b.minutes * ratio) / 5) * 5),
    );
    if (scaled === b.minutes) continue;
    const fitsInPlace =
      !isWithinSleep(b.start, scaled, s.scheduleSettings) &&
      b.start + scaled <= endLimit &&
      free(blocks, b.day, b.start, scaled, b.id);

    if (fitsInPlace) {
      blocks = blocks.map((x) => (x.id === b.id ? { ...x, minutes: scaled } : x));
      adjustedCount++;
    } else {
      const nextSlot = findSlot(blocks, b.day, b.start, scaled, b.id, endLimit);
      if (nextSlot) {
        blocks = blocks.map((x) =>
          x.id === b.id ? { ...x, ...nextSlot, minutes: scaled } : x,
        );
        adjustedCount++;
      }
    }
  }

  return {
    newPaceFactor,
    updatedBlocks: blocks,
    adjustedCount,
    summary:
      actualMinutes > plannedMinutes * 1.25
        ? `本节实际耗时 ${actualMinutes} 分钟（原估 ${plannedMinutes} 分钟），已将个人节奏系数校准为 ${newPaceFactor}x，并自动重估调整后续 ${adjustedCount} 节未完成课程。`
        : `已记录实际学习时长 ${actualMinutes} 分钟，当前节奏系数 ${newPaceFactor}x。`,
  };
}
