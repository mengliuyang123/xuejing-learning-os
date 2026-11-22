"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  BookOpen,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Copy,
  Cpu,
  Database,
  FileCode2,
  Filter,
  GitCommitHorizontal,
  GitCompareArrows,
  Layers,
  Loader2,
  MessageSquare,
  Minus,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react";
import {
  type DbInfo,
  type PlanRevision,
  time,
} from "../lib/learning";
import type {
  AgentStateChangeTrace,
  AgentToolCallTrace,
  AgentTraceEvent,
  AgentTraceRun,
  FullAgentTrace,
  LiveTraceMessage,
} from "../lib/trace-types";
import type { DomainEventRecord } from "../lib/domain-activities";
import { useLearningStore } from "./LearningStore";
import RichMarkdown from "./gen-ui/RichMarkdown";

const KNOWN_TOOLS = [
  "present_interactive_check",
  "record_learning_assessment",
  "research_learning_topic",
  "fetch_reference_url",
  "plan_teaching_move",
  "create_learning_track",
  "adjust_track_scope",
  "save_memory",
  "manage_calendar_block",
  "propose_reschedule",
  "propose_batch_reschedule",
  "read_workspace_state",
  "find_calendar_windows",
  "present_onboarding_survey",
  "present_learning_roadmap",
  "present_data_chart",
  "search_visual_resource",
  "start_active_recall",
];

