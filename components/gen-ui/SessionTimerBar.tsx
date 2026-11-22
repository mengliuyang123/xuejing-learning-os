"use client";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Pause,
  Play,
  Timer,
  Zap,
} from "lucide-react";
import { TRANSITION_FAST } from "../../lib/motion";

export default function SessionTimerBar({
  plannedMinutes,
  paceFactor = 1.0,
  compact = false,
  onFinish,
}: {
  plannedMinutes: number;
  paceFactor?: number;
  compact?: boolean;
  onFinish: (data: {
    actualMinutes: number;
    interruptions: number;
    energy: "high" | "medium" | "low";
  }) => void;
}) {
  const [running, setRunning] = useState(true);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [interruptions, setInterruptions] = useState(0);
  const [energy, setEnergy] = useState<"high" | "medium" | "low">("medium");
  const [showFinish, setShowFinish] = useState(false);
  const [manualMin, setManualMin] = useState<string>("");
  const [savedNote, setSavedNote] = useState<string | null>(null);

  useEffect(() => {
    if (!running || savedNote) return;
    const t = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running, savedNote]);

  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;
  const elapsedMinDisplay = Math.max(1, Math.round(elapsedSec / 60));
  const isOvertime = elapsedSec > plannedMinutes * 60;

  function submitFinish() {
    const actual = manualMin.trim()
      ? Math.max(1, Math.min(240, Number(manualMin)))
      : elapsedMinDisplay;
    onFinish({ actualMinutes: actual, interruptions, energy });
    setRunning(false);
    setShowFinish(false);
    setSavedNote(
      actual > plannedMinutes * 1.25
        ? `已记 ${actual}m（已校准节奏）`
        : `已记学习 ${actual} 分钟`,
    );
  }

  if (compact) {
    return (
      <div className="relative flex items-center gap-1.5 text-xs">
        <span
          className={
            "inline-flex items-center gap-1 rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2 py-0.5 font-mono text-[11px] font-medium " +
            (isOvertime ? "text-[var(--ve-amber)]" : "text-[var(--ve-ink)]")
          }
          title={`计划 ${plannedMinutes} 分钟${paceFactor !== 1 ? ` · 节奏 ${paceFactor}x` : ""}`}
        >
          <Timer size={12} className="text-[var(--ve-accent)]" aria-hidden="true" />
          {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
          <span className="text-[var(--ve-muted)]">/ {plannedMinutes}m</span>
          {interruptions > 0 && (
            <span className="ml-0.5 rounded bg-[var(--ve-amber-soft)] px-1 text-[10px] text-[var(--ve-amber)]">
              打断{interruptions}
            </span>
          )}
        </span>

        {savedNote ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--ve-emerald)]">
            <CheckCircle2 size={12} aria-hidden="true" /> {savedNote}
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setRunning((r) => !r)}
              title={running ? "暂停计时" : "继续计时"}
              aria-label={running ? "暂停计时" : "继续计时"}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
            >
              {running ? <Pause size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowFinish((v) => !v);
                setManualMin(String(Math.max(elapsedMinDisplay, plannedMinutes)));
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2 text-[11px] font-medium text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
            >
              <Clock3 size={11} aria-hidden="true" /> 结课
            </button>
          </>
        )}

        <AnimatePresence>
          {showFinish && !savedNote && (
            <>
              <div
                className="fixed inset-0 z-30"
                onClick={() => setShowFinish(false)}
              />
              <motion.div
                key="timer-finish-popover"
                initial={{ opacity: 0, y: -4, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.985 }}
                transition={TRANSITION_FAST}
                className="absolute top-full right-0 z-40 mt-1.5 w-[272px] space-y-2.5 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-3.5 shadow-xl"
              >
                <div className="flex items-center justify-between text-[11.5px] font-semibold text-[var(--ve-ink)]">
                  <span>记录本次学习耗时</span>
                  <button
                    type="button"
                    onClick={() => setInterruptions((n) => n + 1)}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-1.5 py-0.5 text-[10.5px] font-normal text-[var(--ve-muted)] transition hover:border-[var(--ve-accent)] hover:text-[var(--ve-ink)]"
                  >
                    <AlertCircle size={10} aria-hidden="true" /> 记打断 ({interruptions})
                  </button>
                </div>
                <label className="flex items-center justify-between gap-2 text-[11.5px] text-[var(--ve-muted)]">
                  <span>实际耗时（分钟）</span>
                  <input
                    type="number"
                    min={1}
                    max={240}
                    value={manualMin}
                    onChange={(e) => setManualMin(e.target.value)}
                    className="w-20 rounded-md border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-2 py-1 font-mono text-xs text-[var(--ve-ink)] tabular-nums"
                  />
                </label>
                <div className="flex items-center justify-between gap-1 text-[11.5px] text-[var(--ve-muted)]">
                  <span className="inline-flex items-center gap-1">
                    <Zap size={11} aria-hidden="true" /> 精力状态
                  </span>
                  <div className="flex items-center gap-1">
                    {(
                      [
                        ["high", "充沛"],
                        ["medium", "一般"],
                        ["low", "疲惫"],
                      ] as const
                    ).map(([k, lbl]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setEnergy(k)}
                        className={
                          "rounded-md px-2 py-0.5 text-[11px] font-medium transition " +
                          (energy === k
                            ? "bg-[var(--ve-accent)] text-white"
                            : "bg-[var(--ve-surface-alt)] text-[var(--ve-muted)] hover:text-[var(--ve-ink)]")
                        }
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={submitFinish}
                  className="w-full rounded-lg bg-[var(--ve-accent)] px-3 py-1.5 text-[11.5px] font-semibold text-white transition hover:opacity-90"
                >
                  保存并校准后续节奏
                </button>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="border-b border-[var(--ve-border)] bg-[var(--ve-canvas)] px-5 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={
              "inline-flex items-center gap-1.5 font-mono font-semibold " +
              (isOvertime ? "text-[var(--ve-amber)]" : "text-[var(--ve-ink)]")
            }
          >
            <Timer size={14} className="text-[var(--ve-accent)]" aria-hidden="true" />
            {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
          </span>
          <span className="text-[11px] text-[var(--ve-muted)]">
            计划 {plannedMinutes} 分钟
            {paceFactor !== 1 ? ` · 个人节奏 ${paceFactor}x` : ""}
          </span>
          {interruptions > 0 && (
            <span className="rounded bg-[var(--ve-amber-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ve-amber)]">
              打断 {interruptions} 次
            </span>
          )}
        </div>

        {savedNote ? (
          <span className="inline-flex items-center gap-1 font-medium text-[var(--ve-emerald)]">
            <CheckCircle2 size={13} aria-hidden="true" /> {savedNote}
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setRunning((r) => !r)}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2 py-1 text-[11px] text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
            >
              {running ? <Pause size={11} aria-hidden="true" /> : <Play size={11} aria-hidden="true" />}
              {running ? "暂停" : "继续"}
            </button>
            <button
              type="button"
              onClick={() => setInterruptions((n) => n + 1)}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2 py-1 text-[11px] text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
              title="记录一次分心或中途打断"
            >
              <AlertCircle size={11} aria-hidden="true" /> 记打断
            </button>
            <button
              type="button"
              onClick={() => {
                setShowFinish((v) => !v);
                setManualMin(String(Math.max(elapsedMinDisplay, plannedMinutes)));
              }}
              className="inline-flex items-center gap-1 rounded-md bg-[var(--ve-accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ve-accent)] hover:opacity-90"
            >
              <Clock3 size={11} aria-hidden="true" /> 结课记时
            </button>
          </div>
        )}
      </div>

      {showFinish && !savedNote && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] p-2.5">
          <label className="flex items-center gap-1.5 text-[11px] text-[var(--ve-muted)]">
            实际耗时（分钟）
            <input
              type="number"
              min={1}
              max={240}
              value={manualMin}
              onChange={(e) => setManualMin(e.target.value)}
              className="!w-16 !px-2 !py-1 text-xs"
            />
          </label>
          <div className="flex items-center gap-1 text-[11px] text-[var(--ve-muted)]">
            <Zap size={11} aria-hidden="true" /> 精力：
            {(
              [
                ["high", "充沛"],
                ["medium", "一般"],
                ["low", "疲惫"],
              ] as const
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                onClick={() => setEnergy(k)}
                className={
                  "rounded px-2 py-0.5 text-[11px] " +
                  (energy === k
                    ? "bg-[var(--ve-accent)] text-white"
                    : "bg-[var(--ve-surface-alt)] text-[var(--ve-muted)]")
                }
              >
                {lbl}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={submitFinish}
            className="ml-auto rounded-md bg-[var(--ve-accent)] px-3 py-1 text-[11px] font-semibold text-white hover:opacity-90"
          >
            保存并校准后续节奏
          </button>
        </div>
      )}
    </div>
  );
}
