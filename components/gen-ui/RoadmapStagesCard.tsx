"use client";
import { BookOpen, Code2, Rocket, Table2 } from "lucide-react";
import type { RoadmapStagesCardData } from "../../lib/learning";

const STAGE_ICONS = [BookOpen, Code2, Table2, Rocket];

export default function RoadmapStagesCard({
  card,
}: {
  card: RoadmapStagesCardData;
}) {
  if (!card.stages?.length) return null;

  return (
    <div className="my-4 space-y-3">
      {card.title && (
        <h3 className="text-lg font-bold tracking-tight text-[var(--ve-ink)]">
          {card.title}
        </h3>
      )}
      <div className="space-y-3">
        {card.stages.map((st, idx) => {
          const Icon =
            st.icon === "book"
              ? BookOpen
              : st.icon === "code"
                ? Code2
                : st.icon === "table"
                  ? Table2
                  : st.icon === "rocket"
                    ? Rocket
                    : STAGE_ICONS[idx % STAGE_ICONS.length];
          return (
            <div
              key={`${st.stageTitle}-${idx}`}
              className="flex items-start gap-3.5"
            >
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#eceff4] bg-[#f8f9fb] text-[var(--ve-ink)]">
                <Icon size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-bold text-[var(--ve-ink)]">
                  {st.stageTitle}
                </div>
                <div className="mt-0.5 text-[13.5px] leading-relaxed text-[var(--ve-muted)]">
                  {st.topics}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
