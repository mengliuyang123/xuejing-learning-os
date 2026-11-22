"use client";
import type { DataChartCardData } from "../../lib/learning";

export default function DataChartCard({
  card,
}: {
  card: DataChartCardData;
}) {
  const pts = card.points || [];
  if (!pts.length) return null;

  const yValues = pts.map((p) => p.yValue);
  const rawMinY = Math.min(...yValues);
  const rawMaxY = Math.max(...yValues);
  const padY = Math.max(5, Math.round((rawMaxY - rawMinY) * 0.2) || 10);
  const minY = Math.floor((rawMinY - padY) / 5) * 5;
  const maxY = Math.ceil((rawMaxY + padY) / 5) * 5;
  const ySpan = Math.max(10, maxY - minY);

  const yTicks = [
    maxY,
    Math.round(minY + ySpan * 0.75),
    Math.round(minY + ySpan * 0.5),
    Math.round(minY + ySpan * 0.25),
    minY,
  ];

  // Prevent X-axis label overlap when many points or long labels appear in narrow panes
  const maxLabelLen = Math.max(...pts.map((p) => (p.xLabel || "").length), 1);
  const needsRotate = pts.length >= 6 || maxLabelLen >= 7;
  const labelSkipStep = pts.length > 8 ? 2 : 1;

  const width = 620;
  const leftPad = 50;
  const rightPad = 28;
  const topPad = 20;
  const bottomPad = needsRotate ? 58 : 36;
  const height = 214 + bottomPad;
  const plotW = width - leftPad - rightPad;
  const plotH = height - topPad - bottomPad;

  const coords = pts.map((p, idx) => {
    const xRatio = pts.length === 1 ? 0.5 : idx / (pts.length - 1);
    const yRatio = (p.yValue - minY) / ySpan;
    return {
      ...p,
      cx: Math.round(leftPad + xRatio * plotW),
      cy: Math.round(topPad + (1 - yRatio) * plotH),
    };
  });

  const polylinePoints = coords.map((c) => `${c.cx},${c.cy}`).join(" ");

  return (
    <div className="my-4 overflow-hidden rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-4 sm:p-5 transition-colors">
      {card.title && (
        <div className="mb-3 text-[13.5px] font-semibold text-[var(--ve-ink)]">
          {card.title}
        </div>
      )}

      {/* Theme-aware Data Table */}
      <div className="overflow-x-auto rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)]">
        <table className="w-full min-w-[260px] border-collapse text-left text-[12.5px]">
          <thead>
            <tr className="border-b border-[var(--ve-border)] bg-[var(--ve-surface-alt)] font-semibold text-[var(--ve-ink)]">
              <th className="px-3 py-2">{card.xHeader}</th>
              <th className="px-3 py-2">{card.yHeader}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ve-border)]/70 text-[var(--ve-ink)]">
            {pts.map((p, i) => (
              <tr key={`${p.xLabel}-${i}`}>
                <td className="break-words px-3 py-1.5 font-mono text-xs">
                  {p.xLabel}
                </td>
                <td className="px-3 py-1.5 font-mono text-xs">{p.yValue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Theme-aware SVG Scatter / Line Chart */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full min-w-[320px] overflow-visible"
          role="img"
          aria-label={card.title || "数据关系图"}
        >
          {yTicks.map((tick, i) => {
            const yRatio = (tick - minY) / ySpan;
            const y = Math.round(topPad + (1 - yRatio) * plotH);
            return (
              <g key={`tick-${i}`}>
                <line
                  x1={leftPad}
                  y1={y}
                  x2={width - rightPad}
                  y2={y}
                  stroke="var(--ve-border)"
                  strokeWidth="1"
                  strokeDasharray={i === yTicks.length - 1 ? undefined : "3 3"}
                />
                <text
                  x={leftPad - 10}
                  y={y + 4}
                  textAnchor="end"
                  fill="var(--ve-muted)"
                  fontSize="11"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  {tick}
                </text>
              </g>
            );
          })}

          {card.chartType === "line" && coords.length > 1 && (
            <polyline
              fill="none"
              stroke="var(--ve-accent)"
              strokeWidth="2.2"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={polylinePoints}
            />
          )}

          {coords.map((c, idx) => {
            const showLabel =
              idx === 0 ||
              idx === coords.length - 1 ||
              idx % labelSkipStep === 0;
            const shortLabel =
              c.xLabel.length > 10 ? `${c.xLabel.slice(0, 9)}…` : c.xLabel;
            const labelY = topPad + plotH + (needsRotate ? 18 : 22);

            return (
              <g key={`pt-${idx}`}>
                <circle
                  cx={c.cx}
                  cy={c.cy}
                  r="5.5"
                  fill="var(--ve-accent)"
                  stroke="var(--ve-surface)"
                  strokeWidth="1.8"
                >
                  <title>
                    {card.xHeader}: {c.xLabel} → {card.yHeader}: {c.yValue}
                  </title>
                </circle>
                {showLabel && (
                  <text
                    x={c.cx}
                    y={labelY}
                    textAnchor={needsRotate ? "end" : "middle"}
                    transform={
                      needsRotate
                        ? `rotate(-28 ${c.cx} ${labelY})`
                        : undefined
                    }
                    fill="var(--ve-muted)"
                    fontSize="11"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  >
                    {shortLabel}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {card.caption && (
        <p className="mt-2 text-xs text-[var(--ve-muted)]">{card.caption}</p>
      )}
    </div>
  );
}
