"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ClipboardCheck,
  Code2,
  FileText,
  GitFork,
  Globe,
  Lightbulb,
  Loader2,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { UIMessage } from "ai";
import {
  type DbInfo,
  type InteractiveCheckCard as InteractiveCheckData,
  type Lesson,
  type LessonContract,
  type Store,
  type VisualExplanationCardData,
  available,
  buildActiveRecallCard,
  focusLesson,
  getActiveTrack,
  getLessonById,
  getMissingPrerequisites,
  time,
} from "../lib/learning";
import { groupLessonsIntoStages } from "../lib/curriculum-planner";
import {
  type ExerciseAttemptRecord,
  type ExerciseRecord,
  type LearnerModelUpdateResult,
  type LearningSessionRecord,
  type PlanDraftRecord,
  type StructuredExerciseAnswer,
  exerciseToCheckCard,
} from "../lib/learning-engine-types";
import {
  type PracticeEditorKind,
  resolveLessonPracticeSpec,
} from "../lib/lesson-practice";
import { getClientTaskManager } from "../lib/llm-task-manager";
import { snapWidthWithSpring } from "../lib/spring";
import { SPRING_CRISP, SPRING_PANEL, TRANSITION_FAST } from "../lib/motion";
import type { PreparedLessonPackage } from "../lib/topic-researcher";
import type { KnowledgeAcquisitionMode } from "../lib/web-research";
import { useLearningStore } from "./LearningStore";
import Agent from "./Agent";
import RichMarkdown from "./gen-ui/RichMarkdown";
import VisualExplanationCard from "./gen-ui/VisualExplanationCard";
import ActiveRecallCard from "./gen-ui/ActiveRecallCard";
import CodeEditorBox from "./gen-ui/CodeEditorBox";
import SessionTimerBar from "./gen-ui/SessionTimerBar";
import InteractiveCheckCard, {
  type PersistedCheckState,
} from "./gen-ui/InteractiveCheckCard";

type LearnMode = "learn" | "practice" | "assess" | "review";

function formatExampleAsMarkdown(example: string, trackTitle: string): string {
  const trimmed = example.trim();
  if (!trimmed) return "";
  if (trimmed.includes("```")) return trimmed;
  const lower = `${trackTitle} ${trimmed}`.toLowerCase();
  let lang = "text";
  if (
    lower.includes("def ") ||
    lower.includes("print(") ||
    lower.includes("import ") && !lower.includes("from \"")
  ) {
    lang = "python";
  } else if (
    lower.includes("public class") ||
    lower.includes("system.out")
  ) {
    lang = "java";
  } else if (
    lower.includes("const ") ||
    lower.includes("function ") ||
    lower.includes("async ") ||
    lower.includes("=>")
  ) {
    lang = "typescript";
  } else if (lower.includes("select ") && lower.includes("from ")) {
    lang = "sql";
  } else if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    lang = "json";
  }
  return `\`\`\`${lang}\n${trimmed}\n\`\`\``;
}

