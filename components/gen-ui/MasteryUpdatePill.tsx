"use client";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  CalendarClock,
  CheckCircle2,
  GitFork,
  Lightbulb,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { MasteryNextStep, MasteryUpdateCard } from "../../lib/learning";

function masteryStageLabel(score: number): string {
  if (score >= 80) return "熟练掌握";
  if (score >= 65) return "实战应用";
  if (score >= 35) return "理解原理";
  return "初识概念";
}

export default function MasteryUpdatePill({
  card,
  onOpenGraph,
  onSelectNextStep,
}: {
  card: MasteryUpdateCard;
  onOpenGraph?: (lessonId?: string) => void;
  onSelectNextStep?: (step: MasteryNextStep) => void;
}) {
  const [barWidth, setBarWidth] = useState(card.before);
  const improved = card.after >= card.before;
  const delta = card.after - card.before;
  const stageBefore = masteryStageLabel(card.before);
  const stageAfter = masteryStageLabel(card.after);
  const stageUpgraded = stageBefore !== stageAfter && improved;

  useEffect(() => {
    const t = setTimeout(() => setBarWidth(card.after), 90);
    return () => clearTimeout(t);
  }, [card.after]);

  return (
    <div
      className={
        "overflow-hidden rounded-2xl border p-4 text-xs shadow-2xs transition-all duration-300 " +
        (card.correct
          ? "border-[var(--ve-emerald)]/35 bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]"
          : "border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] text-[var(--ve-amber)]")
      }
    >
      {/* Header: Lesson + Mastery Delta + Cognitive Stage + FSRS Stability */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 font-semibold">
          {card.correct ? (
            <CheckCircle2 size={16} className="text-[var(--ve-emerald)]" />
          ) : (
            <TrendingDown size={16} className="text-amber-600" />
          )}
          <span className="text-[13px]">{card.lessonTitle}</span>
          {card.checkMode && (
            <span className="rounded-md border border-black/10 bg-white/80 px-1.5 py-0.2 text-[10px] font-medium text-[var(--ve-ink)]">
              {card.checkMode}
            </span>
          )}
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--ve-surface)]/95 px-2.5 py-0.5 font-mono text-[11px] shadow-2xs">
            <span>{card.before}%</span>
            <ArrowRight size={10} />
            <strong
              className={improved ? "text-[var(--ve-emerald)]" : "text-[var(--ve-amber)]"}
            >
              {card.after}%
            </strong>
            <span
              className={
                "text-[10px] font-bold " +
                (improved ? "text-[var(--ve-emerald)]" : "text-amber-600")
              }
            >
              ({delta >= 0 ? `+${delta}%` : `${delta}%`})
            </span>
            {improved && <TrendingUp size={10} className="text-[var(--ve-emerald)]" />}
          </span>

          <span className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-[10.5px] font-medium text-[var(--ve-ink)]">
            <span>{stageBefore}</span>
            {stageUpgraded && (
              <>
                <ArrowRight size={9} />
                <strong className="text-[var(--ve-emerald)]">{stageAfter}</strong>
              </>
            )}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] opacity-85">
          {card.stabilityBefore !== undefined &&
            card.stabilityAfter !== undefined && (
              <span className="inline-flex items-center gap-1 rounded-md bg-[var(--ve-surface)]/80 px-2 py-0.5">
                <Brain size={11} />
                稳定期 {card.stabilityBefore.toFixed(1)}d →{" "}
                <strong>{card.stabilityAfter.toFixed(1)}d</strong>
              </span>
            )}
          <span className="inline-flex items-center gap-1">
            <CalendarClock size={12} /> FSRS 下次复习{" "}
            {card.nextReviewDay.slice(5)}
          </span>
        </div>
      </div>

      {/* Explanatory state-change progress bar with 80% mastery threshold marker */}
      <div className="relative mt-3 h-2.5 w-full overflow-hidden rounded-full bg-white/85">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-black/10"
          style={{ width: `${card.before}%` }}
        />
        <div
          className={
            "h-full rounded-full transition-all duration-700 ease-out " +
            (card.correct ? "bg-emerald-500" : "bg-amber-500")
          }
          style={{ width: `${barWidth}%` }}
        />
        <div
          title="80% 解锁下游先修节点阈值"
          className="absolute inset-y-0 left-[80%] w-0.5 bg-black/25"
        />
      </div>

      {/* Overall assessment summary */}
      <p className="mt-2.5 text-[12.5px] font-medium leading-relaxed opacity-95">
        {card.summary}
      </p>

      {/* Structured Diagnostic Breakdown (Strength / Misconception / Key Takeaway) */}
      {card.diagnostic &&
        (card.diagnostic.strength ||
          card.diagnostic.misconception ||
          card.diagnostic.keyTakeaway) && (
          <div className="mt-3 grid gap-2 rounded-xl border border-black/5 bg-white/85 p-3 text-[11.5px] leading-relaxed text-[var(--ve-ink)]">
            {card.diagnostic.strength && (
              <div className="flex items-start gap-2">
                <Target
                  size={13}
                  className="mt-0.5 shrink-0 text-[var(--ve-emerald)]"
                />
                <div>
                  <strong className="text-[var(--ve-emerald)]">掌握亮点：</strong>
                  <span>{card.diagnostic.strength}</span>
                </div>
              </div>
            )}
            {card.diagnostic.misconception && (
              <div className="flex items-start gap-2">
                <AlertTriangle
                  size={13}
                  className="mt-0.5 shrink-0 text-amber-600"
                />
                <div>
                  <strong className="text-[var(--ve-amber)]">薄弱点与纠正：</strong>
                  <span>{card.diagnostic.misconception}</span>
                </div>
              </div>
            )}
            {card.diagnostic.keyTakeaway && (
              <div className="flex items-start gap-2">
                <Lightbulb
                  size={13}
                  className="mt-0.5 shrink-0 text-[var(--ve-accent)]"
                />
                <div>
                  <strong className="text-[var(--ve-accent)]">核心记忆锚点：</strong>
                  <span>{card.diagnostic.keyTakeaway}</span>
                </div>
              </div>
            )}
          </div>
        )}

      {/* Remediation Micro-Lesson Auto-Schedule Notice */}
      {card.remediationTriggered && (
        <div className="mt-2.5 flex items-center gap-2 rounded-xl border border-amber-300/80 bg-amber-100/70 px-3 py-2 text-[11.5px] font-medium text-[var(--ve-amber)]">
          <AlertTriangle size={13} className="shrink-0 text-[var(--ve-amber)]" />
          <span>
            检测到连续薄弱点：系统已自动在日历中排入 20 分钟「{card.lessonTitle} · 降难补救微课」，并顺延下游依赖课程。
          </span>
        </div>
      )}

      {/* Unlocked Downstream Nodes in Knowledge Graph */}
      {card.unlockedTitles.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200/90 bg-white/90 px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--ve-emerald)]">
            <Sparkles size={13} className="text-[var(--ve-emerald)]" />
            先修达标（≥80%），已点亮下游节点：{card.unlockedTitles.join("、")}
          </span>
          {onOpenGraph && (
            <button
              type="button"
              onClick={() => onOpenGraph(card.lessonId)}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--ve-accent)] hover:underline"
            >
              <GitFork size={11} /> 在图谱中聚焦
            </button>
          )}
        </div>
      )}

      {/* Next-step actionable recommendations across diverse exercise formats */}
      {card.nextSteps && card.nextSteps.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-black/5 pt-2.5">
          <span className="text-[11px] font-medium opacity-75">
            下一步行动：
          </span>
          {card.nextSteps.map((step, i) => (
            <button
              key={`${step.label}-${i}`}
              type="button"
              onClick={() => {
                if (step.openGraph) {
                  onOpenGraph?.(step.targetLessonId || card.lessonId);
                } else {
                  onSelectNextStep?.(step);
                }
              }}
              className={
                "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition " +
                (i === 0 && !step.openGraph
                  ? "bg-[var(--ve-accent-solid)] text-white hover:bg-[#1f2937]"
                  : "border border-black/10 bg-white/90 text-[var(--ve-ink)] hover:bg-white")
              }
            >
              {step.openGraph ? (
                <GitFork size={11} />
              ) : (
                <ArrowRight size={11} />
              )}
              {step.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
