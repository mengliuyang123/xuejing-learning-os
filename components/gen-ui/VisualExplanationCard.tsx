"use client";
import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Layers,
  Sparkles,
} from "lucide-react";
import type { VisualExplanationCardData } from "../../lib/learning";
import BeautifulMermaidCanvas from "./BeautifulMermaidCanvas";
import SandboxedSvgCanvas from "./SandboxedSvgCanvas";
import {
  InteractiveTimelineWidget,
  ParameterSimulatorWidget,
} from "./InteractiveVisualWidgets";

const STEP_STORAGE_PREFIX = "xushi.ve-step.v1:";

function ControlledWidgetSlot({
  widget,
  activeStepIndex,
  onSelectStep,
}: {
  widget: NonNullable<VisualExplanationCardData["widget"]>;
  activeStepIndex: number | null;
  onSelectStep?: (idx: number) => void;
}) {
  const cfg = widget.config || {};
  if (widget.widgetType === "timeline") {
    return (
      <InteractiveTimelineWidget
        config={cfg}
        activeStepIndex={activeStepIndex}
        onSelectStep={onSelectStep}
      />
    );
  }
  return <ParameterSimulatorWidget config={cfg} />;
}

export default function VisualExplanationCard({
  card,
  compact = false,
}: {
  card: VisualExplanationCardData;
  compact?: boolean;
}) {
  const steps = useMemo(
    () => (Array.isArray(card.steps) && card.steps.length > 0 ? card.steps : []),
    [card.steps],
  );
  const hasSteps = steps.length > 0;
  const storageKey = `${STEP_STORAGE_PREFIX}${card.visualId}`;

  // Step state: 0..steps.length-1 = specific step, null = show full overview
  const [stepIdx, setStepIdx] = useState<number | null>(() => {
    if (!hasSteps) return null;
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved === "all") return null;
      if (saved !== null) {
        const n = parseInt(saved, 10);
        if (Number.isInteger(n) && n >= 0 && n < steps.length) return n;
      }
    } catch {}
    return 0;
  });

  useEffect(() => {
    if (!hasSteps) return;
    try {
      sessionStorage.setItem(
        storageKey,
        stepIdx === null ? "all" : String(stepIdx),
      );
    } catch {}
  }, [hasSteps, stepIdx, storageKey]);

  const currentStep =
    hasSteps && stepIdx !== null ? steps[stepIdx] || steps[0] : null;
  const activeStepNumber = currentStep ? currentStep.stepNumber : null;

  // For Mermaid: per-step progressive sub-diagram when stepping; richest panoramic diagram in overview mode
  const lastStepMermaid =
    hasSteps && steps[steps.length - 1]?.mermaid?.trim()
      ? steps[steps.length - 1].mermaid!.trim()
      : "";
  const overviewMermaid =
    card.mermaid && lastStepMermaid && lastStepMermaid.length > card.mermaid.trim().length * 1.25
      ? lastStepMermaid
      : card.mermaid || lastStepMermaid;
  const effectiveMermaid =
    (currentStep?.mermaid && currentStep.mermaid.trim()) || overviewMermaid || "";

  const typeLabel =
    card.visualType === "svg"
      ? "矢量图解"
      : card.visualType === "interactive_widget"
        ? "受控交互视图"
        : "结构图解";

  return (
    <div
      className={
        "my-3 rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-surface)] transition-colors " +
        (compact ? "p-3.5" : "p-4 sm:p-5")
      }
    >
      {/* Clean minimal header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-md bg-[var(--ve-accent-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--ve-accent)]">
              <Sparkles size={11} />
              {typeLabel}
            </span>
            {hasSteps && (
              <span className="inline-flex items-center gap-1 rounded-md bg-[var(--ve-surface-alt)] px-2 py-0.5 font-mono text-[10.5px] font-medium text-[var(--ve-muted)]">
                <Layers size={10} />
                {stepIdx === null
                  ? `全景 (${steps.length}步)`
                  : `步骤 ${stepIdx + 1} / ${steps.length}`}
              </span>
            )}
            {card.cacheHit && (
              <span className="rounded-md bg-[var(--ve-emerald-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ve-emerald)]">
                已缓存复用
              </span>
            )}
          </div>
          <h3 className="mt-1.5 text-[14px] font-semibold leading-snug text-[var(--ve-ink)]">
            {card.title}
          </h3>
          {card.summary && (
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--ve-muted)]">
              {card.summary}
            </p>
          )}
        </div>
      </div>

      {/* Main Visual Canvas (Level 1 Mermaid / Level 2 Purified SVG / Level 3 Controlled Widget) */}
      {card.visualType === "svg" && card.svg ? (
        <SandboxedSvgCanvas
          svg={card.svg}
          activeStep={activeStepNumber}
          highlightIds={currentStep?.highlightIds}
          caption={card.caption}
        />
      ) : card.visualType === "interactive_widget" && card.widget ? (
        <ControlledWidgetSlot
          widget={card.widget}
          activeStepIndex={stepIdx}
          onSelectStep={hasSteps ? (idx) => setStepIdx(idx) : undefined}
        />
      ) : effectiveMermaid ? (
        <BeautifulMermaidCanvas
          code={effectiveMermaid}
          caption={card.caption}
        />
      ) : null}

      {/* Progressive Step-by-Step Controls & Narrative */}
      {hasSteps && (
        <div className="mt-3 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-3">
          {currentStep ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--ve-ink)]">
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--ve-accent)] px-1.5 font-mono text-[10.5px] text-white">
                  {currentStep.stepNumber}
                </span>
                <span>{currentStep.title}</span>
              </div>
              <p className="pl-7 text-xs leading-relaxed text-[var(--ve-muted)]">
                {currentStep.explanation}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {steps.map((s) => (
                <div
                  key={s.stepNumber}
                  className="flex items-start gap-2 text-xs"
                >
                  <span className="mt-0.5 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--ve-surface-alt)] px-1 font-mono text-[10px] font-semibold text-[var(--ve-accent)]">
                    {s.stepNumber}
                  </span>
                  <div className="min-w-0">
                    <span className="font-semibold text-[var(--ve-ink)]">
                      {s.title}：
                    </span>
                    <span className="text-[var(--ve-muted)]">
                      {s.explanation}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--ve-border)]/70 pt-2.5">
            <div className="flex flex-wrap items-center gap-1">
              {steps.map((s, idx) => {
                const active = stepIdx === idx;
                return (
                  <button
                    key={s.stepNumber}
                    type="button"
                    onClick={() => setStepIdx(idx)}
                    className={
                      "h-6 min-w-6 rounded-md px-1.5 font-mono text-[11px] font-medium transition " +
                      (active
                        ? "bg-[var(--ve-accent)] text-white"
                        : "bg-[var(--ve-surface)] text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]")
                    }
                    title={s.title}
                  >
                    {idx + 1}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setStepIdx(null)}
                className={
                  "rounded-md px-2 py-1 text-[11px] font-medium transition " +
                  (stepIdx === null
                    ? "bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]"
                    : "text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]")
                }
              >
                全部全景
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={stepIdx === null ? false : stepIdx <= 0}
                onClick={() =>
                  setStepIdx((prev) =>
                    prev === null ? steps.length - 1 : Math.max(0, prev - 1),
                  )
                }
                className="inline-flex items-center gap-1 rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)] disabled:opacity-40"
              >
                <ChevronLeft size={12} /> 上一步
              </button>
              <button
                type="button"
                disabled={stepIdx !== null && stepIdx >= steps.length - 1}
                onClick={() =>
                  setStepIdx((prev) =>
                    prev === null
                      ? 0
                      : Math.min(steps.length - 1, prev + 1),
                  )
                }
                className="inline-flex items-center gap-1 rounded-md bg-[var(--ve-accent)] px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
              >
                下一步 <ChevronRight size={12} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
