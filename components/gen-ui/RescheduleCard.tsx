"use client";
import { useState } from "react";
import {
  ArrowRight,
  CalendarClock,
  Check,
  Sparkles,
  Split,
  WandSparkles,
} from "lucide-react";
import {
  type RescheduleOption,
  type RescheduleProposal,
  time,
} from "../../lib/learning";

export default function RescheduleCard({
  proposal,
  onApply,
  onPreview,
}: {
  proposal: RescheduleProposal;
  onApply: (opt: RescheduleOption) => boolean;
  onPreview?: (opt: RescheduleOption | null) => void;
}) {
  const [selectedId, setSelectedId] = useState(proposal.options[0]?.id || "");
  const [appliedId, setAppliedId] = useState<string | null>(null);

  const chosen =
    proposal.options.find((o) => o.id === selectedId) || proposal.options[0];

  if (!proposal.options.length) {
    return (
      <div className="rounded-xl border border-[#d7e1fb] bg-[#f7f9ff] p-3.5 text-xs text-[#4b5b78]">
        <div className="mb-1 flex items-center gap-1.5 font-semibold text-[#314166]">
          <CalendarClock size={14} className="text-[#395de7]" />
          {proposal.title}
        </div>
        <p>{proposal.reason}</p>
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-xl border border-[#d2defa] bg-[var(--ve-surface)] shadow-xs"
      onMouseLeave={() => onPreview?.(null)}
    >
      <div className="flex items-center justify-between border-b border-[#e5ecfa] bg-[#f3f6ff] px-3.5 py-2.5">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-[#3855bf]">
          <WandSparkles size={14} /> 动态重排对比方案
        </span>
        <span className="rounded-full bg-[var(--ve-surface)] px-2 py-0.5 text-[11px] font-medium text-[#5d6f94] ring-1 ring-[#dce4f6]">
          {proposal.options.length} 个可选方案
        </span>
      </div>

      <div className="space-y-2.5 p-3.5">
        <div>
          <h4 className="text-sm font-semibold text-[#1f2942]">
            {proposal.title}
          </h4>
          <p className="mt-1 text-xs leading-relaxed text-[#5c6a84]">
            {proposal.reason}
          </p>
        </div>

        <div className="space-y-2">
          {proposal.options.map((opt) => {
            const isSelected = chosen?.id === opt.id;
            const isSplit = opt.changes.some((c) => c.newSlots.length > 1);
            return (
              <div
                key={opt.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (appliedId) return;
                  setSelectedId(opt.id);
                  onPreview?.(opt);
                }}
                onMouseEnter={() => {
                  if (!appliedId) onPreview?.(opt);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (!appliedId) {
                      setSelectedId(opt.id);
                      onPreview?.(opt);
                    }
                  }
                }}
                className={
                  "cursor-pointer rounded-lg border p-2.5 transition " +
                  (isSelected
                    ? "border-[#4b6de8] bg-[#f3f6ff] ring-1 ring-[#4b6de8]/20"
                    : "border-[var(--ve-border)] bg-[var(--ve-canvas)] hover:border-[#b7c7f0]")
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={
                        "flex h-4 w-4 items-center justify-center rounded-full border " +
                        (isSelected
                          ? "border-[#395de7] bg-[#395de7] text-white"
                          : "border-[#c2cde3] bg-[var(--ve-surface)]")
                      }
                    >
                      {isSelected && <Check size={10} />}
                    </span>
                    <span className="text-xs font-semibold text-[#243047]">
                      {opt.label}
                    </span>
                    {isSplit && (
                      <Split size={12} className="text-[#4a69d5]" />
                    )}
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#e8eeff] px-2 py-0.5 text-[11px] font-semibold text-[#3657d6]">
                    <Sparkles size={10} /> {opt.score} 分
                  </span>
                </div>

                {opt.insertEvent && (
                  <div className="mt-1.5 rounded-md bg-[var(--ve-amber-soft)] px-2 py-1 text-[11px] text-[var(--ve-amber)]">
                    新增固定日程：{opt.insertEvent.title}（
                    {opt.insertEvent.day.slice(5)} {time(opt.insertEvent.start)}
                    –{time(opt.insertEvent.start + opt.insertEvent.minutes)}）
                  </div>
                )}

                <div className="mt-2 space-y-1">
                  {opt.changes.map((c) => (
                    <div
                      key={c.blockId}
                      className="flex flex-wrap items-center gap-1.5 text-[11px]"
                    >
                      <span className="font-medium text-[#3b4760]">
                        {c.title}
                      </span>
                      <s className="text-[#8a94a8]">
                        {c.oldDay.slice(5)} {time(c.oldStart)}
                      </s>
                      <ArrowRight size={11} className="text-[#4a69d5]" />
                      <span className="font-semibold text-[#2d4fd4]">
                        {c.newSlots
                          .map(
                            (ns) =>
                              `${ns.day.slice(5)} ${time(ns.start)}–${time(ns.start + ns.minutes)}`,
                          )
                          .join(" + ")}
                      </span>
                    </div>
                  ))}
                </div>

                <p className="mt-1.5 text-[11px] leading-relaxed text-[#62708a]">
                  {opt.summary}
                </p>

                {opt.tags.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {opt.tags.map((tg) => (
                      <span
                        key={tg}
                        className="rounded bg-[var(--ve-surface)] px-1.5 py-0.5 text-[10px] font-medium text-[#52658d] ring-1 ring-[#dce3f2]"
                      >
                        {tg}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <button
          type="button"
          disabled={!chosen || Boolean(appliedId)}
          onClick={() => {
            if (!chosen) return;
            const ok = onApply(chosen);
            if (ok) setAppliedId(chosen.id);
          }}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#395de7] px-3 py-2 text-xs font-semibold text-white hover:bg-[#2f50d1] disabled:bg-emerald-50 disabled:text-emerald-700 disabled:opacity-100"
        >
          {appliedId ? (
            <>
              <Check size={14} /> 已应用「{chosen?.label}」到日历
            </>
          ) : (
            <>
              应用「{chosen?.label}」到日历 <ArrowRight size={14} />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
