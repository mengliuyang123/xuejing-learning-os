"use client";
import { useState } from "react";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import type { OnboardingSurveyCardData } from "../../lib/learning";

export default function OnboardingSurveyCard({
  card,
  disabled,
  onSubmitSurvey,
}: {
  card: OnboardingSurveyCardData;
  disabled?: boolean;
  onSubmitSurvey: (
    formattedMessage: string,
    selections: Record<string, number>,
  ) => void;
}) {
  const [selections, setSelections] = useState<Record<string, number>>(() => {
    if (card.savedSelections) return card.savedSelections;
    const init: Record<string, number> = {};
    card.questions.forEach((q) => {
      init[q.id] = 0;
    });
    return init;
  });

  const [submittedLocal, setSubmittedLocal] = useState(false);
  const isSubmitted = submittedLocal || Boolean(card.savedSelections);

  function handleSelect(qid: string, optIdx: number) {
    if (disabled || isSubmitted) return;
    setSelections((prev) => ({ ...prev, [qid]: optIdx }));
  }

  function handleSubmit() {
    if (disabled || isSubmitted) return;
    setSubmittedLocal(true);
    const parts = card.questions.map((q) => {
      const idx = selections[q.id] ?? 0;
      const chosen = q.options[idx] || q.options[0] || "";
      const cleanQ = q.question
        .replace(/^\d+[.、\s]*/, "")
        .replace(/[？?]$/, "");
      return `${cleanQ}：${chosen}`;
    });
    const msg = `${parts.join("。")}。请按我的情况定制学习轨道并开始第一节互动课程。`;
    onSubmitSurvey(msg, selections);
  }

  return (
    <div className="my-4 space-y-3">
      {card.title && (
        <h3 className="text-lg font-bold tracking-tight text-[var(--ve-ink)]">
          {card.title}
        </h3>
      )}

      <div className="rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-5 shadow-2xs sm:p-6">
        <div className="divide-y divide-[#f1f3f7]">
          {card.questions.map((q, qIdx) => {
            const currentIdx = selections[q.id] ?? 0;
            const numberedQuestion = /^\d+[.、]/.test(q.question.trim())
              ? q.question.trim()
              : `${qIdx + 1}. ${q.question.trim()}`;

            return (
              <div
                key={q.id}
                className={
                  qIdx === 0
                    ? "pb-5"
                    : qIdx === card.questions.length - 1
                      ? "pt-5 pb-2"
                      : "py-5"
                }
              >
                <div className="text-[13.5px] font-semibold text-[var(--ve-ink)]">
                  {numberedQuestion}
                </div>
                <div className="mt-3 space-y-2.5">
                  {q.options.map((opt, optIdx) => {
                    const selected = currentIdx === optIdx;
                    return (
                      <button
                        key={`${q.id}-${optIdx}`}
                        type="button"
                        disabled={disabled || isSubmitted}
                        onClick={() => handleSelect(q.id, optIdx)}
                        className="group flex w-full items-center gap-3 text-left text-[14px] text-[var(--ve-ink)] transition hover:text-[var(--ve-ink)] disabled:cursor-default"
                      >
                        <span
                          className={
                            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition " +
                            (selected
                              ? "border-[var(--ve-accent-solid)] bg-[var(--ve-accent-solid)]"
                              : "border-[var(--ve-border)] bg-[var(--ve-surface)] group-hover:border-[var(--ve-line)]")
                          }
                        >
                          {selected && (
                            <span className="h-2 w-2 rounded-full bg-[var(--ve-surface)]" />
                          )}
                        </span>
                        <span
                          className={
                            selected
                              ? "font-medium text-[var(--ve-ink)]"
                              : "text-[var(--ve-muted)]"
                          }
                        >
                          {opt}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-5">
          {isSubmitted ? (
            <div className="flex w-full items-center justify-center gap-1.5 rounded-full bg-[var(--ve-surface-alt)] py-2.5 text-xs font-semibold text-[var(--ve-ink)]">
              <CheckCircle2 size={15} className="text-[var(--ve-emerald)]" />
              已根据你的情况定制专属课程
            </div>
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={handleSubmit}
              className="flex w-full items-center justify-center gap-2 rounded-full bg-[var(--ve-accent-solid)] px-5 py-3 text-[13.5px] font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
            >
              <span>{card.ctaLabel || `开始我的 ${card.topic} 课程`}</span>
              <ArrowRight size={15} />
            </button>
          )}
        </div>
      </div>

      {card.footerNote && (
        <p className="text-[13.5px] leading-relaxed text-[var(--ve-ink)]">
          {card.footerNote}
        </p>
      )}
    </div>
  );
}
