"use client";
import {
  CalendarClock,
  Check,
  GraduationCap,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Unlock,
} from "lucide-react";

export default function MasteryDeltaCard({
  correct,
  explanation,
  masteryBefore,
  masteryAfter,
  unlockedTitles = [],
  nextReviewDay,
  saved,
  hasPlan,
  canSave,
  onSave,
}: {
  correct: boolean;
  explanation: string;
  masteryBefore?: number;
  masteryAfter?: number;
  unlockedTitles?: string[];
  nextReviewDay?: string;
  saved: boolean;
  hasPlan: boolean;
  canSave: boolean;
  onSave: () => void;
}) {
  const showDelta =
    masteryBefore !== undefined && masteryAfter !== undefined;
  const delta = showDelta ? masteryAfter! - masteryBefore! : 0;

  return (
    <section className="mt-3 overflow-hidden rounded-xl border border-[#d6e0f5] bg-[#fbfcff]">
      <header className="flex items-center justify-between border-b border-[#e2e8f4] bg-[#f1f5fc] px-4 py-2.5 text-xs font-semibold text-[#45587c]">
        <span className="flex items-center gap-1.5">
          <GraduationCap size={16} /> 练习反馈与掌握度估计
        </span>
        <span
          className={
            "rounded-full px-2 py-0.5 text-[11px] font-semibold " +
            (correct
              ? "bg-emerald-100 text-emerald-800"
              : "bg-amber-100 text-amber-800")
          }
        >
          {correct ? "回答正确" : "需要巩固"}
        </span>
      </header>

      <div className="space-y-3 p-4">
        <p className="text-sm leading-relaxed text-[#384660]">{explanation}</p>

        {showDelta && (
          <div className="rounded-lg border border-[#e3e9f6] bg-white p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-[#566580]">
                掌握度变化（模拟 BKT + FSRS）
              </span>
              <span
                className={
                  "inline-flex items-center gap-1 font-semibold " +
                  (delta >= 0 ? "text-emerald-700" : "text-amber-700")
                }
              >
                {delta >= 0 ? (
                  <TrendingUp size={13} />
                ) : (
                  <TrendingDown size={13} />
                )}
                {masteryBefore}% → {masteryAfter}%（
                {delta >= 0 ? `+${delta}%` : `${delta}%`}）
              </span>
            </div>

            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#e5eaf5]">
              <div
                className={
                  "h-full rounded-full transition-all duration-500 " +
                  (correct ? "bg-[#395de7]" : "bg-amber-500")
                }
                style={{ width: `${masteryAfter}%` }}
              />
            </div>

            <div className="mt-2.5 flex flex-wrap gap-2 text-[11px]">
              {nextReviewDay && (
                <span className="inline-flex items-center gap-1 rounded-md bg-[#f2f5fc] px-2 py-0.5 text-[#4e6084]">
                  <CalendarClock size={12} /> 建议下次复习：{nextReviewDay.slice(5)}
                </span>
              )}
              {unlockedTitles.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 ring-1 ring-emerald-200"
                >
                  <Unlock size={11} /> 已解锁「{t}」
                </span>
              ))}
            </div>
          </div>
        )}

        <button
          type="button"
          className="tutor-save"
          disabled={saved || !canSave}
          onClick={onSave}
        >
          {saved ? (
            <>
              <Check size={14} />{" "}
              {hasPlan ? "已记录并更新图谱与计划" : "已记录练习反馈"}
            </>
          ) : (
            <>
              <Sparkles size={13} />{" "}
              {hasPlan ? "记录反馈并更新图谱与计划" : "记录练习反馈"}
            </>
          )}
        </button>
      </div>
    </section>
  );
}
