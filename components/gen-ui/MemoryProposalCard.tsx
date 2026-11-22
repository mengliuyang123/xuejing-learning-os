"use client";
import { useState } from "react";
import { Brain, Check, Clock3, Sparkles, X } from "lucide-react";
import { type MemoryProposal, time } from "../../lib/learning";

export default function MemoryProposalCard({
  proposal,
  onConfirm,
  onTriggerReschedule,
}: {
  proposal: MemoryProposal;
  onConfirm: (proposal: MemoryProposal, editedText: string) => void;
  onTriggerReschedule?: () => void;
}) {
  const [text, setText] = useState(proposal.text);
  const [status, setStatus] = useState<"pending" | "saved" | "dismissed">(
    "pending",
  );

  const constraintBadges: string[] = [];
  if (proposal.constraint?.preferredStart !== undefined) {
    constraintBadges.push(`偏好 ${time(proposal.constraint.preferredStart)} 后`);
  } else if (proposal.constraint?.preferredPeriod) {
    constraintBadges.push(
      `偏好${
        { morning: "上午", afternoon: "下午", evening: "晚间" }[
          proposal.constraint.preferredPeriod
        ]
      }`,
    );
  }
  if (proposal.constraint?.maxSessionMinutes) {
    constraintBadges.push(`单次 ≤ ${proposal.constraint.maxSessionMinutes} 分钟`);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[#d6def8] bg-white shadow-xs">
      <div className="flex items-center justify-between border-b border-[#e8eef9] bg-[#f4f6ff] px-3.5 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-[#4759b8]">
          <Brain size={14} /> 长期记忆写入提议
        </span>
        <span className="rounded-full bg-[#e6ecff] px-2 py-0.5 text-[10px] font-semibold text-[#3856c2]">
          {proposal.label}
        </span>
      </div>

      <div className="space-y-2.5 p-3.5">
        <p className="text-xs leading-relaxed text-[#5e6d88]">
          {proposal.reason}
        </p>

        {status === "pending" ? (
          <textarea
            aria-label="编辑记忆内容"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full resize-none rounded-lg border border-[#d4dce9] bg-[#fafcff] px-2.5 py-2 text-xs leading-relaxed text-[#223047] focus:border-[#395de7]"
          />
        ) : (
          <div className="rounded-lg bg-[#f5f7fc] px-2.5 py-2 text-xs text-[#34425c]">
            {text}
          </div>
        )}

        {constraintBadges.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#647491]">
              <Clock3 size={11} /> 自动解析约束：
            </span>
            {constraintBadges.map((b) => (
              <span
                key={b}
                className="rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200"
              >
                {b}
              </span>
            ))}
          </div>
        )}

        {status === "pending" && (
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              disabled={!text.trim()}
              onClick={() => {
                onConfirm(proposal, text);
                setStatus("saved");
              }}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#395de7] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#2f50d1]"
            >
              <Check size={13} /> 确认写入记忆
            </button>
            <button
              type="button"
              onClick={() => setStatus("dismissed")}
              className="inline-flex items-center gap-1 rounded-lg border border-[#dce2ee] bg-white px-2.5 py-1.5 text-xs text-[#64738e] hover:bg-[#f5f7fb]"
            >
              <X size={13} /> 忽略
            </button>
          </div>
        )}

        {status === "saved" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-emerald-50 px-2.5 py-2 text-xs text-emerald-800">
            <span className="inline-flex items-center gap-1 font-medium">
              <Check size={13} /> 已写入长期记忆并生效
            </span>
            {constraintBadges.length > 0 && onTriggerReschedule && (
              <button
                type="button"
                onClick={onTriggerReschedule}
                className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-[#395de7] shadow-2xs ring-1 ring-emerald-200 hover:bg-[#f2f5ff]"
              >
                <Sparkles size={11} /> 按新约束重排今日
              </button>
            )}
          </div>
        )}

        {status === "dismissed" && (
          <div className="text-[11px] text-[#8390a8]">已忽略此记忆提议。</div>
        )}
      </div>
    </div>
  );
}
