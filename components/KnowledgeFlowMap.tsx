"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowRight,
  BookOpen,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Compass,
  FastForward,
  GitFork,
  Layers,
  LockKeyhole,
  Plus,
  Route,
  SlidersHorizontal,
  Target,
  Trash2,
  X,
} from "lucide-react";
import {
  available,
  diffDays,
  focusLesson,
  formatDayWithWeekday,
  getActiveTrack,
  getArchivedTracks,
  getLessonById,
  getLessonRetrievability,
  getMissingPrerequisites,
  getTracks,
  isRemedialBlock,
  offset,
  time,
  type Lesson,
  type TrackDepth,
} from "../lib/learning";
import {
  TRACK_DEPTH_LABELS,
  groupLessonsIntoStages,
  normalizeKnowledgeGraphTopology,
} from "../lib/curriculum-planner";
import { computeLearnerStatus, learnerStatusLabel } from "../lib/pedagogy";
import {
  computeCrossChapterConceptLinks,
  layoutKnowledgeGraph,
} from "../lib/graph";
import { useLearningStore } from "./LearningStore";
import RetentionCurveChart from "./gen-ui/RetentionCurveChart";
import { ConfirmDangerDialog } from "./gen-ui/ConfirmDangerDialog";
import { SPRING_CRISP, TRANSITION_FAST } from "../lib/motion";

function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const sync = () => {
      setDark(document.documentElement.dataset.theme === "dark");
    };
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  return dark;
}

type TrackImpactPreview = {
  trackId: string;
  title: string;
  lessonCount: number;
  exclusiveLessonCount: number;
  sharedLessonIds: string[];
  futureBlockCount: number;
  completedBlockCount: number;
  exerciseCount: number;
  attemptCount: number;
  sessionCount: number;
  pendingDraftCount: number;
  otherTrackCount: number;
};

type FlowUnitData = {
  lesson: Lesson;
  mastery: number;
  status: "mastered" | "available" | "locked";
  dueReview: boolean;
  selected: boolean;
  isCurrentFocus: boolean;
  inRelation: "prereq" | "downstream" | "related" | null;
};

function KnowledgeUnitNode({ data }: NodeProps<Node<FlowUnitData>>) {
  const {
    lesson,
    mastery,
    status,
    dueReview,
    selected,
    isCurrentFocus,
    inRelation,
  } = data;

  const borderCls = selected
    ? "border-[var(--ve-accent)] ring-3 ring-[var(--ve-accent)]/25 shadow-md"
    : isCurrentFocus
      ? "border-[var(--ve-accent)] ring-2 ring-[var(--ve-accent)]/20 shadow-xs"
      : inRelation === "prereq"
        ? "border-[var(--ve-amber)]/60 ring-2 ring-[var(--ve-amber)]/25"
        : inRelation === "downstream"
          ? "border-[var(--ve-emerald)]/60 ring-2 ring-[var(--ve-emerald)]/25"
          : inRelation === "related"
            ? "border-[var(--ve-accent)]/45 ring-2 ring-[var(--ve-accent)]/25"
            : status === "mastered"
              ? "border-[var(--ve-emerald)]/45"
              : status === "available"
                ? "border-[var(--ve-accent)]/55"
                : "border-[var(--ve-border)] opacity-85";

  const shortStage = lesson.stageTitle
    ? lesson.stageTitle.split("·")[0]?.trim()
    : null;
  const shortSection = lesson.moduleTitle
    ? lesson.moduleTitle.slice(0, 14)
    : null;

  return (
    <div
      className={
        "w-[232px] rounded-2xl border bg-[var(--ve-surface)] px-3.5 py-3 text-left transition-all duration-200 " +
        borderCls
      }
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[#2e5bff]"
      />
      <div className="flex items-center justify-between gap-1 text-[10px] font-semibold">
        <span className="inline-flex min-w-0 items-center gap-1 text-[var(--ve-muted)]">
          {status === "locked" ? (
            <LockKeyhole size={11} className="shrink-0 text-[var(--ve-muted)]" />
          ) : status === "mastered" ? (
            <Check size={11} className="shrink-0 text-[var(--ve-emerald)]" />
          ) : (
            <Route size={11} className="shrink-0 text-[var(--ve-accent)]" />
          )}
          <span className="shrink-0">
            {status === "mastered"
              ? "已掌握"
              : isCurrentFocus
                ? "当前主攻"
                : status === "available"
                  ? "可学习"
                  : "待解锁"}
          </span>
          {shortSection ? (
            <span className="truncate text-[var(--ve-muted)]" title={lesson.moduleTitle}>
              · {shortSection}
            </span>
          ) : shortStage ? (
            <span className="truncate text-[var(--ve-muted)]">· {shortStage}</span>
          ) : null}
        </span>
        {dueReview ? (
          <span className="rounded-full bg-[var(--ve-amber-soft)] px-1.5 py-0.2 text-[9px] font-bold text-[var(--ve-amber)]">
            待复习
          </span>
        ) : isCurrentFocus ? (
          <span className="rounded-full bg-[var(--ve-accent-soft)] px-1.5 py-0.2 text-[9px] font-bold text-[var(--ve-accent)]">
            你在这里
          </span>
        ) : inRelation === "prereq" ? (
          <span className="rounded-full bg-[var(--ve-amber-soft)] px-1.5 py-0.2 text-[9px] font-semibold text-[var(--ve-amber)]">
            前置先修
          </span>
        ) : inRelation === "downstream" ? (
          <span className="rounded-full bg-[var(--ve-emerald-soft)] px-1.5 py-0.2 text-[9px] font-semibold text-[var(--ve-emerald)]">
            后续解锁
          </span>
        ) : inRelation === "related" ? (
          <span className="rounded-full bg-[var(--ve-accent-soft)] px-1.5 py-0.2 text-[9px] font-semibold text-[var(--ve-accent)]">
            概念关联
          </span>
        ) : null}
      </div>

      <div className="mt-1.5 line-clamp-2 min-h-[34px] text-[13px] leading-[1.35] font-semibold text-[var(--ve-ink)]">
        {lesson.title}
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--ve-surface-alt)]">
        <div
          className={
            "h-full rounded-full transition-all duration-500 " +
            (mastery >= 80 ? "bg-emerald-500" : "bg-[var(--ve-accent-solid)]")
          }
          style={{ width: `${mastery}%` }}
        />
      </div>

      <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-[var(--ve-muted)]">
        <span>掌握 {mastery}%</span>
        <span>{lesson.minutes} 分钟</span>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[#2e5bff]"
      />
    </div>
  );
}

const nodeTypes = {
  knowledgeUnit: KnowledgeUnitNode,
};

