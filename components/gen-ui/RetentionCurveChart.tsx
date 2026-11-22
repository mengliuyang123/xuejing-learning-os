"use client";
import { buildRetentionCurve } from "../../lib/bkt-fsrs";

export default function RetentionCurveChart({
  stabilityDays,
  elapsedAlready = 0,
  title = "FSRS 记忆遗忘曲线（未来 10 天）",
}: {
  stabilityDays: number;
  elapsedAlready?: number;
  title?: string;
}) {
  const safeS = Math.max(0.6, stabilityDays);
  const currentCurve = buildRetentionCurve(safeS, elapsedAlready, 10);
  const boostedCurve = buildRetentionCurve(
    Math.min(60, safeS * 2.2),
    0,
    10,
  );

  const w = 280;
  const h = 112;
  const padL = 28;
  const padR = 10;
  const padT = 10;
  const padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const toX = (dayOffset: number) => padL + (dayOffset / 10) * plotW;
  const toY = (pct: number) => padT + ((100 - pct) / 100) * plotH;

  const currentPath = currentCurve
    .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(p.dayOffset).toFixed(1)} ${toY(p.retention).toFixed(1)}`)
    .join(" ");

  const boostedPath = boostedCurve
    .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(p.dayOffset).toFixed(1)} ${toY(p.retention).toFixed(1)}`)
    .join(" ");

  const thresholdY = toY(90);

  return (
    <div className="rounded-xl border border-[#e3e9f5] bg-[var(--ve-canvas)] p-3">
      <div className="mb-1.5 flex items-center justify-between text-[11px]">
        <span className="font-semibold text-[#31405e]">{title}</span>
        <span className="text-[#697894]">今日保持率 {currentCurve[0].retention}%</span>
      </div>

      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full overflow-visible"
        role="img"
        aria-label={title}
      >
        {/* Horizontal grid lines */}
        {[100, 90, 50].map((val) => (
          <g key={val}>
            <line
              x1={padL}
              x2={w - padR}
              y1={toY(val)}
              y2={toY(val)}
              stroke={val === 90 ? "#f59e0b" : "#e5ebf5"}
              strokeWidth={val === 90 ? "1" : "0.75"}
              strokeDasharray={val === 90 ? "3 2" : undefined}
            />
            <text
              x={padL - 4}
              y={toY(val) + 3}
              textAnchor="end"
              fontSize="8.5"
              fill={val === 90 ? "#b45309" : "#8693ab"}
            >
              {val}%
            </text>
          </g>
        ))}

        {/* Projected after-review curve */}
        <path
          d={boostedPath}
          fill="none"
          stroke="#10b981"
          strokeWidth="1.5"
          strokeDasharray="3 2"
          opacity="0.85"
        />

        {/* Current decay curve */}
        <path
          d={currentPath}
          fill="none"
          stroke="#395de7"
          strokeWidth="2"
          strokeLinecap="round"
        />

        {/* Today marker */}
        <circle
          cx={toX(0)}
          cy={toY(currentCurve[0].retention)}
          r="3"
          fill="#395de7"
        />

        {/* X axis ticks */}
        {[0, 3, 7, 10].map((d) => (
          <text
            key={d}
            x={toX(d)}
            y={h - 6}
            textAnchor="middle"
            fontSize="8.5"
            fill="#8390a8"
          >
            {d === 0 ? "今天" : `+${d}天`}
          </text>
        ))}

        {/* Threshold annotation */}
        <text
          x={w - padR}
          y={thresholdY + 11}
          textAnchor="end"
          fontSize="8"
          fill="#b45309"
        >
          90% 复习警戒线
        </text>
      </svg>

      <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-[#6d7b95]">
        <span className="inline-flex items-center gap-1">
          <i className="h-0.5 w-3 bg-[#395de7]" /> 当前衰退曲线 (S={safeS}天)
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="h-0.5 w-3 border-t border-dashed border-[var(--ve-emerald)]" />{" "}
          复习后预期曲线
        </span>
      </div>
    </div>
  );
}
