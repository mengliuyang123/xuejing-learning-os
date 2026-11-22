"use client";
import {
  ArrowRight,
  Brain,
  CalendarDays,
  GitFork,
  RotateCcw,
  Sparkles,
  Target,
} from "lucide-react";
import type { DecisionFactor, DecisionTrace } from "../../lib/learning";

const FACTOR_ICON: Record<DecisionFactor["kind"], typeof GitFork> = {
  prerequisite: GitFork,
  mastery: Target,
  calendar: CalendarDays,
  memory: Brain,
  review: RotateCcw,
};

const IMPACT_STYLE: Record<DecisionFactor["impact"], string> = {
  positive: "bg-emerald-50 text-emerald-700 border-emerald-200",
  constraint: "bg-[#edf2ff] text-[#3755c9] border-[#d3dffa]",
  warning: "bg-amber-50 text-amber-800 border-amber-200",
};

export default function DecisionTraceCard({
  trace,
  onOpenLesson,
  onOpenMap,
}: {
  trace: DecisionTrace;
  onOpenLesson?: (lessonId: string) => void;
  onOpenMap?: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#d6e0f7] bg-white shadow-xs">
      <div className="flex items-center justify-between border-b border-[#e8eef9] bg-[#f4f7ff] px-3.5 py-2.5">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-[#3856c2]">
          <Sparkles size={14} /> Agent 决策证据链
        </span>
        <span className="text-[11px] font-medium text-[#6c7b99]">
          目标：{trace.targetTitle}
        </span>
      </div>

      <div className="space-y-3 p-3.5">
        <p className="rounded-lg bg-[#f3f6ff] px-3 py-2 text-xs leading-relaxed text-[#324264]">
          {trace.summary}
        </p>

        <div className="space-y-2">
          {trace.factors.map((f, idx) => {
            const Icon = FACTOR_ICON[f.kind];
            return (
              <div
                key={idx}
                className="flex items-start gap-2.5 rounded-lg border border-[#e7ecf6] bg-[#fbfcff] p-2.5"
              >
                <span
                  className={
                    "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border " +
                    IMPACT_STYLE[f.impact]
                  }
                >
                  <Icon size={13} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-[#233047]">
                    {f.label}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-[#606f89]">
                    {f.detail}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {trace.alternatives && trace.alternatives.length > 0 && (
          <div className="rounded-lg border border-dashed border-[#dce3f2] bg-[#fafbfe] px-3 py-2">
            <div className="mb-1 text-[11px] font-semibold text-[#647492]">
              同轨道备选对比
            </div>
            <ul className="space-y-0.5 text-[11px] text-[#6d7b95]">
              {trace.alternatives.map((alt, i) => (
                <li key={i}>· {alt}</li>
              ))}
            </ul>
          </div>
        )}

        {(onOpenLesson || onOpenMap) && (
          <div className="flex flex-wrap gap-2 pt-0.5">
            {onOpenLesson && trace.targetLessonId && (
              <button
                type="button"
                onClick={() => onOpenLesson(trace.targetLessonId!)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#395de7] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#2f50d1]"
              >
                开始学习 <ArrowRight size={13} />
              </button>
            )}
            {onOpenMap && (
              <button
                type="button"
                onClick={onOpenMap}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#d6deee] bg-white px-3 py-1.5 text-xs font-medium text-[#445577] hover:bg-[#f4f7fc]"
              >
                查看知识地图 <GitFork size={13} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
