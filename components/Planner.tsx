"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  BriefcaseBusiness,
  Check,
  ChevronLeft,
  ChevronRight,
  Coffee,
  Columns3,
  Download,
  GripVertical,
  List,
  LockKeyhole,
  Moon,
  Plus,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import {
  type Block,
  type Store,
  DEFAULT_SCHEDULE_SETTINGS,
  dateLabel,
  findSlot,
  free,
  isRemedialBlock,
  offset,
  time,
} from "../lib/learning";
import {
  getWakingBounds,
  isLockedBlock,
  isWithinSleep,
} from "../lib/scheduler";
import {
  type LearningActivity,
  generateCandidateActivities,
} from "../lib/domain-activities";
import { exportBlocksToICS } from "../lib/ics";
import { SPRING_CRISP, TRANSITION_FAST, TRANSITION_STATE } from "../lib/motion";
import { useLearningStore } from "./LearningStore";

export const kindIcons = {
  学习: BookOpen,
  复习: RotateCcw,
  生活: Coffee,
  工作: BriefcaseBusiness,
};

export const kindColors = {
  学习: "blue",
  复习: "mint",
  生活: "amber",
  工作: "purple",
};

const WEEKDAY_SHORT = ["一", "二", "三", "四", "五", "六", "日"];
const DRAG_ACTIVITY_MIME = "application/x-learnos-activity";

type PositionedBlock = {
  block: Block;
  col: number;
  totalCols: number;
  hasOverlap: boolean;
};

/**
 * Deterministic side-by-side column assignment for overlapping blocks on a single day.
 */
function layoutDayBlocks(blocks: Block[]): PositionedBlock[] {
  const sorted = [...blocks].sort(
    (a, b) => a.start - b.start || b.minutes - a.minutes,
  );
  const clusters: Block[][] = [];
  let currentCluster: Block[] = [];
  let clusterEnd = -1;

  for (const b of sorted) {
    const end = b.start + Math.max(15, b.minutes);
    if (currentCluster.length === 0 || b.start < clusterEnd) {
      currentCluster.push(b);
      clusterEnd = Math.max(clusterEnd, end);
    } else {
      clusters.push(currentCluster);
      currentCluster = [b];
      clusterEnd = end;
    }
  }
  if (currentCluster.length > 0) clusters.push(currentCluster);

  const out: PositionedBlock[] = [];
  for (const cluster of clusters) {
    const colEnds: number[] = [];
    const assignments: Array<{ block: Block; col: number }> = [];
    for (const b of cluster) {
      let col = colEnds.findIndex((end) => end <= b.start);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(b.start + Math.max(15, b.minutes));
      } else {
        colEnds[col] = b.start + Math.max(15, b.minutes);
      }
      assignments.push({ block: b, col });
    }
    const totalCols = Math.max(1, colEnds.length);
    for (const item of assignments) {
      out.push({
        block: item.block,
        col: item.col,
        totalCols,
        hasOverlap: totalCols > 1,
      });
    }
  }
  return out;
}

