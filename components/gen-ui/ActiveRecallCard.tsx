"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Brain, Check, Eye, RotateCcw, Sparkles } from "lucide-react";
import type { ActiveRecallCardData } from "../../lib/learning";
import type { FSRSRating } from "../../lib/bkt-fsrs";
import { TRANSITION_FAST, TRANSITION_STATE } from "../../lib/motion";

const RATING_TONE: Record<FSRSRating, string> = {
  1: "border-[var(--ve-rose)]/35 bg-[var(--ve-rose-soft)] text-[var(--ve-rose)] hover:border-[var(--ve-rose)]",
  2: "border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] text-[var(--ve-amber)] hover:border-[var(--ve-amber)]",
  3: "border-[var(--ve-accent)]/35 bg-[var(--ve-accent-soft)] text-[var(--ve-accent)] hover:border-[var(--ve-accent)]",
  4: "border-[var(--ve-emerald)]/35 bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)] hover:border-[var(--ve-emerald)]",
};

export default function ActiveRecallCard({
  card,
  onRate,
}: {
  card: ActiveRecallCardData;
  onRate: (lessonId: string, rating: FSRSRating) => {
    after: number;
    nextReviewDay: string;
    nextIntervalDays: number;
  } | null;
}) {
  const [revealed, setRevealed] = useState(false);
  const [result, setResult] = useState<{
    rating: FSRSRating;
    after: number;
    nextReviewDay: string;
    nextIntervalDays: number;
  } | null>(null);

  const retentionBadge =
    card.retrievability >= 85
      ? "bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]"
      : card.retrievability >= 65
        ? "bg-[var(--ve-amber-soft)] text-[var(--ve-amber)]"
        : "bg-[var(--ve-rose-soft)] text-[var(--ve-rose)]";

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)]">
      {/* Flashcard Top Strip */}
      <div className="flex items-center justify-between gap-2 border-b border-[var(--ve-border)] bg-[var(--ve-canvas)] px-4 py-2.5">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--ve-ink)]">
          <RotateCcw size={13} className="text-[var(--ve-accent)]" aria-hidden="true" />
          <span>{card.trackTitle}</span>
          <span className="font-normal text-[var(--ve-muted)]">
            · 稳定 {card.stabilityDays} 天
          </span>
        </span>
        <span
          className={
            "rounded-md px-2 py-0.5 font-mono text-[11px] font-semibold " +
            retentionBadge
          }
        >
          保持率 {card.retrievability}%
        </span>
      </div>

      {/* Question Face */}
      <div className="space-y-4 p-5">
        <div>
          <h4 className="text-[17px] font-bold leading-snug tracking-tight text-[var(--ve-ink)]">
            {card.title}
          </h4>
          <p className="mt-3 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-4 py-3.5 text-[14px] leading-relaxed text-[var(--ve-ink)]">
            {card.question}
          </p>
        </div>

        {/* Flip / Reveal Answer Area */}
        <AnimatePresence initial={false} mode="wait">
          {!revealed ? (
            <motion.button
              key="reveal-btn"
              type="button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={TRANSITION_FAST}
              whileTap={{ scale: 0.99 }}
              onClick={() => setRevealed(true)}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--ve-accent)] px-4 py-2.5 text-xs font-semibold text-white transition hover:opacity-92"
            >
              <Eye size={14} aria-hidden="true" /> 先在脑海回忆，点击翻面查看解析
            </motion.button>
          ) : (
            <motion.div
              key="answer-face"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={TRANSITION_STATE}
              style={{ overflow: "hidden" }}
            >
              <div className="space-y-3.5 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-4">
                <div className="text-[13.5px] leading-relaxed text-[var(--ve-ink)]">
                  <strong className="text-[var(--ve-accent)]">核心要点：</strong>
                  {card.answerConcept}
                </div>
                {card.example && (
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] p-3 font-mono text-xs leading-relaxed text-[var(--ve-ink)]">
                    {card.example}
                  </pre>
                )}

                <AnimatePresence initial={false} mode="wait">
                  {result ? (
                    <motion.div
                      key="rated-result"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={TRANSITION_FAST}
                      className="space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--ve-emerald-soft)] px-3.5 py-2.5 text-xs text-[var(--ve-emerald)]">
                        <span className="inline-flex items-center gap-1.5 font-semibold">
                          <Check size={14} aria-hidden="true" /> 已更新掌握度至{" "}
                          {result.after}%
                        </span>
                        <span className="font-mono font-semibold">
                          下次复习 {result.nextReviewDay.slice(5)}（
                          {result.nextIntervalDays} 天后）
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-[var(--ve-muted)]">
                        <Sparkles
                          size={12}
                          className="text-[var(--ve-accent)]"
                          aria-hidden="true"
                        />
                        知识图谱与记忆曲线已同步更新。
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="rating-controls"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={TRANSITION_FAST}
                    >
                      <div className="mb-2 flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--ve-muted)]">
                        <Brain size={12} aria-hidden="true" />{" "}
                        按刚才回忆的顺畅度打分：
                      </div>
                      <div className="grid grid-cols-4 gap-2">
                        {card.ratingPreviews.map((item) => (
                          <motion.button
                            key={item.rating}
                            type="button"
                            whileTap={{ scale: 0.97 }}
                            onClick={() => {
                              const res = onRate(card.lessonId, item.rating);
                              if (res) {
                                setResult({ rating: item.rating, ...res });
                              }
                            }}
                            className={
                              "flex flex-col items-center rounded-lg border px-2 py-2.5 text-center transition " +
                              RATING_TONE[item.rating]
                            }
                          >
                            <span className="text-xs font-semibold">
                              {item.label}
                            </span>
                            <span className="mt-0.5 font-mono text-[10.5px] opacity-80">
                              {item.intervalDays} 天后
                            </span>
                          </motion.button>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
