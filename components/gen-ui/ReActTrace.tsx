"use client";
import { useState } from "react";
import {
  Brain,
  CalendarSearch,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitFork,
  Loader2,
  AlertCircle,
  Cpu,
  Lightbulb,
} from "lucide-react";

export type TraceStep = {
  id: string;
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
};

const TOOL_META: Record<
  string,
  { label: string; icon: typeof GitFork; summarize: (out: unknown) => string }
> = {
  read_workspace_state: {
    label: "读取工作区图谱、日程与记忆",
    icon: GitFork,
    summarize: (out) => {
      const o = out as {
        tracks?: Array<{ title: string; units: unknown[] }>;
        upcomingBlocks?: unknown[];
        activeMemories?: unknown[];
      };
      if (!o) return "已读取工作区";
      return `${o.tracks?.length || 0} 条轨道 · 未来 7 天 ${o.upcomingBlocks?.length || 0} 项日程 · ${o.activeMemories?.length || 0} 条有效记忆`;
    },
  },
  find_calendar_windows: {
    label: "扫描无冲突空闲窗口",
    icon: CalendarSearch,
    summarize: (out) => {
      const o = out as {
        windowsByDay?: Array<{ day: string; freeWindows: unknown[] }>;
      };
      if (!o?.windowsByDay?.length) return "已扫描空档";
      const total = o.windowsByDay.reduce(
        (sum, d) => sum + (d.freeWindows?.length || 0),
        0,
      );
      return `已扫描 ${o.windowsByDay.length} 天，共发现 ${total} 段可用空档`;
    },
  },
  inspect_mastery_graph: {
    label: "检查知识先修图谱与掌握度",
    icon: GitFork,
    summarize: (out) => {
      const o = out as {
        activeTrack?: { title: string };
        nodes?: Array<{ status: string }>;
        dueReviews?: Array<{ title: string }>;
      };
      if (!o?.nodes) return "已读取知识图谱";
      const mastered = o.nodes.filter((n) => n.status === "已掌握").length;
      const reviewNote = o.dueReviews?.length
        ? ` · ${o.dueReviews.length} 项待复习`
        : "";
      return `${o.activeTrack?.title || "当前轨道"}：已掌握 ${mastered}/${o.nodes.length}${reviewNote}`;
    },
  },
  read_calendar: {
    label: "扫描日历日程与空闲窗口",
    icon: CalendarSearch,
    summarize: (out) => {
      const o = out as {
        day?: string;
        scheduled?: unknown[];
        freeWindows?: Array<{ range: string; minutes: number }>;
      };
      if (!o) return "已读取日历";
      const longest = o.freeWindows
        ?.slice()
        .sort((a, b) => b.minutes - a.minutes)[0];
      return `${o.day?.slice(5) || "今日"} 已排 ${o.scheduled?.length || 0} 项 · ${o.freeWindows?.length || 0} 段空档${longest ? `（最长 ${longest.range}）` : ""}`;
    },
  },
  read_memories: {
    label: "检索长期记忆与排程约束",
    icon: Brain,
    summarize: (out) => {
      const o = out as { activeConstraints?: string; memories?: unknown[] };
      if (!o) return "已读取记忆";
      return `${o.memories?.length || 0} 条有效记忆 · ${o.activeConstraints || "无特殊约束"}`;
    },
  },
  check_schedule_feasibility: {
    label: "核算 7 天时间负荷与缺口",
    icon: CalendarSearch,
    summarize: (out) => {
      const o = out as { feasible?: boolean; summary?: string };
      return o?.summary || "已完成可行性核算";
    },
  },
};

export function isObservationTool(toolName: string): boolean {
  return toolName in TOOL_META;
}

export default function ReActTrace({
  steps,
  thoughts = [],
  thinking = false,
}: {
  steps: TraceStep[];
  thoughts?: string[];
  thinking?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cleanThoughts = thoughts.map((t) => t.trim()).filter(Boolean);
  if (!steps.length && !cleanThoughts.length && !thinking) return null;

  const running =
    thinking ||
    steps.some(
      (s) => s.state !== "output-available" && s.state !== "output-error",
    );
  const failed = steps.some((s) => s.state === "output-error");

  const statusBadge = running
    ? thinking && !steps.length
      ? "深度思考中…"
      : `推理中 (${steps.length} 步观测)`
    : cleanThoughts.length && steps.length
      ? `思考 + ${steps.length} 步观测`
      : steps.length
        ? `已完成 ${steps.length} 步观测`
        : "已记录思考过程";

  return (
    <div className="mb-2.5 overflow-hidden rounded-xl bg-[var(--surface-3)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--muted)] transition hover:bg-[var(--surface-hover)]"
      >
        {running ? (
          <Loader2 size={14} className="animate-spin text-[var(--blue)]" />
        ) : failed ? (
          <AlertCircle size={14} className="text-rose-500" />
        ) : (
          <Cpu size={14} className="text-[var(--blue)]" />
        )}
        <span className="font-semibold text-[var(--ink)]">推理过程</span>
        <span className="rounded-md bg-[var(--soft-blue)] px-2 py-0.5 text-[11px] font-medium text-[var(--blue)]">
          {statusBadge}
        </span>
        <span className="ml-auto text-[var(--muted)]">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {/* Zero-JS accordion: grid-template-rows 0fr -> 1fr */}
      <div className="think-accordion" data-open={open ? "true" : "false"}>
        <div className="think-accordion-inner">
          <div className="space-y-2.5 bg-[var(--surface-2)]/70 px-3 py-2.5">
            {cleanThoughts.length > 0 && (
              <div className="rounded-lg bg-[var(--surface-1)] p-2.5">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-[var(--ink)]">
                  <Lightbulb size={12} className="text-[var(--blue)]" />
                  思考过程
                </div>
                <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--muted)]">
                  {cleanThoughts.join("\n\n")}
                </p>
              </div>
            )}

            {steps.map((step, idx) => {
              const meta = TOOL_META[step.toolName];
              const Icon = meta?.icon || Cpu;
              const done = step.state === "output-available";
              const err = step.state === "output-error";
              return (
                <div
                  key={step.id}
                  className="flex items-start gap-2.5 text-xs leading-relaxed"
                >
                  <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--soft-blue)] text-[var(--blue)]">
                    <Icon size={12} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-[var(--ink)]">
                        {idx + 1}. {meta?.label || step.toolName}
                      </span>
                      {done ? (
                        <CheckCircle2 size={12} className="text-emerald-600" />
                      ) : err ? (
                        <AlertCircle size={12} className="text-rose-500" />
                      ) : (
                        <Loader2
                          size={12}
                          className="animate-spin text-[var(--blue)]"
                        />
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                      {done
                        ? meta?.summarize(step.output) || "已返回观测结果"
                        : err
                          ? "工具执行失败"
                          : "正在读取上下文…"}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
