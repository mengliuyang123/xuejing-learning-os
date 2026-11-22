"use client";
import { CalendarClock, Clock3, FastForward, Sparkles, X } from "lucide-react";
import { type Block, time } from "../../lib/learning";

export default function MissedSessionsBanner({
  missed,
  onHandle,
}: {
  missed: Block[];
  onHandle: (blockId: string, action: "reschedule" | "shrink15" | "drop") => void;
}) {
  if (!missed.length) return null;

  return (
    <section className="mb-5 overflow-hidden rounded-2xl border border-[var(--ve-amber)]/35 bg-gradient-to-r from-amber-50/90 to-[#fffcf5] p-4 shadow-2xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ve-amber)]">
          <CalendarClock size={16} className="text-amber-600" />
          接管 {missed.length} 项前期未完成学习（不堆积、不内耗）
        </div>
        <span className="text-[11px] text-amber-800/80">
          系统不会自动标为完成，也不盲目滚雪球，选一个最轻松的处理方式：
        </span>
      </div>

      <div className="mt-3 space-y-2">
        {missed.map((b) => (
          <div
            key={b.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--ve-amber)]/35 bg-[var(--ve-surface)] px-3.5 py-2.5"
          >
            <div>
              <div className="text-xs font-semibold text-[#232f47]">
                {b.title}
              </div>
              <div className="mt-0.5 text-[11px] text-[#6b7890]">
                原定 {b.day.slice(5)} {time(b.start)} · {b.minutes} 分钟（{b.kind}）
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => onHandle(b.id, "reschedule")}
                className="inline-flex items-center gap-1 rounded-lg bg-[#395de7] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-[#2f50d1]"
              >
                <FastForward size={12} /> 顺延下个空档
              </button>
              <button
                type="button"
                onClick={() => onHandle(b.id, "shrink15")}
                className="inline-flex items-center gap-1 rounded-lg border border-[#cbd8f7] bg-[#f2f6ff] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--ve-accent)] hover:bg-[#e5eeff]"
              >
                <Sparkles size={12} /> 缩为 15 分钟微复习
              </button>
              <button
                type="button"
                onClick={() => onHandle(b.id, "drop")}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-[var(--ve-surface)] px-2 py-1.5 text-[11px] text-[var(--ve-muted)] hover:bg-slate-50"
              >
                <X size={12} /> 跳过本次
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
