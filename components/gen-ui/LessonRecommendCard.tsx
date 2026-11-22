"use client";
import { ArrowRight, BookOpen, Check, Clock3, LockKeyhole } from "lucide-react";
import type { LessonRecommendationCard } from "../../lib/learning";

export default function LessonRecommendCard({
  card,
  onOpenLesson,
}: {
  card: LessonRecommendationCard;
  onOpenLesson: (id: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#d6e0f8] bg-white shadow-xs">
      <div className="flex items-center justify-between border-b border-[#e8eef9] bg-[#f3f6ff] px-3.5 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-[#3855bf]">
          <BookOpen size={14} /> 推荐学习节点
        </span>
        <span className="text-[11px] text-[#667696]">{card.trackTitle}</span>
      </div>
      <div className="space-y-2.5 p-3.5">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-semibold text-[#1f2942]">{card.title}</h4>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#eef2ff] px-2 py-0.5 text-[11px] font-medium text-[#3b59cf]">
            <Clock3 size={11} /> {card.minutes} 分钟
          </span>
        </div>

        <p className="text-xs leading-relaxed text-[#5c6a84]">{card.concept}</p>

        <div>
          <div className="mb-1 flex justify-between text-[11px] text-[#64738e]">
            <span>当前掌握度</span>
            <strong className="text-[#2f4574]">{card.mastery}%</strong>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[#e6ebf5]">
            <div
              className="h-full rounded-full bg-[#395de7]"
              style={{ width: `${card.mastery}%` }}
            />
          </div>
        </div>

        {card.prerequisites.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {card.prerequisites.map((p) => (
              <span
                key={p.id}
                className={
                  "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium " +
                  (p.met
                    ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                    : "bg-slate-100 text-slate-600")
                }
              >
                {p.met ? <Check size={10} /> : <LockKeyhole size={10} />}
                先修：{p.title} ({p.mastery}%)
              </span>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => onOpenLesson(card.lessonId)}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#395de7] px-3 py-2 text-xs font-semibold text-white hover:bg-[#2f50d1]"
        >
          进入学习工作台 <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}