export default function LearnWorkspace({
  onOpenModelSettings,
}: {
  onOpenModelSettings: () => void;
}) {
  const {
    s,
    now,
    activeThreadId,
    focusedLessonId,
    setFocusedLessonId,
    setWorkspaceTab,
    learnModeRequest,
    clearLearnModeRequest,
    syncStoreFromServer,
    attachContext,
    askCopilot,
    markLessonSkipped,
    declareSelfReportedMastery,
    completeSessionTiming,
    recordFSRSReview,
    checkDrafts,
    setCheckDraft,
    modelConfig,
    showToast,
  } = useLearningStore();

  const activeTrack = useMemo(() => getActiveTrack(s), [s]);
  const [catalogOpen, setCatalogOpen] = useState(() => {
    if (typeof window !== "undefined" && window.innerWidth < 1280) {
      return false;
    }
    return true;
  });
  const [tutorOpen, setTutorOpen] = useState(true);
  const [tutorWidth, setTutorWidth] = useState(390);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const [containerWidth, setContainerWidth] = useState(1280);
  const wasCompactRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const mainScrollRef = useRef<HTMLElement>(null);
  const scrollMapRef = useRef<Record<string, number>>({});
  const [mode, setModeState] = useState<LearnMode>(() => {
    try {
      const saved = sessionStorage.getItem("xushi.learn-mode.v1") as LearnMode | null;
      if (saved && ["learn", "practice", "assess", "review"].includes(saved)) {
        return saved;
      }
    } catch {}
    return "learn";
  });
  const setMode = (next: LearnMode) => {
    setModeState(next);
    try {
      sessionStorage.setItem("xushi.learn-mode.v1", next);
    } catch {}
  };

  // Adaptive 3-pane reader: below 1280px laptop screens (classroom container < 1120px),
  // auto-collapse catalog into an on-demand slide-over drawer so the central reader maintains ~65-72ch width.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (!w) return;
      const rounded = Math.round(w);
      setContainerWidth(rounded);
      const compactNow = rounded < 1120;
      if (compactNow && !wasCompactRef.current) {
        setCatalogOpen(false);
      }
      wasCompactRef.current = compactNow;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const isCatalogDrawerMode = containerWidth < 1120;
  const effectiveDockedCatalogOpen = catalogOpen && !isCatalogDrawerMode;
  const effectiveDrawerCatalogOpen = catalogOpen && isCatalogDrawerMode;
  const effectiveTutorWidth = Math.max(
    280,
    Math.min(
      tutorWidth,
      Math.max(
        280,
        containerWidth - (effectiveDockedCatalogOpen ? 236 : 0) - 460,
      ),
    ),
  );

  // Authoritative Learning Session + Canonical Exercise + Deterministic Grading + Plan Draft state
  const [session, setSession] = useState<LearningSessionRecord | null>(null);
  const [canonicalExercise, setCanonicalExercise] =
    useState<ExerciseRecord | null>(null);
  const [sessionExercises, setSessionExercises] = useState<ExerciseRecord[]>(
    [],
  );
  const [selectedExerciseId, setSelectedExerciseId] = useState<string | null>(
    null,
  );
  const [latestAttempt, setLatestAttempt] =
    useState<ExerciseAttemptRecord | null>(null);
  const [lastLearnerUpdate, setLastLearnerUpdate] =
    useState<LearnerModelUpdateResult | null>(null);
  const [pendingDrafts, setPendingDrafts] = useState<PlanDraftRecord[]>([]);
  const [submittingAttempt, setSubmittingAttempt] = useState(false);
  const [attemptNonce, setAttemptNonce] = useState(1);

  // Local state for Practice & Assess modes
  const [showHint, setShowHint] = useState(false);
  const [practiceKindOverride, setPracticeKindOverride] =
    useState<PracticeEditorKind | null>(null);
  const [threadMessages, setThreadMessages] = useState<UIMessage[]>(() =>
    getClientTaskManager().getThreadMessages(activeThreadId),
  );
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null);
  const [assessSubmitted, setAssessSubmitted] = useState<{
    correct: boolean;
    chosenIndex: number;
    beforeMastery: number;
    afterMastery: number;
    feedback?: string;
    hasPlanDraft?: boolean;
  } | null>(null);

  // Subscribe to active thread messages so whenever AI Tutor registers a new canonical exercise,
  // Learn refreshes its SQLite Learning Session cleanly.
  useEffect(() => {
    const tm = getClientTaskManager();
    setThreadMessages(tm.getThreadMessages(activeThreadId));
    const unsub = tm.subscribe(
      (ev) => setThreadMessages(ev.messages),
      { threadId: activeThreadId },
    );
    return () => unsub();
  }, [activeThreadId]);

  // Honor explicit navigation requests from AI Tutor Exercise Reference Card (e.g. "在 Learn 中作答")
  useEffect(() => {
    if (!learnModeRequest) return;
    setMode(learnModeRequest.mode);
    if (learnModeRequest.exerciseId) {
      setSelectedExerciseId(learnModeRequest.exerciseId);
    }
    clearLearnModeRequest();
  }, [learnModeRequest, clearLearnModeRequest]);

  // Resolve current lesson from focusedLessonId or track's recommended focusLesson
  const currentLesson: Lesson | null = useMemo(() => {
    if (!activeTrack || activeTrack.units.length === 0) return null;
    if (focusedLessonId) {
      const exact = activeTrack.units.find((u) => u.id === focusedLessonId);
      if (exact) return exact;
    }
    return focusLesson(s, activeTrack.id) || activeTrack.units[0] || null;
  }, [activeTrack, focusedLessonId, s]);

  const currentIndex = useMemo(() => {
    if (!activeTrack || !currentLesson) return -1;
    return activeTrack.units.findIndex((u) => u.id === currentLesson.id);
  }, [activeTrack, currentLesson]);

  const catalogChapters = useMemo(
    () => (activeTrack ? groupLessonsIntoStages(activeTrack.units) : []),
    [activeTrack],
  );
  const [collapsedChapters, setCollapsedChapters] = useState<
    Record<string, boolean>
  >({});

  const currentChapterBreadcrumb = useMemo(() => {
    if (!currentLesson) return null;
    for (const ch of catalogChapters) {
      for (const sec of ch.sections) {
        if (sec.units.some((u) => u.id === currentLesson.id)) {
          return {
            chapterTitle: ch.stageTitle,
            sectionCode: sec.globalSectionCode,
            sectionTitle: sec.sectionTitle,
          };
        }
      }
    }
    return null;
  }, [catalogChapters, currentLesson]);

  // Reset per-lesson UI state when switching lessons & restore saved scroll position (LEARN-08 / UX-20)
  useEffect(() => {
    setSelectedChoice(null);
    setAssessSubmitted(null);
    setShowHint(false);
    setPracticeKindOverride(null);
    setLastLearnerUpdate(null);
    setSelectedExerciseId(null);
    setAttemptNonce(1);
    if (!currentLesson?.id) return;
    const lessonId = currentLesson.id;
    let targetScroll = scrollMapRef.current[lessonId];
    if (targetScroll === undefined) {
      try {
        const raw = sessionStorage.getItem("xushi.learn-scroll.v1");
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, number>;
          if (typeof parsed[lessonId] === "number") {
            targetScroll = parsed[lessonId];
            scrollMapRef.current[lessonId] = targetScroll;
          }
        }
      } catch {}
    }
    const raf = requestAnimationFrame(() => {
      if (mainScrollRef.current) {
        mainScrollRef.current.scrollTop = targetScroll ?? 0;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [currentLesson?.id]);

  // Strictly lessonId-scoped visual explanations from AI Tutor tool outputs (fixes cross-lesson diagram leakage!)
  const threadVisualsForLesson = useMemo<VisualExplanationCardData[]>(() => {
    if (!currentLesson) return [];
    const results: VisualExplanationCardData[] = [];
    const seen = new Set<string>();
    for (let i = threadMessages.length - 1; i >= 0; i--) {
      const msg = threadMessages[i];
      if (msg.role !== "assistant") continue;
      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j] as Record<string, unknown>;
        if (
          part.state === "output-available" &&
          part.output &&
          typeof part.output === "object" &&
          (part.output as { kind?: string }).kind === "visual_explanation"
        ) {
          const card = part.output as VisualExplanationCardData;
          if (card.lessonId === currentLesson.id && !seen.has(card.visualId)) {
            seen.add(card.visualId);
            results.push(card);
          }
        }
      }
    }
    return results;
  }, [threadMessages, currentLesson]);

  // Find latest AI-generated exercise ID in thread so we refresh session when AI registers a new exercise
  const latestAiExerciseId = useMemo<string | null>(() => {
    if (!currentLesson) return null;
    for (let i = threadMessages.length - 1; i >= 0; i--) {
      const msg = threadMessages[i];
      if (msg.role !== "assistant") continue;
      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j] as Record<string, unknown>;
        if (
          part.state === "output-available" &&
          part.output &&
          typeof part.output === "object" &&
          (part.output as { kind?: string }).kind === "interactive_check"
        ) {
          const card = part.output as InteractiveCheckData;
          if (!card.lessonId || card.lessonId === currentLesson.id) {
            return card.exerciseId || card.checkId;
          }
        }
      }
    }
    return null;
  }, [threadMessages, currentLesson]);

  // Start or resume authoritative Learning Session from SQLite (ZERO LLM calls!)
  useEffect(() => {
    if (!currentLesson) {
      setSession(null);
      setCanonicalExercise(null);
      setSessionExercises([]);
      setLatestAttempt(null);
      setPendingDrafts([]);
      return;
    }
    let cancelled = false;
    void fetch("/api/learning/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lessonId: currentLesson.id,
        trackId: activeTrack?.id,
        exerciseId: selectedExerciseId || undefined,
        day: now,
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data: {
            session?: LearningSessionRecord;
            exercise?: ExerciseRecord | null;
            exercises?: ExerciseRecord[];
            latestAttempt?: ExerciseAttemptRecord | null;
            pendingPlanDrafts?: PlanDraftRecord[];
          } | null,
        ) => {
          if (cancelled || !data) return;
          if (data.session) setSession(data.session);
          setCanonicalExercise(data.exercise || null);
          setSessionExercises(data.exercises || []);
          setLatestAttempt(data.latestAttempt || null);
          setPendingDrafts(data.pendingPlanDrafts || []);
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    currentLesson?.id,
    activeTrack?.id,
    now,
    latestAiExerciseId,
    selectedExerciseId,
  ]);

  // Dynamic lesson practice specification (auto-detects code editor vs prose text box)
  const [lessonPrep, setLessonPrep] = useState<PreparedLessonPackage | null>(
    null,
  );
  const [lessonContract, setLessonContract] = useState<LessonContract | null>(
    null,
  );
  const prewarmedLessonIdsRef = useRef<Set<string>>(new Set());
  const [injectedActivities, setInjectedActivities] = useState<
    Array<{
      activityId: string;
      activityType: string;
      gradingMode: string;
      spec: Record<string, unknown>;
      linkedExerciseId: string | null;
      createdAt: string;
    }>
  >([]);

  // Strictly lessonId-scoped visual explanations (SQLite persisted + real-time thread outputs for currentLesson.id ONLY)
  const lessonVisualExplanations = useMemo<VisualExplanationCardData[]>(() => {
    if (!currentLesson) return [];
    const merged: VisualExplanationCardData[] = [];
    const seen = new Set<string>();

    for (const v of threadVisualsForLesson) {
      if (v.lessonId === currentLesson.id && !seen.has(v.visualId)) {
        seen.add(v.visualId);
        merged.push(v);
      }
    }

    for (const act of injectedActivities) {
      if (
        act.activityType !== "visual_explanation" &&
        act.activityType !== "diagram"
      ) {
        continue;
      }
      const sp = act.spec || {};
      const actLessonId = sp.lessonId ? String(sp.lessonId) : currentLesson.id;
      if (actLessonId !== currentLesson.id) continue;
      const vid = String(sp.visualId || act.activityId);
      if (seen.has(vid)) continue;
      seen.add(vid);
      const visualType =
        (sp.visualType as VisualExplanationCardData["visualType"]) ||
        (sp.svg
          ? "svg"
          : sp.widget
            ? "interactive_widget"
            : "mermaid");
      merged.push({
        kind: "visual_explanation",
        visualId: vid,
        lessonId: currentLesson.id,
        conceptId: String(sp.conceptId || currentLesson.title),
        contractVersion: Number(sp.contractVersion ?? 1),
        title: String(sp.title || `${currentLesson.title} · 可视化图解`),
        summary: sp.summary
          ? String(sp.summary)
          : sp.prompt
            ? String(sp.prompt)
            : undefined,
        caption: sp.caption ? String(sp.caption) : undefined,
        visualType,
        mermaid: sp.mermaid ? String(sp.mermaid) : undefined,
        svg: sp.svg ? String(sp.svg) : undefined,
        widget: sp.widget as VisualExplanationCardData["widget"],
        steps: Array.isArray(sp.steps)
          ? (sp.steps as VisualExplanationCardData["steps"])
          : undefined,
      });
    }
    return merged;
  }, [currentLesson, threadVisualsForLesson, injectedActivities]);

  const nonVisualInjectedActivities = useMemo(
    () =>
      injectedActivities.filter(
        (act) =>
          act.activityType !== "visual_explanation" &&
          act.activityType !== "diagram",
      ),
    [injectedActivities],
  );

  const [prepLoading, setPrepLoading] = useState(false);
  const [prepPhaseText, setPrepPhaseText] = useState("");
  const [showPrepMaterialBox, setShowPrepMaterialBox] = useState(false);
  const [prepMaterialUrl, setPrepMaterialUrl] = useState("");
  const [prepMaterialNotes, setPrepMaterialNotes] = useState("");

  function triggerRollingPrewarm(nextLessonId: string | null | undefined) {
    if (!nextLessonId || !activeTrack) return;
    const prewarmKey = `${nextLessonId}:v${activeTrack.blueprintVersion ?? 1}`;
    if (prewarmedLessonIdsRef.current.has(prewarmKey)) return;
    prewarmedLessonIdsRef.current.add(prewarmKey);
    void fetch("/api/learning/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lessonId: nextLessonId,
        trackId: activeTrack.id,
        mode: "auto_web",
        learnerLevel: activeTrack.priorKnowledge || "intermediate",
        prewarm: true,
        day: now,
        clientModelConfig: modelConfig,
      }),
    }).catch(() => {
      prewarmedLessonIdsRef.current.delete(prewarmKey);
    });
  }

  // Load cached SQLite deep lesson preparation immediately on lesson switch,
  // auto-prepare unlocked lessons on entry (no manual click needed), and trigger N+1 rolling prewarm!
  useEffect(() => {
    if (!currentLesson) {
      setLessonPrep(null);
      setLessonContract(null);
      setInjectedActivities([]);
      setPrepLoading(false);
      setPrepPhaseText("");
      return;
    }
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    setLessonPrep(null);
    setLessonContract(currentLesson.contract || null);
    setInjectedActivities([]);
    setPrepLoading(false);
    setPrepPhaseText("");

    async function checkPreparation() {
      if (!currentLesson || cancelled) return;
      try {
        const r = await fetch(
          `/api/learning/prepare?lessonId=${encodeURIComponent(currentLesson.id)}&day=${encodeURIComponent(now)}`,
          { cache: "no-store" },
        );
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as {
          preparation?: Record<string, unknown> | null;
          contract?: LessonContract | null;
          blueprintVersion?: number;
          isStale?: boolean;
          nextRollingLessonId?: string | null;
          teachingActivities?: Array<{
            activityId: string;
            activityType: string;
            gradingMode: string;
            spec: Record<string, unknown>;
            linkedExerciseId: string | null;
            createdAt: string;
          }>;
        } | null;
        if (!cancelled && Array.isArray(data?.teachingActivities)) {
          setInjectedActivities(data.teachingActivities);
        }
        if (!cancelled && data?.contract) {
          setLessonContract(data.contract);
        }
        const p = data?.preparation;
        if (!p || data?.isStale) {
          if (cancelled) return;
          // Auto-prepare unlocked lesson immediately so user enters Learn and starts right away
          if (available(s, currentLesson)) {
            void triggerDeepPrepare("auto_web", Boolean(data?.isStale), true);
          } else {
            setPrepLoading(false);
            setPrepPhaseText("");
          }
          return;
        }
        if (p.status === "researching" || p.status === "drafting") {
          setPrepLoading(true);
          setPrepPhaseText(
            p.status === "researching"
              ? "正在后台复用轨道研究包并整理本节契约…"
              : "正在按知识图谱契约生成本节渐进式模块…",
          );
          pollTimer = setTimeout(() => {
            void checkPreparation();
          }, 2000);
          return;
        }
        if (
          (p.status === "ready" || p.status === "fallback") &&
          p.brief &&
          p.tutorial
        ) {
          setPrepLoading(false);
          setPrepPhaseText("");
          const briefObj = p.brief as PreparedLessonPackage["brief"];
          if (briefObj.contract && !data?.contract) {
            setLessonContract(briefObj.contract);
          }
          setLessonPrep({
            lessonId: String(p.lessonId),
            trackId: p.trackId ? String(p.trackId) : null,
            status: p.status as "ready" | "fallback",
            mode: p.mode as KnowledgeAcquisitionMode,
            effectiveMode: p.mode as KnowledgeAcquisitionMode,
            domain: "general",
            learnerLevel:
              (p.learnerLevel as "beginner" | "intermediate" | "advanced") ||
              "intermediate",
            cacheHit: true,
            reusedTrackResearch: Boolean(briefObj.reusedTrackResearch),
            blueprintVersion:
              briefObj.blueprintVersion ?? data?.blueprintVersion ?? 1,
            contract: briefObj.contract || data?.contract || undefined,
            preparedAt: String(p.updatedAt || ""),
            brief: briefObj,
            tutorial: p.tutorial as PreparedLessonPackage["tutorial"],
            sources: (p.sources as PreparedLessonPackage["sources"]) || [],
            qualityReport:
              p.qualityReport as PreparedLessonPackage["qualityReport"],
          });
          // N+1 Rolling Prewarm: once Lesson N is ready on screen, silently prewarm Lesson N+1 in background
          if (data?.nextRollingLessonId) {
            triggerRollingPrewarm(data.nextRollingLessonId);
          }
        }
      } catch {}
    }

    void checkPreparation();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [currentLesson?.id]);

  async function triggerDeepPrepare(
    reqMode: KnowledgeAcquisitionMode = "auto_web",
    forceRefresh = false,
    silentAuto = false,
  ) {
    if (!currentLesson || prepLoading) return;
    setPrepLoading(true);
    setPrepPhaseText(
      reqMode === "quick_draft"
        ? "正在按图谱契约生成本节渐进式教学模块…"
        : reqMode === "user_materials"
          ? "正在读取指定参考资料并整合本节教学模块…"
          : "正在结合轨道研究包与图谱契约准备本课基础教学内容…",
    );
    try {
      const urls = prepMaterialUrl
        .split(/[\s,]+/)
        .map((u) => u.trim())
        .filter((u) => /^https?:\/\//i.test(u));
      const res = await fetch("/api/learning/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonId: currentLesson.id,
          trackId: activeTrack?.id,
          mode: reqMode,
          learnerLevel: activeTrack?.priorKnowledge || "intermediate",
          userUrls: urls.length ? urls : undefined,
          userNotes: prepMaterialNotes.trim() || undefined,
          forceRefresh,
          day: now,
          clientModelConfig: modelConfig,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            prepared?: PreparedLessonPackage;
            nextPrewarmLessonId?: string | null;
            error?: string;
          }
        | null;
      if (!res.ok || !data?.prepared) {
        if (!silentAuto) {
          showToast(data?.error || "深度备课失败，请稍后重试。");
        }
        return;
      }
      setLessonPrep(data.prepared);
      if (data.prepared.contract) {
        setLessonContract(data.prepared.contract);
      }
      setShowPrepMaterialBox(false);
      if (data.nextPrewarmLessonId) {
        triggerRollingPrewarm(data.nextPrewarmLessonId);
      }
      if (!silentAuto) {
        showToast(
          data.prepared.cacheHit
            ? "已从本地缓存加载本课教学模块"
            : data.prepared.status === "fallback"
              ? "联网检索受限，已生成快速教学模块并缓存"
              : "本课渐进式教学内容已生成并缓存至本机 SQLite",
        );
      }
    } catch {
      if (!silentAuto) {
        showToast("深度备课请求失败，请检查网络连接。");
      }
    } finally {
      setPrepLoading(false);
      setPrepPhaseText("");
    }
  }

  const practiceSpec = useMemo(() => {
    if (!currentLesson) return null;
    return resolveLessonPracticeSpec(currentLesson, activeTrack?.title || "");
  }, [currentLesson, activeTrack?.title]);

  const activePracticeKind: PracticeEditorKind =
    practiceKindOverride ?? practiceSpec?.kind ?? "text";

  // Unified deterministic submission handler (NO chat message sent to LLM!)
  async function submitCanonicalExercise(
    exercise: ExerciseRecord,
    persistedState: PersistedCheckState,
  ) {
    if (!session || submittingAttempt) return;
    setSubmittingAttempt(true);
    try {
      const answer: StructuredExerciseAnswer = {
        selectedOrder: persistedState.savedOrder,
        choiceIndex: persistedState.savedChoiceIndex,
        choiceIndices: persistedState.savedChoiceIndices,
        blanks: persistedState.savedBlanks,
        text: persistedState.savedUserAnswer,
      };
      const idempotencyKey = `${session.learning_session_id}:${exercise.exercise_id}:try-${attemptNonce}`;
      const res = await fetch("/api/learning/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exerciseId: exercise.exercise_id,
          learningSessionId: session.learning_session_id,
          idempotencyKey,
          answer,
          day: now,
        }),
      });
      if (!res.ok) {
        const errData = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        showToast(errData?.error || "评分服务暂不可用，请重试。");
        return;
      }
      const data = (await res.json()) as {
        deduplicated: boolean;
        attempt: ExerciseAttemptRecord;
        learnerUpdate: LearnerModelUpdateResult | null;
        planDraft: PlanDraftRecord | null;
        session: LearningSessionRecord | null;
        store: Store;
        dbInfo?: DbInfo;
      };
      setLatestAttempt(data.attempt);
      if (data.learnerUpdate) setLastLearnerUpdate(data.learnerUpdate);
      if (data.session) setSession(data.session);
      if (data.planDraft) {
        setPendingDrafts((prev) => [
          data.planDraft!,
          ...prev.filter((d) => d.draft_id !== data.planDraft!.draft_id),
        ]);
      }
      if (data.store) {
        syncStoreFromServer(data.store, data.dbInfo);
      }
      showToast(
        data.attempt.correct
          ? `评分通过（${data.attempt.score} 分），已更新掌握状态。`
          : data.planDraft
            ? `评分完成（${data.attempt.score} 分），已生成待确认补救排期草案。`
            : `评分完成（${data.attempt.score} 分），已记录作答结果。`,
      );
    } finally {
      setSubmittingAttempt(false);
    }
  }

  async function handlePlanDraftAction(
    draftId: string,
    action: "apply" | "dismiss",
  ) {
    const res = await fetch("/api/learning/plan-drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId, action, day: now }),
    });
    const data = (await res.json().catch(() => null)) as {
      store?: Store;
      dbInfo?: DbInfo;
      error?: string;
      code?: string;
    } | null;
    if (!res.ok) {
      if (
        data?.code === "DRAFT_EXPIRED" ||
        data?.code === "DRAFT_NOT_PENDING" ||
        data?.code === "DRAFT_CONFLICT"
      ) {
        setPendingDrafts((prev) => prev.filter((d) => d.draft_id !== draftId));
      }
      showToast(data?.error || "排期草案应用失败，请刷新后重试。");
      return;
    }
    setPendingDrafts((prev) => prev.filter((d) => d.draft_id !== draftId));
    if (action === "apply" && data?.store) {
      syncStoreFromServer(data.store, data.dbInfo);
      showToast("已确认应用补救排期草案，日历与运行轨迹已同步。");
    } else {
      showToast("已忽略该补救排期草案，原日历保持不变。");
    }
  }

  const canonicalCheckCard = useMemo(() => {
    if (!canonicalExercise) return null;
    // When user clicks "重新作答" (latestAttempt cleared locally), render fresh unlocked card
    return exerciseToCheckCard(canonicalExercise, latestAttempt);
  }, [canonicalExercise, latestAttempt]);

  function selectLesson(lesson: Lesson) {
    setFocusedLessonId(lesson.id);
    if (isCatalogDrawerMode) {
      setCatalogOpen(false);
    }
    attachContext({
      type: "lesson",
      lessonId: lesson.id,
      title: lesson.title,
      mastery: s.mastery[lesson.id] ?? 0,
    });
  }

  function startResizeTutor(e: React.PointerEvent) {
    e.preventDefault();
    setDraggingSplit(true);
    const startX = e.clientX;
    const startW = tutorWidth;
    let latestW = startW;

    function onMove(ev: PointerEvent) {
      const delta = startX - ev.clientX;
      latestW = Math.max(310, Math.min(560, Math.round(startW + delta)));
      setTutorWidth(latestW);
    }
    function onUp() {
      setDraggingSplit(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // Crisp magnetic snap on drag release (stiffness: 1200, damping: 80)
      snapWidthWithSpring({
        current: latestW,
        min: 310,
        max: 560,
        detents: [340, 390, 440, 520],
        onUpdate: setTutorWidth,
      });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const practiceDraftKey = currentLesson
    ? `learn-practice-${currentLesson.id}`
    : "";
  const storedPracticeDraft = practiceDraftKey
    ? checkDrafts[practiceDraftKey]?.text
    : undefined;
  const practiceDraft =
    storedPracticeDraft !== undefined
      ? storedPracticeDraft
      : activePracticeKind === "code"
        ? practiceSpec?.starterCode || ""
        : "";

  const mastery = currentLesson ? (s.mastery[currentLesson.id] ?? 0) : 0;
  const isUnlocked = currentLesson ? available(s, currentLesson) : false;
  const missingPrereqs = currentLesson
    ? getMissingPrerequisites(s, currentLesson)
    : [];

  const nextUnlockedLesson = useMemo(() => {
    if (!activeTrack || currentIndex < 0) return null;
    for (let i = currentIndex + 1; i < activeTrack.units.length; i++) {
      const u = activeTrack.units[i];
      if (available(s, u)) return u;
    }
    return null;
  }, [activeTrack, currentIndex, s]);

  const recallCard = useMemo(() => {
    if (!currentLesson) return null;
    return buildActiveRecallCard(s, currentLesson, now);
  }, [s, currentLesson, now]);

  async function handleSubmitAssessment() {
    if (
      !currentLesson ||
      selectedChoice === null ||
      assessSubmitted ||
      submittingAttempt
    )
      return;
    if (missingPrereqs.length > 0) {
      showToast(
        `先修课程「${missingPrereqs[0].title}」尚未达标，请先完成先修课再进行正式测验。`,
      );
      return;
    }
    setSubmittingAttempt(true);
    try {
      const beforeMastery = s.mastery[currentLesson.id] ?? 0;
      const regRes = await fetch("/api/learning/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonId: currentLesson.id,
          trackId: activeTrack?.id,
          mode: "assess",
          day: now,
          registerExercise: {
            mode: "choice",
            prompt: currentLesson.question,
            spec: {
              lessonTitle: currentLesson.title,
              choices: currentLesson.choices,
              correctChoiceIndex: currentLesson.answer,
              explanation: currentLesson.feedback,
            },
            source: "curriculum",
          },
        }),
      });
      if (!regRes.ok) {
        const err = (await regRes.json().catch(() => null)) as {
          error?: string;
        } | null;
        showToast(err?.error || "测验初始化失败，请重试。");
        return;
      }
      const regData = (await regRes.json()) as {
        session: LearningSessionRecord;
        registeredExercise?: ExerciseRecord;
        exercise?: ExerciseRecord | null;
      };
      const targetExercise = regData.registeredExercise || regData.exercise;
      if (!targetExercise) {
        showToast("无法定位本课测验题目，请重试。");
        return;
      }

      const idempotencyKey = `assess:${regData.session.learning_session_id}:${targetExercise.exercise_id}:${attemptNonce}:${selectedChoice}`;
      const attRes = await fetch("/api/learning/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exerciseId: targetExercise.exercise_id,
          learningSessionId: regData.session.learning_session_id,
          idempotencyKey,
          answer: { choiceIndex: selectedChoice },
          day: now,
        }),
      });
      if (!attRes.ok) {
        const err = (await attRes.json().catch(() => null)) as {
          error?: string;
        } | null;
        showToast(err?.error || "测验提交失败，请重试。");
        return;
      }
      const attData = (await attRes.json()) as {
        attempt: ExerciseAttemptRecord;
        learnerUpdate: LearnerModelUpdateResult | null;
        planDraft: PlanDraftRecord | null;
        session: LearningSessionRecord | null;
        store: Store;
        dbInfo?: DbInfo;
      };
      if (attData.session) setSession(attData.session);
      if (attData.planDraft) {
        setPendingDrafts((prev) => [
          attData.planDraft!,
          ...prev.filter((d) => d.draft_id !== attData.planDraft!.draft_id),
        ]);
      }
      if (attData.store) {
        syncStoreFromServer(attData.store, attData.dbInfo);
      }
      setAttemptNonce((n) => n + 1);
      setAssessSubmitted({
        correct: attData.attempt.correct,
        chosenIndex: selectedChoice,
        beforeMastery: attData.learnerUpdate?.before ?? beforeMastery,
        afterMastery:
          attData.learnerUpdate?.after ??
          attData.store?.mastery?.[currentLesson.id] ??
          beforeMastery,
        feedback: attData.attempt.feedback || currentLesson.feedback,
        hasPlanDraft: Boolean(attData.planDraft),
      });
    } finally {
      setSubmittingAttempt(false);
    }
  }

  return (
    <div
      ref={containerRef}
      className={
        "flex h-full w-full flex-col overflow-hidden bg-[var(--surface-0)] " +
        (draggingSplit ? "select-none cursor-col-resize" : "")
      }
    >
      {/* Unified Single-Row Classroom Strip (Catalog + Track Progress + Inline Timer + Learning Assistant Toggle) */}
      <div className="flex h-[44px] shrink-0 items-center justify-between gap-2 bg-[var(--surface-1)] px-3.5">
        <div className="flex min-w-0 items-center gap-2">
          {activeTrack && (
            <button
              type="button"
              onClick={() => setCatalogOpen((v) => !v)}
              title={catalogOpen ? "收起课程目录" : "展开课程目录"}
              aria-label={catalogOpen ? "收起课程目录" : "展开课程目录"}
              className="rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] p-1.5 text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
            >
              {catalogOpen ? (
                <PanelLeftClose size={14} aria-hidden="true" />
              ) : (
                <PanelLeftOpen size={14} aria-hidden="true" />
              )}
            </button>
          )}
          {activeTrack ? (
            <span className="truncate text-[13px] font-semibold tracking-tight text-[var(--ve-ink)]">
              {activeTrack.title}
            </span>
          ) : (
            <span className="text-[13px] font-semibold tracking-tight text-[var(--ve-ink)]">
              课堂
            </span>
          )}
          {activeTrack && currentIndex >= 0 && (
            <span className="shrink-0 rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[var(--ve-muted)]">
              {String(currentIndex + 1).padStart(2, "0")}/
              {String(activeTrack.units.length).padStart(2, "0")}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {currentLesson && (
            <SessionTimerBar
              key={currentLesson.id}
              compact
              plannedMinutes={currentLesson.minutes}
              paceFactor={s.paceFactor ?? 1.0}
              onFinish={({ actualMinutes, interruptions, energy }) => {
                completeSessionTiming(
                  currentLesson,
                  currentLesson.minutes,
                  actualMinutes,
                  interruptions,
                  energy,
                );
              }}
            />
          )}
          <button
            type="button"
            onClick={() => setTutorOpen((v) => !v)}
            className={
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition " +
              (tutorOpen
                ? "border-[var(--ve-accent-solid)] bg-[var(--ve-accent-solid)] text-white"
                : "border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]")
            }
          >
            {tutorOpen ? (
              <PanelRightClose size={13} aria-hidden="true" />
            ) : (
              <PanelRightOpen size={13} aria-hidden="true" />
            )}
            <span>学习助手</span>
          </button>
        </div>
      </div>

      {/* 3-Pane Body (Laptop <1280px auto-converts catalog into slide-over drawer to protect reading width) */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Drawer backdrop on compact/laptop screens */}
        <AnimatePresence>
          {activeTrack && effectiveDrawerCatalogOpen && (
            <motion.div
              key="catalog-drawer-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={TRANSITION_FAST}
              onClick={() => setCatalogOpen(false)}
              className="absolute inset-0 z-20 bg-black/25 backdrop-blur-[1px]"
              aria-hidden="true"
            />
          )}
        </AnimatePresence>

        {/* LEFT PANE: Course Catalog (Docked on wide desktop, Slide-Over Drawer on <1280px laptop) */}
        <AnimatePresence initial={false}>
          {activeTrack && (effectiveDockedCatalogOpen || effectiveDrawerCatalogOpen) && (
            <motion.aside
              key={effectiveDrawerCatalogOpen ? "catalog-drawer" : "catalog-docked"}
              aria-label="课程目录"
              initial={effectiveDrawerCatalogOpen ? { x: -252, opacity: 0.6 } : false}
              animate={{ x: 0, opacity: 1 }}
              exit={effectiveDrawerCatalogOpen ? { x: -252, opacity: 0 } : undefined}
              transition={SPRING_PANEL}
              className={
                "flex w-[252px] shrink-0 flex-col border-r border-[var(--ve-border)] bg-[var(--surface-1)] " +
                (effectiveDrawerCatalogOpen
                  ? "absolute inset-y-0 left-0 z-30 shadow-2xl"
                  : "")
              }
            >
            <div className="flex items-center justify-between border-b border-[var(--ve-border)] px-3.5 py-2.5">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-[var(--ve-ink)]">
                  课程目录
                </span>
                <span className="rounded bg-[var(--ve-surface-alt)] px-1.5 py-0.2 font-mono text-[10px] text-[var(--ve-muted)]">
                  {catalogChapters.length}章
                </span>
              </div>
              <span className="font-mono text-[11px] text-[var(--ve-muted)]">
                {
                  activeTrack.units.filter((u) => (s.mastery[u.id] ?? 0) >= 80)
                    .length
                }
                /{activeTrack.units.length}
              </span>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {catalogChapters.map((chapter) => {
                const isCollapsed = Boolean(
                  collapsedChapters[chapter.stageTitle],
                );
                const chapterMastered = chapter.units.filter(
                  (u) => (s.mastery[u.id] ?? 0) >= 80,
                ).length;
                const hasSelectedUnit = chapter.units.some(
                  (u) => u.id === currentLesson?.id,
                );

                return (
                  <div
                    key={chapter.stageTitle}
                    className={
                      "rounded-xl border transition " +
                      (hasSelectedUnit
                        ? "border-[var(--ve-border)] bg-[var(--ve-surface)]/80"
                        : "border-transparent bg-[var(--ve-surface)]/55")
                    }
                  >
                    {/* 大章节 Header */}
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsedChapters((prev) => ({
                          ...prev,
                          [chapter.stageTitle]: !prev[chapter.stageTitle],
                        }))
                      }
                      className="flex w-full items-center justify-between gap-1.5 px-2.5 py-2 text-left"
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        {isCollapsed ? (
                          <ChevronRight
                            size={13}
                            className="shrink-0 text-[var(--ve-muted)]"
                          />
                        ) : (
                          <ChevronDown
                            size={13}
                            className="shrink-0 text-[var(--ve-muted)]"
                          />
                        )}
                        <span
                          className="truncate text-[11.5px] font-semibold text-[var(--ve-ink)]"
                          title={chapter.stageTitle}
                        >
                          {chapter.stageTitle}
                        </span>
                      </div>
                      <span className="shrink-0 font-mono text-[10px] text-[var(--ve-muted)]">
                        {chapterMastered}/{chapter.units.length}
                      </span>
                    </button>

                    {/* 小章节 & 课时 Tree */}
                    {!isCollapsed && (
                      <div className="space-y-1.5 px-1.5 pb-2">
                        {chapter.sections.map((sec) => (
                          <div key={sec.globalSectionCode} className="space-y-0.5">
                            <div
                              className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-[10.5px] font-medium text-[var(--ve-muted)]"
                              title={sec.sectionTitle}
                            >
                              <span className="shrink-0 rounded bg-[var(--ve-accent-soft)] px-1 py-0.2 font-mono text-[9.5px] font-semibold text-[var(--ve-accent)]">
                                {sec.globalSectionCode}
                              </span>
                              <span className="truncate">{sec.sectionTitle}</span>
                            </div>

                            <div className="ml-2 space-y-0.5 border-l border-[var(--ve-border)] pl-1.5">
                              {sec.units.map((u) => {
                                const m = s.mastery[u.id] ?? 0;
                                const mastered = m >= 80;
                                const unlocked = available(s, u);
                                const isSelected = currentLesson?.id === u.id;

                                return (
                                  <button
                                    key={u.id}
                                    type="button"
                                    onClick={() => selectLesson(u)}
                                    className={
                                      "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition " +
                                      (isSelected
                                        ? "bg-[var(--ve-surface)] font-semibold text-[var(--ve-ink)] ring-1 ring-[var(--ve-accent)]/35 shadow-2xs"
                                        : unlocked
                                          ? "font-normal text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
                                          : "font-normal text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]/70")
                                    }
                                  >
                                    <span className="shrink-0">
                                      {mastered ? (
                                        <CheckCircle2
                                          size={13}
                                          className="text-[var(--ve-emerald)]"
                                        />
                                      ) : isSelected ? (
                                        <CircleDot
                                          size={13}
                                          className="text-[var(--ve-accent)]"
                                        />
                                      ) : unlocked ? (
                                        <CircleDot
                                          size={12}
                                          className="text-[var(--ve-muted)]"
                                        />
                                      ) : (
                                        <Lock
                                          size={12}
                                          className="text-[var(--ve-muted)]"
                                        />
                                      )}
                                    </span>
                                    <span
                                      className="min-w-0 flex-1 truncate"
                                      title={u.title}
                                    >
                                      {u.title}
                                    </span>
                                    {m > 0 && (
                                      <span
                                        className={
                                          "shrink-0 font-mono text-[10px] " +
                                          (mastered
                                            ? "font-medium text-[var(--ve-emerald)]"
                                            : "text-[var(--ve-muted)]")
                                        }
                                      >
                                        {m}%
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="border-t border-[var(--ve-border)] p-2.5">
              <button
                type="button"
                onClick={() => {
                  if (currentLesson) setFocusedLessonId(currentLesson.id);
                  setWorkspaceTab("graph");
                }}
                className="flex w-full items-center justify-between rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3 py-1.5 text-xs font-medium text-[var(--ve-muted)] transition hover:border-[var(--ve-line)] hover:text-[var(--ve-ink)]"
              >
                <span className="inline-flex items-center gap-1.5">
                  <GitFork size={13} /> 先修关系
                </span>
                <ArrowRight size={12} />
              </button>
            </div>
          </motion.aside>
        )}
        </AnimatePresence>

        {/* CENTER PANE: Structured Lesson Workbench */}
        <section
          ref={mainScrollRef}
          onScroll={(e) => {
            if (!currentLesson?.id) return;
            const top = e.currentTarget.scrollTop;
            scrollMapRef.current[currentLesson.id] = top;
            try {
              sessionStorage.setItem(
                "xushi.learn-scroll.v1",
                JSON.stringify(scrollMapRef.current),
              );
            } catch {}
          }}
          className="flex min-w-[320px] flex-1 flex-col overflow-y-auto bg-[var(--ve-surface)]"
        >
          {!activeTrack || !currentLesson ? (
            <div className="mx-auto flex max-w-lg flex-1 flex-col items-center justify-center p-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] text-[var(--ve-accent)]">
                <BookOpen size={22} />
              </div>
              <h2 className="mt-4 text-base font-bold text-[var(--ve-ink)]">
                还没有正在学习的课程轨道
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-[var(--ve-muted)]">
                在右侧学习助手中输入你想学习的主题，或在今日工作台建立第一个可执行目标，系统会自动生成带先修顺序的结构化课程目录与互动练习。
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setWorkspaceTab("today")}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ve-accent-solid)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
                >
                  去今日工作台建立目标 <ArrowRight size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTutorOpen(true);
                    askCopilot(
                      "我想从零系统学习 AI Agent 开发（Tool Calling 与 ReAct），请先了解我的基础并帮我规划可执行课程轨道。",
                    );
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--ve-border)] bg-[var(--ve-surface)] px-4 py-2 text-xs font-medium text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
                >
                  <Sparkles size={13} className="text-[var(--ve-accent)]" /> 试试「AI Agent
                  开发」
                </button>
              </div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[720px] space-y-6 px-6 py-6 sm:px-8">
              {/* Lesson Meta + 4-Mode Switcher */}
              <div className="space-y-3 border-b border-[var(--ve-border)] pb-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-[var(--ve-muted)]">
                    <span>预计 {currentLesson.minutes} min</span>
                    <span
                      className={
                        mastery >= 80
                          ? "font-medium text-[var(--ve-emerald)]"
                          : mastery > 0
                            ? "font-medium text-[var(--ve-accent)]"
                            : "text-[var(--ve-muted)]"
                      }
                    >
                      已验证掌握 {mastery}%
                    </span>
                  </div>

                  {/* 4-Mode Segmented Control with Motion shared pill */}
                  <div className="inline-flex rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface-alt)] p-0.5">
                    {(
                      [
                        { id: "learn", label: "讲解", icon: BookOpen },
                        { id: "practice", label: "练习", icon: Code2 },
                        { id: "assess", label: "测验", icon: ClipboardCheck },
                        { id: "review", label: "复习", icon: RotateCcw },
                      ] as const
                    ).map((tab) => {
                      const active = mode === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setMode(tab.id)}
                          className={
                            "relative inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs transition " +
                            (active
                              ? "font-semibold text-[var(--ve-ink)]"
                              : "text-[var(--ve-muted)] hover:text-[var(--ve-ink)]")
                          }
                        >
                          {active && (
                            <motion.span
                              layoutId="learn-mode-pill"
                              transition={SPRING_CRISP}
                              className="absolute inset-0 rounded-md bg-[var(--ve-surface)] shadow-2xs"
                            />
                          )}
                          <span className="relative z-10 inline-flex items-center gap-1.5">
                            <tab.icon
                              size={13}
                              aria-hidden="true"
                              className={active ? "text-[var(--ve-accent)]" : ""}
                            />
                            <span>{tab.label}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  {currentChapterBreadcrumb && (
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-[var(--ve-muted)]">
                      <span className="rounded bg-[var(--ve-surface-alt)] px-1.5 py-0.5 text-[var(--ve-ink)]">
                        {currentChapterBreadcrumb.chapterTitle}
                      </span>
                      <span className="text-[var(--ve-muted)]">/</span>
                      <span className="rounded bg-[var(--ve-accent-soft)] px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-[var(--ve-accent)]">
                        {currentChapterBreadcrumb.sectionCode}{" "}
                        {currentChapterBreadcrumb.sectionTitle}
                      </span>
                    </div>
                  )}
                  <h1 className="text-[20px] font-semibold tracking-tight text-[var(--ink)]">
                    {currentLesson.title}
                  </h1>
                  {(currentLesson.objective || currentLesson.completionCriteria) ? (
                    <div className="mt-2.5 grid gap-2 rounded-xl bg-[var(--surface-1)] p-3 text-[12px] sm:grid-cols-2">
                      {currentLesson.objective && (
                        <div>
                          <div className="text-[10.5px] font-medium text-[var(--muted)]">
                            学习目标
                          </div>
                          <p className="mt-0.5 text-[var(--ink)]">
                            {currentLesson.objective}
                          </p>
                        </div>
                      )}
                      {currentLesson.completionCriteria && (
                        <div>
                          <div className="text-[10.5px] font-medium text-[var(--muted)]">
                            完成条件
                          </div>
                          <p className="mt-0.5 text-[var(--ink)]">
                            {currentLesson.completionCriteria}
                          </p>
                        </div>
                      )}
                    </div>
                  ) : (
                    currentLesson.subtitle && (
                      <p className="mt-1 text-[13px] text-[var(--muted)]">
                        {currentLesson.subtitle}
                      </p>
                    )
                  )}
                </div>

                {/* Locked Warning if prerequisites unmet */}
                {!isUnlocked && missingPrereqs.length > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] px-3.5 py-2.5 text-xs text-[var(--ve-amber)]">
                    <span>
                      先修未完成：
                      {missingPrereqs.map((m) => `「${m.title}」`).join("、")}
                    </span>
                    <button
                      type="button"
                      onClick={() => selectLesson(missingPrereqs[0])}
                      className="rounded-md bg-[#92400e] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#78350f]"
                    >
                      先学「{missingPrereqs[0].title}」
                    </button>
                  </div>
                )}
              </div>

              {/* MODE 1: LEARN */}
              {mode === "learn" && (
                <div className="space-y-5">
                  {/* Show preparation status/trigger ONLY when loading or not yet prepared */}
                  {(prepLoading || !lessonPrep) && (
                    <div className="rounded-xl bg-[var(--surface-1)] p-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-xs">
                          {prepLoading ? (
                            <>
                              <Loader2
                                size={13}
                                className="animate-spin text-[var(--blue)]"
                              />
                              <span className="font-medium text-[var(--ink)]">
                                {prepPhaseText || "正在准备本课深度教程…"}
                              </span>
                            </>
                          ) : (
                            <>
                              <Globe size={13} className="text-[var(--blue)]" />
                              <span className="text-[var(--ink)]">
                                本课尚未生成深度教程（生成后自动缓存）
                              </span>
                            </>
                          )}
                        </div>

                        {!prepLoading && !lessonPrep && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => void triggerDeepPrepare("auto_web")}
                              className="inline-flex items-center gap-1 rounded-md bg-[var(--ve-accent-solid)] px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90"
                            >
                              <Sparkles size={11} /> 生成深度教程
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void triggerDeepPrepare("quick_draft")
                              }
                              className="rounded-md bg-[var(--surface-2)] px-2.5 py-1 text-[11px] text-[var(--muted)] hover:text-[var(--ink)]"
                            >
                              快速开始
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setShowPrepMaterialBox((v) => !v)
                              }
                              className="rounded-md bg-[var(--surface-2)] px-2.5 py-1 text-[11px] text-[var(--muted)] hover:text-[var(--ink)]"
                            >
                              + 参考资料
                            </button>
                          </div>
                        )}
                      </div>

                      {!prepLoading && showPrepMaterialBox && (
                        <div className="mt-3 space-y-2 rounded-lg bg-[var(--surface-2)] p-3 text-xs">
                          <input
                            type="text"
                            value={prepMaterialUrl}
                            onChange={(e) => setPrepMaterialUrl(e.target.value)}
                            placeholder="参考网页 URL（多个用空格分隔，可选）"
                            className="w-full rounded-md bg-[var(--surface-1)] px-2.5 py-1.5 text-xs text-[var(--ink)]"
                          />
                          <textarea
                            rows={2}
                            value={prepMaterialNotes}
                            onChange={(e) =>
                              setPrepMaterialNotes(e.target.value)
                            }
                            placeholder="或粘贴教材/笔记片段（可选）…"
                            className="w-full resize-none rounded-md bg-[var(--surface-1)] px-2.5 py-1.5 text-xs text-[var(--ink)]"
                          />
                          <div className="flex justify-end">
                            <button
                              type="button"
                              disabled={
                                !prepMaterialUrl.trim() &&
                                !prepMaterialNotes.trim()
                              }
                              onClick={() =>
                                void triggerDeepPrepare("user_materials", true)
                              }
                              className="rounded-md bg-[var(--ve-accent-solid)] px-3 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-45"
                            >
                              基于指定资料生成教程
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Prepared Deep Tutorial — Single-flow textbook layout with ZERO duplicate sections */}
                  {lessonPrep ? (
                    <div className="space-y-5">
                      {lessonPrep.fallbackNotice && (
                        <div className="rounded-lg bg-[var(--ve-amber-soft)] px-3.5 py-2 text-xs text-[var(--ve-amber)] dark:text-amber-200">
                          {lessonPrep.fallbackNotice}
                        </div>
                      )}

                      {lessonPrep.tutorial.environmentOrContextSetup && (
                        <div className="tonal-well rounded-xl px-4 py-3 text-[13px] leading-6 text-[var(--ink)]">
                          <span className="mr-2 text-[11px] font-semibold text-[var(--muted)]">
                            课前准备
                          </span>
                          {lessonPrep.tutorial.environmentOrContextSetup}
                        </div>
                      )}

                      {/* Everyday Analogy Callout */}
                      <div className="rounded-xl bg-[var(--surface-1)] px-4 py-3.5">
                        <div className="text-[11px] font-medium text-[var(--blue)]">
                          直觉类比
                        </div>
                        <p className="mt-1 text-[13.5px] leading-6 text-[var(--ink)]">
                          {lessonPrep.brief.everydayAnalogy}
                        </p>
                      </div>

                      {/* Core Walkthrough Markdown */}
                      <div className="max-w-[68ch]">
                        <RichMarkdown
                          content={lessonPrep.tutorial.coreWalkthroughMarkdown}
                        />
                      </div>

                      {/* Progressive Examples */}
                      {lessonPrep.brief.progressiveExamples.length > 0 && (
                        <div className="space-y-3">
                          <div className="text-xs font-semibold text-[var(--ink)]">
                            循序渐进示例
                          </div>
                          {lessonPrep.brief.progressiveExamples.map((ex, i) => (
                            <div
                              key={i}
                              className="tonal-well rounded-xl p-4 space-y-2.5"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                <div className="flex items-center gap-2">
                                  <span className="rounded bg-[var(--surface-2)] px-2 py-0.5 font-mono text-[10.5px] font-medium text-[var(--blue)]">
                                    {ex.stage}
                                  </span>
                                  <span className="font-medium text-[var(--ink)]">
                                    {ex.title}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setTutorOpen(true);
                                    askCopilot(
                                      `请逐行拆解「${currentLesson.title}」中「${ex.stage} · ${ex.title}」的示例，并说明关键边界。`,
                                    );
                                  }}
                                  className="text-[11px] font-medium text-[var(--blue)] hover:underline"
                                >
                                  请学习助手逐行讲解
                                </button>
                              </div>
                              <p className="text-[13px] leading-6 text-[var(--muted)]">
                                {ex.explanation}
                              </p>
                              <RichMarkdown
                                content={formatExampleAsMarkdown(
                                  ex.codeOrContent,
                                  activeTrack.title,
                                )}
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Jargon Glossary */}
                      {lessonPrep.brief.jargonGlossary.length > 0 && (
                        <div className="space-y-2">
                          <div className="text-xs font-semibold text-[var(--ink)]">
                            核心术语速查
                          </div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {lessonPrep.brief.jargonGlossary.map((g, i) => (
                              <div
                                key={i}
                                className="tonal-well rounded-lg p-3 text-xs"
                              >
                                <div className="font-semibold text-[var(--ink)]">
                                  {g.term}
                                </div>
                                <p className="mt-1 leading-5 text-[var(--muted)]">
                                  {g.plainExplanation}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Common Misconceptions */}
                      {lessonPrep.brief.commonMisconceptions.length > 0 && (
                        <div className="space-y-2">
                          <div className="text-xs font-semibold text-[var(--ink)]">
                            常见误区与纠偏
                          </div>
                          <div className="space-y-2">
                            {lessonPrep.brief.commonMisconceptions.map((m, i) => (
                              <div
                                key={i}
                                className="tonal-well rounded-lg p-3 text-xs space-y-1"
                              >
                                <div className="font-medium text-[var(--ve-rose)] dark:text-rose-300">
                                  误区：{m.misconception}
                                </div>
                                <div className="leading-5 text-[var(--ink)]">
                                  纠偏：{m.correction}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Hands-on Task CTA */}
                      <div className="tonal-well rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="text-xs font-semibold text-[var(--ink)]">
                            动手实践
                          </div>
                          <p className="text-[13px] leading-6 text-[var(--muted)]">
                            {lessonPrep.brief.handsOnTask}
                          </p>
                          {(lessonContract || currentLesson.contract)
                            ?.deferredTo?.[0] && (
                            <p className="pt-0.5 text-[11.5px] text-[var(--blue)]">
                              完成本节后，下一节将衔接《
                              {
                                (lessonContract || currentLesson.contract)!
                                  .deferredTo[0].targetLessonTitle
                              }
                              》
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setMode("practice")}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--ve-accent-solid)] px-3.5 py-2 text-xs font-medium text-white hover:opacity-90"
                        >
                          进入练习区 <ArrowRight size={12} />
                        </button>
                      </div>

                      {/* Collapsible Provenance, Cache Status & Refresh (Zero Reading Burden) */}
                      <details className="rounded-xl bg-[var(--surface-1)] px-3.5 py-2.5 text-xs">
                        <summary className="flex cursor-pointer select-none flex-wrap items-center justify-between gap-2 font-medium text-[var(--muted)] hover:text-[var(--ink)]">
                          <span>
                            研究依据与待核验标注（
                            {lessonPrep.effectiveMode === "auto_web"
                              ? "自动检索"
                              : lessonPrep.effectiveMode === "user_materials"
                                ? "参考资料"
                                : "快速生成"}
                            {lessonPrep.cacheHit ? " · 本地缓存" : ""} ·{" "}
                            {lessonPrep.sources.length} 条来源
                            {lessonPrep.brief.knowledgeGaps.length > 0
                              ? ` · ${lessonPrep.brief.knowledgeGaps.length} 项待核验`
                              : ""}
                            ）
                          </span>
                          <button
                            type="button"
                            disabled={prepLoading}
                            onClick={(e) => {
                              e.preventDefault();
                              void triggerDeepPrepare("auto_web", true);
                            }}
                            className="inline-flex items-center gap-1 rounded-md bg-[var(--surface-2)] px-2 py-0.5 text-[11px] text-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-50"
                          >
                            <RefreshCw size={10} /> 刷新研究
                          </button>
                        </summary>
                        <div className="mt-2.5 space-y-2.5">
                          {lessonPrep.brief.knowledgeGaps.length > 0 && (
                            <div className="rounded-lg bg-[var(--ve-amber-soft)] p-2.5 text-[11.5px] text-[var(--ve-amber)] dark:text-amber-200">
                              <div className="font-medium">待核验 / 信息缺口</div>
                              <ul className="mt-1 list-disc pl-4 space-y-0.5">
                                {lessonPrep.brief.knowledgeGaps.map((g, i) => (
                                  <li key={i}>{g}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {lessonPrep.sources.length > 0 ? (
                            <ul className="space-y-1.5">
                              {lessonPrep.sources.map((src, i) => (
                                <li
                                  key={i}
                                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-[var(--surface-2)] px-2.5 py-1.5"
                                >
                                  <a
                                    href={
                                      src.url.startsWith("http")
                                        ? src.url
                                        : undefined
                                    }
                                    target="_blank"
                                    rel="noreferrer"
                                    className="font-medium text-[var(--blue)] hover:underline truncate max-w-[420px]"
                                  >
                                    {src.title}
                                  </a>
                                  <span className="font-mono text-[10px] text-[var(--muted)]">
                                    {src.siteName || "来源"} · 检索于{" "}
                                    {src.retrievedAt.slice(0, 10)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-[var(--muted)]">
                              本次未引用外部网页来源（使用模型内生快速草案）。
                            </p>
                          )}
                        </div>
                      </details>
                    </div>
                  ) : (
                    <>
                      <div className="max-w-[66ch]">
                        <p className="text-[14.5px] leading-7 text-[var(--ink)]">
                          {currentLesson.concept}
                        </p>
                      </div>

                      {currentLesson.example && (
                        <div className="tonal-well rounded-xl p-4">
                          <div className="mb-2.5 flex items-center justify-between text-xs font-medium text-[var(--ink)]">
                            <span>代码示例</span>
                            <button
                              type="button"
                              onClick={() => {
                                setTutorOpen(true);
                                askCopilot(
                                  `请逐行拆解「${currentLesson.title}」的代码示例，并结合我的基础举一个贴近实战的例子。`,
                                );
                              }}
                              className="text-xs font-medium text-[var(--blue)] hover:underline"
                            >
                              请学习助手逐行讲解
                            </button>
                          </div>
                          <RichMarkdown
                            content={formatExampleAsMarkdown(
                              currentLesson.example,
                              activeTrack.title,
                            )}
                          />
                        </div>
                      )}
                    </>
                  )}

                  {/* Lesson-Scoped Visual Explanations (Level 1 Mermaid / Level 2 Purified SVG / Level 3 Controlled Widget + Step Reveal) */}
                  {lessonVisualExplanations.length > 0 && (
                    <div className="space-y-3">
                      {lessonVisualExplanations.slice(0, 3).map((vis) => (
                        <VisualExplanationCard key={vis.visualId} card={vis} />
                      ))}
                    </div>
                  )}

                  {/* Dynamically Injected Non-Visual Teaching Activities (from Hybrid Teaching Planner, persisted in SQLite) */}
                  {nonVisualInjectedActivities.length > 0 && (
                    <div className="space-y-2.5">
                      <div className="text-xs font-semibold text-[var(--ink)]">
                        动态教学活动（学习助手注入）
                      </div>
                      {nonVisualInjectedActivities.slice(0, 3).map((act) => {
                        const title = String(act.spec?.title || act.activityType);
                        const prompt = String(act.spec?.prompt || "");
                        const markdown = act.spec?.markdown
                          ? String(act.spec.markdown)
                          : "";
                        return (
                          <div
                            key={act.activityId}
                            className="tonal-well rounded-xl p-3.5 space-y-1.5 text-xs"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-[var(--ink)]">
                                {title}
                              </span>
                              <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
                                {act.activityType}
                              </span>
                            </div>
                            {prompt && (
                              <p className="text-[12.5px] leading-6 text-[var(--muted)]">
                                {prompt}
                              </p>
                            )}
                            {markdown && <RichMarkdown content={markdown} />}
                            {act.linkedExerciseId && (
                              <button
                                type="button"
                                onClick={() => setMode("practice")}
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--blue)] hover:underline"
                              >
                                去练习区完成该题 <ArrowRight size={11} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Prerequisites */}
                  {currentLesson.requires.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-[var(--ve-border)] pt-4 text-xs text-[var(--ve-muted)]">
                      <span>先修依赖</span>
                      {currentLesson.requires.map((reqId) => {
                        const req = getLessonById(s, reqId);
                        const met = (s.mastery[reqId] ?? 0) >= 80;
                        return (
                          <button
                            key={reqId}
                            type="button"
                            onClick={() => req && selectLesson(req)}
                            className={
                              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium " +
                              (met
                                ? "border-[var(--ve-emerald)]/35 bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]"
                                : "border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] text-[var(--ve-amber)]")
                            }
                          >
                            {met ? <Check size={10} /> : <Lock size={10} />}
                            {req?.title || reqId}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Primary Action Bar */}
                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setMode("practice")}
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--ve-accent-solid)] px-4 py-2 text-xs font-medium text-white transition hover:opacity-90"
                    >
                      开始练习
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("assess")}
                      className="rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3.5 py-2 text-xs font-medium text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
                    >
                      直接测验
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTutorOpen(true);
                        askCopilot(
                          `请使用 visual_explainer 为「${currentLesson.title}」（lessonId: ${currentLesson.id}）用图解释核心机制，并提供分步揭示（steps），严格遵守本节契约不剧透后续章节。`,
                        );
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ve-accent)]/35 bg-[var(--ve-accent-soft)] px-3.5 py-2 text-xs font-medium text-[var(--ve-accent)] hover:bg-[var(--ve-accent-soft)]"
                    >
                      <Sparkles size={12} /> 用图解释
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTutorOpen(true);
                        askCopilot(
                          `我正在学习「${currentLesson.title}」，请用类比帮我建立直觉理解，并给我一道互动练习题。`,
                        );
                      }}
                      className="rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3.5 py-2 text-xs font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]"
                    >
                      询问学习助手
                    </button>
                  </div>
                </div>
              )}

              {/* MODE 2: PRACTICE (Authoritative Single Exercise + Deterministic Assessment + Plan Draft Preview) */}
              {mode === "practice" && practiceSpec && (
                <div className="space-y-5">
                  {/* Single Canonical Interactive Exercise (SQLite-backed, deterministic grading, ZERO chat auto-send) */}
                  {canonicalExercise && canonicalCheckCard && (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-[var(--ve-ink)]">
                          本课唯一互动练习
                        </span>
                        <span className="font-mono text-[11px] text-[var(--ve-muted)]">
                          {canonicalExercise.exercise_id} · 本地确定性评分
                        </span>
                      </div>

                      {sessionExercises.length > 1 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-[var(--ve-muted)]">
                            切换历史题目：
                          </span>
                          {sessionExercises.map((ex, idx) => {
                            const active =
                              ex.exercise_id === canonicalExercise.exercise_id;
                            return (
                              <button
                                key={ex.exercise_id}
                                type="button"
                                onClick={() =>
                                  setSelectedExerciseId(ex.exercise_id)
                                }
                                className={
                                  "rounded-md border px-2 py-0.5 font-mono text-[11px] transition " +
                                  (active
                                    ? "border-[var(--ve-accent-solid)] bg-[var(--ve-accent-solid)] text-white"
                                    : "border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]")
                                }
                              >
                                #{sessionExercises.length - idx} {ex.mode} (
                                {ex.exercise_id.slice(0, 7)})
                              </button>
                            );
                          })}
                        </div>
                      )}

                      <InteractiveCheckCard
                        key={`${canonicalExercise.exercise_id}-${attemptNonce}`}
                        card={canonicalCheckCard}
                        disabled={submittingAttempt}
                        onSubmitAnswer={(
                          _answerText: string,
                          persistedState: PersistedCheckState,
                        ) => {
                          void submitCanonicalExercise(
                            canonicalExercise,
                            persistedState,
                          );
                        }}
                        onRequestModeSwitch={(_, prompt) => {
                          setTutorOpen(true);
                          askCopilot(prompt);
                        }}
                      />

                      {/* Objective Deterministic Grading Result Panel */}
                      {latestAttempt && (
                        <div
                          className={
                            "rounded-xl border p-4 text-xs " +
                            (latestAttempt.correct
                              ? "border-[var(--ve-emerald)]/35 bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]"
                              : "border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] text-[var(--ve-amber)]")
                          }
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-semibold">
                              {latestAttempt.correct
                                ? `评分通过（${latestAttempt.score} 分）`
                                : `需巩固（${latestAttempt.score} 分 · ${latestAttempt.error_type}）`}
                            </span>
                            <span className="font-mono text-[10.5px] opacity-80">
                              {latestAttempt.grader_version}
                              {lastLearnerUpdate
                                ? ` · BKT ${lastLearnerUpdate.before}% → ${lastLearnerUpdate.after}% · FSRS 下次复习 ${lastLearnerUpdate.nextReviewDay.slice(5)}`
                                : ""}
                            </span>
                          </div>

                          <p className="mt-2 leading-6 text-[var(--ve-ink)]">
                            {latestAttempt.feedback}
                          </p>

                          {/* Per-Position Factual Diff for order_steps / fill_blank */}
                          {latestAttempt.position_matches &&
                            latestAttempt.position_matches.length > 0 && (
                              <div className="mt-3 divide-y divide-[var(--ve-border)] overflow-hidden rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)]">
                                {latestAttempt.position_matches.map((pm) => (
                                  <div
                                    key={pm.index}
                                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11.5px]"
                                  >
                                    <div className="flex items-center gap-2">
                                      <span
                                        className={
                                          "inline-flex h-5 w-5 items-center justify-center rounded font-mono text-[10px] font-semibold " +
                                          (pm.matched
                                            ? "bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]"
                                            : "bg-[var(--ve-rose-soft)] text-[var(--ve-rose)]")
                                        }
                                      >
                                        {pm.index}
                                      </span>
                                      <span className="text-[var(--ve-ink)]">
                                        你的顺序：{pm.submitted}
                                      </span>
                                    </div>
                                    <span
                                      className={
                                        pm.matched
                                          ? "font-medium text-[var(--ve-emerald)]"
                                          : "font-medium text-[var(--ve-rose)]"
                                      }
                                    >
                                      {pm.matched
                                        ? "位置正确"
                                        : `应为：${pm.expected}`}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}

                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setLatestAttempt(null);
                                setAttemptNonce((n) => n + 1);
                              }}
                              className="rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3 py-1.5 text-xs font-medium text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
                            >
                              重新作答
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setTutorOpen(true);
                                askCopilot(
                                  `请基于系统刚记录的确定性评分结果（attemptId=${latestAttempt.attempt_id}，得分 ${latestAttempt.score} 分，errorType=${latestAttempt.error_type}）向我解释本次作答中的核心问题和原理，不要重新判分。`,
                                );
                              }}
                              className="rounded-md bg-[var(--ve-accent-solid)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                            >
                              请学习助手讲解本次错因
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Pending Remedial Plan Drafts (Preview Diff ONLY — calendar stays untouched until user confirms!) */}
                      {pendingDrafts.map((draft) => (
                        <div
                          key={draft.draft_id}
                          className="rounded-xl border border-[var(--ve-accent)]/35 bg-[var(--ve-accent-soft)] p-4 text-xs"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-semibold text-[var(--ve-ink)]">
                              补救排期草案（尚未改动当前日历）
                            </span>
                            <span className="font-mono text-[10.5px] text-[var(--ve-muted)]">
                              {draft.draft_id} · 影响 {draft.impact_count} 项
                            </span>
                          </div>
                          <p className="mt-1.5 leading-relaxed text-[var(--ve-ink)]">
                            {draft.summary}
                          </p>
                          <div className="mt-2.5 space-y-1 text-[11px] text-[var(--ve-muted)]">
                            {draft.diff.addedBlocks.map((b) => (
                              <div key={b.id} className="font-mono">
                                + 新增：{b.day.slice(5)} {time(b.start)}–
                                {time(b.start + b.minutes)} {b.title}
                              </div>
                            ))}
                            {draft.diff.movedBlocks.map((m) => (
                              <div key={m.blockId} className="font-mono">
                                ~ 顺延：{m.title}（{m.oldDay.slice(5)}{" "}
                                {time(m.oldStart)} → {m.newDay.slice(5)}{" "}
                                {time(m.newStart)}）
                              </div>
                            ))}
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                void handlePlanDraftAction(
                                  draft.draft_id,
                                  "apply",
                                )
                              }
                              className="rounded-md bg-[var(--ve-accent-solid)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                            >
                              确认应用排期草案
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void handlePlanDraftAction(
                                  draft.draft_id,
                                  "dismiss",
                                )
                              }
                              className="rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3 py-1.5 text-xs font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]"
                            >
                              暂不调整日历
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Built-in Dynamic Lesson Practice Workbench (CodeMirror 6 for code vs Prose Box for conceptual lessons) */}
                  <div className="rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--ve-ink)]">
                          <Wrench size={14} className="text-[var(--ve-accent)]" />{" "}
                          {activePracticeKind === "code"
                            ? "动手编程练习"
                            : "原理思考练习"}
                        </span>
                        <span className="rounded-full bg-[var(--ve-surface)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--ve-muted)] ring-1 ring-[var(--ve-border)]">
                          {practiceSpec.reason}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <div className="inline-flex rounded-full border border-[var(--ve-border)] bg-[var(--ve-surface)] p-0.5">
                          <button
                            type="button"
                            onClick={() => setPracticeKindOverride("code")}
                            className={
                              "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition " +
                              (activePracticeKind === "code"
                                ? "bg-[var(--ve-accent-solid)] text-white"
                                : "text-[var(--ve-muted)] hover:text-[var(--ve-ink)]")
                            }
                          >
                            <Code2 size={11} /> 代码框
                          </button>
                          <button
                            type="button"
                            onClick={() => setPracticeKindOverride("text")}
                            className={
                              "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition " +
                              (activePracticeKind === "text"
                                ? "bg-[var(--ve-accent-solid)] text-white"
                                : "text-[var(--ve-muted)] hover:text-[var(--ve-ink)]")
                            }
                          >
                            <FileText size={11} /> 文本框
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => setShowHint((v) => !v)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--ve-muted)] hover:text-[var(--ve-accent)]"
                        >
                          <Lightbulb size={12} />{" "}
                          {showHint ? "隐藏提示" : "思路提示"}
                        </button>
                      </div>
                    </div>

                    <p className="mt-2.5 text-sm leading-relaxed text-[var(--ve-ink)]">
                      {practiceSpec.prompt}
                    </p>

                    {showHint && (
                      <div className="mt-3 rounded-xl border border-[var(--ve-accent)]/35 bg-[var(--ve-surface)] px-3.5 py-2.5 text-xs text-[var(--ve-ink)]">
                        <strong className="text-[var(--ve-accent)]">提示：</strong>
                        {currentLesson.feedback || currentLesson.concept}
                      </div>
                    )}
                  </div>

                  {/* Dynamically chosen input component: CodeMirror 6 vs Prose Textarea */}
                  {activePracticeKind === "code" ? (
                    <CodeEditorBox
                      key={`cm-${currentLesson.id}-${practiceSpec.language}`}
                      value={practiceDraft}
                      onChange={(val) =>
                        setCheckDraft(practiceDraftKey, { text: val })
                      }
                      language={practiceSpec.language}
                      starterCode={practiceSpec.starterCode}
                      label="代码实现（切页自动保留）"
                      placeholder={practiceSpec.placeholder}
                      minHeight="210px"
                    />
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs text-[var(--ve-muted)]">
                        <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--ve-ink)]">
                          <FileText size={13} className="text-[var(--ve-accent)]" />
                          原理阐述与思考作答（切换页面自动保留）
                        </span>
                        <span className="font-mono text-[10.5px]">
                          {practiceDraft.length} 字
                        </span>
                      </div>
                      <textarea
                        value={practiceDraft}
                        onChange={(e) =>
                          setCheckDraft(practiceDraftKey, {
                            text: e.target.value,
                          })
                        }
                        rows={6}
                        placeholder={practiceSpec.placeholder}
                        className="w-full rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-4 text-[13.5px] leading-7 text-[var(--ve-ink)] outline-none transition focus:border-[var(--ve-accent)] focus:ring-2 focus:ring-[var(--ve-accent)]/20"
                      />
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setTutorOpen(true);
                        const formattedSubmission =
                          activePracticeKind === "code"
                            ? `\`\`\`${practiceSpec.language}\n${practiceDraft.trim() || "（尚未编写代码，请先给我一步步引导）"}\n\`\`\``
                            : practiceDraft.trim() ||
                              "（尚未填写，请先给我一步步引导）";
                        askCopilot(
                          `请批改我在「${currentLesson.title}」练习中的作答，指出亮点与潜在误区，并调用 record_learning_assessment 更新我的掌握度：\n\n${formattedSubmission}`,
                        );
                      }}
                      className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ve-accent-solid)] px-5 py-2.5 text-xs font-semibold text-white hover:opacity-90"
                    >
                      <Sparkles size={13} /> 提交给学习助手批改点评
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTutorOpen(true);
                        askCopilot(
                          `请针对「${currentLesson.title}」动态生成一道最适合本课的互动练习题（使用 present_interactive_check：若是编程课用 code 或 fill_blank，若是原理课用 order_steps 或 short_answer）。`,
                        );
                      }}
                      className="rounded-full border border-[var(--ve-border)] bg-[var(--ve-surface)] px-4 py-2.5 text-xs font-medium text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
                    >
                      动态生成互动题（填空 / 排序 / 实战）
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("assess")}
                      className="ml-auto inline-flex items-center gap-1 rounded-full border border-[var(--ve-accent)]/35 bg-[var(--ve-accent-soft)] px-4 py-2.5 text-xs font-semibold text-[var(--ve-accent)] hover:bg-[var(--ve-accent-soft)]"
                    >
                      去正式测验（Assess） <ArrowRight size={13} />
                    </button>
                  </div>
                </div>
              )}

              {/* MODE 3: ASSESS (Deterministic structured assessment -> BKT + FSRS) */}
              {mode === "assess" && (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--ve-ink)]">
                        <ClipboardCheck size={14} className="text-[var(--ve-accent)]" />{" "}
                        结构化掌握度测验
                      </span>
                      <span className="rounded-full bg-[var(--ve-surface-alt)] px-2.5 py-0.5 text-[10.5px] font-medium text-[var(--ve-muted)]">
                        提交后直接更新 BKT 与 FSRS
                      </span>
                    </div>

                    {missingPrereqs.length > 0 ? (
                      <div className="mt-4 space-y-3 rounded-xl border border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] p-4">
                        <p className="text-xs font-semibold text-[var(--ve-amber)]">
                          先修未完成：需先达标「{missingPrereqs.map((m) => m.title).join("」、「")}」（已验证掌握度 ≥ 80%）后方可进行本课正式测验。
                        </p>
                        <p className="text-[11.5px] leading-relaxed text-[var(--ve-amber)]/90">
                          为保持知识依赖图的可信度，未完成先修前不会写入本课「已验证掌握」状态。你可以先完成先修课，或将本课标记为「暂时跳过」。
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              selectLesson(missingPrereqs[0]);
                              setMode("learn");
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ve-accent-solid)] px-3.5 py-1.5 text-xs font-medium text-white hover:opacity-90"
                          >
                            前往先修课：{missingPrereqs[0].title} <ArrowRight size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => markLessonSkipped(currentLesson)}
                            className="inline-flex items-center gap-1 rounded-lg border border-[var(--ve-amber)]/45 bg-[var(--ve-surface)] px-3 py-1.5 text-xs font-medium text-[var(--ve-amber)] hover:bg-[var(--ve-amber-soft)]"
                          >
                            暂时跳过（不更新掌握度）
                          </button>
                        </div>
                      </div>
                    ) : currentLesson.choices.length === 0 ? (
                      <div className="mt-4 space-y-3 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-4">
                        <p className="text-xs leading-relaxed text-[var(--ve-ink)]">
                          本课尚未配置内置客观题。为区分「已验证掌握」与「自我报告」，只有完成客观题/结构化评测才会更新已验证 BKT 分数；你也可以先声明未验证掌握或暂时跳过。
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setTutorOpen(true);
                              askCopilot(
                                `请针对「${currentLesson.title}」给我出一道带标准答案的客观互动测验题（调用 present_interactive_check，包含 correctChoiceIndex 或 correctStepsOrder），我将在课堂中提交正式评分。`,
                              );
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ve-accent-solid)] px-3.5 py-2 text-xs font-medium text-white hover:opacity-90"
                          >
                            由学习助手出本课实战测验
                          </button>
                          <button
                            type="button"
                            onClick={() => declareSelfReportedMastery(currentLesson)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] px-3.5 py-2 text-xs font-medium text-[var(--ve-amber)] hover:bg-[var(--ve-amber-soft)]"
                          >
                            手动声明掌握（标注未验证）
                          </button>
                          <button
                            type="button"
                            onClick={() => markLessonSkipped(currentLesson)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3.5 py-2 text-xs font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]"
                          >
                            暂时跳过（不改掌握度）
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                    <p className="mt-3 text-sm font-semibold leading-relaxed text-[var(--ve-ink)]">
                      {currentLesson.question}
                    </p>

                    <div className="mt-4 space-y-2">
                      {currentLesson.choices.map((choice, idx) => {
                        const isSelected = selectedChoice === idx;
                        const isRightChoice = idx === currentLesson.answer;
                        let style =
                          "border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-ink)] hover:border-[var(--ve-accent)] hover:bg-[var(--ve-accent-soft)]";
                        if (assessSubmitted) {
                          if (isRightChoice) {
                            style =
                              "border-[var(--ve-emerald)]/45 bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)] font-semibold";
                          } else if (isSelected && !isRightChoice) {
                            style =
                              "border-[var(--ve-rose)]/45 bg-[var(--ve-rose-soft)] text-[var(--ve-rose)]";
                          } else {
                            style =
                              "border-[var(--ve-border)] bg-[var(--ve-canvas)] text-[var(--ve-muted)]";
                          }
                        } else if (isSelected) {
                          style =
                            "border-[var(--ve-accent)] bg-[var(--ve-accent-soft)] text-[var(--ve-accent)] font-semibold";
                        }

                        return (
                          <button
                            key={idx}
                            type="button"
                            disabled={Boolean(assessSubmitted)}
                            onClick={() => setSelectedChoice(idx)}
                            className={
                              "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left text-xs transition " +
                              style
                            }
                          >
                            <span
                              className={
                                "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] font-bold " +
                                (assessSubmitted && isRightChoice
                                  ? "border-[var(--ve-emerald)] bg-emerald-500 text-white"
                                  : isSelected
                                    ? "border-[var(--ve-accent)] bg-[var(--ve-accent-solid)] text-white"
                                    : "border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-muted)]")
                              }
                            >
                              {String.fromCharCode(65 + idx)}
                            </span>
                            <span className="flex-1 leading-relaxed">
                              {choice}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {!assessSubmitted ? (
                      <div className="mt-4 flex items-center justify-between gap-2">
                        <span className="text-[11px] text-[var(--ve-muted)]">
                          请选择最准确的一项提交评估
                        </span>
                        <button
                          type="button"
                          disabled={selectedChoice === null}
                          onClick={handleSubmitAssessment}
                          className="rounded-full bg-[var(--ve-accent-solid)] px-5 py-2 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          提交测验并更新掌握度
                        </button>
                      </div>
                    ) : (
                      <div className="mt-4 space-y-3">
                        <div
                          className={
                            "rounded-xl border p-3.5 text-xs leading-relaxed " +
                            (assessSubmitted.correct
                              ? "border-[var(--ve-emerald)]/35 bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]"
                              : "border-[var(--ve-rose)]/35 bg-[var(--ve-rose-soft)] text-[var(--ve-rose)]")
                          }
                        >
                          <div className="flex items-center justify-between font-bold">
                            <span>
                              {assessSubmitted.correct
                                ? "回答正确 · 掌握度已提升"
                                : assessSubmitted.hasPlanDraft
                                  ? "答错了 · 已记录薄弱点并生成待确认补救草案"
                                  : "答错了 · 已记录薄弱点（日历暂未自动修改）"}
                            </span>
                            <span className="font-mono">
                              {assessSubmitted.beforeMastery}% → {assessSubmitted.afterMastery}%
                            </span>
                          </div>
                          <p className="mt-1.5 opacity-90">
                            {assessSubmitted.feedback || currentLesson.feedback}
                          </p>
                        </div>

                        {!assessSubmitted.correct && pendingDrafts.length > 0 && (
                          <div className="rounded-xl border border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] p-3.5 text-xs">
                            <div className="font-semibold text-[var(--ve-amber)]">
                              待确认补救排期草案（确认后才写入日历）
                            </div>
                            <p className="mt-1 text-[var(--ve-amber)]">
                              {pendingDrafts[0].summary}
                            </p>
                            <div className="mt-2.5 flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  void handlePlanDraftAction(
                                    pendingDrafts[0].draft_id,
                                    "apply",
                                  )
                                }
                                className="rounded-lg bg-[var(--ve-accent-solid)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                              >
                                确认应用排期草案
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void handlePlanDraftAction(
                                    pendingDrafts[0].draft_id,
                                    "dismiss",
                                  )
                                }
                                className="rounded-lg border border-[var(--ve-amber)]/45 bg-[var(--ve-surface)] px-3 py-1.5 text-xs font-medium text-[var(--ve-amber)] hover:bg-[var(--ve-amber-soft)]"
                              >
                                暂不调整日历
                              </button>
                            </div>
                          </div>
                        )}

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedChoice(null);
                              setAssessSubmitted(null);
                            }}
                            className="rounded-full border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3.5 py-1.5 text-xs font-medium text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
                          >
                            重新作答
                          </button>
                          {!assessSubmitted.correct && (
                            <button
                              type="button"
                              onClick={() => {
                                setTutorOpen(true);
                                askCopilot(
                                  `我在「${currentLesson.title}」的测验中选错了（选了「${currentLesson.choices[assessSubmitted.chosenIndex]}」），请帮我剖析错因，并用一道变式题确认我真正理解。`,
                                );
                              }}
                              className="rounded-full border border-[var(--ve-accent)]/35 bg-[var(--ve-accent-soft)] px-3.5 py-1.5 text-xs font-semibold text-[var(--ve-accent)] hover:bg-[var(--ve-accent-soft)]"
                            >
                              让学习助手剖析错因
                            </button>
                          )}
                          {nextUnlockedLesson && (
                            <button
                              type="button"
                              onClick={() => {
                                selectLesson(nextUnlockedLesson);
                                setMode("learn");
                              }}
                              className="ml-auto inline-flex items-center gap-1 rounded-full bg-[var(--ve-accent-solid)] px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                            >
                              进入下一课：{nextUnlockedLesson.title}{" "}
                              <ArrowRight size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* MODE 4: REVIEW (FSRS Active Recall Card) */}
              {mode === "review" && recallCard && (
                <div className="space-y-3">
                  <ActiveRecallCard
                    key={currentLesson.id}
                    card={recallCard}
                    onRate={(lessonId, rating) =>
                      recordFSRSReview(lessonId, rating)
                    }
                  />
                  <div className="flex items-center justify-between text-xs text-[var(--ve-muted)]">
                    <span>
                      每次主动回忆评分都会实时更新本课的 FSRS 遗忘曲线与下次复习日期。
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setFocusedLessonId(currentLesson.id);
                        setWorkspaceTab("graph");
                      }}
                      className="shrink-0 font-medium text-[var(--ve-accent)] hover:underline"
                    >
                      查看遗忘曲线 →
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* RESIZE HANDLE */}
        {tutorOpen && (
          <div
            role="separator"
            aria-orientation="vertical"
            title="左右拖动调整学习助手宽度"
            onPointerDown={startResizeTutor}
            className={
              "group flex w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-[var(--ve-border)] transition-colors hover:bg-[var(--ve-accent)] " +
              (draggingSplit ? "!bg-[var(--ve-accent)]" : "")
            }
          >
            <span className="h-8 w-0.5 rounded-full bg-[var(--ve-line)] group-hover:bg-[var(--ve-surface)]" />
          </div>
        )}

        {/* RIGHT PANE: Contextual Learning Assistant */}
        {tutorOpen && (
          <aside
            aria-label="学习助手对话面板"
            style={{ width: `${effectiveTutorWidth}px` }}
            className="flex h-full shrink-0 flex-col bg-[var(--surface-1)]"
          >
            <Agent
              mode="dock"
              onOpenModelSettings={onOpenModelSettings}
              onCollapseDock={() => setTutorOpen(false)}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
