"use client";
import { AlertTriangle, ArrowRight, ShieldAlert } from "lucide-react";
import type { FeasibilityReport } from "../../lib/scheduler";

export default function FeasibilityAlertCard({
  report,
  onApplyFix,
}: {
  report: FeasibilityReport;
  onApplyFix: (
    id: "extend_deadline" | "protect_reviews_only" | "compress_micro",
  ) => void;
}) {
  if (report.feasible) return null;

  return (
    <section className="mb-5 overflow-hidden rounded-2xl border border-[var(--ve-rose)]/35 bg-rose-50/70 p-4">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--ve-rose-soft)] text-[var(--ve-rose)]">
          <ShieldAlert size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-[var(--ve-rose)]">
              未来 {report.horizonDays} 天时间超载预警（缺口{" "}
              {(report.deficitMinutes / 60).toFixed(1)} 小时）
            </h3>
            <span className="rounded-full bg-[var(--ve-rose-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--ve-rose)]">
              可用 {(report.availableMinutes / 60).toFixed(1)}h / 需{" "}
              {(report.requiredMinutes / 60).toFixed(1)}h
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-rose-800/90">
            {report.summary}
          </p>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {report.suggestions.map((sug) => (
              <button
                key={sug.id}
                type="button"
                onClick={() => onApplyFix(sug.id)}
                className="flex flex-col justify-between rounded-xl border border-[var(--ve-rose)]/35 bg-[var(--ve-surface)] p-3 text-left transition hover:border-[#4b6de8] hover:bg-[#f6f8ff]"
              >
                <div>
                  <div className="flex items-center justify-between text-xs font-semibold text-[#233047]">
                    <span>{sug.label}</span>
                    <ArrowRight size={13} className="text-[#395de7]" />
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-[#61708a]">
                    {sug.detail}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
