"use client";
import { useEffect, useId, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Lightbulb,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { safeEvaluateMath } from "../../lib/safe-math-eval";
import { SPRING_CRISP, TRANSITION_FAST, TRANSITION_STATE } from "../../lib/motion";

export interface TimelineWidgetEvent {
  time?: string;
  label?: string;
  detail?: string;
  cause?: string;
  impact?: string;
  keyTakeaway?: string;
  tags?: string[];
}

export interface ParameterWidgetParam {
  name: string;
  key?: string;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  unit?: string;
  effect?: string;
}

export interface ParameterWidgetOutput {
  label: string;
  formula: string;
  unit?: string;
  precision?: number;
  min?: number;
  max?: number;
  warnAbove?: number;
  warnBelow?: number;
  description?: string;
}

export interface ParameterWidgetCurve {
  title?: string;
  xVar: string;
  xMin: number;
  xMax: number;
  xLabel?: string;
  yLabel?: string;
  yFormula: string;
  markerXVar?: string;
}

export interface ParameterWidgetPreset {
  label: string;
  values: Record<string, number>;
  note?: string;
}

function deriveParamKey(p: ParameterWidgetParam, index: number): string {
  if (p.key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(p.key.trim())) {
    return p.key.trim();
  }
  const ascii = p.name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (ascii && /^[A-Za-z_]/.test(ascii)) return ascii;
  return `p${index + 1}`;
}

function formatNumber(n: number, precision = 2): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 10000) return n.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
  const p = Math.max(0, Math.min(4, Math.trunc(precision)));
  return Number(n.toFixed(p)).toString();
}

/**
 * Level 3 Controlled Interactive Widget #1: Clickable Timeline / Stage Evolution
 * Works for History, Algorithm Traces, System Lifecycles, Biology/Physics Stages.
 */