function FlowCanvasInner({
  units,
  selectedId,
  currentFocusId,
  onSelect,
}: {
  units: Lesson[];
  selectedId: string;
  currentFocusId: string;
  onSelect: (id: string) => void;
}) {
  const { s, now } = useLearningStore();
  const { setCenter, fitView } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(820);
  const [minimapManual, setMinimapManual] = useState<boolean | null>(null);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w) setCanvasWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const showMiniMap =
    minimapManual !== null ? minimapManual : canvasWidth >= 760;

  const layout = useMemo(() => layoutKnowledgeGraph(units, s), [units, s]);

  const selectedUnit = useMemo(
    () => units.find((u) => u.id === selectedId) || units[0],
    [units, selectedId],
  );
  const directPrereqs = useMemo(
    () => new Set(selectedUnit?.requires || []),
    [selectedUnit],
  );
  const directDownstream = useMemo(
    () =>
      new Set(
        units
          .filter((u) => selectedUnit && u.requires.includes(selectedUnit.id))
          .map((u) => u.id),
      ),
    [units, selectedUnit],
  );
  const crossRelatedIds = useMemo(() => {
    const set = new Set<string>();
    if (!selectedUnit) return set;
    for (const ce of layout.crossEdges) {
      if (ce.fromId === selectedUnit.id) set.add(ce.toId);
      if (ce.toId === selectedUnit.id) set.add(ce.fromId);
    }
    return set;
  }, [layout.crossEdges, selectedUnit]);

  const flowNodes = useMemo<Array<Node<FlowUnitData>>>(() => {
    return layout.nodes.map((n) => {
      const meta = s.masteryMeta?.[n.lesson.id];
      const due =
        Boolean(meta) &&
        n.mastery > 0 &&
        diffDays(meta!.nextReviewDay, now) >= 0;

      const inRelation = directPrereqs.has(n.lesson.id)
        ? "prereq"
        : directDownstream.has(n.lesson.id)
          ? "downstream"
          : crossRelatedIds.has(n.lesson.id)
            ? "related"
            : null;

      return {
        id: n.lesson.id,
        type: "knowledgeUnit",
        position: { x: n.px, y: n.py },
        data: {
          lesson: n.lesson,
          mastery: n.mastery,
          status: n.status,
          dueReview: due,
          selected: n.lesson.id === selectedId,
          isCurrentFocus: n.lesson.id === currentFocusId,
          inRelation,
        },
      };
    });
  }, [
    layout,
    s.masteryMeta,
    now,
    selectedId,
    currentFocusId,
    directPrereqs,
    directDownstream,
    crossRelatedIds,
  ]);

  const flowEdges = useMemo<Edge[]>(() => {
    const edges: Edge[] = [];
    for (const u of units) {
      for (const reqId of u.requires) {
        if (!units.some((x) => x.id === reqId)) continue;
        const satisfied = (s.mastery[reqId] ?? 0) >= 80;
        const isHighlighted =
          u.id === selectedId || reqId === selectedId;
        const strokeColor = isHighlighted
          ? "#2E5BFF"
          : satisfied
            ? "#10B981"
            : "#94A3B8";

        edges.push({
          id: `${reqId}->${u.id}`,
          source: reqId,
          target: u.id,
          type: "smoothstep",
          animated: isHighlighted,
          style: {
            stroke: strokeColor,
            strokeWidth: isHighlighted ? 2.6 : satisfied ? 2.0 : 1.5,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: strokeColor,
            width: 15,
            height: 15,
          },
        });
      }
    }

    // Add cross-chapter conceptual relationship edges (dashed indigo curves with semantic labels)
    for (const ce of layout.crossEdges) {
      const isHighlighted =
        ce.fromId === selectedId || ce.toId === selectedId;
      edges.push({
        id: ce.id,
        source: ce.fromId,
        target: ce.toId,
        type: "default",
        label: ce.label,
        labelStyle: {
          fill: isHighlighted ? "#4338ca" : "#64748b",
          fontSize: 10,
          fontWeight: 600,
        },
        labelBgStyle: {
          fill: "#ffffff",
          fillOpacity: 0.92,
        },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 6,
        style: {
          stroke: isHighlighted ? "#6366f1" : "#a5b4fc",
          strokeWidth: isHighlighted ? 2 : 1.4,
          strokeDasharray: "6 4",
        },
      });
    }

    return edges;
  }, [units, layout.crossEdges, s.mastery, selectedId]);

  const focusNodeSmoothly = useCallback(
    (targetId: string) => {
      const target = flowNodes.find((n) => n.id === targetId);
      if (!target) return;
      void setCenter(target.position.x + 116, target.position.y + 52, {
        zoom: 0.96,
        duration: 420,
      });
    },
    [flowNodes, setCenter],
  );

  // Initial readable overview: always fit the entire 2D graph evenly across the canvas
  // so there is never wasted whitespace on the left or right side.
  useEffect(() => {
    const t = setTimeout(() => {
      void fitView({
        padding: 0.12,
        minZoom: 0.58,
        maxZoom: 1.05,
        duration: 320,
      });
    }, 60);
    return () => clearTimeout(t);
  }, [units.length, layout.layerCount, fitView]);

  const isDark = useIsDarkTheme();
  return (
    <div
      ref={canvasRef}
      className="relative h-[540px] w-full overflow-hidden rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-canvas)]"
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        className={isDark ? "dark" : undefined}
        onNodeClick={(_, node) => {
          onSelect(node.id);
        }}
        fitView
        fitViewOptions={{ padding: 0.12, minZoom: 0.58, maxZoom: 1.05 }}
        minZoom={0.55}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          color={isDark ? "#2d374a" : "#dce3f0"}
          gap={22}
          size={1.2}
        />
        <Controls
          showInteractive={false}
          className="!rounded-xl !border !border-[var(--ve-border)] !bg-[var(--ve-surface)] !shadow-xs"
        />
        {showMiniMap && (
          <MiniMap
            pannable
            zoomable
            maskColor={
              isDark ? "rgba(17, 21, 29, 0.72)" : "rgba(240, 244, 250, 0.65)"
            }
            nodeColor={(n) => {
              const d = n.data as FlowUnitData | undefined;
              if (!d) return isDark ? "#475569" : "#cbd5e1";
              if (d.selected) return isDark ? "#6091ff" : "#2444c9";
              if (d.status === "mastered") return isDark ? "#34d399" : "#10b981";
              if (d.status === "available") return "#60a5fa";
              return isDark ? "#3b475c" : "#cbd5e1";
            }}
            className="!rounded-xl !border !border-[var(--ve-border)] !bg-[var(--ve-surface)]/95 !shadow-xs"
          />
        )}
      </ReactFlow>

      <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)]/95 px-2.5 py-1.5 text-[11px] text-[var(--ve-muted)] shadow-2xs backdrop-blur-xs">
          <span className="inline-flex items-center gap-1 font-medium text-[var(--ve-ink)]">
            <Compass size={12} className="text-[var(--ve-accent)]" /> 先修与概念图谱
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="h-0.5 w-3 bg-[var(--ve-accent-solid)]" /> 先修
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="h-0.5 w-3 border-t-2 border-dashed border-[var(--ve-accent)]/60" /> 跨章
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="h-2 w-2 rounded-full bg-emerald-500" /> 已掌握
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="h-2 w-2 rounded-full bg-[var(--ve-accent-solid)]" /> 可学习
          </span>
        </div>

        <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
          {selectedId && (
            <button
              type="button"
              onClick={() => focusNodeSmoothly(selectedId)}
              className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)]/95 px-2.5 py-1 text-[11px] font-medium text-[var(--ve-accent)] shadow-2xs hover:bg-[var(--ve-accent-soft)]"
            >
              定位当前节点
            </button>
          )}
          <button
            type="button"
            onClick={() => setMinimapManual(!showMiniMap)}
            className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)]/95 px-2.5 py-1 text-[11px] font-medium text-[var(--ve-muted)] shadow-2xs hover:bg-[var(--ve-accent-soft)]"
          >
            {showMiniMap ? "收起缩略图" : "显示缩略图"}
          </button>
          <button
            type="button"
            onClick={() =>
              void fitView({
                padding: 0.14,
                minZoom: 0.62,
                maxZoom: 1.05,
                duration: 420,
              })
            }
            className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)]/95 px-2.5 py-1 text-[11px] font-medium text-[var(--ve-muted)] shadow-2xs hover:bg-[var(--ve-accent-soft)]"
          >
            全景视图
          </button>
        </div>
      </div>
    </div>
  );
}

