"use client";
import { useState } from "react";
import { Brain, Check, Undo2 } from "lucide-react";
import { type MemorySavedCard, time } from "../../lib/learning";

/**
 * Compact, non-blocking receipt pill shown when the LLM autonomously saves or
 * updates a long-term memory. Requires zero clicks from the user, with an
 * optional subtle undo button.
 */
export default function MemorySavedPill({
  card,
  onUndo,
}: {
  card: MemorySavedCard;
  onUndo?: (memoryId: string) => void;
}) {
  const [undone, setUndone] = useState(false);

  const constraintTags: string[] = [];
  if (
    card.constraint?.preferredStart !== undefined &&
    card.constraint?.preferredEnd !== undefined
  ) {
    constraintTags.push(
      `${time(card.constraint.preferredStart)}–${time(card.constraint.preferredEnd)}`,
    );
  } else if (card.constraint?.preferredStart !== undefined) {
    constraintTags.push(`${time(card.constraint.preferredStart)} 后`);
  }
  if (card.constraint?.maxSessionMinutes) {
    constraintTags.push(`≤${card.constraint.maxSessionMinutes}m`);
  }

  return (
    <div
      className={
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed " +
        (undone
          ? "border-slate-200 bg-slate-50 text-[var(--ve-muted)] line-through"
          : "border-[var(--ve-border)] bg-[#f6f8ff] text-[#354669]")
      }
    >
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]">
        {undone ? <Brain size={10} /> : <Check size={10} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold text-[#2a3b63]">
            {undone
              ? "已撤销记忆"
              : card.action === "update"
                ? `已自动更新记忆 · ${card.label}`
                : card.action === "remove"
                  ? `已自动清理记忆 · ${card.label}`
                  : `已自动记住 · ${card.label}`}
          </span>
          {constraintTags.map((t) => (
            <span
              key={t}
              className="rounded bg-[var(--ve-emerald-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--ve-emerald)] ring-1 ring-[var(--ve-emerald)]/30"
            >
              {t}
            </span>
          ))}
          {card.expiresAt && (
            <span className="rounded bg-[var(--ve-amber-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ve-amber)] ring-1 ring-[var(--ve-amber)]/30">
              有效期至 {card.expiresAt.slice(5)}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[#586784]">{card.text}</p>
      </div>
      {!undone && card.action !== "remove" && onUndo && (
        <button
          type="button"
          onClick={() => {
            onUndo(card.memoryId);
            setUndone(true);
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[#6d7c98] hover:bg-white hover:text-rose-600"
          title="撤销这条自动保存的记忆"
        >
          <Undo2 size={10} /> 撤销
        </button>
      )}
    </div>
  );
}