const ENTITY_TYPE_LABELS: Record<string, string> = {
  learning_state: "Learning State（掌握度状态）",
  assessment_record: "Assessment Record（评估记录）",
  memory: "Memory Write（长期记忆）",
  learning_track: "Learning Track（学习轨道）",
  study_plan: "Study Plan Change（日程排期）",
  schedule_replanning: "Schedule Replanning（重排方案）",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTs(iso: string | null | undefined): string {
  if (!iso) return "未提供";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function eventDisplayMeta(ev: AgentTraceEvent): {
  category: string;
  title: string;
  subtitle: string;
  icon: typeof MessageSquare;
  badgeColor: string;
} {
  switch (ev.event_type) {
    case "run.started":
      return {
        category: "User Input",
        title: "User Input",
        subtitle: String(ev.payload.user_prompt || "").slice(0, 60) || "启动执行",
        icon: MessageSquare,
        badgeColor: "bg-[var(--ve-surface-alt)] text-[var(--ve-ink)]",
      };
    case "model.request":
      return {
        category: "LLM Request",
        title: `LLM Request (Round ${String(ev.payload.iteration || 1)})`,
        subtitle: `${String(ev.payload.provider || "")} / ${String(ev.payload.model || "")}`,
        icon: Cpu,
        badgeColor: "bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]",
      };
    case "model.response": {
      const reqTools = Array.isArray(ev.payload.requested_tool_calls)
        ? ev.payload.requested_tool_calls.length
        : 0;
      return {
        category: "LLM Response",
        title: `LLM Response · Decision`,
        subtitle:
          reqTools > 0
            ? `模型请求调用 ${reqTools} 个工具`
            : `finish=${String(ev.payload.finish_reason || "stop")}`,
        icon: Bot,
        badgeColor: "bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]",
      };
    }
    case "tool.requested":
      return {
        category: "Tool Request",
        title: `Tool Request · ${ev.tool_name || "unknown"}`,
        subtitle: `Model Requested · ${ev.tool_call_id || ""}`,
        icon: Wrench,
        badgeColor: "bg-[var(--ve-amber-soft)] text-[var(--ve-amber)]",
      };
    case "tool.started":
      return {
        category: "Tool Executed",
        title: `Tool Executing · ${ev.tool_name || "unknown"}`,
        subtitle: `Tool Executed · ${ev.tool_call_id || ""}`,
        icon: Loader2,
        badgeColor: "bg-[var(--ve-accent-soft)] text-sky-700",
      };
    case "tool.completed":
      return {
        category: "Tool Result",
        title: `Tool Result · ${ev.tool_name || "unknown"}`,
        subtitle: `Tool Succeeded · ${formatDuration(ev.duration_ms)}`,
        icon: CheckCircle2,
        badgeColor: "bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]",
      };
    case "tool.failed":
      return {
        category: "Tool Result",
        title: `Tool Failed · ${ev.tool_name || "unknown"}`,
        subtitle: String(ev.payload.error || "执行失败").slice(0, 56),
        icon: XCircle,
        badgeColor: "bg-[var(--ve-rose-soft)] text-[var(--ve-rose)]",
      };
    case "state.changed":
      return {
        category: "State Changes",
        title: `State Change · ${String(ev.payload.entity_type || "state")}`,
        subtitle: `${String(ev.payload.action || "update")} · ${String(ev.payload.entity_id || "")}`,
        icon: GitCompareArrows,
        badgeColor:
          ev.status === "error"
            ? "bg-[var(--ve-rose-soft)] text-[var(--ve-rose)]"
            : "bg-teal-50 text-teal-700",
      };
    case "run.completed":
      return {
        category: "Final Response",
        title: "Final Response",
        subtitle: `Completed · ${formatDuration(ev.duration_ms)}`,
        icon: Sparkles,
        badgeColor: "bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]",
      };
    case "run.failed":
      return {
        category: "Final Response",
        title: "Run Failed",
        subtitle: String(ev.payload.error || "执行中断").slice(0, 60),
        icon: AlertCircle,
        badgeColor: "bg-[var(--ve-rose-soft)] text-[var(--ve-rose)]",
      };
  }
}

function JsonViewer({
  title,
  data,
  defaultOpen = true,
  emptyLabel = "未提供",
}: {
  title: string;
  data: unknown;
  defaultOpen?: boolean;
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);

  const formatted = useMemo(() => {
    if (data === null || data === undefined) return "";
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }, [data]);

  function handleCopy() {
    if (!formatted) return;
    void navigator.clipboard?.writeText(formatted);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--ve-border)] bg-[var(--ve-canvas)] px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-semibold text-[var(--ve-ink)]"
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <FileCode2 size={13} className="text-[var(--ve-accent)]" />
          <span>{title}</span>
        </button>
        {formatted && (
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-accent-soft)] hover:text-[var(--ve-accent)]"
          >
            {copied ? (
              <Check size={11} className="text-[var(--ve-emerald)]" />
            ) : (
              <Copy size={11} />
            )}
            {copied ? "已复制" : "复制 JSON"}
          </button>
        )}
      </div>
      {open && (
        <div className="p-3">
          {formatted ? (
            <pre className="max-h-[340px] overflow-auto rounded-lg bg-[#0f172a] p-3 font-mono text-[11.5px] leading-relaxed text-[#e2e8f0] whitespace-pre-wrap break-all">
              {formatted}
            </pre>
          ) : (
            <div className="rounded-lg bg-[var(--ve-canvas)] px-3 py-2 text-xs text-[var(--ve-muted)]">
              {emptyLabel}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StateDiffBlock({ sc }: { sc: AgentStateChangeTrace }) {
  return (
    <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-3.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-md bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-800">
            {ENTITY_TYPE_LABELS[sc.entity_type] || sc.entity_type}
          </span>
          <span className="rounded bg-[var(--ve-accent-soft)] px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-[var(--ve-accent)]">
            {sc.action}
          </span>
          <span className="font-mono text-[10.5px] text-[var(--ve-muted)]">
            id: {sc.entity_id}
          </span>
        </div>
        <span
          className={
            "rounded-full px-2 py-0.5 text-[10px] font-semibold " +
            (sc.status === "failed"
              ? "bg-[var(--ve-rose-soft)] text-[var(--ve-rose)]"
              : "bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]")
          }
        >
          {sc.status === "failed" ? "状态更新失败" : "状态已更新"}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-[var(--ve-muted)]">
        <span>来源：{sc.source}</span>
        {sc.tool_call_id && (
          <span className="font-mono">tool_call_id: {sc.tool_call_id}</span>
        )}
        <span>{formatTs(sc.timestamp)}</span>
      </div>

      {sc.error && (
        <div className="mt-2 rounded-lg border border-[var(--ve-rose)]/35 bg-[var(--ve-rose-soft)] px-2.5 py-1.5 text-xs text-[var(--ve-rose)]">
          错误：{sc.error}
        </div>
      )}

      <div className="mt-2.5 grid gap-2.5 md:grid-cols-2">
        <JsonViewer
          title="Before State（变更前）"
          data={sc.before_state}
          emptyLabel="无（新建对象）"
        />
        <JsonViewer
          title="After State（变更后）"
          data={sc.after_state}
          emptyLabel="无（已删除或未写入）"
        />
      </div>
    </div>
  );
}

export default function ActivityAudit() {
  const {
    setWorkspaceTab,
    setActiveTrackId,
    setDay,
    openLessonInLearn,
  } = useLearningStore();
  const [viewLayer, setViewLayer] = useState<"history" | "trace">("history");
  const [tab, setTab] = useState<"runs" | "revisions" | "events">("runs");
  const [loading, setLoading] = useState(true);
  const [traceLoading, setTraceLoading] = useState(false);

  const [traceRuns, setTraceRuns] = useState<AgentTraceRun[]>([]);
  const [revisions, setRevisions] = useState<PlanRevision[]>([]);
  const [domainEvents, setDomainEvents] = useState<DomainEventRecord[]>([]);
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [toolFilter, setToolFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "running" | "completed" | "failed"
  >("all");

  // Selected Run + Full Trace
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activeTrace, setActiveTrace] = useState<FullAgentTrace | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [collapsedToolGroups, setCollapsedToolGroups] = useState<
    Record<string, boolean>
  >({});
  const [copiedFullTrace, setCopiedFullTrace] = useState(false);
  const [liveConnected, setLiveConnected] = useState(false);

  const selectedRunIdRef = useRef<string | null>(null);
  selectedRunIdRef.current = selectedRunId;

  const fetchAuditList = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: "60" });
      if (statusFilter !== "all") qs.set("status", statusFilter);
      if (toolFilter !== "all") qs.set("toolName", toolFilter);
      if (searchQuery.trim()) qs.set("q", searchQuery.trim());

      const res = await fetch(`/api/audit?${qs.toString()}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        const nextRuns: AgentTraceRun[] = data.traceRuns || [];
        setTraceRuns(nextRuns);
        setRevisions(data.revisions || []);
        setDomainEvents(data.domainEvents || []);
        setDbInfo(data.dbInfo || null);

        if (nextRuns.length > 0) {
          const stillExists = nextRuns.some(
            (r) => r.run_id === selectedRunIdRef.current,
          );
          if (!selectedRunIdRef.current || !stillExists) {
            setSelectedRunId(nextRuns[0].run_id);
          }
        } else {
          setSelectedRunId(null);
          setActiveTrace(null);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [statusFilter, toolFilter, searchQuery]);

  const fetchTraceById = useCallback(async (runId: string) => {
    setTraceLoading(true);
    try {
      const res = await fetch(
        `/api/audit?runId=${encodeURIComponent(runId)}`,
        { cache: "no-store" },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          trace: FullAgentTrace;
          dbInfo?: DbInfo;
        };
        setActiveTrace(data.trace);
        if (data.dbInfo) setDbInfo(data.dbInfo);
        if (data.trace.events.length > 0) {
          setSelectedStepId((prev) =>
            prev && data.trace.events.some((e) => e.step_id === prev)
              ? prev
              : data.trace.events[data.trace.events.length - 1].step_id,
          );
        } else {
          setSelectedStepId(null);
        }
      }
    } finally {
      setTraceLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAuditList();
  }, [fetchAuditList]);

  useEffect(() => {
    if (selectedRunId) {
      void fetchTraceById(selectedRunId);
    }
  }, [selectedRunId, fetchTraceById]);

  // Phase 5: Read-only Real-time SSE Trace subscription.
  // Unmounting ActivityAudit ONLY closes EventSource; NEVER cancels running LLM tasks!
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/audit/stream");

    es.onopen = () => setLiveConnected(true);
    es.onerror = () => setLiveConnected(false);

    es.onmessage = (msgEvent) => {
      try {
        const msg = JSON.parse(msgEvent.data) as
          | LiveTraceMessage
          | { kind: "connected" };
        if (msg.kind === "connected") {
          setLiveConnected(true);
          return;
        }

        if (msg.kind === "run") {
          setTraceRuns((prev) => {
            const exists = prev.some((r) => r.run_id === msg.run.run_id);
            if (exists) {
              return prev.map((r) =>
                r.run_id === msg.run.run_id ? msg.run : r,
              );
            }
            return [msg.run, ...prev];
          });
          if (!selectedRunIdRef.current) {
            setSelectedRunId(msg.run.run_id);
          }
        } else if (msg.kind === "event") {
          setTraceRuns((prev) => {
            const exists = prev.some((r) => r.run_id === msg.run.run_id);
            if (exists) {
              return prev.map((r) =>
                r.run_id === msg.run.run_id ? msg.run : r,
              );
            }
            return [msg.run, ...prev];
          });

          if (selectedRunIdRef.current === msg.runId) {
            setActiveTrace((prev) => {
              if (!prev || prev.run.run_id !== msg.runId) {
                return {
                  run: msg.run,
                  events: [msg.event],
                  toolCalls: [],
                  stateChanges: [],
                };
              }
              const exists = prev.events.some(
                (e) => e.step_id === msg.event.step_id,
              );
              const nextEvents = exists
                ? prev.events.map((e) =>
                    e.step_id === msg.event.step_id ? msg.event : e,
                  )
                : [...prev.events, msg.event];
              return {
                ...prev,
                run: msg.run,
                events: nextEvents,
              };
            });
            setSelectedStepId((prev) => prev || msg.event.step_id);
          }
        } else if (msg.kind === "tool_call") {
          if (selectedRunIdRef.current === msg.runId) {
            setActiveTrace((prev) => {
              if (!prev || prev.run.run_id !== msg.runId) return prev;
              const exists = prev.toolCalls.some(
                (t) => t.tool_call_id === msg.toolCall.tool_call_id,
              );
              const nextTcs = exists
                ? prev.toolCalls.map((t) =>
                    t.tool_call_id === msg.toolCall.tool_call_id
                      ? msg.toolCall
                      : t,
                  )
                : [...prev.toolCalls, msg.toolCall];
              return { ...prev, toolCalls: nextTcs };
            });
          }
        } else if (msg.kind === "state_change") {
          if (selectedRunIdRef.current === msg.runId) {
            setActiveTrace((prev) => {
              if (!prev || prev.run.run_id !== msg.runId) return prev;
              const exists = prev.stateChanges.some(
                (s) => s.change_id === msg.stateChange.change_id,
              );
              return exists
                ? prev
                : {
                    ...prev,
                    stateChanges: [...prev.stateChanges, msg.stateChange],
                  };
            });
          }
        }
      } catch {}
    };

    return () => {
      es.close();
      setLiveConnected(false);
    };
  }, []);

  async function clearAudit() {
    await fetch("/api/audit", { method: "DELETE" });
    setSelectedRunId(null);
    setActiveTrace(null);
    setSelectedStepId(null);
    await fetchAuditList();
  }

  function copyFullTraceJson() {
    if (!activeTrace) return;
    void navigator.clipboard?.writeText(JSON.stringify(activeTrace, null, 2));
    setCopiedFullTrace(true);
    setTimeout(() => setCopiedFullTrace(false), 1800);
  }

  // Group timeline events so runs with many tool calls stay compact and collapsible
  const timelineGroups = useMemo(() => {
    const events = activeTrace?.events || [];
    const shouldGroupTools = (activeTrace?.toolCalls.length || 0) > 4;
    if (!shouldGroupTools) {
      return events.map((ev, idx) => ({
        kind: "single" as const,
        key: ev.step_id,
        index: idx + 1,
        event: ev,
      }));
    }

    const out: Array<
      | { kind: "single"; key: string; index: number; event: AgentTraceEvent }
      | {
          kind: "tool_group";
          key: string;
          label: string;
          events: AgentTraceEvent[];
          hasError: boolean;
        }
    > = [];

    let toolBuf: AgentTraceEvent[] = [];
    let groupCounter = 0;

    const flushToolBuf = () => {
      if (toolBuf.length === 0) return;
      groupCounter += 1;
      const names = Array.from(
        new Set(toolBuf.map((e) => e.tool_name).filter(Boolean)),
      );
      out.push({
        kind: "tool_group",
        key: `tg-${groupCounter}`,
        label: `工具执行分组 #${groupCounter}（${names.join(" · ") || `${toolBuf.length} 步`}）`,
        events: toolBuf,
        hasError: toolBuf.some((e) => e.status === "error"),
      });
      toolBuf = [];
    };

    events.forEach((ev, idx) => {
      if (
        ev.event_type === "tool.requested" ||
        ev.event_type === "tool.started" ||
        ev.event_type === "tool.completed" ||
        ev.event_type === "tool.failed" ||
        ev.event_type === "state.changed"
      ) {
        toolBuf.push(ev);
      } else {
        flushToolBuf();
        out.push({
          kind: "single",
          key: ev.step_id,
          index: idx + 1,
          event: ev,
        });
      }
    });
    flushToolBuf();
    return out;
  }, [activeTrace]);

  const selectedEvent = useMemo(
    () =>
      activeTrace?.events.find((e) => e.step_id === selectedStepId) ||
      activeTrace?.events[0] ||
      null,
    [activeTrace, selectedStepId],
  );

  const linkedToolCall: AgentToolCallTrace | null = useMemo(() => {
    if (!selectedEvent?.tool_call_id || !activeTrace) return null;
    return (
      activeTrace.toolCalls.find(
        (t) => t.tool_call_id === selectedEvent.tool_call_id,
      ) || null
    );
  }, [selectedEvent, activeTrace]);

  const linkedStateChanges: AgentStateChangeTrace[] = useMemo(() => {
    if (!selectedEvent || !activeTrace) return [];
    if (selectedEvent.event_type === "state.changed") {
      const cid = String(selectedEvent.payload.change_id || "");
      return activeTrace.stateChanges.filter((s) => s.change_id === cid);
    }
    if (selectedEvent.tool_call_id) {
      return activeTrace.stateChanges.filter(
        (s) => s.tool_call_id === selectedEvent.tool_call_id,
      );
    }
    return [];
  }, [selectedEvent, activeTrace]);

  // Unified human-readable Activity Timeline (Layer 1: 活动历史)
  const userTimeline = useMemo(() => {
    type TimelineEntry = {
      id: string;
      kind: "plan" | "assessment" | "study" | "goal" | "memory" | "agent";
      title: string;
      subtitle: string;
      timestamp: string;
      runId?: string | null;
      revisionId?: string;
    };

    const list: TimelineEntry[] = [];
    const seenRunIds = new Set<string>();

    for (const rev of revisions) {
      const movedCount = rev.diff.moved.length;
      const addedCount = rev.diff.added.length;
      const diffHint = [
        addedCount ? `新增 ${addedCount} 项` : "",
        movedCount ? `调整 ${movedCount} 项` : "",
        rev.diff.removed.length ? `移除 ${rev.diff.removed.length} 项` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      list.push({
        id: `rev-${rev.id}`,
        kind: "plan",
        title: `学习计划已调整（${rev.trigger}）`,
        subtitle: diffHint ? `${rev.summary} · ${diffHint}` : rev.summary,
        timestamp: rev.createdAt,
        revisionId: rev.id,
      });
    }

    const domainTitleMap: Record<string, { title: string; kind: TimelineEntry["kind"] }> = {
      GoalCreated: { title: "学习目标已建立", kind: "goal" },
      AssessmentCompleted: { title: "课程测验完成", kind: "assessment" },
      RemediationTriggered: { title: "已安排薄弱点巩固", kind: "assessment" },
      CalendarChanged: { title: "学习日程已更新", kind: "plan" },
      PlanVersionCreated: { title: "学习计划已调整", kind: "plan" },
      MemoryUpdated: { title: "个人约束与偏好已更新", kind: "memory" },
      ReviewCompleted: { title: "主动回忆复习完成", kind: "study" },
    };

    for (const ev of domainEvents) {
      if (ev.runId) seenRunIds.add(ev.runId);
      const mapped = domainTitleMap[ev.eventType] || {
        title: ev.eventType,
        kind: "agent" as const,
      };
      list.push({
        id: `ev-${ev.eventId}`,
        kind: mapped.kind,
        title: mapped.title,
        subtitle: ev.summary,
        timestamp: ev.createdAt,
        runId: ev.runId,
      });
    }

    for (const run of traceRuns) {
      if (seenRunIds.has(run.run_id)) continue;
      list.push({
        id: `run-${run.run_id}`,
        kind: "study",
        title:
          run.status === "failed"
            ? "AI 助教执行中断"
            : run.tool_call_count > 0
              ? `AI 助教完成学习动作（${run.tool_call_count} 次工具调用）`
              : "AI 助教课程辅导",
        subtitle: `${(run.user_prompt || "对话交互").slice(0, 56)}${run.total_duration_ms ? ` · 耗时 ${formatDuration(run.total_duration_ms)}` : ""}`,
        timestamp: run.started_at,
        runId: run.run_id,
      });
    }

    return list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [revisions, domainEvents, traceRuns]);

  function openTraceFromHistory(entry: {
    runId?: string | null;
    revisionId?: string;
  }) {
    setViewLayer("trace");
    if (entry.runId) {
      setSelectedRunId(entry.runId);
      setTab("runs");
    } else if (entry.revisionId) {
      setTab("revisions");
    } else {
      setTab("runs");
    }
  }

  return (
    <div className="mx-auto max-w-[1440px] space-y-4">
      {/* Top 2-Layer Activity Switcher (活动历史 vs 开发者 Trace) */}
      <section className="flex flex-wrap items-center justify-between gap-3 pb-2">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[22px] font-semibold tracking-tight text-[var(--ink)]">
            Activity
          </h1>
          <span
            className={
              "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-medium " +
              (liveConnected
                ? "bg-[var(--surface-2)] text-[var(--ve-emerald)]"
                : "bg-[var(--surface-1)] text-[var(--muted)]")
            }
          >
            <Radio
              size={10}
              className={liveConnected ? "animate-pulse" : ""}
            />
            {liveConnected ? "实时记录" : "本地存档"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg bg-[var(--surface-1)] p-0.5">
            <button
              type="button"
              onClick={() => setViewLayer("history")}
              className={
                "rounded-md px-3 py-1 text-xs transition " +
                (viewLayer === "history"
                  ? "bg-[var(--surface-2)] font-medium text-[var(--ink)] shadow-2xs"
                  : "text-[var(--muted)] hover:text-[var(--ink)]")
              }
            >
              活动历史
            </button>
            <button
              type="button"
              onClick={() => setViewLayer("trace")}
              className={
                "rounded-md px-3 py-1 text-xs transition " +
                (viewLayer === "trace"
                  ? "bg-[var(--ve-surface)] font-medium text-[var(--ve-ink)] shadow-2xs"
                  : "text-[var(--ve-muted)] hover:text-[var(--ve-ink)]")
              }
            >
              开发者 Trace
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              void fetchAuditList();
              if (selectedRunId) void fetchTraceById(selectedRunId);
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3 py-1.5 text-xs font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
          >
            <RefreshCw
              size={12}
              className={loading || traceLoading ? "animate-spin" : ""}
            />
            刷新
          </button>
        </div>
      </section>

      {/* LAYER 1: User-Friendly Activity History (活动历史) */}
      {viewLayer === "history" && (
        <section className="mx-auto max-w-[820px] overflow-hidden rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)]">
          {loading ? (
            <div className="py-12 text-center text-xs text-[var(--ve-muted)]">
              正在加载活动历史…
            </div>
          ) : userTimeline.length === 0 ? (
            <div className="py-12 text-center text-xs text-[var(--ve-muted)]">
              暂无学习与计划活动记录
            </div>
          ) : (
            <div className="divide-y divide-[var(--ve-border)]">
              {userTimeline.map((item) => {
                const Icon =
                  item.kind === "plan"
                    ? CalendarDays
                    : item.kind === "assessment"
                      ? ClipboardCheck
                      : item.kind === "goal"
                        ? Sparkles
                        : BookOpen;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => openTraceFromHistory(item)}
                    className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left transition hover:bg-[var(--ve-surface-alt)]"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <Icon size={16} className="shrink-0 text-[var(--ve-muted)]" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-medium text-[var(--ve-ink)]">
                          {item.title}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-[var(--ve-muted)]">
                          {item.subtitle}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-xs text-[var(--ve-muted)]">
                      <span className="hidden font-mono text-[11px] sm:inline">
                        {formatTs(item.timestamp)}
                      </span>
                      <ChevronRight size={14} />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* LAYER 2: Full Developer Trace Inspector (开发者 Trace) */}
      {viewLayer === "trace" && (
        <div className="space-y-4">
          {/* Top SQLite + Live SSE Status Header */}
          <section className="rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-4 shadow-2xs">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)] ring-1 ring-[var(--ve-emerald)]/30">
                  <Database size={18} />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-bold text-[var(--ve-ink)]">
                      Agent Execution Trace Inspector & 本机 SQLite 审计引擎
                    </h2>
                    <span
                      className={
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold " +
                        (liveConnected
                          ? "bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]"
                          : "bg-[var(--ve-surface-alt)] text-[var(--ve-muted)]")
                      }
                    >
                      <Radio
                        size={10}
                        className={liveConnected ? "animate-pulse" : ""}
                      />
                      {liveConnected ? "实时轨迹追踪已连接" : "离线重放模式"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--ve-muted)]">
                    {dbInfo
                      ? `${dbInfo.path} · ${formatSize(dbInfo.sizeBytes)} · ${dbInfo.runCount} 次 ReAct 执行轨迹 · ${dbInfo.revisionCount} 条计划变更 Diff · ${dbInfo.threadCount} 个持久化会话`
                      : "正在连接本机 SQLite 数据库…"}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {(traceRuns.length > 0 || revisions.length > 0) && (
                  <button
                    type="button"
                    onClick={() => void clearAudit()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ve-rose)]/35 bg-[var(--ve-rose-soft)] px-3 py-1.5 text-xs font-medium text-[var(--ve-rose)] hover:bg-[var(--ve-rose-soft)]"
                  >
                    <Trash2 size={13} /> 清空审计日志
                  </button>
                )}
              </div>
            </div>
          </section>

      {/* Sub-Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTab("runs")}
            className={
              "inline-flex items-center gap-1.5 rounded-xl border px-4 py-2 text-xs font-semibold transition " +
              (tab === "runs"
                ? "border-[var(--ve-accent)] bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]"
                : "border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]")
            }
          >
            <Activity size={14} /> ReAct Execution Trace（{traceRuns.length}）
          </button>
          <button
            type="button"
            onClick={() => setTab("revisions")}
            className={
              "inline-flex items-center gap-1.5 rounded-xl border px-4 py-2 text-xs font-semibold transition " +
              (tab === "revisions"
                ? "border-[var(--ve-accent)] bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]"
                : "border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]")
            }
          >
            <GitCommitHorizontal size={14} /> 计划变更 Diff 历史（
            {revisions.length}）
          </button>
          <button
            type="button"
            onClick={() => setTab("events")}
            className={
              "inline-flex items-center gap-1.5 rounded-xl border px-4 py-2 text-xs font-semibold transition " +
              (tab === "events"
                ? "border-[var(--ve-accent)] bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]"
                : "border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]")
            }
          >
            <Layers size={14} /> 领域事件流（{domainEvents.length}）
          </button>
        </div>

        {/* Filter & Search Bar for Execution Traces */}
        {tab === "runs" && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1.5">
              <Search size={13} className="text-[var(--ve-muted)]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && searchQuery.trim().startsWith("run-")) {
                    setSelectedRunId(searchQuery.trim());
                  }
                }}
                placeholder="按 run_id 或提问内容搜索…"
                className="w-[190px] bg-transparent text-xs text-[var(--ve-ink)] outline-none placeholder:text-[#94a3b8]"
              />
              {searchQuery.trim().startsWith("run-") && (
                <button
                  type="button"
                  onClick={() => setSelectedRunId(searchQuery.trim())}
                  className="rounded bg-[var(--ve-accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--ve-accent)] hover:bg-[var(--ve-accent-soft)]"
                >
                  加载
                </button>
              )}
            </div>

            <div className="flex items-center gap-1 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2 py-1">
              <Filter size={12} className="text-[var(--ve-muted)]" />
              <select
                aria-label="按工具名称过滤"
                value={toolFilter}
                onChange={(e) => setToolFilter(e.target.value)}
                className="bg-transparent text-xs font-medium text-[var(--ve-ink)] outline-none"
              >
                <option value="all">全部工具</option>
                {KNOWN_TOOLS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] p-0.5 text-[11px]">
              {(
                [
                  { id: "all", label: "全部" },
                  { id: "running", label: "运行中" },
                  { id: "completed", label: "成功" },
                  { id: "failed", label: "失败" },
                ] as const
              ).map((st) => (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => setStatusFilter(st.id)}
                  className={
                    "rounded-md px-2.5 py-1 font-medium transition " +
                    (statusFilter === st.id
                      ? "bg-[var(--ve-accent-solid)] text-white"
                      : "text-[var(--ve-muted)] hover:text-[var(--ve-ink)]")
                  }
                >
                  {st.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* TAB 1: AGENT EXECUTION TRACE INSPECTOR */}
      {tab === "runs" && (
        <div className="space-y-4">
          {/* Horizontal / Compact Run Selector Strip */}
          {traceRuns.length === 0 ? (
            <section className="rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-surface)] py-14 text-center text-sm text-[var(--ve-muted)]">
              暂无匹配的 ReAct Execution Trace。在「学习课堂」发起对话后，完整的用户输入、模型决策、工具参数、返回结果与状态 Diff 会实时落盘并展示在此处。
            </section>
          ) : (
            <>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {traceRuns.map((r) => {
                  const active = r.run_id === selectedRunId;
                  return (
                    <button
                      key={r.run_id}
                      type="button"
                      onClick={() => setSelectedRunId(r.run_id)}
                      className={
                        "flex min-w-[240px] max-w-[300px] shrink-0 flex-col rounded-xl border p-3 text-left transition " +
                        (active
                          ? "border-[var(--ve-accent)] bg-[var(--ve-accent-soft)] shadow-2xs"
                          : "border-[var(--ve-border)] bg-[var(--ve-surface)] hover:border-[var(--ve-line)]")
                      }
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] font-bold text-[var(--ve-accent)]">
                          #{r.run_id.replace(/^run-/, "").slice(0, 8)}
                        </span>
                        <span
                          className={
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.2 text-[10px] font-semibold " +
                            (r.status === "completed"
                              ? "bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]"
                              : r.status === "running"
                                ? "bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]"
                                : "bg-[var(--ve-rose-soft)] text-[var(--ve-rose)]")
                          }
                        >
                          {r.status === "running" && (
                            <Loader2 size={9} className="animate-spin" />
                          )}
                          {r.status === "completed"
                            ? "Completed"
                            : r.status === "running"
                              ? "Running"
                              : r.status === "cancelled"
                                ? "Cancelled"
                                : "Failed"}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-1 text-xs font-semibold text-[var(--ve-ink)]">
                        {r.user_prompt || "（空输入）"}
                      </p>
                      <div className="mt-1.5 flex items-center justify-between text-[10.5px] text-[var(--ve-muted)]">
                        <span className="truncate">
                          {r.model_label} · {r.tool_call_count} 工具
                        </span>
                        <span className="font-mono">
                          {formatDuration(r.total_duration_ms)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Active Trace Detail Header + Metric Cards + 2-Pane Inspector */}
              {activeTrace && (
                <section className="rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-5 shadow-2xs">
                  {/* Trace Summary Header (matches clean desktop inspector layout) */}
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-bold text-[var(--ve-ink)]">
                          ReAct Execution Trace
                        </h3>
                        <span
                          className={
                            "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold " +
                            (activeTrace.run.status === "completed"
                              ? "bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)] ring-1 ring-[var(--ve-emerald)]/30"
                              : activeTrace.run.status === "running"
                                ? "bg-[var(--ve-accent-soft)] text-[var(--ve-accent)] ring-1 ring-[var(--ve-accent)]/30"
                                : "bg-[var(--ve-rose-soft)] text-[var(--ve-rose)] ring-1 ring-[var(--ve-rose)]/30")
                          }
                        >
                          {activeTrace.run.status === "running" && (
                            <Loader2 size={11} className="animate-spin" />
                          )}
                          {activeTrace.run.status === "completed"
                            ? "Completed"
                            : activeTrace.run.status === "running"
                              ? "Running"
                              : activeTrace.run.status === "cancelled"
                                ? "Cancelled"
                                : "Failed"}
                        </span>
                        {activeTrace.run.trace_write_errors > 0 && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--ve-amber-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ve-amber)]">
                            <AlertCircle size={11} /> Trace 写入异常{" "}
                            {activeTrace.run.trace_write_errors} 次
                          </span>
                        )}
                      </div>
                      <p className="mt-1 font-mono text-xs text-[var(--ve-muted)]">
                        Run {activeTrace.run.run_id} ·{" "}
                        {activeTrace.run.provider} / {activeTrace.run.model} ·{" "}
                        {formatTs(activeTrace.run.started_at)} · 会话{" "}
                        {activeTrace.run.conversation_id}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void fetchTraceById(activeTrace.run.run_id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]"
                      >
                        <RefreshCw size={12} /> 按 run_id 重载
                      </button>
                      <button
                        type="button"
                        onClick={copyFullTraceJson}
                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-accent-soft)] hover:text-[var(--ve-accent)]"
                      >
                        {copiedFullTrace ? (
                          <Check size={12} className="text-[var(--ve-emerald)]" />
                        ) : (
                          <Copy size={12} />
                        )}
                        {copiedFullTrace ? "已复制完整 Trace" : "复制完整 JSON"}
                      </button>
                    </div>
                  </div>

                  {/* 4 Metric Cards */}
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-3">
                      <div className="text-[11px] font-medium text-[var(--ve-muted)]">
                        执行时间
                      </div>
                      <div className="mt-1 font-mono text-lg font-bold text-[var(--ve-ink)]">
                        {formatDuration(activeTrace.run.total_duration_ms)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-3">
                      <div className="text-[11px] font-medium text-[var(--ve-muted)]">
                        工具调用
                      </div>
                      <div className="mt-1 font-mono text-lg font-bold text-[var(--ve-ink)]">
                        {activeTrace.toolCalls.length} 次
                        {activeTrace.toolCalls.some(
                          (t) => t.execution_status === "failed",
                        ) && (
                          <span className="ml-1.5 text-xs font-semibold text-[var(--ve-rose)]">
                            (
                            {
                              activeTrace.toolCalls.filter(
                                (t) => t.execution_status === "failed",
                              ).length
                            }{" "}
                            失败)
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-3">
                      <div className="text-[11px] font-medium text-[var(--ve-muted)]">
                        执行步数
                      </div>
                      <div className="mt-1 font-mono text-lg font-bold text-[var(--ve-ink)]">
                        {activeTrace.run.step_count || activeTrace.events.length}
                      </div>
                    </div>
                    <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-3">
                      <div className="text-[11px] font-medium text-[var(--ve-muted)]">
                        状态变更 Diff
                      </div>
                      <div className="mt-1 font-mono text-lg font-bold text-[var(--ve-ink)]">
                        {activeTrace.stateChanges.length} 项
                      </div>
                    </div>
                  </div>

                  {/* Two-Pane Inspector: Left Execution Step Timeline | Right Step Detail */}
                  {activeTrace.events.length === 0 ? (
                    <div className="mt-4 rounded-xl border border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] p-4 text-xs text-[var(--ve-amber)]">
                      该历史记录写入于 Trace 升级之前，未采集逐步骤参数与返回值（未提供）。发起一次新对话即可查看完整结构化轨迹。
                    </div>
                  ) : (
                    <div className="mt-5 grid gap-4 lg:grid-cols-12">
                      {/* LEFT: Execution Steps Timeline */}
                      <div className="space-y-2 lg:col-span-5">
                        <div className="flex items-center justify-between px-1 text-[11px] font-semibold text-[var(--ve-muted)]">
                          <span>执行步骤时间线（点击查看详情）</span>
                          <span className="font-mono">
                            {activeTrace.events.length} events
                          </span>
                        </div>

                        <div className="max-h-[640px] space-y-1.5 overflow-y-auto pr-1">
                          {timelineGroups.map((item) => {
                            if (item.kind === "tool_group") {
                              const collapsed =
                                collapsedToolGroups[item.key] ?? true;
                              return (
                                <div
                                  key={item.key}
                                  className="overflow-hidden rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)]"
                                >
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setCollapsedToolGroups((prev) => ({
                                        ...prev,
                                        [item.key]: !collapsed,
                                      }))
                                    }
                                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
                                  >
                                    <span className="flex items-center gap-1.5 truncate">
                                      {collapsed ? (
                                        <ChevronRight size={13} />
                                      ) : (
                                        <ChevronDown size={13} />
                                      )}
                                      <Layers
                                        size={13}
                                        className="text-[var(--ve-accent)]"
                                      />
                                      <span className="truncate">
                                        {item.label}
                                      </span>
                                    </span>
                                    <span
                                      className={
                                        "shrink-0 rounded-full px-2 py-0.2 text-[10px] " +
                                        (item.hasError
                                          ? "bg-[var(--ve-rose-soft)] text-[var(--ve-rose)]"
                                          : "bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]")
                                      }
                                    >
                                      {item.events.length} 步
                                    </span>
                                  </button>

                                  {!collapsed && (
                                    <div className="space-y-1 border-t border-[var(--ve-border)] p-2">
                                      {item.events.map((ev) => {
                                        const meta = eventDisplayMeta(ev);
                                        const Icon = meta.icon;
                                        const active =
                                          selectedEvent?.step_id === ev.step_id;
                                        return (
                                          <button
                                            key={ev.step_id}
                                            type="button"
                                            onClick={() =>
                                              setSelectedStepId(ev.step_id)
                                            }
                                            className={
                                              "flex w-full items-start justify-between gap-2 rounded-lg border px-2.5 py-2 text-left transition " +
                                              (active
                                                ? "border-[var(--ve-accent)] bg-[var(--ve-accent-soft)]"
                                                : "border-transparent bg-[var(--ve-surface)] hover:border-[var(--ve-line)]")
                                            }
                                          >
                                            <div className="flex min-w-0 items-start gap-2">
                                              <Icon
                                                size={13}
                                                className="mt-0.5 shrink-0 text-[var(--ve-muted)]"
                                              />
                                              <div className="min-w-0">
                                                <div className="truncate text-xs font-semibold text-[var(--ve-ink)]">
                                                  {String(ev.seq).padStart(
                                                    2,
                                                    "0",
                                                  )}{" "}
                                                  · {meta.title}
                                                </div>
                                                <div className="truncate text-[11px] text-[var(--ve-muted)]">
                                                  {meta.subtitle}
                                                </div>
                                              </div>
                                            </div>
                                            {ev.duration_ms !== null && (
                                              <span className="shrink-0 font-mono text-[10px] text-[var(--ve-muted)]">
                                                {formatDuration(ev.duration_ms)}
                                              </span>
                                            )}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            }

                            const ev = item.event;
                            const meta = eventDisplayMeta(ev);
                            const Icon = meta.icon;
                            const active =
                              selectedEvent?.step_id === ev.step_id;

                            return (
                              <button
                                key={ev.step_id}
                                type="button"
                                onClick={() => setSelectedStepId(ev.step_id)}
                                className={
                                  "flex w-full items-start justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-left transition " +
                                  (active
                                    ? "border-[var(--ve-accent)] bg-[var(--ve-accent-soft)] shadow-2xs"
                                    : "border-[var(--ve-border)] bg-[var(--ve-surface)] hover:border-[var(--ve-line)] hover:bg-[var(--ve-surface-alt)]")
                                }
                              >
                                <div className="flex min-w-0 items-start gap-2.5">
                                  <span
                                    className={
                                      "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg " +
                                      meta.badgeColor
                                    }
                                  >
                                    <Icon
                                      size={13}
                                      className={
                                        ev.event_type === "tool.started"
                                          ? "animate-spin"
                                          : ""
                                      }
                                    />
                                  </span>
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--ve-ink)]">
                                      <span className="font-mono text-[11px] text-[var(--ve-muted)]">
                                        {String(ev.seq).padStart(2, "0")} ·
                                      </span>
                                      <span className="truncate">
                                        {meta.title}
                                      </span>
                                    </div>
                                    <div className="mt-0.5 truncate text-[11px] text-[var(--ve-muted)]">
                                      {meta.subtitle}
                                    </div>
                                  </div>
                                </div>

                                <div className="flex shrink-0 flex-col items-end gap-1">
                                  <span className="font-mono text-[10px] text-[var(--ve-muted)]">
                                    {formatDuration(ev.duration_ms)}
                                  </span>
                                  <span
                                    className={
                                      "rounded-full px-1.5 py-0.2 font-mono text-[9.5px] font-semibold " +
                                      (ev.status === "error"
                                        ? "bg-[var(--ve-rose-soft)] text-[var(--ve-rose)]"
                                        : ev.status === "running"
                                          ? "bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]"
                                          : "bg-[var(--ve-surface-alt)] text-[var(--ve-muted)]")
                                    }
                                  >
                                    {ev.event_type}
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* RIGHT: Selected Step Inspector Detail */}
                      <div className="space-y-3 lg:col-span-7">
                        {selectedEvent ? (
                          <div className="rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-4 space-y-3.5">
                            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--ve-border)] pb-3">
                              <div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="rounded-md bg-[var(--ve-accent-solid)] px-2 py-0.5 font-mono text-[11px] font-semibold text-white">
                                    {selectedEvent.event_type}
                                  </span>
                                  <span className="text-sm font-bold text-[var(--ve-ink)]">
                                    {eventDisplayMeta(selectedEvent).title}
                                  </span>
                                  {selectedEvent.duration_ms !== null && (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--ve-surface)] px-2 py-0.5 font-mono text-[11px] text-[var(--ve-muted)] ring-1 ring-[var(--ve-border)]">
                                      <Clock3 size={10} />
                                      {formatDuration(selectedEvent.duration_ms)}
                                    </span>
                                  )}
                                </div>
                                <div className="mt-1.5 flex flex-wrap items-center gap-3 font-mono text-[10.5px] text-[var(--ve-muted)]">
                                  <span>step_id: {selectedEvent.step_id}</span>
                                  {selectedEvent.parent_span_id && (
                                    <span>
                                      parent_span: {selectedEvent.parent_span_id}
                                    </span>
                                  )}
                                  {selectedEvent.tool_call_id && (
                                    <span className="font-semibold text-[var(--ve-accent)]">
                                      tool_call_id: {selectedEvent.tool_call_id}
                                    </span>
                                  )}
                                  <span>{formatTs(selectedEvent.timestamp)}</span>
                                </div>
                              </div>
                            </div>

                            {/* 1. Final Response Markdown Rendering */}
                            {selectedEvent.event_type === "run.completed" && (
                              <div className="space-y-3">
                                <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-4">
                                  <div className="mb-2 text-xs font-semibold text-[var(--ve-accent)]">
                                    Final Response（Markdown 渲染）
                                  </div>
                                  {activeTrace.run.final_response ? (
                                    <RichMarkdown
                                      content={activeTrace.run.final_response}
                                    />
                                  ) : (
                                    <div className="text-xs text-[var(--ve-muted)]">
                                      未提供最终文本（本轮仅输出工具卡片）
                                    </div>
                                  )}
                                </div>
                                <JsonViewer
                                  title="Run Completed Payload"
                                  data={selectedEvent.payload}
                                  defaultOpen={false}
                                />
                              </div>
                            )}

                            {/* 2. Run Failed Error Banner */}
                            {selectedEvent.event_type === "run.failed" && (
                              <div className="space-y-3">
                                <div className="rounded-xl border border-[var(--ve-rose)]/35 bg-[var(--ve-rose-soft)] p-3.5 text-xs text-[var(--ve-rose)]">
                                  <div className="font-semibold">
                                    运行异常 / 中断原因：
                                  </div>
                                  <p className="mt-1 font-mono">
                                    {String(
                                      selectedEvent.payload.error ||
                                        activeTrace.run.error_message ||
                                        "未知错误",
                                    )}
                                  </p>
                                </div>
                                <JsonViewer
                                  title="Failure Payload"
                                  data={selectedEvent.payload}
                                />
                              </div>
                            )}

                            {/* 3. LLM Response Details (Visible output, Reasoning availability, Requested Tool Intents) */}
                            {selectedEvent.event_type === "model.response" && (
                              <div className="space-y-3">
                                <div className="grid gap-2.5 sm:grid-cols-3">
                                  <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-2.5 text-xs">
                                    <div className="text-[10.5px] text-[var(--ve-muted)]">
                                      Finish Reason
                                    </div>
                                    <div className="mt-0.5 font-mono font-semibold text-[var(--ve-ink)]">
                                      {String(
                                        selectedEvent.payload.finish_reason ||
                                          "未提供",
                                      )}
                                    </div>
                                  </div>
                                  <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-2.5 text-xs">
                                    <div className="text-[10.5px] text-[var(--ve-muted)]">
                                      LLM 内部推理
                                    </div>
                                    <div className="mt-0.5 font-medium text-[var(--ve-ink)]">
                                      {selectedEvent.payload.reasoning_provided
                                        ? `已返回（${String(selectedEvent.payload.reasoning || "").length} 字）`
                                        : "未提供（Provider 未暴露）"}
                                    </div>
                                  </div>
                                  <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-2.5 text-xs">
                                    <div className="text-[10.5px] text-[var(--ve-muted)]">
                                      Token Usage
                                    </div>
                                    <div className="mt-0.5 font-mono text-[11px] text-[var(--ve-ink)]">
                                      {selectedEvent.payload.usage
                                        ? JSON.stringify(
                                            selectedEvent.payload.usage,
                                          ).slice(0, 48)
                                        : "未提供"}
                                    </div>
                                  </div>
                                </div>

                                <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-3.5">
                                  <div className="mb-1.5 text-xs font-semibold text-[var(--ve-ink)]">
                                    LLM 可见输出（Visible Output）
                                  </div>
                                  {String(
                                    selectedEvent.payload.visible_output || "",
                                  ).trim() ? (
                                    <RichMarkdown
                                      content={String(
                                        selectedEvent.payload.visible_output,
                                      )}
                                      compact
                                    />
                                  ) : (
                                    <div className="text-xs text-[var(--ve-muted)]">
                                      本步模型直接发起了工具调用，未产出可见文本。
                                    </div>
                                  )}
                                </div>

                                {Boolean(
                                  selectedEvent.payload.reasoning_provided,
                                ) && (
                                  <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-3.5">
                                    <div className="mb-1.5 text-xs font-semibold text-[var(--ve-ink)]">
                                      Provider 返回的推理文本（Reasoning）
                                    </div>
                                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--ve-canvas)] p-2.5 font-mono text-[11.5px] text-[var(--ve-ink)]">
                                      {String(selectedEvent.payload.reasoning)}
                                    </pre>
                                  </div>
                                )}

                                <JsonViewer
                                  title="Model Requested Tool Calls（模型请求的工具意图与参数）"
                                  data={selectedEvent.payload.requested_tool_calls}
                                  emptyLabel="模型本步未请求任何工具调用"
                                />
                              </div>
                            )}

                            {/* 4. Tool Request / Started / Completed / Failed */}
                            {(selectedEvent.event_type === "tool.requested" ||
                              selectedEvent.event_type === "tool.started" ||
                              selectedEvent.event_type === "tool.completed" ||
                              selectedEvent.event_type === "tool.failed") && (
                              <div className="space-y-3">
                                {linkedToolCall && (
                                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3.5 py-2.5 text-xs">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-mono font-bold text-[var(--ve-accent)]">
                                        {linkedToolCall.tool_name}
                                      </span>
                                      <span className="rounded bg-[var(--ve-surface-alt)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--ve-muted)]">
                                        call_id: {linkedToolCall.tool_call_id}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className="rounded-full bg-[var(--ve-accent-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--ve-accent)]">
                                        Model Requested ✓
                                      </span>
                                      <span
                                        className={
                                          "rounded-full px-2 py-0.5 text-[10.5px] font-semibold " +
                                          (linkedToolCall.started_at
                                            ? "bg-[var(--ve-accent-soft)] text-sky-700"
                                            : "bg-[var(--ve-surface-alt)] text-[var(--ve-muted)]")
                                        }
                                      >
                                        Tool Executed{" "}
                                        {linkedToolCall.started_at ? "✓" : "…"}
                                      </span>
                                      <span
                                        className={
                                          "rounded-full px-2 py-0.5 text-[10.5px] font-semibold " +
                                          (linkedToolCall.execution_status ===
                                          "succeeded"
                                            ? "bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]"
                                            : linkedToolCall.execution_status ===
                                                "failed"
                                              ? "bg-[var(--ve-rose-soft)] text-[var(--ve-rose)]"
                                              : "bg-[var(--ve-amber-soft)] text-[var(--ve-amber)]")
                                        }
                                      >
                                        {linkedToolCall.execution_status ===
                                        "succeeded"
                                          ? "Tool Succeeded ✓"
                                          : linkedToolCall.execution_status ===
                                              "failed"
                                            ? "Tool Failed ✕"
                                            : linkedToolCall.execution_status}
                                      </span>
                                    </div>
                                  </div>
                                )}

                                {Boolean(
                                  linkedToolCall?.error ||
                                    selectedEvent.payload.error,
                                ) && (
                                  <div className="rounded-xl border border-[var(--ve-rose)]/35 bg-[var(--ve-rose-soft)] px-3.5 py-2.5 text-xs text-[var(--ve-rose)]">
                                    <strong className="font-semibold">
                                      工具执行错误：
                                    </strong>
                                    <span className="ml-1 font-mono">
                                      {String(
                                        linkedToolCall?.error ||
                                          selectedEvent.payload.error,
                                      )}
                                    </span>
                                  </div>
                                )}

                                <JsonViewer
                                  title="Tool Arguments（模型提交的参数）"
                                  data={
                                    linkedToolCall
                                      ? linkedToolCall.arguments
                                      : selectedEvent.payload.arguments
                                  }
                                />

                                <JsonViewer
                                  title="Tool Execution Result（工具实际返回值）"
                                  data={
                                    linkedToolCall
                                      ? linkedToolCall.result
                                      : selectedEvent.payload.result
                                  }
                                  emptyLabel="工具仍在执行中或无返回值"
                                />

                                {linkedStateChanges.length > 0 && (
                                  <div className="space-y-2">
                                    <div className="text-xs font-semibold text-[var(--ve-ink)]">
                                      关联的数据状态变化 Diff（
                                      {linkedStateChanges.length} 项）
                                    </div>
                                    {linkedStateChanges.map((sc) => (
                                      <StateDiffBlock
                                        key={sc.change_id}
                                        sc={sc}
                                      />
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* 5. Dedicated State Change Event */}
                            {selectedEvent.event_type === "state.changed" && (
                              <div className="space-y-3">
                                {linkedStateChanges.length > 0 ? (
                                  linkedStateChanges.map((sc) => (
                                    <StateDiffBlock key={sc.change_id} sc={sc} />
                                  ))
                                ) : (
                                  <JsonViewer
                                    title="State Change Payload"
                                    data={selectedEvent.payload}
                                  />
                                )}
                              </div>
                            )}

                            {/* 6. Run Started (with Context Inspector) / Model Request */}
                            {(selectedEvent.event_type === "run.started" ||
                              selectedEvent.event_type === "model.request") && (
                              <div className="space-y-3">
                                {selectedEvent.event_type === "run.started" &&
                                  Boolean(
                                    selectedEvent.payload.context_compaction,
                                  ) && (() => {
                                    const cc = selectedEvent.payload
                                      .context_compaction as {
                                      taskType?: string;
                                      selectedSections?: string[];
                                      originalTokens?: number;
                                      compactedTokens?: number;
                                      savedPct?: number;
                                      foldedToolCount?: number;
                                      rollingCompacted?: boolean;
                                      budgetTokens?: number;
                                    };
                                    return (
                                      <div className="rounded-xl border border-[var(--ve-accent)]/35 bg-[var(--ve-surface)] p-3.5 text-xs">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                          <span className="font-bold text-[var(--ve-accent)]">
                                            Context Inspector（本次发送给 LLM 的上下文组装）
                                          </span>
                                          <span className="rounded-full bg-[var(--ve-accent-soft)] px-2 py-0.5 font-mono text-[10.5px] font-semibold text-[var(--ve-accent)]">
                                            任务类型：{cc.taskType || "chat"}
                                          </span>
                                        </div>
                                        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                                          <div className="rounded-lg bg-[var(--ve-canvas)] p-2">
                                            <div className="text-[10px] text-[var(--ve-muted)]">
                                              原始 Token 估算
                                            </div>
                                            <div className="font-mono font-bold text-[var(--ve-ink)]">
                                              {cc.originalTokens ?? 0}
                                            </div>
                                          </div>
                                          <div className="rounded-lg bg-[var(--ve-canvas)] p-2">
                                            <div className="text-[10px] text-[var(--ve-muted)]">
                                              裁剪后 Token
                                            </div>
                                            <div className="font-mono font-bold text-[var(--ve-emerald)]">
                                              {cc.compactedTokens ?? 0}（省{" "}
                                              {cc.savedPct ?? 0}%）
                                            </div>
                                          </div>
                                          <div className="rounded-lg bg-[var(--ve-canvas)] p-2">
                                            <div className="text-[10px] text-[var(--ve-muted)]">
                                              已折叠旧工具
                                            </div>
                                            <div className="font-mono font-bold text-[var(--ve-ink)]">
                                              {cc.foldedToolCount ?? 0} 个
                                            </div>
                                          </div>
                                          <div className="rounded-lg bg-[var(--ve-canvas)] p-2">
                                            <div className="text-[10px] text-[var(--ve-muted)]">
                                              滚动摘要压缩
                                            </div>
                                            <div className="font-semibold text-[var(--ve-ink)]">
                                              {cc.rollingCompacted
                                                ? "已触发"
                                                : "窗口充裕"}
                                            </div>
                                          </div>
                                        </div>
                                        {Array.isArray(cc.selectedSections) &&
                                          cc.selectedSections.length > 0 && (
                                            <div className="mt-2.5 flex flex-wrap gap-1.5">
                                              {cc.selectedSections.map((sec) => (
                                                <span
                                                  key={sec}
                                                  className="rounded-md border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-2 py-0.5 text-[10.5px] text-[var(--ve-muted)]"
                                                >
                                                  ✓ {sec}
                                                </span>
                                              ))}
                                            </div>
                                          )}
                                      </div>
                                    );
                                  })()}

                                <JsonViewer
                                  title={
                                    selectedEvent.event_type === "run.started"
                                      ? "User Input & Run Context（已自动脱敏）"
                                      : "LLM Request Metadata（已自动脱敏）"
                                  }
                                  data={selectedEvent.payload}
                                />
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-8 text-center text-xs text-[var(--ve-muted)]">
                            请在左侧点击任意执行步骤查看详细参数、返回值与状态变更。
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      )}

      {/* TAB 2: PLAN REVISION DIFF HISTORY */}
      {tab === "revisions" && (
        <section className="rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-5 shadow-2xs space-y-3">
          {revisions.length === 0 ? (
            <div className="py-10 text-center text-sm text-[var(--ve-muted)]">
              暂无计划变更记录。当你创建课程、调整日程或由 Agent 动态重排后，这里会自动保存每次前后 Diff。
            </div>
          ) : (
            revisions.map((rev) => (
              <div
                key={rev.id}
                className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-[var(--ve-accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ve-accent)]">
                      {rev.trigger}
                    </span>
                    <span className="text-xs text-[var(--ve-muted)]">
                      日程数：{rev.beforeCount} → {rev.afterCount}
                    </span>
                  </div>
                  <span className="inline-flex items-center gap-1 text-[11px] text-[var(--ve-muted)]">
                    <Clock3 size={11} /> {formatTs(rev.createdAt)}
                  </span>
                </div>

                <p className="mt-2 text-xs leading-relaxed text-[var(--ve-ink)]">
                  {rev.summary}
                </p>

                <div className="mt-2.5 space-y-1.5">
                  {rev.diff.added.map((a, idx) => (
                    <div
                      key={`add-${idx}`}
                      className="flex flex-wrap items-center gap-1.5 rounded-lg bg-[var(--ve-emerald-soft)] px-2.5 py-1.5 text-[11px] text-[var(--ve-emerald)]"
                    >
                      <Plus size={12} />
                      <strong>新增</strong>
                      <span>{a.title}</span>
                      <span className="text-[var(--ve-emerald)]/85">
                        · {a.day.slice(5)} {time(a.start)}–
                        {time(a.start + a.minutes)}（{a.minutes}m）
                      </span>
                    </div>
                  ))}
                  {rev.diff.moved.map((m, idx) => (
                    <div
                      key={`mov-${idx}`}
                      className="flex flex-wrap items-center gap-1.5 rounded-lg bg-[var(--ve-accent-soft)] px-2.5 py-1.5 text-[11px] text-[var(--ve-accent)]"
                    >
                      <strong>调整</strong>
                      <span>{m.title}</span>
                      <s className="text-[var(--ve-muted)]">
                        {m.oldDay.slice(5)} {time(m.oldStart)} ({m.oldMinutes}m)
                      </s>
                      <ArrowRight size={11} />
                      <span className="font-semibold">
                        {m.newDay.slice(5)} {time(m.newStart)} ({m.newMinutes}m)
                      </span>
                    </div>
                  ))}
                  {rev.diff.removed.map((r, idx) => (
                    <div
                      key={`rem-${idx}`}
                      className="flex flex-wrap items-center gap-1.5 rounded-lg bg-[var(--ve-rose-soft)] px-2.5 py-1.5 text-[11px] text-[var(--ve-rose)]"
                    >
                      <Minus size={12} />
                      <strong>移除</strong>
                      <span>{r.title}</span>
                      <span className="opacity-80">
                        · {r.day.slice(5)} {time(r.start)}（{r.minutes}m）
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </section>
      )}

      {/* TAB 3: DOMAIN EVENTS STREAM */}
      {tab === "events" && (
        <section className="rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-5 shadow-2xs space-y-2.5">
          {domainEvents.length === 0 ? (
            <div className="py-10 text-center text-sm text-[var(--ve-muted)]">
              暂无领域事件。当创建学习目标、完成练习评估、写入记忆或发生计划变更时，系统会自动将事实事件落入 SQLite `domain_events` 表并关联对应 Agent Run。
            </div>
          ) : (
            domainEvents.map((ev) => (
              <div
                key={ev.eventId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-4 py-3 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-[var(--ve-accent-soft)] px-2 py-0.5 font-mono text-[11px] font-semibold text-[var(--ve-accent)]">
                      {ev.eventType}
                    </span>
                    <span className="font-mono text-[10.5px] text-[var(--ve-muted)]">
                      {ev.entityType} · {ev.entityId}
                    </span>
                  </div>
                  <p className="mt-1 font-medium text-[var(--ve-ink)]">{ev.summary}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {/* ACT-02 / ACT-03 / ACT-04: Clickable entity navigation */}
                  {(ev.eventType === "GoalCreated" ||
                    ev.entityType === "goal") && (
                    <button
                      type="button"
                      onClick={() => {
                        if (ev.entityId) setActiveTrackId(ev.entityId);
                        setWorkspaceTab("graph");
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
                    >
                      查看知识路径 <ArrowRight size={11} />
                    </button>
                  )}
                  {(ev.eventType === "AssessmentCompleted" ||
                    ev.eventType === "RemediationTriggered" ||
                    ev.eventType === "ReviewCompleted") &&
                    typeof ev.payload?.lessonId === "string" && (
                      <button
                        type="button"
                        onClick={() => {
                          openLessonInLearn(String(ev.payload.lessonId), {
                            mode: "practice",
                            exerciseId:
                              typeof ev.payload.exerciseId === "string"
                                ? ev.payload.exerciseId
                                : undefined,
                          });
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
                      >
                        查看课程与作答 <ArrowRight size={11} />
                      </button>
                    )}
                  {(ev.eventType === "CalendarChanged" ||
                    ev.eventType === "PlanVersionCreated") && (
                    <button
                      type="button"
                      onClick={() => {
                        if (typeof ev.payload?.day === "string") {
                          setDay(ev.payload.day);
                        }
                        setWorkspaceTab("calendar");
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
                    >
                      查看日历 <ArrowRight size={11} />
                    </button>
                  )}
                  {ev.runId && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedRunId(ev.runId!);
                        setTab("runs");
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-[var(--ve-accent)]/35 bg-[var(--ve-surface)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ve-accent)] hover:bg-[var(--ve-accent-soft)]"
                    >
                      查看 Trace ({ev.runId.slice(-6)}) <ArrowRight size={11} />
                    </button>
                  )}
                  <span className="font-mono text-[10.5px] text-[var(--ve-muted)]">
                    {formatTs(ev.createdAt)}
                  </span>
                </div>
              </div>
            ))
          )}
        </section>
      )}
        </div>
      )}
    </div>
  );
}
