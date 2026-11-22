"use client";
import { useState } from "react";
import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  GitFork,
  Undo2,
} from "lucide-react";
import {
  type TrackCreatedCard,
  formatDayWithWeekday,
  time,
} from "../../lib/learning";

export default function TrackCreatedCardView({
  card,
  onOpenLesson,
  onOpenMap,
  onUndo,
}: {
  card: TrackCreatedCard;
  onOpenLesson: (lessonId: string) => void;
  onOpenMap: () => void;
  onUndo?: (planId: string) => void;
}) {
  const [undone, setUndone] = useState(false);
  const { plan } = card;

  return (
    <div className="overflow-hidden rounded-xl border border-[#cddaf8] bg-[var(--ve-surface)] shadow-xs">
      <div className="flex items-center justify-between border-b border-[#e4ecfa] bg-[#f2f6ff] px-3.5 py-2.5">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--ve-accent)]">
          <GitFork size={14} />
          {undone ? "已撤销课程轨道" : "已自动创建课程轨道与日程"}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--ve-emerald-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--ve-emerald)] ring-1 ring-[var(--ve-emerald)]/30">
          <Check size={10} /> {plan.units.length} 节微课
        </span>
      </div>

      <div className="space-y-3 p-3.5">
        <div>
          <h4 className="text-sm font-semibold text-[#1f2942]">{plan.title}</h4>
          <p className="mt-0.5 text-[11px] text-[#606f8a]">{plan.goal}</p>
        </div>

        <div className="space-y-1.5">
          {plan.units.map((u, idx) => {
            const slot = plan.slots.find((b) => b.lesson === u.id);
            return (
              <div
                key={u.id}
                className="flex items-start justify-between gap-2 rounded-lg border border-[#e7ecf6] bg-[var(--ve-canvas)] px-2.5 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#25334e]">
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded bg-[var(--ve-accent-soft)] text-[10px] text-[#395de7]">
                      {idx + 1}
                    </span>
                    <span className="truncate">{u.title}</span>
                  </div>
                  {slot && (
                    <div className="mt-1 flex items-center gap-1 font-mono text-[10px] text-[#5e6e8a]">
                      <CalendarDays size={10} />
                      <span>{formatDayWithWeekday(slot.day)}</span>
                      <span>·</span>
                      <span>
                        {time(slot.start)}–{time(slot.start + slot.minutes)}（
                        {slot.minutes} 分钟 · 正课）
                      </span>
                    </div>
                  )}
                </div>
                {!undone && idx === 0 && (
                  <button
                    type="button"
                    onClick={() => onOpenLesson(u.id)}
                    className="shrink-0 rounded-md bg-[var(--ve-accent-soft)] px-2 py-1 text-[11px] font-semibold text-[var(--ve-accent)] hover:bg-[#dfe9ff]"
                  >
                    学习
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {!undone && (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {plan.units[0] && (
              <button
                type="button"
                onClick={() => onOpenLesson(plan.units[0].id)}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#395de7] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#2f50d1]"
              >
                <BookOpen size={13} /> 开始第一节课 <ArrowRight size={13} />
              </button>
            )}
            <button
              type="button"
              onClick={onOpenMap}
              className="inline-flex items-center gap-1 rounded-lg border border-[#d6deee] bg-[var(--ve-surface)] px-2.5 py-1.5 text-xs font-medium text-[#445577] hover:bg-[var(--ve-surface-alt)]"
            >
              <GitFork size={12} /> 知识地图
            </button>
            {onUndo && (
              <button
                type="button"
                onClick={() => {
                  onUndo(plan.id);
                  setUndone(true);
                }}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-[#728099] hover:bg-[var(--ve-rose-soft)] hover:text-rose-600"
              >
                <Undo2 size={11} /> 撤销
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