export default function KnowledgeFlowMap({
  onStartStudyLesson,
}: {
  onStartStudyLesson?: (lesson: Lesson) => void;
}) {
  const {
    s,
    now,
    setActiveTrackId,
    setWorkspaceTab,
    attachContext,
    setCopilotOpen,
    askCopilot,
    markLessonSkipped,
    declareSelfReportedMastery,
    archiveTrack,
    restoreTrack,
    permanentDeleteTrack,
    adjustTrackScope,
    focusedLessonId,
    setFocusedLessonId,
  } = useLearningStore();

  const tracks = useMemo(() => getTracks(s), [s]);
  const archivedTracks = useMemo(() => getArchivedTracks(s), [s]);
  const activeTrack = useMemo(() => getActiveTrack(s), [s]);
  const [viewMode, setViewMode] = useState<"path" | "graph">("path");
  const [showMasteryChoices, setShowMasteryChoices] = useState(false);
  const [showArchivedList, setShowArchivedList] = useState(false);
  const [showScopeModal, setShowScopeModal] = useState(false);
  const [scopeDepth, setScopeDepth] = useState<TrackDepth>("standard");
  const [scopeNoteDraft, setScopeNoteDraft] = useState("");
  const [scopeDaysDraft, setScopeDaysDraft] = useState(7);
  const [scopeDailyDraft, setScopeDailyDraft] = useState(45);
  const [trimIds, setTrimIds] = useState<string[]>([]);
  const [newLessonChapterTitle, setNewLessonChapterTitle] = useState("");
  const [newLessonSectionTitle, setNewLessonSectionTitle] = useState("");
  const [newLessonTitle, setNewLessonTitle] = useState("");
  const [newLessonObjective, setNewLessonObjective] = useState("");
  const [newLessonCriteria, setNewLessonCriteria] = useState("");
  const [collapsedPathStages, setCollapsedPathStages] = useState<
    Record<string, boolean>
  >({});
  const [trackActionBusy, setTrackActionBusy] = useState(false);
  const [pendingArchiveTrack, setPendingArchiveTrack] = useState<{
    id: string;
    title: string;
    lessonCount: number;
  } | null>(null);
  const [pendingDeleteImpact, setPendingDeleteImpact] =
    useState<TrackImpactPreview | null>(null);

  const openPermanentDeleteDialog = useCallback(
    async (trackId: string, title: string, lessonCount: number) => {
      try {
        const res = await fetch(
          `/api/tracks?trackId=${encodeURIComponent(trackId)}`,
          { cache: "no-store" },
        );
        if (res.ok) {
          const data = (await res.json()) as { impact?: TrackImpactPreview };
          if (data.impact) {
            setPendingDeleteImpact(data.impact);
            return;
          }
        }
      } catch {}
      setPendingDeleteImpact({
        trackId,
        title,
        lessonCount,
        exclusiveLessonCount: lessonCount,
        sharedLessonIds: [],
        futureBlockCount: 0,
        completedBlockCount: 0,
        exerciseCount: 0,
        attemptCount: 0,
        sessionCount: 0,
        pendingDraftCount: 0,
        otherTrackCount: Math.max(0, (s.goalPlans?.length ?? 1) - 1),
      });
    },
    [s.goalPlans],
  );

  const [selectedId, setSelectedId] = useState<string>(() => {
    if (focusedLessonId) return focusedLessonId;
    return activeTrack ? focusLesson(s, activeTrack.id)?.id || "" : "";
  });

  useEffect(() => {
    if (focusedLessonId) {
      setSelectedId(focusedLessonId);
    }
  }, [focusedLessonId]);

  useEffect(() => {
    if (!activeTrack) {
      setSelectedId("");
      return;
    }
    if (!activeTrack.units.some((u) => u.id === selectedId)) {
      setSelectedId(
        focusLesson(s, activeTrack.id)?.id || activeTrack.units[0]?.id || "",
      );
    }
  }, [activeTrack, selectedId, s]);

  if (!activeTrack) {
    return (
      <div className="space-y-4">
        <section className="mx-auto max-w-xl rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-surface)] px-8 py-14 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]">
            <GitFork size={20} />
          </div>
          <h2 className="text-base font-bold text-[var(--ve-ink)]">
            Knowledge Explorer
          </h2>
          <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-[var(--ve-muted)]">
            建立学习目标后，这里会自动展示你的结构化学习路径（Learning
            Path）和先修依赖关系图谱（Knowledge Graph），并支持点击任意节点直接进入课程学习。
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => setWorkspaceTab("today")}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ve-accent-solid)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
            >
              去今日工作台建立第一个目标 <ArrowRight size={13} />
            </button>
          </div>
        </section>

        {archivedTracks.length > 0 && (
          <section className="mx-auto max-w-xl rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-4">
            <div className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-[var(--ve-ink)]">
              <Archive size={13} className="text-[var(--ve-muted)]" />
              <span>已归档轨道（{archivedTracks.length}）</span>
            </div>
            <div className="space-y-2">
              {archivedTracks.map((tr) => (
                <div
                  key={tr.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-3 py-2"
                >
                  <div>
                    <div className="text-xs font-medium text-[var(--ve-ink)]">
                      {tr.title}
                    </div>
                    <div className="text-[11px] text-[var(--ve-muted)]">
                      {tr.units.length} 节课 · 已暂停排程与主动复习提醒，历史记录完整保留
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={trackActionBusy}
                      onClick={async () => {
                        setTrackActionBusy(true);
                        await restoreTrack(tr.id);
                        setTrackActionBusy(false);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1 text-xs font-medium text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
                    >
                      <ArchiveRestore size={11} /> 恢复轨道
                    </button>
                    <button
                      type="button"
                      disabled={trackActionBusy}
                      onClick={() =>
                        void openPermanentDeleteDialog(
                          tr.id,
                          tr.title,
                          tr.units.length,
                        )
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--ve-rose)]/35 bg-[var(--ve-surface)] px-2.5 py-1 text-xs font-medium text-[var(--ve-rose)] hover:bg-[var(--ve-rose-soft)]"
                    >
                      <Trash2 size={11} /> 永久删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <ConfirmDangerDialog
          open={Boolean(pendingDeleteImpact)}
          title={
            pendingDeleteImpact
              ? `永久删除轨道「${pendingDeleteImpact.title}」？`
              : "永久删除轨道？"
          }
          description="永久删除不可撤销。如果只是暂时不学，建议先归档以保留全部学习历史。"
          impacts={
            pendingDeleteImpact
              ? [
                  `独占课程：${pendingDeleteImpact.exclusiveLessonCount} 节（总 ${pendingDeleteImpact.lessonCount} 节）`,
                  `关联日程块：未完成 ${pendingDeleteImpact.futureBlockCount} 条 / 已完成 ${pendingDeleteImpact.completedBlockCount} 条`,
                  `持久化练习与作答：${pendingDeleteImpact.exerciseCount} 道题 / ${pendingDeleteImpact.attemptCount} 条作答 / ${pendingDeleteImpact.sessionCount} 个会话`,
                ]
              : []
          }
          preservedNote={
            pendingDeleteImpact
              ? `其他 ${pendingDeleteImpact.otherTrackCount} 条轨道、共享课程（${pendingDeleteImpact.sharedLessonIds.length} 节）与无关长期记忆均不会被删除。`
              : undefined
          }
          confirmLabel="确认永久删除"
          busy={trackActionBusy}
          onCancel={() => setPendingDeleteImpact(null)}
          onConfirm={async () => {
            if (!pendingDeleteImpact) return;
            setTrackActionBusy(true);
            await permanentDeleteTrack(pendingDeleteImpact.trackId);
            setTrackActionBusy(false);
            setPendingDeleteImpact(null);
          }}
        />
      </div>
    );
  }

  const graphUnits = useMemo(
    () => normalizeKnowledgeGraphTopology(activeTrack.units),
    [activeTrack.units],
  );
  const stageGroups = useMemo(
    () => groupLessonsIntoStages(graphUnits),
    [graphUnits],
  );
  const crossConceptLinks = useMemo(
    () => computeCrossChapterConceptLinks(graphUnits),
    [graphUnits],
  );

  const masteredCountTotal = graphUnits.filter(
    (u) => (s.mastery[u.id] ?? 0) >= 80,
  ).length;
  const progressPct = graphUnits.length
    ? Math.round((masteredCountTotal / graphUnits.length) * 100)
    : 0;
  const remainingMinutes = graphUnits
    .filter((u) => (s.mastery[u.id] ?? 0) < 80)
    .reduce((acc, u) => acc + u.minutes, 0);

  const currentFocusLesson =
    graphUnits.find(
      (u) => (s.mastery[u.id] ?? 0) < 80 && available(s, u),
    ) || graphUnits[0];

  const l =
    graphUnits.find((x) => x.id === selectedId) ||
    currentFocusLesson ||
    graphUnits[0];
  const meta = l ? s.masteryMeta?.[l.id] : undefined;
  const mastery = l ? (s.mastery[l.id] ?? 0) : 0;
  const learnerStatus = l ? computeLearnerStatus(s, l.id, now) : "NOT_STARTED";
  const missingPrereqs = l ? getMissingPrerequisites(s, l) : [];
  const retrievability = l ? getLessonRetrievability(s, l.id, now) : 0;
  const elapsedDays = meta
    ? Math.max(
        0,
        diffDays(meta.lastReviewDay || meta.updatedAt || offset(now, -1), now),
      )
    : 0;
  const isDueReview =
    meta &&
    mastery > 0 &&
    (diffDays(meta.nextReviewDay, now) >= 0 || retrievability <= 88);

  const downstreamUnits = l
    ? graphUnits.filter((u) => u.requires.includes(l.id))
    : [];
  const relatedLinksForSelected = useMemo(() => {
    if (!l) return [];
    return crossConceptLinks
      .filter((ce) => ce.fromId === l.id || ce.toId === l.id)
      .map((ce) => {
        const peerId = ce.fromId === l.id ? ce.toId : ce.fromId;
        const peer = graphUnits.find((u) => u.id === peerId);
        return peer ? { peer, label: ce.label } : null;
      })
      .filter(
        (x): x is { peer: Lesson; label: string } => Boolean(x),
      );
  }, [l, crossConceptLinks, graphUnits]);
  const scheduledBlocks = l
    ? s.blocks
        .filter((b) => b.lesson === l.id && !b.done && b.day >= now)
        .sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start)
    : [];
  const mainLessonBlocks = scheduledBlocks.filter((b) => !isRemedialBlock(b));
  const remedialBlocks = scheduledBlocks.filter((b) => isRemedialBlock(b));

  function handleSelectNode(id: string) {
    setSelectedId(id);
    setFocusedLessonId(id);
    setShowMasteryChoices(false);
  }

  function handleStartQuickDiagnostic(target: Lesson) {
    setShowMasteryChoices(false);
    handleLaunchLesson(target);
    askCopilot(
      `我已经学过「${target.title}」，请给我出一道有区分度的快速诊断题（使用 present_interactive_check），通过我真实作答后的证据调用 record_learning_assessment 更新已验证的 BKT 掌握度。`,
    );
  }

  function handleLaunchLesson(target: Lesson) {
    attachContext({
      type: "lesson",
      lessonId: target.id,
      title: target.title,
      mastery: s.mastery[target.id] ?? 0,
    });
    if (onStartStudyLesson) {
      onStartStudyLesson(target);
    } else {
      setFocusedLessonId(target.id);
      setWorkspaceTab("study");
    }
  }

  return (
    <div className="space-y-4">
      {/* Knowledge Explorer Header + View Switcher + Track Switcher */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--ve-border)] pb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--ink)]">
              Knowledge
            </h1>
          </div>
          <div className="hidden h-5 w-px bg-[var(--ve-border)] sm:block" />
          <div className="flex flex-wrap items-center gap-1.5">
            {tracks.map((tr) => {
              const masteredCount = tr.units.filter(
                (u) => (s.mastery[u.id] ?? 0) >= 80,
              ).length;
              const isCurrent = tr.id === activeTrack.id;
              return (
                <button
                  key={tr.id}
                  type="button"
                  onClick={() => setActiveTrackId(tr.id)}
                  className={
                    "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition " +
                    (isCurrent
                      ? "border-[var(--ve-accent-solid)] bg-[var(--ve-accent-solid)] text-white"
                      : "border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]")
                  }
                >
                  <span>{tr.title}</span>
                  <span
                    className={
                      "font-mono text-[10px] " +
                      (isCurrent ? "text-white/75" : "text-[var(--ve-muted)]")
                    }
                  >
                    {masteredCount}/{tr.units.length}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex shrink-0 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface-alt)] p-0.5">
            {(
              [
                { id: "path", label: "学习路径", icon: Route },
                { id: "graph", label: "关系图谱", icon: GitFork },
              ] as const
            ).map((opt) => {
              const isSelectedMode = viewMode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setViewMode(opt.id)}
                  className={
                    "relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-xs transition " +
                    (isSelectedMode
                      ? "font-semibold text-[var(--ve-ink)]"
                      : "text-[var(--ve-muted)] hover:text-[var(--ve-ink)]")
                  }
                >
                  {isSelectedMode && (
                    <motion.span
                      layoutId="graph-view-pill"
                      transition={SPRING_CRISP}
                      className="absolute inset-0 rounded-md bg-[var(--ve-surface)] shadow-2xs"
                    />
                  )}
                  <span className="relative z-10 inline-flex items-center gap-1.5">
                    <opt.icon
                      size={12}
                      aria-hidden="true"
                      className={isSelectedMode ? "text-[var(--ve-accent)]" : ""}
                    />
                    {opt.label}
                  </span>
                </button>
              );
            })}
          </div>

          {archivedTracks.length > 0 && (
            <button
              type="button"
              onClick={() => setShowArchivedList((v) => !v)}
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1 text-xs font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]"
            >
              <Archive size={11} /> 已归档 ({archivedTracks.length})
            </button>
          )}

          {!activeTrack.builtIn && (
            <>
              <button
                type="button"
                onClick={() => {
                  setScopeDepth(activeTrack.depth || "standard");
                  setScopeNoteDraft(activeTrack.scopeNote || "");
                  setScopeDaysDraft(activeTrack.days || Math.max(3, activeTrack.units.length * 2));
                  setScopeDailyDraft(activeTrack.daily || 45);
                  setTrimIds([]);
                  setNewLessonChapterTitle("");
                  setNewLessonSectionTitle("");
                  setNewLessonTitle("");
                  setNewLessonObjective("");
                  setNewLessonCriteria("");
                  setShowScopeModal(true);
                }}
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--surface-3)]"
              >
                <SlidersHorizontal size={11} />
                <span>
                  范围与深度
                  {activeTrack.depth
                    ? ` · ${TRACK_DEPTH_LABELS[activeTrack.depth]}`
                    : ""}
                </span>
              </button>
              <button
                type="button"
                onClick={() =>
                  setPendingArchiveTrack({
                    id: activeTrack.id,
                    title: activeTrack.title,
                    lessonCount: activeTrack.units.length,
                  })
                }
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--muted)] hover:text-[var(--ve-amber)]"
              >
                <Archive size={11} /> 归档轨道
              </button>
              <button
                type="button"
                onClick={() =>
                  void openPermanentDeleteDialog(
                    activeTrack.id,
                    activeTrack.title,
                    activeTrack.units.length,
                  )
                }
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--ve-rose)] hover:bg-[var(--ve-rose-soft)]"
              >
                <Trash2 size={11} /> 永久删除
              </button>
            </>
          )}
        </div>
      </header>

      {showArchivedList && archivedTracks.length > 0 && (
        <section className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-[var(--ve-ink)]">
              已归档轨道（历史保留，已暂停主动排程与到期提醒）
            </span>
            <button
              type="button"
              onClick={() => setShowArchivedList(false)}
              className="text-[11px] text-[var(--ve-muted)] hover:text-[var(--ve-ink)]"
            >
              收起
            </button>
          </div>
          <div className="space-y-2">
            {archivedTracks.map((tr) => (
              <div
                key={tr.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3 py-2"
              >
                <div>
                  <div className="text-xs font-medium text-[var(--ve-ink)]">
                    {tr.title}
                  </div>
                  <div className="text-[11px] text-[var(--ve-muted)]">
                    {tr.units.length} 节课
                    {tr.archivedAt ? ` · 归档于 ${tr.archivedAt.slice(0, 10)}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={trackActionBusy}
                    onClick={async () => {
                      setTrackActionBusy(true);
                      await restoreTrack(tr.id);
                      setTrackActionBusy(false);
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1 text-xs font-medium text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
                  >
                    <ArchiveRestore size={11} /> 恢复轨道
                  </button>
                  <button
                    type="button"
                    disabled={trackActionBusy}
                    onClick={() =>
                      void openPermanentDeleteDialog(
                        tr.id,
                        tr.title,
                        tr.units.length,
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--ve-rose)]/35 bg-[var(--ve-surface)] px-2.5 py-1 text-xs font-medium text-[var(--ve-rose)] hover:bg-[var(--ve-rose-soft)]"
                  >
                    <Trash2 size={11} /> 永久删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Main Grid: Learning Path (Stage Roadmap) OR 2D Concept Relationship Graph + Learner-Centered Node Guide */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="xl:col-span-7">
          {viewMode === "path" ? (
            <div className="space-y-4">
              {/* Macro Progress & "Where I Am Now" Banner */}
              <div className="rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-[var(--ve-ink)]">
                        目标总进度 · {activeTrack.title}
                      </span>
                      <span className="rounded-md bg-[var(--ve-surface-alt)] px-2 py-0.5 font-mono text-[11px] font-medium text-[var(--ve-muted)]">
                        {stageGroups.length} 个大章节 ·{" "}
                        {stageGroups.reduce(
                          (acc, st) => acc + st.sections.length,
                          0,
                        )}{" "}
                        个小章节 · {graphUnits.length} 节课
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--ve-muted)]">
                      已完成 {masteredCountTotal}/{graphUnits.length} 节（{progressPct}%）
                      {remainingMinutes > 0
                        ? ` · 距离完成目标预计还需约 ${remainingMinutes} 分钟`
                        : " · 已全部达成目标！"}
                    </p>
                  </div>
                  {currentFocusLesson && (
                    <button
                      type="button"
                      onClick={() => handleLaunchLesson(currentFocusLesson)}
                      className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ve-accent-solid)] px-3.5 py-2 text-xs font-semibold text-white transition hover:opacity-90"
                    >
                      <span>继续学习：{currentFocusLesson.title.slice(0, 16)}</span>
                      <ArrowRight size={13} />
                    </button>
                  )}
                </div>

                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--ve-surface-alt)]">
                  <div
                    className="h-full rounded-full bg-[var(--ve-accent-solid)] transition-all duration-500"
                    style={{ width: `${Math.max(4, progressPct)}%` }}
                  />
                </div>
              </div>

              {/* 2-Level Chapter -> Sub-chapter -> Lesson Roadmap */}
              {stageGroups.map((stage) => {
                const stageMastered = stage.units.filter(
                  (u) => (s.mastery[u.id] ?? 0) >= 80,
                ).length;
                const stageUnlockedCount = stage.units.filter(
                  (u) => (s.mastery[u.id] ?? 0) < 80 && available(s, u),
                ).length;
                const isStageComplete = stageMastered === stage.units.length;
                const hasCurrentFocus = stage.units.some(
                  (u) => u.id === currentFocusLesson?.id,
                );
                const isCollapsed = Boolean(
                  collapsedPathStages[stage.stageTitle],
                );

                return (
                  <div
                    key={stage.stageTitle}
                    className={
                      "rounded-2xl border bg-[var(--ve-surface)] p-4 sm:p-5 transition " +
                      (hasCurrentFocus
                        ? "border-[var(--ve-accent)]/45 shadow-2xs"
                        : "border-[var(--ve-border)]")
                    }
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--ve-border)] pb-3">
                      <button
                        type="button"
                        onClick={() =>
                          setCollapsedPathStages((prev) => ({
                            ...prev,
                            [stage.stageTitle]: !prev[stage.stageTitle],
                          }))
                        }
                        className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left"
                      >
                        {isCollapsed ? (
                          <ChevronRight
                            size={15}
                            className="shrink-0 text-[var(--ve-muted)]"
                          />
                        ) : (
                          <ChevronDown
                            size={15}
                            className="shrink-0 text-[var(--ve-muted)]"
                          />
                        )}
                        <span
                          className={
                            "rounded-md px-2 py-0.5 font-mono text-[10.5px] font-semibold " +
                            (isStageComplete
                              ? "bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]"
                              : hasCurrentFocus
                                ? "bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]"
                                : "bg-[var(--ve-surface-alt)] text-[var(--ve-muted)]")
                          }
                        >
                          大章节 {String(stage.stageIndex).padStart(2, "0")}
                        </span>
                        <h3 className="text-sm font-semibold text-[var(--ve-ink)]">
                          {stage.stageTitle}
                        </h3>
                        {stageUnlockedCount >= 2 && (
                          <span className="rounded-full bg-[var(--ve-accent-soft)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--ve-accent)]">
                            支持并行学习
                          </span>
                        )}
                      </button>
                      <span className="font-mono text-xs text-[var(--ve-muted)]">
                        {stage.sections.length} 小节 · {stageMastered}/
                        {stage.units.length} 已掌握
                      </span>
                    </div>

                    {stage.stageSubtitle && !isCollapsed && (
                      <p className="mt-2.5 text-xs text-[var(--ve-muted)]">
                        {stage.stageSubtitle}
                      </p>
                    )}

                    {/* Nested Sub-chapters (小章节) -> Lessons (课时) */}
                    {!isCollapsed && (
                      <div className="mt-3.5 space-y-3.5">
                        {stage.sections.map((sec) => {
                          const secMastered = sec.units.filter(
                            (u) => (s.mastery[u.id] ?? 0) >= 80,
                          ).length;

                          return (
                            <div
                              key={sec.globalSectionCode}
                              className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)]/80 p-3"
                            >
                              <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                  <span className="inline-flex items-center gap-1 rounded-md bg-[var(--ve-accent-soft)] px-2 py-0.5 font-mono text-[10.5px] font-semibold text-[var(--ve-accent)]">
                                    <Layers size={11} /> 小节{" "}
                                    {sec.globalSectionCode}
                                  </span>
                                  <span className="text-xs font-semibold text-[var(--ve-ink)]">
                                    {sec.sectionTitle}
                                  </span>
                                </div>
                                <span className="font-mono text-[10.5px] text-[var(--ve-muted)]">
                                  {secMastered}/{sec.units.length} 课时
                                </span>
                              </div>

                              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                                {sec.units.map((u) => {
                                  const m = s.mastery[u.id] ?? 0;
                                  const origin =
                                    s.masteryMeta?.[u.id]?.masteryOrigin;
                                  const mastered = m >= 80;
                                  const selfReported =
                                    !mastered && origin === "self_reported";
                                  const skipped =
                                    !mastered && origin === "skipped";
                                  const unlocked = available(s, u);
                                  const isSelected = l?.id === u.id;
                                  const isFocus =
                                    currentFocusLesson?.id === u.id;
                                  const missingForU = getMissingPrerequisites(
                                    s,
                                    u,
                                  );

                                  const statusText = mastered
                                    ? "已掌握"
                                    : isFocus
                                      ? "当前主攻 · 你在这里"
                                      : selfReported
                                        ? "自报熟悉 · 待验证"
                                        : skipped
                                          ? "暂时跳过"
                                          : unlocked
                                            ? stageUnlockedCount >= 2
                                              ? "可并行学习"
                                              : m > 0
                                                ? `学习中 · ${m}%`
                                                : "可学习"
                                            : "待解锁";

                                  return (
                                    <button
                                      key={u.id}
                                      type="button"
                                      onClick={() => handleSelectNode(u.id)}
                                      className={
                                        "flex min-w-0 flex-col justify-between gap-2.5 overflow-hidden rounded-xl border p-3.5 text-left transition " +
                                        (isSelected
                                          ? "border-[var(--ve-accent)] bg-[var(--ve-accent-soft)] ring-2 ring-[var(--ve-accent)]/20"
                                          : isFocus
                                            ? "border-[var(--ve-accent)]/55 bg-[var(--ve-surface)] hover:border-[var(--ve-accent)]"
                                            : unlocked
                                              ? "border-[var(--ve-border)] bg-[var(--ve-surface)] hover:border-[var(--ve-line)] hover:bg-[var(--ve-surface-alt)]"
                                              : "border-[var(--ve-border)] bg-[var(--ve-surface)]/80 opacity-80 hover:border-[var(--ve-line)]")
                                      }
                                    >
                                      <div className="flex min-w-0 flex-wrap items-start justify-between gap-1.5">
                                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                                          {mastered ? (
                                            <CheckCircle2
                                              size={15}
                                              className="shrink-0 text-[var(--ve-emerald)]"
                                            />
                                          ) : unlocked ? (
                                            <CircleDot
                                              size={15}
                                              className="shrink-0 text-[var(--ve-accent)]"
                                            />
                                          ) : (
                                            <LockKeyhole
                                              size={14}
                                              className="shrink-0 text-[var(--ve-muted)]"
                                            />
                                          )}
                                          <span className="line-clamp-2 text-[13px] leading-snug font-semibold text-[var(--ve-ink)]">
                                            {u.title}
                                          </span>
                                        </div>
                                        <span
                                          className={
                                            "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold " +
                                            (mastered
                                              ? "bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]"
                                              : isFocus
                                                ? "bg-[var(--ve-accent-solid)] text-white"
                                                : selfReported
                                                  ? "bg-[var(--ve-amber-soft)] text-[var(--ve-amber)]"
                                                  : unlocked
                                                    ? "bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]"
                                                    : "bg-[var(--ve-surface-alt)] text-[var(--ve-muted)]")
                                          }
                                        >
                                          {statusText}
                                        </span>
                                      </div>

                                      <p className="line-clamp-2 text-xs leading-relaxed text-[var(--ve-muted)]">
                                        {u.objective || u.concept}
                                      </p>

                                      <div className="flex items-center justify-between border-t border-[var(--ve-border)] pt-2 font-mono text-[10.5px] text-[var(--ve-muted)]">
                                        <span>预计 {u.minutes} 分钟</span>
                                        {!unlocked && missingForU.length > 0 ? (
                                          <span className="max-w-[150px] truncate font-sans text-[var(--ve-muted)]">
                                            先学：{missingForU[0].title.slice(0, 10)}…
                                          </span>
                                        ) : (
                                          <span>掌握度 {m}%</span>
                                        )}
                                      </div>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <ReactFlowProvider>
              <FlowCanvasInner
                units={graphUnits}
                selectedId={l?.id || ""}
                currentFocusId={currentFocusLesson?.id || ""}
                onSelect={handleSelectNode}
              />
            </ReactFlowProvider>
          )}
        </div>

        {l && (
          <aside className="panel detail space-y-4 xl:col-span-5">
            <div className="flex items-center justify-between gap-2">
              <div className="section-kicker">
                <Target size={15} /> 聚焦知识点
              </div>
              <span className="rounded-full bg-[var(--ve-accent-soft)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--ve-accent)]">
                {learnerStatusLabel(learnerStatus)}
              </span>
            </div>

            <div>
              <h2 className="text-base font-semibold text-[var(--ve-ink)]">
                {l.title}
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-[var(--ve-muted)]">
                {l.concept}
              </p>
            </div>

            {/* Mastery & Schedule Status Box */}
            <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-accent-soft)] p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-[var(--ve-ink)]">
                <span className="inline-flex items-center gap-1.5">
                  <span>已验证掌握度（BKT）</span>
                  {mastery >= 80 ? (
                    <span className="rounded-full bg-[var(--ve-emerald-soft)] px-2 py-0.2 text-[10px] font-semibold text-[var(--ve-emerald)]">
                      已验证
                    </span>
                  ) : meta?.masteryOrigin === "self_reported" ? (
                    <span className="rounded-full bg-[var(--ve-amber-soft)] px-2 py-0.2 text-[10px] font-semibold text-[var(--ve-amber)] ring-1 ring-[var(--ve-amber)]/30">
                      自我报告 · 未验证
                    </span>
                  ) : meta?.masteryOrigin === "skipped" ? (
                    <span className="rounded-full bg-[var(--ve-surface-alt)] px-2 py-0.2 text-[10px] font-semibold text-[var(--ve-muted)]">
                      暂时跳过
                    </span>
                  ) : null}
                </span>
                <span className="font-mono">{mastery}%</span>
              </div>
              <div className="progress mt-2">
                <i
                  className="transition-all duration-500"
                  style={{ width: `${mastery}%` }}
                />
              </div>
              {mastery < 80 && meta?.masteryOrigin === "self_reported" && (
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] px-2.5 py-2 text-[11px] text-[var(--ve-amber)]">
                  <span>
                    已标注为「自我报告掌握（未验证）」，未修改 BKT 分数。完成快速诊断即可转为已验证并解锁后续节点。
                  </span>
                  <button
                    type="button"
                    onClick={() => handleStartQuickDiagnostic(l)}
                    className="shrink-0 rounded-full bg-amber-900 px-2.5 py-1 text-[10.5px] font-semibold text-white hover:bg-amber-800"
                  >
                    快速诊断验证 →
                  </button>
                </div>
              )}
              {mastery < 80 && meta?.masteryOrigin === "skipped" && (
                <div className="mt-2.5 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1.5 text-[11px] text-[var(--ve-muted)]">
                  当前处于「暂时跳过」状态，BKT 掌握度保持 {mastery}% 不变，可随时开始学习或做快速诊断。
                </div>
              )}
              <div className="mt-2.5 flex flex-wrap gap-3 text-[11px] text-[var(--ve-muted)]">
                <span className="inline-flex items-center gap-1">
                  <Clock3 size={12} /> 预计 {l.minutes} 分钟
                </span>
                {meta && (
                  <span className="inline-flex items-center gap-1 font-mono">
                    <CalendarClock size={12} /> 下次复习 {meta.nextReviewDay.slice(5)}
                  </span>
                )}
              </div>
              {scheduledBlocks.length > 0 && (
                <div className="mt-2.5 space-y-1.5">
                  {mainLessonBlocks.map((b) => (
                    <div
                      key={b.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-[var(--ve-accent)]/35 bg-[var(--ve-surface)] px-2.5 py-1.5 text-[11px] text-[var(--ve-accent)]"
                    >
                      <span className="inline-flex items-center gap-1.5 font-semibold">
                        <span className="rounded bg-[var(--ve-accent-solid)] px-1.5 py-0.2 text-[10px] text-white">
                          正课
                        </span>
                        <span>{formatDayWithWeekday(b.day)}</span>
                      </span>
                      <span className="font-mono font-medium">
                        {time(b.start)}–{time(b.start + b.minutes)}（
                        {b.minutes} 分钟）
                      </span>
                    </div>
                  ))}
                  {remedialBlocks.map((b) => (
                    <div
                      key={b.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] px-2.5 py-1.5 text-[11px] text-[var(--ve-amber)]"
                    >
                      <span className="inline-flex items-center gap-1.5 font-semibold">
                        <span className="rounded bg-amber-500 px-1.5 py-0.2 text-[10px] text-white">
                          补救 / 复习
                        </span>
                        <span>{formatDayWithWeekday(b.day)}</span>
                      </span>
                      <span className="font-mono font-medium">
                        {time(b.start)}–{time(b.start + b.minutes)}（
                        {b.minutes} 分钟）
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {isDueReview && (
                <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-[var(--ve-amber-soft)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--ve-amber)]">
                  <AlertTriangle size={12} /> 当前记忆保持率 {retrievability}%，建议复习
                </div>
              )}
            </div>

            {/* Prerequisite & Downstream Relationship Graph Pills */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-2.5">
                <div className="text-[11px] font-semibold text-[var(--ve-muted)]">
                  前置先修（点击聚焦）
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {l.requires.length > 0 ? (
                    l.requires.map((reqId) => {
                      const req = getLessonById(s, reqId);
                      const reqMastery = s.mastery[reqId] ?? 0;
                      const met = reqMastery >= 80;
                      return (
                        <button
                          key={reqId}
                          type="button"
                          onClick={() => handleSelectNode(reqId)}
                          className={
                            "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition " +
                            (met
                              ? "border-[var(--ve-emerald)]/35 bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)] hover:bg-[var(--ve-emerald-soft)]"
                              : "border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] text-[var(--ve-amber)] hover:bg-[var(--ve-amber-soft)]")
                          }
                        >
                          {met ? <Check size={10} /> : <LockKeyhole size={10} />}
                          <span className="max-w-[110px] truncate">
                            {req?.title || reqId}
                          </span>
                          <span className="font-mono text-[10px]">
                            {reqMastery}%
                          </span>
                        </button>
                      );
                    })
                  ) : (
                    <span className="text-[11px] text-[var(--ve-muted)]">
                      起点课程（无前置依赖）
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-2.5">
                <div className="text-[11px] font-semibold text-[var(--ve-muted)]">
                  后续解锁（点击聚焦）
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {downstreamUnits.length > 0 ? (
                    downstreamUnits.map((dn) => (
                      <button
                        key={dn.id}
                        type="button"
                        onClick={() => handleSelectNode(dn.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-accent-soft)] px-2 py-1 text-[11px] font-medium text-[var(--ve-ink)] hover:border-[var(--ve-accent)] hover:bg-[var(--ve-accent-soft)]"
                      >
                        <ArrowRight size={10} />
                        <span className="max-w-[115px] truncate">
                          {dn.title}
                        </span>
                      </button>
                    ))
                  ) : (
                    <span className="text-[11px] text-[var(--ve-muted)]">
                      终点综合节点
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Learner-Centered 4-Point Lesson Guide (Replaces Technical Contract Dump) */}
            <div className="rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-3.5 space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[var(--ve-ink)]">
                  课程导览与定位
                </span>
                {l.stageTitle && (
                  <span className="rounded-md bg-[var(--ve-surface-alt)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--ve-muted)]">
                    {l.stageTitle}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 gap-2">
                <div className="rounded-lg bg-[var(--ve-canvas)] p-2.5">
                  <div className="text-[10.5px] font-semibold text-[var(--ve-accent)]">
                    为什么现在学
                  </div>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--ve-ink)]">
                    {l.requires.length > 0
                      ? `承接前置《${l.requires
                          .map((r) => graphUnits.find((u) => u.id === r)?.title || r)
                          .join("》《")}》的基础能力，${
                          downstreamUnits.length > 0
                            ? `学完即可解锁《${downstreamUnits
                                .slice(0, 2)
                                .map((d) => d.title)
                                .join("》《")}》等后续模块。`
                            : "完成当前阶段的综合收官验证。"
                        }`
                      : `本阶段起点课程，无需前置课程即可直接上手，为你打开后续《${
                          downstreamUnits[0]?.title || "核心机制"
                        }》的大门。`}
                  </p>
                </div>

                <div className="rounded-lg bg-[var(--ve-canvas)] p-2.5">
                  <div className="text-[10.5px] font-semibold text-[var(--ve-emerald)]">
                    学完能做什么
                  </div>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--ve-ink)]">
                    {l.completionCriteria || l.objective || l.concept}
                  </p>
                </div>
              </div>

              {relatedLinksForSelected.length > 0 && (
                <div className="border-t border-[var(--ve-border)] pt-2">
                  <div className="text-[10.5px] font-semibold text-[var(--ve-muted)]">
                    跨章概念协同（点击可对比查看）
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {relatedLinksForSelected.map(({ peer, label }) => (
                      <button
                        key={peer.id}
                        type="button"
                        onClick={() => handleSelectNode(peer.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--ve-accent)]/35 bg-[var(--ve-accent-soft)] px-2 py-1 text-[11px] font-medium text-[var(--ve-accent)] hover:bg-[var(--ve-accent-soft)]"
                      >
                        <span>{peer.title}</span>
                        <span className="text-[10px] text-[var(--ve-accent)]">
                          · {label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {!available(s, l) && missingPrereqs.length > 0 && (
              <div className="rounded-xl border border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] px-3 py-2 text-xs text-[var(--ve-amber)]">
                需先完成先修：
                {missingPrereqs.map((m) => `「${m.title}」`).join(" → ")}
                （掌握度达 80% 自动解锁）
              </div>
            )}

            {meta && mastery > 0 && (
              <RetentionCurveChart
                stabilityDays={meta.stabilityDays}
                elapsedAlready={elapsedDays}
              />
            )}

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {!available(s, l) && missingPrereqs.length > 0 ? (
                <button
                  type="button"
                  onClick={() => handleLaunchLesson(missingPrereqs[0])}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-[var(--ve-accent-solid)] px-4 py-2.5 text-xs font-semibold text-white transition hover:opacity-90"
                >
                  <BookOpen size={14} /> 先学习先修「{missingPrereqs[0].title}」
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleLaunchLesson(l)}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-[var(--ve-accent-solid)] px-4 py-2.5 text-xs font-semibold text-white transition hover:opacity-90"
                >
                  <BookOpen size={14} /> {isDueReview ? "进入 Learn 开始复习" : "进入 Learn 开始学习"}
                </button>
              )}
              {mastery < 80 && available(s, l) && (
                <button
                  type="button"
                  onClick={() => setShowMasteryChoices((v) => !v)}
                  className={
                    "inline-flex items-center justify-center gap-1.5 rounded-full border px-3.5 py-2.5 text-xs font-semibold transition " +
                    (showMasteryChoices
                      ? "border-[var(--ve-accent-solid)] bg-[var(--ve-surface-alt)] text-[var(--ve-ink)]"
                      : "border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]")
                  }
                >
                  <FastForward size={13} /> 标记已掌握
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  attachContext({
                    type: "lesson",
                    lessonId: l.id,
                    title: l.title,
                    mastery,
                  });
                  setCopilotOpen(true);
                }}
                className="inline-flex items-center justify-center gap-1 rounded-full border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3 py-2.5 text-xs font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]"
              >
                问 AI
              </button>
            </div>

            {/* 3-Option Mastery Verification Selector: distinguishes Self-Reported vs Verified BKT Mastery */}
            {showMasteryChoices && mastery < 80 && available(s, l) && (
              <div className="space-y-2 rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-[var(--ve-ink)]">
                    如何处理「{l.title}」的掌握状态？
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowMasteryChoices(false)}
                    className="text-[11px] text-[var(--ve-muted)] hover:text-[var(--ve-ink)]"
                  >
                    取消
                  </button>
                </div>
                <p className="text-[11px] leading-relaxed text-[var(--ve-muted)]">
                  系统严格区分「自我报告」与「已验证掌握（基于测验/练习证据）」，避免一次点击误解锁全部后续依赖。
                </p>

                <div className="space-y-1.5 pt-1">
                  <button
                    type="button"
                    onClick={() => handleStartQuickDiagnostic(l)}
                    className="flex w-full items-start justify-between gap-2 rounded-xl border border-[var(--ve-accent)]/35 bg-[var(--ve-surface)] px-3 py-2.5 text-left transition hover:border-[var(--ve-accent)] hover:bg-[var(--ve-accent-soft)]"
                  >
                    <div>
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--ve-ink)]">
                        <span>已经学过，进行快速诊断</span>
                        <span className="rounded-full bg-[var(--ve-accent-soft)] px-1.5 py-0.2 text-[10px] font-semibold text-[var(--ve-accent)]">
                          推荐
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--ve-muted)]">
                        用 1 道高区分度题目验证理解，通过后更新已验证 BKT 掌握度并解锁后续课程
                      </div>
                    </div>
                    <ArrowRight size={14} className="mt-1 shrink-0 text-[var(--ve-accent)]" />
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      markLessonSkipped(l);
                      setShowMasteryChoices(false);
                    }}
                    className="flex w-full items-start justify-between gap-2 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3 py-2.5 text-left transition hover:border-[var(--ve-line)] hover:bg-[var(--ve-surface-alt)]"
                  >
                    <div>
                      <div className="text-xs font-semibold text-[var(--ve-ink)]">
                        暂时跳过，但不更新掌握度
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--ve-muted)]">
                        仅标注为暂时跳过，保持当前 BKT {mastery}% 不变，可随时回来学习
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      declareSelfReportedMastery(l);
                      setShowMasteryChoices(false);
                    }}
                    className="flex w-full items-start justify-between gap-2 rounded-xl border border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] px-3 py-2.5 text-left transition hover:border-[var(--ve-amber)] hover:bg-[var(--ve-amber-soft)]"
                  >
                    <div>
                      <div className="text-xs font-semibold text-[var(--ve-amber)]">
                        手动声明掌握，标注为未验证
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--ve-amber)]/90">
                        记录你的自我评估为「未验证」，不伪造已验证 BKT 分数
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            )}
          </aside>
        )}
      </div>

      <ConfirmDangerDialog
        open={Boolean(pendingArchiveTrack)}
        tone="warning"
        title={
          pendingArchiveTrack
            ? `归档轨道「${pendingArchiveTrack.title}」？`
            : "归档轨道？"
        }
        description="归档是安全的默认整理方式：会暂停该轨道未完成的未来排程与主动复习提醒，且可随时恢复。"
        impacts={
          pendingArchiveTrack
            ? [
                `涉及 ${pendingArchiveTrack.lessonCount} 节课程的未来未完成日程将被暂停`,
                "该轨道的待处理补救草案将自动转为已忽略",
                "Today 与 Planner 将暂停该轨道的主动到期复习提醒",
              ]
            : []
        }
        preservedNote="完整保留全部课程内容、答题记录、掌握度、学习会话与已完成日程历史，随时可一键恢复。"
        confirmLabel="确认归档"
        busy={trackActionBusy}
        onCancel={() => setPendingArchiveTrack(null)}
        onConfirm={async () => {
          if (!pendingArchiveTrack) return;
          setTrackActionBusy(true);
          await archiveTrack(pendingArchiveTrack.id);
          setTrackActionBusy(false);
          setPendingArchiveTrack(null);
        }}
      />

      <AnimatePresence>
        {showScopeModal && activeTrack && (
          <motion.div
            key="scope-modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={TRANSITION_FAST}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
            onClick={(e) => {
              if (e.target === e.currentTarget && !trackActionBusy) {
                setShowScopeModal(false);
              }
            }}
          >
            <motion.div
              initial={{ opacity: 0, y: 6, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.985 }}
              transition={TRANSITION_FAST}
              className="flex max-h-[86dvh] w-full max-w-[540px] flex-col overflow-hidden rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] shadow-xl"
            >
              <div className="flex items-center justify-between gap-2 border-b border-[var(--ve-border)] bg-[var(--ve-canvas)] px-5 py-3.5">
                <div className="min-w-0">
                  <h3 className="truncate text-[14.5px] font-semibold text-[var(--ve-ink)]">
                    调整范围与深度 · {activeTrack.title}
                  </h3>
                  <p className="mt-0.5 text-[11.5px] text-[var(--ve-muted)]">
                    当前 {activeTrack.units.length} 节课，调整时自动保留已掌握记录与已完成日程。
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={() => setShowScopeModal(false)}
                  className="rounded-md p-1 text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>

              <div className="flex-1 space-y-4 overflow-y-auto p-5 text-xs">
                <div>
                  <div className="mb-1.5 font-semibold text-[var(--ve-ink)]">
                    学习深度
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        { id: "crash", label: "速通聚焦", hint: "直奔核心主干" },
                        { id: "standard", label: "实战标准", hint: "理论与实战均衡" },
                        { id: "deep", label: "系统深入", hint: "完整体系与原理" },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setScopeDepth(opt.id)}
                        className={
                          "rounded-lg border px-3 py-2 text-left transition " +
                          (scopeDepth === opt.id
                            ? "border-[var(--ve-accent)] bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]"
                            : "border-[var(--ve-border)] bg-[var(--ve-canvas)] text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]")
                        }
                      >
                        <div className="font-semibold">{opt.label}</div>
                        <div className="mt-0.5 text-[10.5px] opacity-80">
                          {opt.hint}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block font-semibold text-[var(--ve-ink)]">
                      目标周期（天）
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={180}
                      value={scopeDaysDraft}
                      onChange={(e) =>
                        setScopeDaysDraft(Number(e.target.value) || 7)
                      }
                      className="w-full rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-3 py-1.5 text-xs text-[var(--ve-ink)] outline-none focus:border-[var(--ve-accent)]"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block font-semibold text-[var(--ve-ink)]">
                      每日投入（分钟）
                    </span>
                    <input
                      type="number"
                      min={15}
                      max={240}
                      step={15}
                      value={scopeDailyDraft}
                      onChange={(e) =>
                        setScopeDailyDraft(Number(e.target.value) || 45)
                      }
                      className="w-full rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-3 py-1.5 text-xs text-[var(--ve-ink)] outline-none focus:border-[var(--ve-accent)]"
                    />
                  </label>
                </div>

                <label className="block">
                  <span className="mb-1 block font-semibold text-[var(--ve-ink)]">
                    范围说明（可选）
                  </span>
                  <input
                    type="text"
                    value={scopeNoteDraft}
                    onChange={(e) => setScopeNoteDraft(e.target.value)}
                    placeholder="例如：跳过基础语法，重点补强工具调用与异常恢复"
                    className="w-full rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-3 py-1.5 text-xs text-[var(--ve-ink)] outline-none focus:border-[var(--ve-accent)]"
                  />
                </label>

                <div className="space-y-2 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-3">
                  <div className="flex items-center gap-1.5 font-semibold text-[var(--ve-ink)]">
                    <Plus size={12} aria-hidden="true" /> 追加自定义章节 / 新课时（可选）
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input
                      type="text"
                      value={newLessonChapterTitle}
                      onChange={(e) => setNewLessonChapterTitle(e.target.value)}
                      placeholder="大章节标题（可新建或归入已有章）"
                      className="w-full rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1.5 text-xs text-[var(--ve-ink)] outline-none focus:border-[var(--ve-accent)]"
                    />
                    <input
                      type="text"
                      value={newLessonSectionTitle}
                      onChange={(e) => setNewLessonSectionTitle(e.target.value)}
                      placeholder="小章节标题（可新建或归入已有节）"
                      className="w-full rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1.5 text-xs text-[var(--ve-ink)] outline-none focus:border-[var(--ve-accent)]"
                    />
                  </div>
                  <input
                    type="text"
                    value={newLessonTitle}
                    onChange={(e) => setNewLessonTitle(e.target.value)}
                    placeholder="新课时标题，例如：生产环境限流与超时重试"
                    className="w-full rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1.5 text-xs text-[var(--ve-ink)] outline-none focus:border-[var(--ve-accent)]"
                  />
                  {newLessonTitle.trim() && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input
                        type="text"
                        value={newLessonObjective}
                        onChange={(e) => setNewLessonObjective(e.target.value)}
                        placeholder="学习目标（留空自动生成）"
                        className="w-full rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1.5 text-xs text-[var(--ve-ink)] outline-none focus:border-[var(--ve-accent)]"
                      />
                      <input
                        type="text"
                        value={newLessonCriteria}
                        onChange={(e) => setNewLessonCriteria(e.target.value)}
                        placeholder="完成条件（留空自动生成）"
                        className="w-full rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1.5 text-xs text-[var(--ve-ink)] outline-none focus:border-[var(--ve-accent)]"
                      />
                    </div>
                  )}
                </div>

                {activeTrack.units.length > 1 && (
                  <div>
                    <div className="mb-1.5 font-semibold text-[var(--ve-ink)]">
                      精简未掌握课程（勾选移除；已掌握课程受保护）
                    </div>
                    <div className="max-h-[150px] space-y-1 overflow-y-auto rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-2">
                      {activeTrack.units.map((u) => {
                        const mastered = (s.mastery[u.id] ?? 0) >= 80;
                        const checked = trimIds.includes(u.id);
                        const remainingCount =
                          activeTrack.units.length -
                          trimIds.length +
                          (newLessonTitle.trim() ? 1 : 0);
                        const disableCheck =
                          mastered || (!checked && remainingCount <= 1);
                        return (
                          <label
                            key={u.id}
                            className={
                              "flex items-center justify-between gap-2 rounded-md px-2 py-1 text-[11.5px] " +
                              (disableCheck
                                ? "opacity-55"
                                : "cursor-pointer hover:bg-[var(--ve-surface-alt)]")
                            }
                          >
                            <span className="flex items-center gap-2 truncate">
                              <input
                                type="checkbox"
                                disabled={disableCheck}
                                checked={checked}
                                onChange={(e) => {
                                  setTrimIds((prev) =>
                                    e.target.checked
                                      ? [...prev, u.id]
                                      : prev.filter((id) => id !== u.id),
                                  );
                                }}
                              />
                              <span className="truncate text-[var(--ve-ink)]">
                                {u.title}
                              </span>
                            </span>
                            <span className="shrink-0 font-mono text-[10px] text-[var(--ve-muted)]">
                              {mastered ? "已掌握" : `${u.minutes}m`}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--ve-border)] bg-[var(--ve-canvas)] px-5 py-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowScopeModal(false);
                    setCopilotOpen(true);
                    askCopilot(
                      `请使用 adjust_track_scope 帮我自由重编/扩展轨道「${activeTrack.title}」的章节与课时：目标深度=${TRACK_DEPTH_LABELS[scopeDepth]}，周期=${scopeDaysDraft}天，每日${scopeDailyDraft}分钟${scopeNoteDraft.trim() ? `，范围要求：${scopeNoteDraft.trim()}` : ""}。请完全自由发挥（不限固定节数，按贴合该学科真实体系的「大章节 chapterTitle → 小章节 sectionTitle → 课时」分层规划），保留我已掌握的课程并构建无环先修依赖。`,
                    );
                  }}
                  className="rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3 py-1.5 text-xs font-medium text-[var(--ve-accent)] hover:border-[var(--ve-accent)]"
                >
                  让助手重编章节
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowScopeModal(false)}
                    className="rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3 py-1.5 text-xs font-medium text-[var(--ve-muted)] hover:text-[var(--ve-ink)]"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={trackActionBusy}
                    onClick={async () => {
                      setTrackActionBusy(true);
                      const ok = await adjustTrackScope({
                        trackId: activeTrack.id,
                        depth: scopeDepth,
                        scopeNote: scopeNoteDraft,
                        days: scopeDaysDraft,
                        dailyMinutes: scopeDailyDraft,
                        removeLessonIds:
                          trimIds.length > 0 ? trimIds : undefined,
                        appendUnits: newLessonTitle.trim()
                          ? [
                              {
                                chapterTitle:
                                  newLessonChapterTitle.trim() || undefined,
                                sectionTitle:
                                  newLessonSectionTitle.trim() || undefined,
                                title: newLessonTitle.trim(),
                                concept:
                                  newLessonObjective.trim() ||
                                  newLessonTitle.trim(),
                                objective:
                                  newLessonObjective.trim() || undefined,
                                completionCriteria:
                                  newLessonCriteria.trim() || undefined,
                                minutes: Math.min(
                                  60,
                                  Math.max(20, scopeDailyDraft),
                                ),
                              },
                            ]
                          : undefined,
                      });
                      setTrackActionBusy(false);
                      if (ok) setShowScopeModal(false);
                    }}
                    className="rounded-lg bg-[var(--ve-accent-solid)] px-3.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {trackActionBusy ? "保存中…" : "应用调整"}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmDangerDialog
        open={Boolean(pendingDeleteImpact)}
        title={
          pendingDeleteImpact
            ? `永久删除轨道「${pendingDeleteImpact.title}」？`
            : "永久删除轨道？"
        }
        description="永久删除采用事务执行且不可撤销。如希望保留历史，请改用「归档轨道」。"
        impacts={
          pendingDeleteImpact
            ? [
                `独占课程：${pendingDeleteImpact.exclusiveLessonCount} 节（总 ${pendingDeleteImpact.lessonCount} 节）`,
                `关联日程块：未完成 ${pendingDeleteImpact.futureBlockCount} 条 / 已完成 ${pendingDeleteImpact.completedBlockCount} 条`,
                `持久化练习与作答：${pendingDeleteImpact.exerciseCount} 道题 / ${pendingDeleteImpact.attemptCount} 条作答 / ${pendingDeleteImpact.sessionCount} 个会话`,
              ]
            : []
        }
        preservedNote={
          pendingDeleteImpact
            ? `其他 ${pendingDeleteImpact.otherTrackCount} 条轨道、共享课程（${pendingDeleteImpact.sharedLessonIds.length} 节）与无关长期记忆均不会被删除。`
            : undefined
        }
        confirmLabel="确认永久删除"
        busy={trackActionBusy}
        onCancel={() => setPendingDeleteImpact(null)}
        onConfirm={async () => {
          if (!pendingDeleteImpact) return;
          setTrackActionBusy(true);
          await permanentDeleteTrack(pendingDeleteImpact.trackId);
          setTrackActionBusy(false);
          setPendingDeleteImpact(null);
        }}
      />
    </div>
  );
}
