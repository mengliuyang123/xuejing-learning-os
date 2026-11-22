"use client";
import { CalendarCheck2, CalendarMinus, CalendarPlus } from "lucide-react";
import type { CalendarUpdatedCard } from "../../lib/learning";

export default function CalendarUpdatedPill({
  card,
  onFocusCalendar,
}: {
  card: CalendarUpdatedCard;
  onFocusCalendar?: (day: string) => void;
}) {
  const Icon =
    card.action === "delete"
      ? CalendarMinus
      : card.action === "add"
        ? CalendarPlus
        : CalendarCheck2;

  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-[#dce4f7] bg-[var(--ve-accent-soft)] px-3 py-2 text-xs text-[#263963]">
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={14} className="shrink-0 text-[#395de7]" />
        <span className="truncate font-medium">{card.summary}</span>
      </div>
      {onFocusCalendar && (
        <button
          type="button"
          onClick={() => onFocusCalendar(card.block.day)}
          className="shrink-0 rounded-md bg-[var(--ve-surface)] px-2 py-0.5 text-[11px] font-medium text-[#3555cf] shadow-2xs hover:bg-[var(--ve-accent-soft)]"
        >
          在日历查看
        </button>
      )}
    </div>
  );
}