export function InteractiveTimelineWidget({
  config,
  activeStepIndex,
  onSelectStep,
}: {
  config: Record<string, unknown>;
  activeStepIndex: number | null;
  onSelectStep?: (idx: number) => void;
}) {
  const railId = useId();
  const events = useMemo<TimelineWidgetEvent[]>(() => {
    if (!Array.isArray(config.events)) return [];
    return config.events
      .filter((e): e is Record<string, unknown> => Boolean(e && typeof e === "object"))
      .map((e, idx) => ({
        time: typeof e.time === "string" && e.time.trim() ? e.time.trim() : `阶段 ${idx + 1}`,
        label: typeof e.label === "string" && e.label.trim() ? e.label.trim() : `节点 ${idx + 1}`,
        detail: typeof e.detail === "string" ? e.detail.trim() : "",
        cause: typeof e.cause === "string" && e.cause.trim() ? e.cause.trim() : undefined,
        impact: typeof e.impact === "string" && e.impact.trim() ? e.impact.trim() : undefined,
        keyTakeaway:
          typeof e.keyTakeaway === "string" && e.keyTakeaway.trim()
            ? e.keyTakeaway.trim()
            : undefined,
        tags: Array.isArray(e.tags)
          ? e.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 4)
          : undefined,
      }));
  }, [config.events]);

  const [localIdx, setLocalIdx] = useState(0);

  useEffect(() => {
    if (
      activeStepIndex !== null &&
      activeStepIndex >= 0 &&
      activeStepIndex < events.length
    ) {
      setLocalIdx(activeStepIndex);
    }
  }, [activeStepIndex, events.length]);

  if (events.length === 0) return null;

  const currentIdx = Math.max(0, Math.min(events.length - 1, localIdx));
  const current = events[currentIdx];
  const progressPct =
    events.length > 1 ? (currentIdx / (events.length - 1)) * 100 : 100;

  function selectIdx(next: number) {
    const clamped = Math.max(0, Math.min(events.length - 1, next));
    setLocalIdx(clamped);
    onSelectStep?.(clamped);
  }

  return (
    <div
      className="my-3 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-3.5 sm:p-4"
      data-testid="level3-timeline-widget"
    >
      {/* Top interactive scrub rail */}
      <div className="flex items-center justify-between gap-2 pb-2.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[var(--ve-muted)]">
          <Clock3 size={12} className="text-[var(--ve-accent)]" aria-hidden="true" />
          交互时间线 · 点击节点探索演进
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={currentIdx <= 0}
            onClick={() => selectIdx(currentIdx - 1)}
            aria-label="上一节点"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-ink)] transition hover:border-[var(--ve-accent)] disabled:opacity-35"
          >
            <ChevronLeft size={12} aria-hidden="true" />
          </button>
          <span className="min-w-[44px] text-center font-mono text-[11px] font-medium text-[var(--ve-muted)] tabular-nums">
            {currentIdx + 1} / {events.length}
          </span>
          <button
            type="button"
            disabled={currentIdx >= events.length - 1}
            onClick={() => selectIdx(currentIdx + 1)}
            aria-label="下一节点"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-ink)] transition hover:border-[var(--ve-accent)] disabled:opacity-35"
          >
            <ChevronRight size={12} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Horizontal clickable nodes with animated progress track */}
      <div className="relative overflow-x-auto pb-2">
        <div className="relative flex min-w-max items-start gap-2 px-1 pt-2">
          {/* Background + active progress rail */}
          <div
            className="pointer-events-none absolute top-[18px] right-6 left-6 h-[2px] rounded-full bg-[var(--ve-border)]"
            aria-hidden="true"
          >
            <motion.div
              className="h-full rounded-full bg-[var(--ve-accent)]"
              initial={false}
              animate={{ width: `${progressPct}%` }}
              transition={SPRING_CRISP}
            />
          </div>

          {events.map((ev, idx) => {
            const isSelected = idx === currentIdx;
            const isPast = idx < currentIdx;
            return (
              <button
                key={`${ev.time}-${idx}`}
                type="button"
                onClick={() => selectIdx(idx)}
                aria-current={isSelected ? "step" : undefined}
                className="group relative flex min-w-[104px] max-w-[152px] flex-1 flex-col items-center gap-1.5 rounded-lg px-2 py-1 text-center transition hover:bg-[var(--ve-surface)]/70"
              >
                <span className="relative flex h-5 w-5 items-center justify-center">
                  {isSelected && (
                    <motion.span
                      layoutId={`timeline-ring-${railId}`}
                      transition={SPRING_CRISP}
                      className="absolute inset-[-4px] rounded-full bg-[var(--ve-accent-soft)] ring-2 ring-[var(--ve-accent)]/40"
                    />
                  )}
                  <span
                    className={
                      "relative z-10 h-2.5 w-2.5 rounded-full border-2 transition-colors " +
                      (isSelected
                        ? "border-[var(--ve-accent)] bg-[var(--ve-accent)]"
                        : isPast
                          ? "border-[var(--ve-accent)] bg-[var(--ve-surface)]"
                          : "border-[var(--ve-line)] bg-[var(--ve-surface)]")
                    }
                  />
                </span>
                <span
                  className={
                    "font-mono text-[10.5px] font-semibold leading-tight " +
                    (isSelected ? "text-[var(--ve-accent)]" : "text-[var(--ve-muted)]")
                  }
                >
                  {ev.time}
                </span>
                <span
                  className={
                    "line-clamp-2 text-[11px] leading-snug " +
                    (isSelected
                      ? "font-semibold text-[var(--ve-ink)]"
                      : "text-[var(--ve-muted)] group-hover:text-[var(--ve-ink)]")
                  }
                >
                  {ev.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Animated Active Milestone Detail Card */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={currentIdx}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={TRANSITION_STATE}
          className="mt-2 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-3.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-[var(--ve-accent-soft)] px-2 py-0.5 font-mono text-[11px] font-semibold text-[var(--ve-accent)]">
                {current.time}
              </span>
              <h4 className="text-[13.5px] font-semibold text-[var(--ve-ink)]">
                {current.label}
              </h4>
            </div>
            {current.tags && current.tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                {current.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-md bg-[var(--ve-surface-alt)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ve-muted)]"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>

          {current.detail && (
            <p className="mt-2 text-xs leading-relaxed text-[var(--ve-ink)]/90">
              {current.detail}
            </p>
          )}

          {(current.cause || current.impact) && (
            <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {current.cause && (
                <div className="rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-2.5 py-2 text-[11.5px]">
                  <div className="text-[10px] font-semibold text-[var(--ve-muted)]">
                    触发背景
                  </div>
                  <p className="mt-0.5 leading-relaxed text-[var(--ve-ink)]">
                    {current.cause}
                  </p>
                </div>
              )}
              {current.impact && (
                <div className="rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-2.5 py-2 text-[11.5px]">
                  <div className="text-[10px] font-semibold text-[var(--ve-muted)]">
                    演进影响
                  </div>
                  <p className="mt-0.5 leading-relaxed text-[var(--ve-ink)]">
                    {current.impact}
                  </p>
                </div>
              )}
            </div>
          )}

          {current.keyTakeaway && (
            <div className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-[var(--ve-accent-soft)] px-2.5 py-2 text-[11.5px] text-[var(--ve-accent)]">
              <Lightbulb size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="leading-relaxed font-medium">
                {current.keyTakeaway}
              </span>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/**
 * Level 3 Controlled Interactive Widget #2: Deterministic Parameter Simulator & Curve Plotter
 * Zero eval/Function: every formula runs through `safeEvaluateMath`.
 */
export function ParameterSimulatorWidget({
  config,
}: {
  config: Record<string, unknown>;
}) {
  const params = useMemo(() => {
    if (!Array.isArray(config.parameters)) return [];
    return config.parameters
      .filter((p): p is ParameterWidgetParam =>
        Boolean(p && typeof p === "object" && typeof (p as ParameterWidgetParam).name === "string"),
      )
      .map((p, idx) => {
        const min = typeof p.min === "number" && Number.isFinite(p.min) ? p.min : 0;
        const max =
          typeof p.max === "number" && Number.isFinite(p.max) && p.max > min
            ? p.max
            : min + 100;
        const step =
          typeof p.step === "number" && Number.isFinite(p.step) && p.step > 0
            ? p.step
            : (max - min) / 20;
        const def =
          typeof p.defaultValue === "number" && Number.isFinite(p.defaultValue)
            ? Math.min(max, Math.max(min, p.defaultValue))
            : min;
        return {
          ...p,
          resolvedKey: deriveParamKey(p, idx),
          min,
          max,
          step,
          defaultValue: def,
        };
      });
  }, [config.parameters]);

  const outputs = useMemo<ParameterWidgetOutput[]>(() => {
    if (!Array.isArray(config.outputs)) return [];
    return config.outputs.filter(
      (o): o is ParameterWidgetOutput =>
        Boolean(
          o &&
            typeof o === "object" &&
            typeof (o as ParameterWidgetOutput).label === "string" &&
            typeof (o as ParameterWidgetOutput).formula === "string",
        ),
    );
  }, [config.outputs]);

  const presets = useMemo<ParameterWidgetPreset[]>(() => {
    if (!Array.isArray(config.presets)) return [];
    return config.presets.filter(
      (pr): pr is ParameterWidgetPreset =>
        Boolean(
          pr &&
            typeof pr === "object" &&
            typeof (pr as ParameterWidgetPreset).label === "string" &&
            (pr as ParameterWidgetPreset).values &&
            typeof (pr as ParameterWidgetPreset).values === "object",
        ),
    );
  }, [config.presets]);

  const curve = useMemo<ParameterWidgetCurve | null>(() => {
    const c = config.curve;
    if (!c || typeof c !== "object") return null;
    const raw = c as Partial<ParameterWidgetCurve>;
    if (
      typeof raw.xVar !== "string" ||
      !raw.xVar.trim() ||
      typeof raw.yFormula !== "string" ||
      !raw.yFormula.trim() ||
      typeof raw.xMin !== "number" ||
      typeof raw.xMax !== "number" ||
      raw.xMax <= raw.xMin
    ) {
      return null;
    }
    return raw as ParameterWidgetCurve;
  }, [config.curve]);

  const defaultMap = useMemo(() => {
    const init: Record<string, number> = {};
    for (const p of params) {
      init[p.resolvedKey] = p.defaultValue;
    }
    return init;
  }, [params]);

  const [values, setValues] = useState<Record<string, number>>(defaultMap);
  const [activePreset, setActivePreset] = useState<string | null>(null);

  // Build evaluation scope mapping both resolvedKey and display name aliases
  const evalVars = useMemo(() => {
    const scope: Record<string, number> = {};
    for (const p of params) {
      const v = values[p.resolvedKey] ?? p.defaultValue;
      scope[p.resolvedKey] = v;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name)) {
        scope[p.name] = v;
      }
    }
    return scope;
  }, [params, values]);

  const computedOutputs = useMemo(
    () =>
      outputs.map((out) => {
        const val = safeEvaluateMath(out.formula, evalVars);
        const isWarn =
          val !== null &&
          ((out.warnAbove !== undefined && val > out.warnAbove) ||
            (out.warnBelow !== undefined && val < out.warnBelow));
        let meterPct: number | null = null;
        if (
          val !== null &&
          typeof out.min === "number" &&
          typeof out.max === "number" &&
          out.max > out.min
        ) {
          meterPct = Math.max(
            0,
            Math.min(100, ((val - out.min) / (out.max - out.min)) * 100),
          );
        }
        return { out, val, isWarn, meterPct };
      }),
    [outputs, evalVars],
  );

  // Sample 64 deterministic points for optional live SVG curve
  const curvePlot = useMemo(() => {
    if (!curve) return null;
    const samples = 64;
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= samples; i++) {
      const x = curve.xMin + ((curve.xMax - curve.xMin) * i) / samples;
      const y = safeEvaluateMath(curve.yFormula, { ...evalVars, [curve.xVar]: x });
      if (y !== null) pts.push({ x, y });
    }
    if (pts.length < 2) return null;

    let yMin = Math.min(...pts.map((p) => p.y));
    let yMax = Math.max(...pts.map((p) => p.y));
    if (Math.abs(yMax - yMin) < 1e-6) {
      yMin -= 1;
      yMax += 1;
    } else {
      const pad = (yMax - yMin) * 0.1;
      yMin -= pad;
      yMax += pad;
    }

    const W = 560;
    const H = 190;
    const padL = 46;
    const padR = 18;
    const padT = 16;
    const padB = 30;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const toSvgX = (x: number) =>
      padL + ((x - curve.xMin) / (curve.xMax - curve.xMin)) * plotW;
    const toSvgY = (y: number) =>
      padT + (1 - (y - yMin) / (yMax - yMin)) * plotH;

    const linePath = pts
      .map(
        (p, idx) =>
          `${idx === 0 ? "M" : "L"}${toSvgX(p.x).toFixed(1)},${toSvgY(p.y).toFixed(1)}`,
      )
      .join(" ");
    const areaPath = `${linePath} L${toSvgX(pts[pts.length - 1].x).toFixed(1)},${(padT + plotH).toFixed(1)} L${toSvgX(pts[0].x).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

    let marker: { x: number; y: number; sx: number; sy: number } | null = null;
    if (curve.markerXVar && Object.hasOwn(evalVars, curve.markerXVar)) {
      const mx = evalVars[curve.markerXVar];
      if (mx >= curve.xMin && mx <= curve.xMax) {
        const my = safeEvaluateMath(curve.yFormula, {
          ...evalVars,
          [curve.xVar]: mx,
        });
        if (my !== null) {
          marker = { x: mx, y: my, sx: toSvgX(mx), sy: toSvgY(my) };
        }
      }
    }

    return {
      W,
      H,
      padL,
      padR,
      padT,
      padB,
      plotW,
      plotH,
      yMin,
      yMax,
      linePath,
      areaPath,
      marker,
    };
  }, [curve, evalVars]);

  function applyPreset(pr: ParameterWidgetPreset) {
    const next = { ...values };
    for (const p of params) {
      const candidate =
        pr.values[p.resolvedKey] ?? pr.values[p.name];
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        next[p.resolvedKey] = Math.min(p.max, Math.max(p.min, candidate));
      }
    }
    setValues(next);
    setActivePreset(pr.label);
  }

  function resetAll() {
    setValues(defaultMap);
    setActivePreset(null);
  }

  const activePresetObj = presets.find((pr) => pr.label === activePreset);

  return (
    <div
      className="my-3 space-y-3 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-3.5 sm:p-4"
      data-testid="level3-parameter-simulator"
    >
      {/* Header + Presets + Reset */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[var(--ve-muted)]">
          <SlidersHorizontal
            size={12}
            className="text-[var(--ve-accent)]"
            aria-hidden="true"
          />
          参数联动模拟 · 拖动滑块观察实时变化
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {presets.map((pr) => {
            const isActive = activePreset === pr.label;
            return (
              <button
                key={pr.label}
                type="button"
                onClick={() => applyPreset(pr)}
                className={
                  "rounded-md border px-2 py-0.5 text-[11px] font-medium transition " +
                  (isActive
                    ? "border-[var(--ve-accent)] bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]"
                    : "border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-muted)] hover:border-[var(--ve-accent)] hover:text-[var(--ve-ink)]")
                }
              >
                {pr.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={resetAll}
            title="恢复默认参数"
            className="inline-flex items-center gap-1 rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--ve-muted)] transition hover:text-[var(--ve-ink)]"
          >
            <RotateCcw size={10} aria-hidden="true" /> 重置
          </button>
        </div>
      </div>

      {activePresetObj?.note && (
        <motion.div
          initial={{ opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={TRANSITION_FAST}
          className="flex items-center gap-1.5 rounded-lg bg-[var(--ve-accent-soft)] px-2.5 py-1.5 text-[11px] text-[var(--ve-accent)]"
        >
          <Sparkles size={11} className="shrink-0" aria-hidden="true" />
          <span>{activePresetObj.note}</span>
        </motion.div>
      )}

      {/* Live Computed Output KPIs */}
      {computedOutputs.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {computedOutputs.map(({ out, val, isWarn, meterPct }) => (
            <div
              key={out.label}
              className={
                "rounded-lg border p-2.5 transition-colors " +
                (isWarn
                  ? "border-[var(--ve-amber)]/45 bg-[var(--ve-amber-soft)]"
                  : "border-[var(--ve-border)] bg-[var(--ve-surface)]")
              }
            >
              <div className="flex items-center justify-between gap-1 text-[11px] text-[var(--ve-muted)]">
                <span className="truncate font-medium">{out.label}</span>
                {isWarn && (
                  <AlertTriangle
                    size={12}
                    className="shrink-0 text-[var(--ve-amber)]"
                    aria-label="超出建议范围"
                  />
                )}
              </div>
              <div
                className={
                  "mt-1 font-mono text-base font-bold tabular-nums " +
                  (isWarn ? "text-[var(--ve-amber)]" : "text-[var(--ve-ink)]")
                }
              >
                {val !== null ? formatNumber(val, out.precision ?? 2) : "—"}
                {out.unit ? (
                  <span className="ml-1 text-[11px] font-medium text-[var(--ve-muted)]">
                    {out.unit}
                  </span>
                ) : null}
              </div>
              {meterPct !== null && (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--ve-surface-alt)]">
                  <motion.div
                    className={
                      "h-full rounded-full " +
                      (isWarn ? "bg-[var(--ve-amber)]" : "bg-[var(--ve-accent)]")
                    }
                    initial={false}
                    animate={{ width: `${meterPct}%` }}
                    transition={SPRING_CRISP}
                  />
                </div>
              )}
              {out.description && (
                <p className="mt-1 text-[10.5px] leading-snug text-[var(--ve-muted)]">
                  {out.description}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Optional Live SVG Response Curve */}
      {curve && curvePlot && (
        <div className="rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] p-3">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
            <span className="font-semibold text-[var(--ve-ink)]">
              {curve.title || `${curve.yLabel || "输出"} 随 ${curve.xLabel || curve.xVar} 变化曲线`}
            </span>
            {curvePlot.marker && (
              <span className="font-mono text-[10.5px] font-medium text-[var(--ve-accent)] tabular-nums">
                ({formatNumber(curvePlot.marker.x, 2)}, {formatNumber(curvePlot.marker.y, 2)})
              </span>
            )}
          </div>
          <svg
            viewBox={`0 0 ${curvePlot.W} ${curvePlot.H}`}
            className="block h-auto w-full"
            role="img"
            aria-label={curve.title || "实时参数响应曲线"}
          >
            {/* Subtle horizontal gridlines */}
            {[0, 0.5, 1].map((t) => {
              const y = curvePlot.padT + t * curvePlot.plotH;
              const val = curvePlot.yMax - t * (curvePlot.yMax - curvePlot.yMin);
              return (
                <g key={t}>
                  <line
                    x1={curvePlot.padL}
                    y1={y}
                    x2={curvePlot.padL + curvePlot.plotW}
                    y2={y}
                    stroke="var(--ve-border)"
                    strokeDasharray={t === 1 ? undefined : "3 3"}
                    strokeWidth="1"
                  />
                  <text
                    x={curvePlot.padL - 6}
                    y={y + 3.5}
                    textAnchor="end"
                    fontSize="10"
                    fill="var(--ve-muted)"
                  >
                    {formatNumber(val, 1)}
                  </text>
                </g>
              );
            })}

            {/* Area fill & Curve line */}
            <path d={curvePlot.areaPath} fill="var(--ve-accent-soft)" opacity="0.7" />
            <path
              d={curvePlot.linePath}
              fill="none"
              stroke="var(--ve-accent)"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* Current parameter point marker */}
            {curvePlot.marker && (
              <g>
                <line
                  x1={curvePlot.marker.sx}
                  y1={curvePlot.padT}
                  x2={curvePlot.marker.sx}
                  y2={curvePlot.padT + curvePlot.plotH}
                  stroke="var(--ve-accent)"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                  opacity="0.6"
                />
                <circle
                  cx={curvePlot.marker.sx}
                  cy={curvePlot.marker.sy}
                  r="5.5"
                  fill="var(--ve-accent)"
                  stroke="var(--ve-surface)"
                  strokeWidth="2"
                />
              </g>
            )}

            {/* X-axis ticks */}
            <text
              x={curvePlot.padL}
              y={curvePlot.H - 8}
              fontSize="10"
              fill="var(--ve-muted)"
            >
              {formatNumber(curve.xMin, 1)}
            </text>
            <text
              x={curvePlot.padL + curvePlot.plotW / 2}
              y={curvePlot.H - 8}
              textAnchor="middle"
              fontSize="10.5"
              fill="var(--ve-muted)"
            >
              {curve.xLabel || curve.xVar}
            </text>
            <text
              x={curvePlot.padL + curvePlot.plotW}
              y={curvePlot.H - 8}
              textAnchor="end"
              fontSize="10"
              fill="var(--ve-muted)"
            >
              {formatNumber(curve.xMax, 1)}
            </text>
          </svg>
        </div>
      )}

      {/* Interactive Parameter Sliders */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {params.map((p) => {
          const val = values[p.resolvedKey] ?? p.defaultValue;
          return (
            <div
              key={p.resolvedKey}
              className="rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] p-3"
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <label
                  htmlFor={`param-${p.resolvedKey}`}
                  className="font-semibold text-[var(--ve-ink)]"
                >
                  {p.name}
                </label>
                <span className="font-mono text-[11.5px] font-semibold text-[var(--ve-accent)] tabular-nums">
                  {formatNumber(val, p.step < 1 ? 2 : 0)}
                  {p.unit ? ` ${p.unit}` : ""}
                </span>
              </div>
              <input
                id={`param-${p.resolvedKey}`}
                type="range"
                min={p.min}
                max={p.max}
                step={p.step}
                value={val}
                onChange={(e) => {
                  setActivePreset(null);
                  setValues((prev) => ({
                    ...prev,
                    [p.resolvedKey]: Number(e.target.value),
                  }));
                }}
                className="mt-2 w-full cursor-pointer accent-[var(--ve-accent)]"
              />
              <div className="mt-0.5 flex items-center justify-between font-mono text-[10px] text-[var(--ve-muted)] tabular-nums">
                <span>
                  {p.min}
                  {p.unit ? ` ${p.unit}` : ""}
                </span>
                <span>
                  {p.max}
                  {p.unit ? ` ${p.unit}` : ""}
                </span>
              </div>
              {p.effect && (
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--ve-muted)]">
                  {p.effect}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