function getCurrentMinutesLocal(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function blockToneClass(kind: Block["kind"]): string {
  switch (kind) {
    case "学习":
      return "cal-tone-study";
    case "复习":
      return "cal-tone-review";
    case "工作":
      return "cal-tone-work";
    default:
      return "cal-tone-life";
  }
}

/**
 * Right-rail companion backlog for unscheduled candidate learning activities.
 * Supports one-click scheduling or dragging directly onto the Time-Axis Calendar.
 */
export function CalendarBacklogPanel() {
  const { s, now, day, showToast, saveStoreState } = useLearningStore();
  const sleepCfg = s.scheduleSettings || DEFAULT_SCHEDULE_SETTINGS;

  const candidates = useMemo(
    () =>
      generateCandidateActivities(s, now).filter(
        (a) => a.status === "candidate",
      ),
    [s, now],
  );

  function scheduleCandidate(activity: LearningActivity) {
    const waking = getWakingBounds(sleepCfg);
    const kind: Block["kind"] =
      activity.type === "review" || activity.type === "remediation"
        ? "复习"
        : "学习";
    const startDay = day || now;
    const slot =
      findSlot(
        s.blocks,
        startDay,
        Math.max(waking.wakeStart, 1140),
        activity.estimatedMinutes,
        undefined,
        waking.wakeEnd,
      ) ||
      findSlot(
        s.blocks,
        startDay,
        waking.wakeStart,
        activity.estimatedMinutes,
        undefined,
        waking.wakeEnd,
      );

    if (!slot) {
      showToast("未来 7 天均无满足睡眠红线的空档，请先清理部分日程。");
      return;
    }

    const newBlock: Block = {
      id: `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: activity.title,
      kind,
      day: slot.day,
      start: slot.start,
      minutes: activity.estimatedMinutes,
      lesson: activity.conceptId,
    };

    saveStoreState(
      { ...s, blocks: [...s.blocks, newBlock] },
      slot.day,
      `已排入「${activity.title}」至 ${slot.day.slice(5)} ${time(slot.start)}`,
    );
  }

  function autoScheduleBatch() {
    if (!candidates.length) return;
    const waking = getWakingBounds(sleepCfg);
    const nextBlocks = [...s.blocks];
    let added = 0;
    for (const act of candidates.slice(0, 5)) {
      const slot = findSlot(
        nextBlocks,
        day || now,
        Math.max(waking.wakeStart, 1140),
        act.estimatedMinutes,
        undefined,
        waking.wakeEnd,
      );
      if (!slot) continue;
      nextBlocks.push({
        id: `auto-${Date.now().toString(36)}-${added}`,
        title: act.title,
        kind:
          act.type === "review" || act.type === "remediation" ? "复习" : "学习",
        day: slot.day,
        start: slot.start,
        minutes: act.estimatedMinutes,
        lesson: act.conceptId,
      });
      added += 1;
    }
    if (added > 0) {
      saveStoreState(
        { ...s, blocks: nextBlocks },
        day || now,
        `已自动将 ${added} 项待排活动安排进无冲突空档。`,
      );
    } else {
      showToast("近期空闲窗口不足，暂无法自动排入更多活动。");
    }
  }

  return (
    <section className="wb-work-panel" aria-labelledby="wb-backlog-heading">
      <header className="wb-panel-heading cal-panel-head-row">
        <h2 id="wb-backlog-heading">
          待排期活动 <span>{candidates.length}</span>
        </h2>
        {candidates.length > 0 && (
          <button
            type="button"
            className="wb-button wb-subtle-action cal-mini-btn"
            onClick={autoScheduleBatch}
          >
            自动排入
          </button>
        )}
      </header>

      {candidates.length === 0 ? (
        <p className="wb-panel-empty">
          当前没有待排期的学习活动。创建新轨道或出现待复习节点后会自动汇集于此。
        </p>
      ) : (
        <ul className="cal-backlog-list">
          <AnimatePresence initial={false} mode="popLayout">
            {candidates.slice(0, 7).map((act) => (
              <motion.li
                key={act.id}
                layout
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={TRANSITION_FAST}
                draggable
                onDragStart={(e) => {
                  const dt = (
                    e as unknown as React.DragEvent<HTMLLIElement>
                  ).dataTransfer;
                  if (dt) {
                    dt.setData(DRAG_ACTIVITY_MIME, JSON.stringify(act));
                    dt.effectAllowed = "copyMove";
                  }
                }}
                className="cal-backlog-item"
              >
                <div className="cal-backlog-main">
                  <GripVertical
                    size={12}
                    className="cal-backlog-grip"
                    aria-hidden="true"
                  />
                  <div className="cal-backlog-copy">
                    <strong>{act.title}</strong>
                    <small>
                      {act.estimatedMinutes} 分钟 ·{" "}
                      {act.type === "review"
                        ? "复习"
                        : act.type === "remediation"
                          ? "巩固"
                          : "新课"}
                    </small>
                  </div>
                </div>
                <button
                  type="button"
                  className="wb-icon cal-backlog-add"
                  title="排入最近无冲突空档"
                  aria-label={`排入 ${act.title}`}
                  onClick={() => scheduleCandidate(act)}
                >
                  <Plus size={13} aria-hidden="true" />
                </button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}

export function Agenda({
  s,
  day,
  setDay,
  now,
  onBlock,
  onAdd,
  onAskSchedule,
  large = false,
}: {
  s: Store;
  day: string;
  setDay: (day: string) => void;
  now: string;
  onBlock: (b: Block) => void;
  onAdd: (prefillStart?: number) => void;
  onAskSchedule?: () => void;
  large?: boolean;
}) {
  const {
    previewOption,
    showToast,
    updateScheduleSettings,
    recentScheduleHighlight,
    clearScheduleHighlight,
    moveBlockToSlot,
    toggleBlockDone,
    saveStoreState,
    setWorkspaceTab,
    calendarViewMode: viewMode,
    setCalendarViewMode: setViewMode,
  } = useLearningStore();

  const instanceId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editSleep, setEditSleep] = useState(false);
  const [nowMinutes, setNowMinutes] = useState<number>(getCurrentMinutesLocal);

  const sleepCfg = s.scheduleSettings || DEFAULT_SCHEDULE_SETTINGS;
  const [sleepStartVal, setSleepStartVal] = useState(time(sleepCfg.sleepStart));
  const [sleepEndVal, setSleepEndVal] = useState(time(sleepCfg.sleepEnd));

  // Keep current-time hairline accurate every minute
  useEffect(() => {
    const id = window.setInterval(
      () => setNowMinutes(getCurrentMinutesLocal()),
      60_000,
    );
    return () => window.clearInterval(id);
  }, []);

  // Drag & Drop state (supports both existing Blocks and dragged Candidate Activities)
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragHover, setDragHover] = useState<{
    day: string;
    start: number;
  } | null>(null);

  const draggingBlock = useMemo<Block | null>(
    () => (draggingId ? s.blocks.find((b) => b.id === draggingId) || null : null),
    [draggingId, s.blocks],
  );

  const weekday = (new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7;
  const week = useMemo(
    () => Array.from({ length: 7 }, (_, i) => offset(day, i - weekday)),
    [day, weekday],
  );

  const dayBlocks = useMemo(
    () => s.blocks.filter((b) => b.day === day).sort((a, b) => a.start - b.start),
    [s.blocks, day],
  );

  // Determine vertical hour range (default 07:00 – 23:00; expands cleanly if early/late events exist)
  const visibleDays = viewMode === "week" ? week : [day];
  const { startHour, endHour } = useMemo(() => {
    let minH = 7;
    let maxH = 23;
    for (const b of s.blocks) {
      if (!visibleDays.includes(b.day)) continue;
      minH = Math.min(minH, Math.floor(b.start / 60));
      maxH = Math.max(maxH, Math.ceil((b.start + b.minutes) / 60));
    }
    return {
      startHour: Math.max(0, minH),
      endHour: Math.min(24, Math.max(23, maxH)),
    };
  }, [s.blocks, visibleDays]);

  const hours = useMemo(
    () =>
      Array.from(
        { length: endHour - startHour },
        (_, idx) => startHour + idx,
      ),
    [startHour, endHour],
  );

  const hourPx = viewMode === "week" ? 46 : 56;
  const startMin = startHour * 60;
  const totalHeight = hours.length * hourPx;

  // Smart scroll to relevant hour (first event minus 60m, or 08:30 / current time)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const targetMinutes =
      dayBlocks.length > 0
        ? Math.max(startMin, dayBlocks[0].start - 60)
        : day === now
          ? Math.max(startMin, nowMinutes - 90)
          : Math.max(startMin, 510);
    const targetScroll = ((targetMinutes - startMin) / 60) * hourPx;
    el.scrollTop = Math.max(0, Math.round(targetScroll));
  }, [day, viewMode]); // intentionally scroll on day/view change only

  const movedIds = useMemo(
    () => new Set(previewOption?.changes.map((c) => c.blockId) || []),
    [previewOption],
  );
  const addedHighlightSet = useMemo(
    () => new Set(recentScheduleHighlight?.addedIds || []),
    [recentScheduleHighlight],
  );

  const dragEvaluation = useMemo(() => {
    if (!draggingBlock || !dragHover) return null;
    const targetDay = dragHover.day;
    const targetStart = dragHover.start;
    const dur = draggingBlock.minutes;
    const others = s.blocks.filter((b) => b.id !== draggingBlock.id);

    if (
      (draggingBlock.kind === "学习" || draggingBlock.kind === "复习") &&
      isWithinSleep(targetStart, dur, sleepCfg)
    ) {
      const waking = getWakingBounds(sleepCfg);
      const fallback = findSlot(
        others,
        targetDay,
        waking.wakeStart,
        dur,
        draggingBlock.id,
        waking.wakeEnd,
      );
      return {
        status: "sleep" as const,
        message: `触及睡眠保护（${time(sleepCfg.sleepStart)}–${time(sleepCfg.sleepEnd)}）`,
        fallback,
      };
    }

    const clash = others.find(
      (b) =>
        b.day === targetDay &&
        targetStart < b.start + b.minutes &&
        b.start < targetStart + dur,
    );
    if (clash) {
      const waking = getWakingBounds(sleepCfg);
      const fallback = findSlot(
        others,
        targetDay,
        Math.max(waking.wakeStart, clash.start + clash.minutes),
        dur,
        draggingBlock.id,
        waking.wakeEnd,
      );
      return {
        status: "conflict" as const,
        message: `与「${clash.title}」冲突`,
        fallback,
      };
    }

    return {
      status: "valid" as const,
      message: `${targetDay.slice(5)} ${time(targetStart)}–${time(targetStart + dur)}`,
    };
  }, [draggingBlock, dragHover, s.blocks, sleepCfg]);

  function placeCandidateAt(
    activity: LearningActivity,
    targetDay: string,
    targetStart: number,
  ) {
    const waking = getWakingBounds(sleepCfg);
    const kind: Block["kind"] =
      activity.type === "review" || activity.type === "remediation"
        ? "复习"
        : "学习";
    const okHere =
      !isWithinSleep(targetStart, activity.estimatedMinutes, sleepCfg) &&
      free(s.blocks, targetDay, targetStart, activity.estimatedMinutes);
    const slot = okHere
      ? { day: targetDay, start: targetStart }
      : findSlot(
          s.blocks,
          targetDay,
          Math.max(waking.wakeStart, targetStart),
          activity.estimatedMinutes,
          undefined,
          waking.wakeEnd,
        ) ||
        findSlot(
          s.blocks,
          targetDay,
          waking.wakeStart,
          activity.estimatedMinutes,
          undefined,
          waking.wakeEnd,
        );

    if (!slot) {
      showToast("该日及近期均无满足睡眠红线的空档。");
      return;
    }

    const newBlock: Block = {
      id: `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: activity.title,
      kind,
      day: slot.day,
      start: slot.start,
      minutes: activity.estimatedMinutes,
      lesson: activity.conceptId,
    };
    saveStoreState(
      { ...s, blocks: [...s.blocks, newBlock] },
      slot.day,
      `已排入「${activity.title}」至 ${slot.day.slice(5)} ${time(slot.start)}`,
    );
  }

  function handleDropAt(
    targetDay: string,
    targetStart: number,
    e?: React.DragEvent,
  ) {
    const rawAct = e?.dataTransfer?.getData(DRAG_ACTIVITY_MIME);
    if (rawAct) {
      try {
        const parsed = JSON.parse(rawAct) as LearningActivity;
        placeCandidateAt(parsed, targetDay, targetStart);
      } catch {}
      setDragHover(null);
      return;
    }

    if (!draggingBlock) return;
    const others = s.blocks.filter((b) => b.id !== draggingBlock.id);
    const isSleep =
      (draggingBlock.kind === "学习" || draggingBlock.kind === "复习") &&
      isWithinSleep(targetStart, draggingBlock.minutes, sleepCfg);
    const isFree = free(others, targetDay, targetStart, draggingBlock.minutes);

    if (!isSleep && isFree) {
      moveBlockToSlot(draggingBlock.id, targetDay, targetStart);
    } else {
      const waking = getWakingBounds(sleepCfg);
      const nearest =
        findSlot(
          others,
          targetDay,
          Math.max(waking.wakeStart, targetStart),
          draggingBlock.minutes,
          draggingBlock.id,
          waking.wakeEnd,
        ) ||
        findSlot(
          others,
          targetDay,
          waking.wakeStart,
          draggingBlock.minutes,
          draggingBlock.id,
          waking.wakeEnd,
        );
      if (nearest) {
        moveBlockToSlot(draggingBlock.id, nearest.day, nearest.start);
      } else {
        moveBlockToSlot(draggingBlock.id, targetDay, targetStart);
      }
    }
    setDraggingId(null);
    setDragHover(null);
  }

  function nudgeBlock(b: Block, deltaMinutes: number) {
    const others = s.blocks.filter((x) => x.id !== b.id);
    const waking = getWakingBounds(sleepCfg);
    const candidate = Math.max(
      waking.wakeStart,
      Math.min(waking.wakeEnd - b.minutes, b.start + deltaMinutes),
    );
    if (free(others, b.day, candidate, b.minutes)) {
      moveBlockToSlot(b.id, b.day, candidate);
    } else {
      const nextSlot = findSlot(
        others,
        b.day,
        deltaMinutes > 0
          ? candidate
          : Math.max(waking.wakeStart, candidate - 60),
        b.minutes,
        b.id,
        waking.wakeEnd,
      );
      if (nextSlot) {
        moveBlockToSlot(b.id, nextSlot.day, nextSlot.start);
      } else {
        showToast("相邻时段已满，请拖动到其他空档。");
      }
    }
  }

  function handleExportICS() {
    const ics = exportBlocksToICS(s.blocks);
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `xuejing-schedule-${now}.ics`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("已导出 .ics 日历文件，可导入系统日历。");
  }

  // Compute sleep bands inside [startMin, endHour * 60]
  const sleepBands = useMemo(() => {
    const bands: Array<{ top: number; height: number }> = [];
    const maxMin = endHour * 60;
    const pushBand = (a: number, b: number) => {
      const lo = Math.max(startMin, a);
      const hi = Math.min(maxMin, b);
      if (hi > lo) {
        bands.push({
          top: ((lo - startMin) / 60) * hourPx,
          height: ((hi - lo) / 60) * hourPx,
        });
      }
    };
    if (sleepCfg.sleepStart > sleepCfg.sleepEnd) {
      pushBand(0, sleepCfg.sleepEnd);
      pushBand(sleepCfg.sleepStart, 1440);
    } else {
      pushBand(sleepCfg.sleepStart, sleepCfg.sleepEnd);
    }
    return bands;
  }, [endHour, hourPx, sleepCfg.sleepEnd, sleepCfg.sleepStart, startMin]);

  // Helper to render one vertical day column (reused seamlessly by Day & Week axis!)
  function renderDayColumn(colDay: string, compact: boolean) {
    const colBlocks = s.blocks.filter((b) => b.day === colDay);
    const positioned = layoutDayBlocks(colBlocks);
    const isToday = colDay === now;
    const nowTop = ((nowMinutes - startMin) / 60) * hourPx;
    const showNowLine =
      isToday && nowMinutes >= startMin && nowMinutes <= endHour * 60;

    // Preview slots on this day (from Agent reschedule options)
    const previews: Array<{
      key: string;
      start: number;
      minutes: number;
      title: string;
      badge: string;
    }> = [];
    if (previewOption) {
      if (previewOption.insertEvent?.day === colDay) {
        previews.push({
          key: "preview-insert",
          start: previewOption.insertEvent.start,
          minutes: previewOption.insertEvent.minutes,
          title: previewOption.insertEvent.title,
          badge: "预览新增",
        });
      }
      for (const c of previewOption.changes) {
        for (const [idx, ns] of c.newSlots.entries()) {
          if (ns.day !== colDay) continue;
          previews.push({
            key: `preview-${c.blockId}-${idx}`,
            start: ns.start,
            minutes: ns.minutes,
            title: ns.title || c.title,
            badge: "预览移至",
          });
        }
      }
    }

    // Moved-out origin ghost slots
    const ghosts: Array<{
      key: string;
      start: number;
      minutes: number;
      title: string;
      dest: string;
    }> = [];
    if (recentScheduleHighlight && !previewOption) {
      for (const [bid, mv] of Object.entries(recentScheduleHighlight.movedMap)) {
        if (
          mv.oldDay === colDay &&
          (mv.newDay !== colDay || mv.newStart !== mv.oldStart)
        ) {
          ghosts.push({
            key: `ghost-${bid}`,
            start: mv.oldStart,
            minutes: mv.oldMinutes,
            title: mv.title,
            dest: `${mv.newDay.slice(5)} ${time(mv.newStart)}`,
          });
        }
      }
    }

    return (
      <div
        key={colDay}
        className={"cal-col" + (isToday ? " cal-col-today" : "")}
        style={{ height: `${totalHeight}px` }}
      >
        {/* Subtle Sleep Protection Bands */}
        {sleepBands.map((band, i) => (
          <div
            key={i}
            className="cal-sleep-band"
            style={{ top: `${band.top}px`, height: `${band.height}px` }}
            aria-hidden="true"
          />
        ))}

        {/* Interactive 30-minute Grid Slots (click to add, drag-over to drop) */}
        {hours.map((h) =>
          [0, 30].map((half) => {
            const slotStart = h * 60 + half;
            const slotTop = ((slotStart - startMin) / 60) * hourPx;
            const isDropTarget =
              dragHover?.day === colDay && dragHover?.start === slotStart;
            return (
              <button
                key={slotStart}
                type="button"
                className={
                  "cal-slot" +
                  (half === 0 ? " cal-slot-hour" : " cal-slot-half") +
                  (isDropTarget ? " cal-slot-hover" : "")
                }
                style={{
                  top: `${slotTop}px`,
                  height: `${hourPx / 2}px`,
                }}
                aria-label={`在 ${colDay} ${time(slotStart)} 添加日程`}
                onClick={() => {
                  if (colDay !== day) setDay(colDay);
                  onAdd(slotStart);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (
                    dragHover?.day !== colDay ||
                    dragHover?.start !== slotStart
                  ) {
                    setDragHover({ day: colDay, start: slotStart });
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDropAt(colDay, slotStart, e);
                }}
              >
                {!compact && (
                  <span className="cal-slot-hint">
                    + {time(slotStart)}
                  </span>
                )}
              </button>
            );
          }),
        )}

        {/* Drag Drop Preview Ghost */}
        {draggingBlock && dragHover?.day === colDay && (
          <div
            className={
              "cal-drag-ghost " +
              (dragEvaluation?.status === "valid"
                ? "cal-drag-valid"
                : "cal-drag-warn")
            }
            style={{
              top: `${((dragHover.start - startMin) / 60) * hourPx}px`,
              height: `${Math.max(24, (draggingBlock.minutes / 60) * hourPx - 2)}px`,
            }}
            aria-hidden="true"
          >
            <span>
              {time(dragHover.start)} · {draggingBlock.title}
            </span>
          </div>
        )}

        {/* Moved-out Origin Ghost Markers */}
        {ghosts.map((g) => (
          <div
            key={g.key}
            className="cal-ghost-origin"
            style={{
              top: `${((g.start - startMin) / 60) * hourPx}px`,
              height: `${Math.max(26, (g.minutes / 60) * hourPx - 2)}px`,
            }}
          >
            <span className="cal-ghost-title">{g.title}</span>
            <span className="cal-ghost-dest">→ {g.dest}</span>
          </div>
        ))}

        {/* Reschedule Preview Blocks */}
        {previews.map((p) => (
          <div
            key={p.key}
            className="cal-preview-block"
            style={{
              top: `${((p.start - startMin) / 60) * hourPx}px`,
              height: `${Math.max(28, (p.minutes / 60) * hourPx - 2)}px`,
            }}
          >
            <strong>{p.title}</strong>
            <span>
              {time(p.start)} · {p.badge}
            </span>
          </div>
        ))}

        {/* Scheduled Time Blocks (Proportional height + Motion layout transitions!) */}
        {positioned.map(({ block: b, col, totalCols, hasOverlap }) => {
          const top = ((b.start - startMin) / 60) * hourPx;
          const height = Math.max(28, (b.minutes / 60) * hourPx - 3);
          const widthPct = 100 / totalCols;
          const leftPct = col * widthPct;
          const locked = isLockedBlock(b);
          const movingOut = movedIds.has(b.id);
          const isAdded = addedHighlightSet.has(b.id);
          const movedInfo = recentScheduleHighlight?.movedMap[b.id];
          const remedial = b.lesson ? isRemedialBlock(b) : false;
          const isTight = height < 44;

          return (
            <motion.div
              key={b.id}
              layout
              transition={SPRING_CRISP}
              draggable={!locked}
              onDragStart={() => {
                if (!locked) setDraggingId(b.id);
              }}
              onDragEnd={() => {
                setDraggingId(null);
                setDragHover(null);
              }}
              onClick={(e) => {
                e.stopPropagation();
                onBlock(b);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onBlock(b);
                }
              }}
              title={`${b.title} (${time(b.start)}–${time(b.start + b.minutes)})`}
              className={
                "cal-block " +
                blockToneClass(b.kind) +
                (b.done ? " cal-block-done" : "") +
                (movingOut ? " cal-block-moving" : "") +
                (draggingId === b.id ? " cal-block-dragging" : "") +
                (hasOverlap ? " cal-block-overlap" : "") +
                (isAdded || movedInfo ? " cal-block-changed" : "")
              }
              style={{
                top: `${top}px`,
                height: `${height}px`,
                left: `calc(${leftPct}% + 3px)`,
                width: `calc(${widthPct}% - 6px)`,
              }}
            >
              <div className="cal-block-head">
                <span className="cal-block-title">
                  {b.title}
                </span>
                {isTight && (
                  <time className="cal-block-inline-time">
                    {time(b.start)}–{time(b.start + b.minutes)}
                  </time>
                )}
                {locked && (
                  <LockKeyhole
                    size={11}
                    className="cal-block-lock"
                    aria-label="已锁定"
                  />
                )}
              </div>

              {!isTight && (
                <div className="cal-block-meta">
                  <time>
                    {time(b.start)}–{time(b.start + b.minutes)}
                  </time>
                  {!compact && (
                    <span>
                      · {remedial ? "补救巩固" : b.kind}
                    </span>
                  )}
                  {movedInfo && (
                    <span className="cal-block-diff">
                      原 {time(movedInfo.oldStart)}
                    </span>
                  )}
                </div>
              )}

              {/* Hover Quick Controls (Day View) */}
              {!compact && !movingOut && (
                <div
                  className="cal-block-actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  {!locked && !b.done && (
                    <>
                      <button
                        type="button"
                        onClick={() => nudgeBlock(b, -30)}
                        title="提前 30 分钟"
                      >
                        -30m
                      </button>
                      <button
                        type="button"
                        onClick={() => nudgeBlock(b, 30)}
                        title="顺延 30 分钟"
                      >
                        +30m
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className={b.done ? "cal-check-active" : ""}
                    onClick={() => toggleBlockDone(b.id)}
                    title={b.done ? "标记未完成" : "标记已完成"}
                    aria-label={b.done ? "标记未完成" : "标记已完成"}
                  >
                    <Check size={11} aria-hidden="true" />
                  </button>
                </div>
              )}
            </motion.div>
          );
        })}

        {/* Live Current-Time Hairline */}
        {showNowLine && (
          <div
            className="cal-now-line"
            style={{ top: `${nowTop}px` }}
            aria-hidden="true"
          >
            <span />
          </div>
        )}
      </div>
    );
  }

  const headerDateLabel =
    viewMode === "week"
      ? `${week[0].slice(5).replace("-", "月")}日 – ${week[6].slice(5).replace("-", "月")}日`
      : `${dateLabel(day, { month: "long", day: "numeric" })} · ${dateLabel(day, { weekday: "short" })}`;

  return (
    <section
      className={"cal-shell" + (large ? " cal-shell-large" : "")}
      aria-label="学习日历时间轴"
    >
      {/* 1. Single Compact Top Toolbar */}
      <header className="cal-toolbar">
        <div className="cal-toolbar-left">
          <div className="cal-date-nav">
            <button
              type="button"
              className="wb-button"
              onClick={() => setDay(now)}
            >
              今天
            </button>
            <div className="cal-arrows">
              <button
                type="button"
                className="wb-icon"
                aria-label={viewMode === "week" ? "上一周" : "上一天"}
                onClick={() => setDay(offset(day, viewMode === "week" ? -7 : -1))}
              >
                <ChevronLeft size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="wb-icon"
                aria-label={viewMode === "week" ? "下一周" : "下一天"}
                onClick={() => setDay(offset(day, viewMode === "week" ? 7 : 1))}
              >
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
          <h2 className="cal-date-title">{headerDateLabel}</h2>
        </div>

        <div className="cal-toolbar-right">
          {large && (
            <div
              className="cal-mode-switch"
              role="group"
              aria-label="日历视图切换"
            >
              {(
                [
                  ["day", "日轴", List],
                  ["week", "周轴", Columns3],
                ] as const
              ).map(([modeKey, modeLabel, Icon]) => {
                const active = viewMode === modeKey;
                return (
                  <button
                    key={modeKey}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setViewMode(modeKey)}
                    className={active ? "cal-mode-btn is-active" : "cal-mode-btn"}
                  >
                    {active && (
                      <motion.span
                        layoutId={`cal-mode-${instanceId}`}
                        className="cal-mode-pill"
                        transition={SPRING_CRISP}
                      />
                    )}
                    <span className="cal-mode-label">
                      <Icon size={12} aria-hidden="true" />
                      {modeLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {large && (
            <button
              type="button"
              className="wb-button"
              aria-expanded={editSleep}
              onClick={() => {
                setSleepStartVal(time(sleepCfg.sleepStart));
                setSleepEndVal(time(sleepCfg.sleepEnd));
                setEditSleep((v) => !v);
              }}
              title="设置睡眠保护红线，系统排课会自动避开"
            >
              <Moon size={13} aria-hidden="true" />
              <span>
                {time(sleepCfg.sleepStart)}–{time(sleepCfg.sleepEnd)}
              </span>
            </button>
          )}

          {large && (
            <button
              type="button"
              className="wb-icon"
              onClick={handleExportICS}
              title="导出 .ics 日历文件"
              aria-label="导出 .ics 日历文件"
            >
              <Download size={14} aria-hidden="true" />
            </button>
          )}

          {large && onAskSchedule && (
            <button
              type="button"
              className="wb-button"
              onClick={onAskSchedule}
              title="让学习助手检查冲突并优化本周排期"
            >
              <Sparkles size={13} aria-hidden="true" />
              <span>助手重排</span>
            </button>
          )}

          <button
            type="button"
            className="wb-button wb-primary"
            onClick={() => onAdd()}
          >
            <Plus size={14} aria-hidden="true" />
            <span>添加</span>
          </button>
        </div>
      </header>

      {/* Inline Expandable Sleep Protection Editor (AnimatePresence height: 0 -> auto) */}
      <AnimatePresence initial={false}>
        {large && editSleep && (
          <motion.div
            key="sleep-editor"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={TRANSITION_STATE}
            style={{ overflow: "hidden" }}
          >
            <form
              className="cal-sleep-editor"
              onSubmit={(e) => {
                e.preventDefault();
                const [sh, sm] = sleepStartVal.split(":").map(Number);
                const [eh, em] = sleepEndVal.split(":").map(Number);
                updateScheduleSettings({
                  sleepStart: sh * 60 + sm,
                  sleepEnd: eh * 60 + em,
                });
                setEditSleep(false);
              }}
            >
              <span className="cal-sleep-label">
                <Moon size={13} aria-hidden="true" /> 睡眠保护时段（排课自动避开）
              </span>
              <label>
                入睡
                <input
                  type="time"
                  value={sleepStartVal}
                  onChange={(e) => setSleepStartVal(e.target.value)}
                />
              </label>
              <label>
                起床
                <input
                  type="time"
                  value={sleepEndVal}
                  onChange={(e) => setSleepEndVal(e.target.value)}
                />
              </label>
              <button type="submit" className="wb-button wb-primary">
                保存
              </button>
              <button
                type="button"
                className="wb-button"
                onClick={() => setEditSleep(false)}
              >
                取消
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reschedule Preview / Recent Change Diff / Active Drag Status Strip */}
      <AnimatePresence initial={false}>
        {previewOption && (
          <motion.div
            key="preview-banner"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={TRANSITION_FAST}
            style={{ overflow: "hidden" }}
          >
            <div className="cal-banner cal-banner-info">
              <Sparkles size={13} aria-hidden="true" />
              <span>
                正在预览重排方案「<strong>{previewOption.label}</strong>」
              </span>
            </div>
          </motion.div>
        )}

        {recentScheduleHighlight && !previewOption && (
          <motion.div
            key="diff-banner"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={TRANSITION_FAST}
            style={{ overflow: "hidden" }}
          >
            <div className="cal-banner cal-banner-info">
              <Sparkles size={13} aria-hidden="true" />
              <span className="cal-banner-text">
                <strong>{recentScheduleHighlight.trigger}</strong>：
                {recentScheduleHighlight.summary}
              </span>
              <button
                type="button"
                className="wb-button cal-mini-btn"
                onClick={() => setWorkspaceTab("audit")}
              >
                查看轨迹
              </button>
              <button
                type="button"
                className="wb-icon"
                onClick={clearScheduleHighlight}
                aria-label="收起变更提示"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          </motion.div>
        )}

        {draggingBlock && (
          <motion.div
            key="drag-banner"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={TRANSITION_FAST}
            style={{ overflow: "hidden" }}
          >
            <div
              className={
                "cal-banner " +
                (dragEvaluation?.status === "conflict" ||
                dragEvaluation?.status === "sleep"
                  ? "cal-banner-warn"
                  : "cal-banner-ok")
              }
            >
              {dragEvaluation?.status === "conflict" ||
              dragEvaluation?.status === "sleep" ? (
                <AlertTriangle size={13} aria-hidden="true" />
              ) : (
                <Check size={13} aria-hidden="true" />
              )}
              <span>
                拖动「<strong>{draggingBlock.title}</strong>」：
                {dragEvaluation
                  ? dragEvaluation.status === "valid"
                    ? `松开落位至 ${dragEvaluation.message}`
                    : `${dragEvaluation.message}${dragEvaluation.fallback ? ` · 松开将自动移至 ${dragEvaluation.fallback.day.slice(5)} ${time(dragEvaluation.fallback.start)}` : ""}`
                  : "移到目标时段后松开"}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 2. Week Strip (Day Mode) OR Synchronized 7-Day Column Header (Week Mode) */}
      {viewMode === "day" ? (
        <div className="cal-week-strip" role="tablist" aria-label="选择日期">
          {week.map((d, idx) => {
            const isSelected = d === day;
            const isToday = d === now;
            const count = s.blocks.filter((b) => b.day === d).length;
            return (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={isSelected}
                className={
                  "cal-day-tab" +
                  (isSelected ? " is-selected" : "") +
                  (isToday ? " is-today" : "")
                }
                onClick={() => setDay(d)}
                onDragOver={(e) => {
                  if (!draggingBlock) return;
                  e.preventDefault();
                  setDragHover({ day: d, start: draggingBlock.start });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDropAt(d, draggingBlock?.start ?? 1140, e);
                }}
              >
                {isSelected && (
                  <motion.span
                    layoutId={`cal-day-pill-${instanceId}`}
                    className="cal-day-pill"
                    transition={SPRING_CRISP}
                  />
                )}
                <span className="cal-day-content">
                  <small>周{WEEKDAY_SHORT[idx]}</small>
                  <strong>{Number(d.slice(-2))}</strong>
                  <i className={count > 0 ? "has-dot" : ""} aria-hidden="true" />
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="cal-week-header">
          <div className="cal-ruler-spacer" />
          {week.map((d, idx) => {
            const isToday = d === now;
            const isSelected = d === day;
            const studyMin = s.blocks
              .filter(
                (b) => b.day === d && (b.kind === "学习" || b.kind === "复习"),
              )
              .reduce((acc, b) => acc + b.minutes, 0);
            return (
              <button
                key={d}
                type="button"
                className={
                  "cal-week-col-head" +
                  (isToday ? " is-today" : "") +
                  (isSelected ? " is-selected" : "")
                }
                onClick={() => {
                  setDay(d);
                  setViewMode("day");
                }}
                title="点击切换到日时间轴"
              >
                <span className="cal-week-col-top">
                  <small>周{WEEKDAY_SHORT[idx]}</small>
                  <strong>{Number(d.slice(-2))}</strong>
                </span>
                <span className="cal-week-col-min">
                  {studyMin > 0 ? `${studyMin}m` : "空闲"}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* 3. Proportional Scrollable Time-Axis Body */}
      <div className="cal-body" ref={scrollRef}>
        <div
          className={
            "cal-grid " +
            (viewMode === "week" ? "cal-grid-week" : "cal-grid-day")
          }
        >
          {/* Left Sticky Hourly Ruler */}
          <div
            className="cal-ruler"
            style={{ height: `${totalHeight}px` }}
            aria-hidden="true"
          >
            {hours.map((h) => (
              <span
                key={h}
                style={{ top: `${(h - startHour) * hourPx}px` }}
              >
                {String(h).padStart(2, "0")}:00
              </span>
            ))}
          </div>

          {/* Day or 7-Day Columns */}
          {viewMode === "week"
            ? week.map((d) => renderDayColumn(d, true))
            : renderDayColumn(day, false)}
        </div>
      </div>
    </section>
  );
}

export function AddEvent({
  s,
  day,
  initialStart,
  editing,
  save,
}: {
  s: Store;
  day: string;
  initialStart?: number;
  editing?: Block | null;
  save: (s: Store, targetDay: string) => void;
}) {
  const [title, setTitle] = useState(editing?.title || "");
  const [date, setDate] = useState(editing?.day || day);
  const [start, setStart] = useState(
    editing
      ? time(editing.start)
      : initialStart !== undefined
        ? time(initialStart)
        : "19:30",
  );
  const [duration, setDuration] = useState(editing?.minutes || 45);
  const [kind, setKind] = useState<Block["kind"]>(editing?.kind || "学习");
  const [locked, setLocked] = useState<boolean>(
    editing?.locked ?? (editing ? editing.kind === "工作" : false),
  );
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<{
    state: Store;
    changes: string[];
    targetDay: string;
  } | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!title.trim()) {
      setError("请填写日程名称。");
      return;
    }
    const [h, m] = start.split(":").map(Number);
    const minutes = h * 60 + m;
    if (duration <= 0 || duration > 1440) {
      setError("日程时长需在 1–1440 分钟之间。");
      return;
    }

    const baseBlocks = editing
      ? s.blocks.filter(
          (b) =>
            b.id !== editing.id &&
            (!editing.splitGroup || b.splitGroup !== editing.splitGroup),
        )
      : s.blocks;

    const isCrossMidnight = minutes + duration > 1440;
    const splitGroupId = isCrossMidnight
      ? editing?.splitGroup || `midnight-${crypto.randomUUID().slice(0, 8)}`
      : undefined;
    const newEntries: Block[] = isCrossMidnight
      ? [
          {
            id: editing?.id || crypto.randomUUID(),
            title: `${title.trim()}（跨日 · 当晚）`,
            day: date,
            start: minutes,
            minutes: 1440 - minutes,
            kind,
            locked: locked || kind === "工作",
            lesson: editing?.lesson,
            done: editing?.done,
            splitGroup: splitGroupId,
          },
          {
            id: `${editing?.id || crypto.randomUUID()}-nextday`,
            title: `${title.trim()}（跨日 · 次日凌晨）`,
            day: offset(date, 1),
            start: 0,
            minutes: minutes + duration - 1440,
            kind,
            locked: locked || kind === "工作",
            lesson: editing?.lesson,
            done: editing?.done,
            splitGroup: splitGroupId,
          },
        ]
      : [
          {
            id: editing?.id || crypto.randomUUID(),
            title: title.trim(),
            day: date,
            start: minutes,
            minutes: duration,
            kind,
            locked: locked || kind === "工作",
            lesson: editing?.lesson,
            done: editing?.done,
          },
        ];

    const clashes = baseBlocks.filter((b) =>
      newEntries.some((ne) => !free([b], ne.day, ne.start, ne.minutes)),
    );
    if (clashes.some((b) => isLockedBlock(b))) {
      setError("这个时段已有锁定或固定安排，请换一个时间。");
      return;
    }

    const waking = getWakingBounds(s.scheduleSettings);
    let blocks = [
      ...baseBlocks.filter((b) => !clashes.includes(b)),
      ...newEntries,
    ];
    const changes: string[] = [];
    for (const b of clashes) {
      const slot = findSlot(
        blocks,
        b.day,
        Math.max(
          waking.wakeStart,
          minutes + duration <= 1440 ? minutes + duration : waking.wakeStart,
        ),
        b.minutes,
        undefined,
        waking.wakeEnd,
      );
      if (!slot) {
        setError("找不到可用的学习时段，请调整时间。");
        return;
      }
      blocks = [...blocks, { ...b, ...slot }];
      changes.push(
        `${b.title}：${time(b.start)} → ${slot.day.slice(5)} ${time(slot.start)}`,
      );
    }

    const state: Store = {
      ...s,
      blocks,
      decision: changes.length
        ? `为日程「${title.trim()}」腾出时间。${changes.join("；")}`
        : isCrossMidnight
          ? `已创建跨午夜日程「${title.trim()}」（${date.slice(5)} ${time(minutes)} 至次日 ${time(minutes + duration - 1440)}）。`
          : s.decision,
    };

    if (changes.length) setDraft({ state, changes, targetDay: date });
    else save(state, date);
  }

  if (draft) {
    return (
      <div className="wb-form">
        <h3>有一项时间调整需要确认</h3>
        <p className="wb-form-hint">
          为新日程保留时间，受影响的学习任务将自动移到以下无冲突空档：
        </p>
        {draft.changes.map((c) => (
          <div className="wb-empty" key={c}>
            {c}
          </div>
        ))}
        <div className="wb-toolbar">
          <button
            type="button"
            className="wb-button wb-primary"
            onClick={() => save(draft.state, draft.targetDay)}
          >
            确认并应用重排 <ArrowRight size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="wb-button"
            onClick={() => setDraft(null)}
          >
            返回编辑
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="wb-form" onSubmit={submit}>
      <label>
        日程名称
        <input
          autoFocus
          required
          maxLength={80}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：专注完成 Pandas 数据清洗实战"
        />
      </label>
      <div className="wb-form-pair">
        <label>
          日期
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          开始时间
          <input
            type="time"
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
      </div>
      <div className="wb-form-pair">
        <label>
          时长（分钟）
          <input
            type="number"
            required
            min="5"
            max="720"
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
        </label>
        <label>
          类别
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Block["kind"])}
          >
            {Object.keys(kindIcons).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="cal-lock-check">
        <input
          type="checkbox"
          checked={locked || kind === "工作"}
          onChange={(e) => setLocked(e.target.checked)}
        />
        <span>锁定为不可移动事项（重排时绝不移动此日程）</span>
      </label>
      {error && (
        <p role="alert" className="wb-form-error">
          {error}
        </p>
      )}
      <button className="wb-button wb-primary" type="submit">
        {editing ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
        <span>{editing ? "保存修改" : "添加到时间轴"}</span>
      </button>
    </form>
  );
}
