"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type AgentCard,
  type Block,
  type CalendarUpdatedCard,
  type DbInfo,
  type GoalPlan,
  type Lesson,
  type MasteryUpdateCard,
  type Memory,
  type MemoryCategory,
  type MemoryProposal,
  type MemorySavedCard,
  type RescheduleOption,
  type ScheduleSettings,
  type Store,
  available,
  buildDecisionTrace,
  categoryLabel,
  computeFSRSReviewUpdate,
  computeMasteryUpdate,
  findSlot,
  free,
  getAllLessons,
  getLessonById,
  getTrackForLesson,
  initial,
  isMemoryExpired,
  lessons,
  migrateStore,
  offset,
  parseMemoryConstraint,
  parseMemoryExpiry,
  time,
} from "../lib/learning";
import {
  extractMemoryPreferences,
  getWakingBounds,
  isLockedBlock,
  isWithinSleep,
  postponeDependentBlocks,
  recalibrateForOvertime,
  scheduleDueReviews,
  validateRescheduleOption,
} from "../lib/scheduler";
import type { FSRSRating } from "../lib/bkt-fsrs";
import {
  type ClientModelConfig,
  isClientConfigActive,
  readClientModelConfig,
  readClientModelConfigAsync,
  saveClientModelConfigSecure,
} from "../lib/model-config";
import {
  type LLMTaskStatusSummary,
  getClientTaskManager,
} from "../lib/llm-task-manager";
import type { ChatThreadMeta } from "../lib/db";

const STORAGE_KEY = "xushi.learning-os.v2";
const CHECK_DRAFTS_KEY = "xushi.check-drafts.v1";
const CHAT_DRAFT_KEY = "xushi.chat-draft.v1";
const ACTIVE_THREAD_KEY = "xushi.active-thread.v1";

export type CheckDraft = {
  text?: string;
  choiceIndex?: number;
  choiceIndices?: number[];
  blanks?: Record<string, string>;
  order?: string[];
};

export type WorkspaceTab =
  | "today"
  | "study"
  | "calendar"
  | "graph"
  | "conversations"
  | "audit"
  | "memory";

export type ScheduleChangeHighlight = {
  trigger: string;
  summary: string;
  addedIds: string[];
  movedMap: Record<
    string,
    {
      title: string;
      oldDay: string;
      oldStart: number;
      oldMinutes: number;
      newDay: string;
      newStart: number;
    }
  >;
  timestamp: number;
};

export type AttachedContext =
  | { type: "lesson"; lessonId: string; title: string; mastery: number }
  | {
      type: "block";
      blockId: string;
      title: string;
      day: string;
      start: number;
      minutes: number;
    };

export type CopilotTrigger = {
  prompt: string;
  targetBlockId?: string;
  nonce: number;
};

type LearningStoreValue = {
  now: string;
  live: boolean;
  activeModelName: string | null;
  modelConfig: ClientModelConfig;
  setModelConfig: (cfg: ClientModelConfig) => void;
  dbInfo: DbInfo | null;
  s: Store;
  loaded: boolean;
  day: string;
  setDay: (day: string) => void;
  workspaceTab: WorkspaceTab;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  focusedLessonId: string | null;
  setFocusedLessonId: (id: string | null) => void;
  learnModeRequest: {
    mode: "learn" | "practice" | "assess" | "review";
    exerciseId?: string;
    nonce: number;
  } | null;
  clearLearnModeRequest: () => void;
  openLessonInLearn: (
    lessonId: string,
    opts?: {
      trackId?: string;
      mode?: "learn" | "practice" | "assess" | "review";
      exerciseId?: string;
      returnTrackId?: string;
    },
  ) => void;
  syncStoreFromServer: (nextStore: Store, nextDbInfo?: DbInfo | null) => void;
  recentScheduleHighlight: ScheduleChangeHighlight | null;
  clearScheduleHighlight: () => void;
  moveBlockToSlot: (
    blockId: string,
    newDay: string,
    newStart: number,
  ) => { ok: boolean; reason?: string };
  attachedContext: AttachedContext | null;
  attachContext: (ctx: AttachedContext | null) => void;
  checkDrafts: Record<string, CheckDraft>;
  setCheckDraft: (checkId: string, draft: CheckDraft) => void;
  clearCheckDraft: (checkId: string) => void;
  chatDraft: string;
  setChatDraft: (val: string) => void;
  calendarViewMode: "day" | "week";
  setCalendarViewMode: (mode: "day" | "week") => void;
  llmTaskStatus: LLMTaskStatusSummary;
  cancelActiveLlmTask: (taskIdOrThreadId?: string) => void;
  activeThreadId: string;
  threads: ChatThreadMeta[];
  setActiveThreadId: (threadId: string) => void;
  refreshThreads: () => Promise<void>;
  createNewThread: (opts?: {
    title?: string;
    trackId?: string;
    lessonId?: string;
  }) => Promise<string>;
  switchToTrackThread: (trackId: string, trackTitle: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  archiveThread: (threadId: string) => Promise<void>;
  restoreThread: (threadId: string) => Promise<void>;
  compactThread: (threadId: string) => Promise<void>;
  setActiveTrackId: (trackId: string) => void;
  copilotOpen: boolean;
  setCopilotOpen: (open: boolean) => void;
  copilotTrigger: CopilotTrigger | null;
  clearCopilotTrigger: () => void;
  askCopilot: (prompt: string, targetBlockId?: string) => void;
  previewOption: RescheduleOption | null;
  setPreviewOption: (opt: RescheduleOption | null) => void;
  toast: string;
  showToast: (msg: string) => void;
  savePlan: (plan: GoalPlan) => void;
  removePlan: (planId: string) => void;
  archiveTrack: (planId: string) => Promise<boolean>;
  restoreTrack: (planId: string) => Promise<boolean>;
  permanentDeleteTrack: (planId: string) => Promise<boolean>;
  adjustTrackScope: (opts: {
    trackId: string;
    depth?: "crash" | "standard" | "deep";
    scopeNote?: string;
    days?: number;
    dailyMinutes?: number;
    removeLessonIds?: string[];
    appendUnits?: Array<{
      chapterTitle?: string;
      sectionTitle?: string;
      title: string;
      concept: string;
      objective?: string;
      completionCriteria?: string;
      minutes?: number;
      requires?: string[];
    }>;
  }) => Promise<boolean>;
  recordFeedback: (
    lesson: Lesson,
    ok: boolean,
    attempt: string,
    kind?: "quiz" | "lab" | "diagnostic",
  ) => void;
  commitAgentAssessment: (card: MasteryUpdateCard) => void;
  applyCalendarAction: (card: CalendarUpdatedCard) => void;
  skipAsMastered: (lesson: Lesson) => void;
  markLessonSkipped: (lesson: Lesson) => void;
  declareSelfReportedMastery: (lesson: Lesson) => void;
  autoScheduleDueReviews: () => number;
  handleMissedSession: (
    blockId: string,
    action: "reschedule" | "shrink15" | "drop",
  ) => void;
  completeSessionTiming: (
    lesson: Lesson,
    plannedMinutes: number,
    actualMinutes: number,
    interruptions: number,
    energy: "high" | "medium" | "low",
  ) => void;
  applyFeasibilityFix: (
    fixId: "extend_deadline" | "protect_reviews_only" | "compress_micro",
  ) => void;
  updateScheduleSettings: (settings: ScheduleSettings) => void;
  recordFSRSReview: (
    lessonId: string,
    rating: FSRSRating,
  ) => {
    after: number;
    nextReviewDay: string;
    nextIntervalDays: number;
  } | null;
  applyRescheduleOption: (opt: RescheduleOption) => boolean;
  saveStoreState: (next: Store, focusDay?: string, toastMsg?: string) => void;
  deleteBlock: (blockId: string) => void;
  toggleBlockDone: (blockId: string) => void;
  addMemory: (
    category: MemoryCategory,
    text: string,
    label?: string,
    expiresAt?: string,
  ) => void;
  updateMemory: (
    id: string,
    text: string,
    category?: MemoryCategory,
    expiresAt?: string,
  ) => void;
  deleteMemory: (id: string) => void;
  purgeExpiredMemories: () => void;
  applyMemoryProposal: (proposal: MemoryProposal, editedText?: string) => void;
  commitAutoMemory: (card: MemorySavedCard) => void;
  resetDemo: () => void;
};

const LearningStoreContext = createContext<LearningStoreValue | null>(null);

export function LearningStoreProvider({
  now,
  live,
  serverModelName,
  children,
}: {
  now: string;
  live: boolean;
  serverModelName?: string;
  children: React.ReactNode;
}) {
  const [s, setS] = useState<Store>(() => initial(now));
  const [loaded, setLoaded] = useState(false);
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [modelConfig, setModelConfigState] = useState<ClientModelConfig>({
    provider: "auto",
  });
  const [day, setDay] = useState(now);
  const [workspaceTab, setWorkspaceTabState] = useState<WorkspaceTab>("today");
  const [focusedLessonId, setFocusedLessonIdState] = useState<string | null>(
    null,
  );

  // UX-20: Restore last active tab & focused lesson across browser reloads
  useEffect(() => {
    try {
      const hash = window.location.hash.replace(/^#/, "");
      const validTabs: WorkspaceTab[] = [
        "today",
        "study",
        "calendar",
        "graph",
        "conversations",
        "audit",
      ];
      const savedTab = sessionStorage.getItem(
        "xushi.workspace-tab.v1",
      ) as WorkspaceTab | null;
      const savedLesson = sessionStorage.getItem("xushi.focused-lesson.v1");
      if (validTabs.includes(hash as WorkspaceTab)) {
        setWorkspaceTabState(hash as WorkspaceTab);
      } else if (savedTab && validTabs.includes(savedTab)) {
        setWorkspaceTabState(savedTab);
      }
      if (savedLesson) {
        setFocusedLessonIdState(savedLesson);
      }
    } catch {}
  }, []);

  const setWorkspaceTab = useCallback((tab: WorkspaceTab) => {
    setWorkspaceTabState(tab);
    try {
      sessionStorage.setItem("xushi.workspace-tab.v1", tab);
    } catch {}
  }, []);

  const setFocusedLessonId = useCallback((id: string | null) => {
    setFocusedLessonIdState(id);
    try {
      if (id) sessionStorage.setItem("xushi.focused-lesson.v1", id);
      else sessionStorage.removeItem("xushi.focused-lesson.v1");
    } catch {}
  }, []);
  const [learnModeRequest, setLearnModeRequest] = useState<{
    mode: "learn" | "practice" | "assess" | "review";
    exerciseId?: string;
    nonce: number;
  } | null>(null);
  const clearLearnModeRequest = useCallback(() => setLearnModeRequest(null), []);
  const syncStoreFromServer = useCallback(
    (nextStore: Store, nextDbInfo?: DbInfo | null) => {
      if (nextStore.stateVersion !== undefined) {
        latestStateVersionRef.current = nextStore.stateVersion;
      }
      skipNextSaveRef.current = true;
      setS(nextStore);
      if (nextDbInfo) setDbInfo(nextDbInfo);
    },
    [],
  );
  const returnTrackAfterReviewRef = useRef<string | null>(null);
  const openLessonInLearn = useCallback(
    (
      lessonId: string,
      opts?: {
        trackId?: string;
        mode?: "learn" | "practice" | "assess" | "review";
        exerciseId?: string;
        returnTrackId?: string;
      },
    ) => {
      returnTrackAfterReviewRef.current = opts?.returnTrackId ?? null;
      if (opts?.trackId) {
        const tid = opts.trackId;
        setS((prev) => ({ ...prev, activeTrackId: tid }));
      }
      setFocusedLessonId(lessonId);
      setWorkspaceTab("study");
      if (opts?.mode || opts?.exerciseId) {
        setLearnModeRequest({
          mode: opts.mode || "learn",
          exerciseId: opts.exerciseId,
          nonce: Date.now(),
        });
      }
      // Also invoke canonical Lesson Session Controller on server (non-blocking, zero LLM call)
      void fetch("/api/learning/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonId,
          trackId: opts?.trackId,
          mode: opts?.mode || "learn",
          day: now,
        }),
      }).catch(() => {});
    },
    [now],
  );
  const [recentScheduleHighlight, setRecentScheduleHighlight] =
    useState<ScheduleChangeHighlight | null>(null);
  const [attachedContext, setAttachedContext] =
    useState<AttachedContext | null>(null);
  const [checkDrafts, setCheckDrafts] = useState<Record<string, CheckDraft>>(
    () => {
      if (typeof window === "undefined") return {};
      try {
        const raw = localStorage.getItem(CHECK_DRAFTS_KEY);
        return raw ? (JSON.parse(raw) as Record<string, CheckDraft>) : {};
      } catch {
        return {};
      }
    },
  );
  const [chatDraft, setChatDraftState] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try {
      return localStorage.getItem(CHAT_DRAFT_KEY) || "";
    } catch {
      return "";
    }
  });
  const [calendarViewMode, setCalendarViewMode] = useState<"day" | "week">(
    "day",
  );
  const [llmTaskStatus, setLlmTaskStatus] = useState<LLMTaskStatusSummary>(() =>
    getClientTaskManager().getStatus(),
  );
  const [activeThreadId, setActiveThreadIdState] = useState<string>(() => {
    if (typeof window === "undefined") return "agent-main";
    try {
      return localStorage.getItem(ACTIVE_THREAD_KEY) || "agent-main";
    } catch {
      return "agent-main";
    }
  });
  const [threads, setThreads] = useState<ChatThreadMeta[]>([]);
  const processedToolCallsRef = useRef<Set<string>>(new Set());
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotTrigger, setCopilotTrigger] = useState<CopilotTrigger | null>(
    null,
  );
  const [previewOption, setPreviewOption] = useState<RescheduleOption | null>(
    null,
  );
  const [toast, setToast] = useState("");
  const lastTriggerRef = useRef<{ trigger: string; summary?: string }>({
    trigger: "状态更新",
  });
  const skipNextSaveRef = useRef(true);
  const latestStateVersionRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    async function hydrateFromSqlite() {
      try {
        setModelConfigState(readClientModelConfig());
        void readClientModelConfigAsync().then((secureCfg) => {
          if (!cancelled) setModelConfigState(secureCfg);
        });
        const res = await fetch(`/api/state?day=${encodeURIComponent(now)}`, {
          cache: "no-store",
        });
        if (res.ok) {
          const data = (await res.json()) as {
            store: Store;
            dbInfo: DbInfo;
            stateVersion?: number;
          };
          const dbStore = data.store;
          latestStateVersionRef.current =
            data.stateVersion ?? dbStore.stateVersion ?? 0;
          const dbEmpty =
            !dbStore.blocks.length &&
            !dbStore.memories.length &&
            !(dbStore.goalPlans?.length);

          // One-time seamless migration if browser localStorage has user data while SQLite is fresh
          if (dbEmpty) {
            try {
              const rawLocal = localStorage.getItem(STORAGE_KEY);
              if (rawLocal) {
                const migrated = migrateStore(JSON.parse(rawLocal), now);
                const hasLocalData =
                  migrated &&
                  (migrated.blocks.length > 0 ||
                    migrated.memories.length > 0 ||
                    (migrated.goalPlans?.length ?? 0) > 0);
                if (hasLocalData && migrated && !cancelled) {
                  skipNextSaveRef.current = false;
                  lastTriggerRef.current = {
                    trigger: "迁移至本机 SQLite",
                    summary: "已将浏览器缓存数据自动迁移至本机 SQLite 数据库。",
                  };
                  setS(migrated);
                  setDbInfo(data.dbInfo);
                  setLoaded(true);
                  setToast("已将历史数据迁移至本机 SQLite（data/learnos.sqlite）。");
                  return;
                }
              }
            } catch {}
          }

          if (!cancelled) {
            skipNextSaveRef.current = true;
            setS(dbStore);
            setDbInfo(data.dbInfo);
            setLoaded(true);
            return;
          }
        }
      } catch (err) {
        console.error("[LearningStore] SQLite load failed:", err);
      }
      if (!cancelled) setLoaded(true);
    }
    void hydrateFromSqlite();
    return () => {
      cancelled = true;
    };
  }, [now]);

  const setModelConfig = useCallback((cfg: ClientModelConfig) => {
    setModelConfigState(cfg);
    void saveClientModelConfigSecure(cfg);
  }, []);

  const effectiveLive = live || isClientConfigActive(modelConfig);
  const activeModelName = isClientConfigActive(modelConfig)
    ? modelConfig.modelId!.trim()
    : serverModelName || null;

  useEffect(() => {
    if (!loaded) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    const { trigger, summary } = lastTriggerRef.current;
    const timer = setTimeout(() => {
      const expectedVersion = latestStateVersionRef.current;
      void fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          store: s,
          trigger,
          summary,
          expectedVersion,
        }),
      })
        .then(async (r) => {
          const data = (await r.json().catch(() => null)) as
            | {
                ok?: boolean;
                stateVersion?: number;
                dbInfo?: DbInfo;
                code?: string;
                error?: string;
              }
            | null;
          if (r.status === 409 && data?.code === "STATE_VERSION_CONFLICT") {
            setToast("检测到状态已被其他操作更新，已自动刷新为最新状态。");
            const freshRes = await fetch(
              `/api/state?day=${encodeURIComponent(now)}`,
              { cache: "no-store" },
            );
            if (freshRes.ok) {
              const fresh = (await freshRes.json()) as {
                store?: Store;
                dbInfo?: DbInfo;
                stateVersion?: number;
              };
              if (fresh.store) {
                latestStateVersionRef.current =
                  fresh.stateVersion ?? fresh.store.stateVersion;
                skipNextSaveRef.current = true;
                setS(fresh.store);
                if (fresh.dbInfo) setDbInfo(fresh.dbInfo);
              }
            }
            return;
          }
          if (!r.ok) {
            setToast(data?.error || "本机 SQLite 写入失败，请检查服务是否运行。");
            return;
          }
          if (data?.stateVersion !== undefined) {
            latestStateVersionRef.current = data.stateVersion;
          }
          if (data?.dbInfo) setDbInfo(data.dbInfo);
        })
        .catch(() => {
          setToast("本机 SQLite 写入失败，请检查服务是否运行。");
        });
    }, 120);
    return () => clearTimeout(timer);
  }, [s, loaded, now]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3800);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = useCallback((msg: string) => setToast(msg), []);

  const askCopilot = useCallback((prompt: string, targetBlockId?: string) => {
    setCopilotOpen(true);
    setCopilotTrigger({ prompt, targetBlockId, nonce: Date.now() });
  }, []);

  const clearCopilotTrigger = useCallback(() => setCopilotTrigger(null), []);

  const setActiveTrackId = useCallback(
    (trackId: string) => {
      setS((prev) => {
        const next: Store = { ...prev, activeTrackId: trackId };
        const trace = buildDecisionTrace(next, now, trackId);
        return { ...next, decisionTrace: trace, decision: trace.summary };
      });
    },
    [now],
  );

  const saveStoreState = useCallback(
    (next: Store, focusDay?: string, toastMsg?: string) => {
      lastTriggerRef.current = { trigger: "日程编辑", summary: toastMsg };
      const trace = buildDecisionTrace(next, now, next.activeTrackId);
      setS({ ...next, decisionTrace: trace });
      if (focusDay) setDay(focusDay);
      if (toastMsg) setToast(toastMsg);
    },
    [now],
  );

  const savePlan = useCallback(
    (plan: GoalPlan) => {
      lastTriggerRef.current = {
        trigger: "建轨排课",
        summary: `创建学习轨道「${plan.title}」并排入 ${plan.slots.length} 个日历时段`,
      };
      setS((prev) => {
        const prior = prev.goalPlans?.find((p) => p.id === plan.id);
        if (prior?.version === plan.version) return prev;
        const previousIds = new Set(prior?.slots.map((b) => b.id));
        const blocks = prev.blocks.filter(
          (b) => b.done || !previousIds.has(b.id),
        );
        const waking = getWakingBounds(prev.scheduleSettings);
        const addedBlocks: Block[] = [];
        for (const b of plan.slots) {
          if (blocks.some((x) => x.id === b.id)) continue;
          if (free(blocks, b.day, b.start, b.minutes)) {
            blocks.push(b);
            addedBlocks.push(b);
          } else {
            const alt = findSlot(
              blocks,
              b.day,
              Math.max(waking.wakeStart, b.start),
              b.minutes,
              undefined,
              waking.wakeEnd,
            );
            if (alt) {
              const shifted = { ...b, day: alt.day, start: alt.start };
              blocks.push(shifted);
              addedBlocks.push(shifted);
            }
          }
        }
        const effectivePlan: GoalPlan =
          addedBlocks.length > 0 ? { ...plan, slots: addedBlocks } : plan;
        const mastery = { ...prev.mastery };
        for (const u of effectivePlan.units) mastery[u.id] ??= 0;
        const next: Store = {
          ...prev,
          activeTrackId: effectivePlan.id,
          blocks,
          mastery,
          goalPlans: [
            ...(prev.goalPlans || []).filter((p) => p.id !== effectivePlan.id),
            effectivePlan,
          ],
          memories: prev.memories.some(
            (m) => m.category === "goal" && m.text.trim() === plan.goal.trim(),
          )
            ? prev.memories
            : [
                {
                  id: plan.id,
                  label: "学习目标",
                  category: "goal",
                  text: plan.goal,
                  createdAt: now,
                },
                ...prev.memories.filter(
                  (m) => m.id !== plan.id && m.category !== "goal",
                ),
              ],
        };
        const trace = buildDecisionTrace(next, now, plan.id);
        setDay(plan.slots[0]?.day || now);
        if (plan.slots.length > 0) {
          setRecentScheduleHighlight({
            trigger: "Agent 新建学习轨道",
            summary: `已为「${plan.title}」新增 ${plan.slots.length} 个无冲突学习时段`,
            addedIds: plan.slots.map((b) => b.id),
            movedMap: {},
            timestamp: Date.now(),
          });
        }
        setToast(`已创建「${plan.title}」并同步至知识地图与日历。`);
        return { ...next, decisionTrace: trace, decision: trace.summary };
      });
    },
    [now],
  );

  const archiveTrack = useCallback(
    async (planId: string): Promise<boolean> => {
      try {
        const res = await fetch("/api/tracks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "archive", trackId: planId, day: now }),
        });
        const data = (await res.json().catch(() => null)) as
          | {
              ok?: boolean;
              store?: Store;
              stateVersion?: number;
              pausedBlocks?: number;
              dbInfo?: DbInfo;
              error?: string;
            }
          | null;
        if (!res.ok || !data?.store) {
          setToast(data?.error || "归档轨道失败。");
          return false;
        }
        latestStateVersionRef.current =
          data.stateVersion ?? data.store.stateVersion;
        skipNextSaveRef.current = true;
        setS(data.store);
        if (data.dbInfo) setDbInfo(data.dbInfo);
        setToast(
          `已归档该轨道（保留全部学习历史，暂停 ${data.pausedBlocks ?? 0} 条未完成排期，可随时恢复）。`,
        );
        return true;
      } catch {
        setToast("归档轨道失败，请检查服务是否运行。");
        return false;
      }
    },
    [now],
  );

  const restoreTrack = useCallback(
    async (planId: string): Promise<boolean> => {
      try {
        const res = await fetch("/api/tracks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "restore", trackId: planId, day: now }),
        });
        const data = (await res.json().catch(() => null)) as
          | {
              ok?: boolean;
              store?: Store;
              stateVersion?: number;
              dbInfo?: DbInfo;
              error?: string;
            }
          | null;
        if (!res.ok || !data?.store) {
          setToast(data?.error || "恢复轨道失败。");
          return false;
        }
        latestStateVersionRef.current =
          data.stateVersion ?? data.store.stateVersion;
        skipNextSaveRef.current = true;
        setS(data.store);
        if (data.dbInfo) setDbInfo(data.dbInfo);
        setToast("已恢复归档轨道。");
        return true;
      } catch {
        setToast("恢复轨道失败，请检查服务是否运行。");
        return false;
      }
    },
    [now],
  );

  const permanentDeleteTrack = useCallback(
    async (planId: string): Promise<boolean> => {
      try {
        const res = await fetch("/api/tracks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "permanent_delete",
            trackId: planId,
            confirmTrackId: planId,
            day: now,
          }),
        });
        const data = (await res.json().catch(() => null)) as
          | {
              ok?: boolean;
              store?: Store;
              stateVersion?: number;
              dbInfo?: DbInfo;
              error?: string;
            }
          | null;
        if (!res.ok || !data?.store) {
          setToast(data?.error || "永久删除轨道失败。");
          return false;
        }
        latestStateVersionRef.current =
          data.stateVersion ?? data.store.stateVersion;
        skipNextSaveRef.current = true;
        setS(data.store);
        if (data.dbInfo) setDbInfo(data.dbInfo);
        setToast("已永久删除该轨道及其独占记录，其他轨道与无关记忆已保留。");
        return true;
      } catch {
        setToast("永久删除轨道失败，请检查服务是否运行。");
        return false;
      }
    },
    [now],
  );

  const removePlan = useCallback(
    (planId: string) => {
      void archiveTrack(planId);
    },
    [archiveTrack],
  );

  const adjustTrackScope = useCallback(
    async (opts: {
      trackId: string;
      depth?: "crash" | "standard" | "deep";
      scopeNote?: string;
      days?: number;
      dailyMinutes?: number;
      removeLessonIds?: string[];
      appendUnits?: Array<{
        title: string;
        concept: string;
        objective?: string;
        completionCriteria?: string;
        minutes?: number;
        requires?: string[];
      }>;
    }): Promise<boolean> => {
      try {
        const res = await fetch("/api/tracks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "adjust_scope",
            day: now,
            ...opts,
          }),
        });
        const data = (await res.json().catch(() => null)) as
          | {
              ok?: boolean;
              store?: Store;
              stateVersion?: number;
              dbInfo?: DbInfo;
              error?: string;
            }
          | null;
        if (!res.ok || !data?.store) {
          setToast(data?.error || "调整学习范围与深度失败。");
          return false;
        }
        latestStateVersionRef.current =
          data.stateVersion ?? data.store.stateVersion;
        skipNextSaveRef.current = true;
        setS(data.store);
        if (data.dbInfo) setDbInfo(data.dbInfo);
        setToast(data.store.decision || "已更新学习轨道的范围与深度。");
        return true;
      } catch {
        setToast("调整学习范围与深度失败，请检查服务是否运行。");
        return false;
      }
    },
    [now],
  );

  const recordFeedback = useCallback(
    (
      l: Lesson,
      ok: boolean,
      attempt: string,
      kind: "quiz" | "lab" | "diagnostic" = "quiz",
    ) => {
      lastTriggerRef.current = {
        trigger: ok ? "学习反馈达标" : "学习反馈补救",
        summary: `${l.title}（${ok ? "达标解锁" : "巩固/补救"}）`,
      };
      setS((prev) => {
        if (prev.memories.some((m) => m.id === attempt)) return prev;
        const calc = computeMasteryUpdate(prev, l, ok, now);
        const mastery = { ...prev.mastery, [l.id]: calc.after };
        const masteryMeta = { ...(prev.masteryMeta || {}), [l.id]: calc.meta };
        const attempts = [
          {
            id: attempt,
            lessonId: l.id,
            kind,
            correct: ok,
            attemptedAt: new Date().toISOString(),
          },
          ...(prev.attempts || []),
        ].slice(0, 100);

        const registered = prev.goalPlans?.find((p) =>
          p.units.some((u) => u.id === l.id),
        );
        const isKnown = Boolean(registered || lessons.some((u) => u.id === l.id));

        if (!isKnown) {
          setToast("已保存本次试学反馈。");
          return {
            ...prev,
            mastery,
            masteryMeta,
            attempts,
            memories: [
              {
                id: attempt,
                label: "学习记录",
                category: "record",
                text: `${now} · ${l.title}，${ok ? "答对" : "需要巩固"}（掌握度 ${calc.before}% → ${calc.after}%）。`,
                createdAt: now,
              },
              ...prev.memories,
            ],
          };
        }

        const existing = prev.blocks
          .filter((b) => b.day >= now && b.lesson === l.id && !b.done)
          .sort(
            (a, b) => a.day.localeCompare(b.day) || a.start - b.start,
          )[0];

        let blocks = prev.blocks.map((b) =>
          b.id === existing?.id ? { ...b, done: ok ? true : b.done } : b,
        );

        const track = getTrackForLesson(prev, l.id);

        let reason = ok
          ? `练习达标，已验证 BKT 掌握度由 ${calc.before}% 提升至 ${calc.after}%，FSRS 下次建议复习 ${calc.nextReviewDay.slice(5)}。`
          : `练习需巩固，已验证 BKT 掌握度记录为 ${calc.after}%（不自动改动未来日历，补救排期需由草案确认）。`;

        if (calc.unlocked.length) {
          reason += ` 已解锁：${calc.unlocked.map((u) => `「${u.title}」`).join("、")}。`;
        }

        const nextStore: Store = {
          ...prev,
          activeTrackId: track?.id || prev.activeTrackId,
          mastery,
          masteryMeta,
          attempts,
          blocks,
          decision: reason,
          memories: [
            {
              id: attempt,
              label: "学习记录",
              category: "record",
              text: `${now} · ${l.title}：${reason}`,
              createdAt: now,
            },
            ...prev.memories,
          ],
        };
        const trace = buildDecisionTrace(nextStore, now, track?.id);
        trace.summary = reason;
        setToast(
          ok
            ? `已验证达标（${calc.before}% → ${calc.after}%），知识路径已同步。`
            : "已记录本次作答与掌握度状态；如需补救排期请在草案中确认。",
        );
        return { ...nextStore, decisionTrace: trace };
      });
    },
    [now],
  );

  const skipAsMastered = useCallback(
    (l: Lesson) => {
      lastTriggerRef.current = {
        trigger: "跳过已掌握课程",
        summary: `跳过「${l.title}」并释放原定学习时段`,
      };
      setS((prev) => {
        const mastery = { ...prev.mastery, [l.id]: 95 };
        const nextReviewDay = offset(now, 7);
        const masteryMeta = {
          ...(prev.masteryMeta || {}),
          [l.id]: {
            pKnown: 0.95,
            stabilityDays: 7,
            difficulty: 2.5,
            lapses: 0,
            reps: 1,
            consecutiveFailures: 0,
            lastReviewDay: now,
            nextReviewDay,
            attempts: (prev.masteryMeta?.[l.id]?.attempts ?? 0) + 1,
            lastResult: true,
            updatedAt: now,
            masteryOrigin: "verified" as const,
          },
        };
        // Release uncompleted future learning blocks for this already-mastered lesson!
        const freedCount = prev.blocks.filter(
          (b) => !b.done && b.lesson === l.id && b.kind === "学习",
        ).length;
        const blocks = prev.blocks.filter(
          (b) => b.done || b.lesson !== l.id || b.kind !== "学习",
        );

        const track = getTrackForLesson(prev, l.id);
        const unlocked = (track?.units || []).filter(
          (u) =>
            u.id !== l.id &&
            !available(prev, u) &&
            available({ ...prev, mastery }, u),
        );

        const summary =
          `已将「${l.title}」标记为已掌握（95%）` +
          (unlocked.length
            ? `，解锁后续：${unlocked.map((u) => `「${u.title}」`).join("、")}`
            : "") +
          (freedCount ? `，并释放了 ${freedCount} 个原定日历学习块。` : "。");

        const next: Store = {
          ...prev,
          mastery,
          masteryMeta,
          blocks,
          decision: summary,
          memories: [
            {
              id: `skip-${l.id}-${Date.now()}`,
              label: "学习记录",
              category: "record",
              text: `${now} · ${summary}`,
              createdAt: now,
            },
            ...prev.memories,
          ],
        };
        const trace = buildDecisionTrace(next, now, track?.id);
        trace.summary = summary;
        return { ...next, decisionTrace: trace };
      });
      setToast(`已跳过「${l.title}」并解锁后续知识，释放了日历空档。`);
    },
    [now],
  );

  const markLessonSkipped = useCallback(
    (l: Lesson) => {
      lastTriggerRef.current = {
        trigger: "暂时跳过课程",
        summary: `暂时跳过「${l.title}」（保持原 BKT 掌握度不变）`,
      };
      setS((prev) => {
        const existing = prev.masteryMeta?.[l.id];
        const masteryMeta = {
          ...(prev.masteryMeta || {}),
          [l.id]: {
            stabilityDays: existing?.stabilityDays ?? 1,
            nextReviewDay: existing?.nextReviewDay ?? offset(now, 3),
            attempts: existing?.attempts ?? 0,
            ...existing,
            updatedAt: now,
            masteryOrigin: "skipped" as const,
          },
        };
        const next: Store = { ...prev, masteryMeta };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        setToast(`已暂时跳过「${l.title}」（未修改 BKT 掌握度，可随时回来学习）。`);
        return { ...next, decisionTrace: trace, decision: trace.summary };
      });
    },
    [now],
  );

  const declareSelfReportedMastery = useCallback(
    (l: Lesson) => {
      lastTriggerRef.current = {
        trigger: "自我报告掌握（未验证）",
        summary: `手动声明已掌握「${l.title}」，标注为未验证（保留原 BKT 掌握度）`,
      };
      setS((prev) => {
        const existing = prev.masteryMeta?.[l.id];
        const masteryMeta = {
          ...(prev.masteryMeta || {}),
          [l.id]: {
            stabilityDays: existing?.stabilityDays ?? 1,
            nextReviewDay: existing?.nextReviewDay ?? offset(now, 3),
            attempts: existing?.attempts ?? 0,
            ...existing,
            updatedAt: now,
            masteryOrigin: "self_reported" as const,
          },
        };
        const next: Store = { ...prev, masteryMeta };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        setToast(
          `已标注「${l.title}」为「自我报告掌握（未验证）」，不影响已验证 BKT 分数；完成快速诊断即可转为已验证掌握。`,
        );
        return { ...next, decisionTrace: trace, decision: trace.summary };
      });
    },
    [now],
  );

  const autoScheduleDueReviews = useCallback(() => {
    lastTriggerRef.current = { trigger: "到期复习排程", summary: "自动排入 FSRS 到期复习块" };
    let added = 0;
    setS((prev) => {
      const { newBlocks } = scheduleDueReviews(prev, now);
      added = newBlocks.length;
      if (!newBlocks.length) return prev;
      const blocks = [...prev.blocks, ...newBlocks];
      const summary = `已为 ${newBlocks.length} 项到期 FSRS 知识点自动安排 15 分钟碎片复习块。`;
      const next: Store = { ...prev, blocks, decision: summary };
      const trace = buildDecisionTrace(next, now, next.activeTrackId);
      trace.summary = summary;
      setDay(newBlocks[0].day);
      return { ...next, decisionTrace: trace };
    });
    setToast(
      added > 0
        ? `已将 ${added} 项到期复习自动排入日历空档。`
        : "所有到期复习均已在日历中，或暂无到期复习项。",
    );
    return added;
  }, [now]);

  const handleMissedSession = useCallback(
    (blockId: string, action: "reschedule" | "shrink15" | "drop") => {
      lastTriggerRef.current = {
        trigger: "错课接管",
        summary:
          action === "drop"
            ? "跳过未完成任务"
            : action === "shrink15"
              ? "压缩为 15 分钟微复习并重排"
              : "顺延未完成任务至最近空档",
      };
      setS((prev) => {
        const target = prev.blocks.find((b) => b.id === blockId);
        if (!target) return prev;
        const waking = getWakingBounds(prev.scheduleSettings);
        const prefs = extractMemoryPreferences(prev.memories);
        const endLimit = Math.min(waking.wakeEnd, prefs.preferredEnd ?? waking.wakeEnd);
        const startPref = Math.max(waking.wakeStart, prefs.preferredStart ?? 1140);

        if (action === "drop") {
          const blocks = prev.blocks.filter((b) => b.id !== blockId);
          const summary = `已跳过前期未完成任务「${target.title}」，减轻堆积压力。`;
          const next: Store = { ...prev, blocks, decision: summary };
          const trace = buildDecisionTrace(next, now, next.activeTrackId);
          trace.summary = summary;
          setToast("已跳过该次任务，不再堆积。");
          return { ...next, decisionTrace: trace };
        }

        const duration = action === "shrink15" ? 15 : target.minutes;
        const slot =
          findSlot(prev.blocks, now, startPref, duration, blockId, endLimit) ||
          findSlot(prev.blocks, now, waking.wakeStart, duration, blockId, waking.wakeEnd);

        if (!slot) {
          setToast("未来 7 天暂无合适空档，请先检查日历负荷。");
          return prev;
        }

        const blocks = prev.blocks.map((b) =>
          b.id === blockId
            ? {
                ...b,
                day: slot.day,
                start: slot.start,
                minutes: duration,
                kind: action === "shrink15" ? ("复习" as const) : b.kind,
                title:
                  action === "shrink15" && !b.title.includes("微复习")
                    ? `${b.title} · 15m 微复习`
                    : b.title,
              }
            : b,
        );
        const summary =
          action === "shrink15"
            ? `已将未完成的「${target.title}」压缩为 15 分钟微复习，排在 ${slot.day.slice(5)} ${time(slot.start)}。`
            : `已将未完成的「${target.title}」顺延至 ${slot.day.slice(5)} ${time(slot.start)}。`;

        const next: Store = { ...prev, blocks, decision: summary };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        trace.summary = summary;
        setDay(slot.day);
        setToast(summary);
        return { ...next, decisionTrace: trace };
      });
    },
    [now],
  );

  const completeSessionTiming = useCallback(
    (
      l: Lesson,
      plannedMinutes: number,
      actualMinutes: number,
      interruptions: number,
      energy: "high" | "medium" | "low",
    ) => {
      lastTriggerRef.current = {
        trigger: "超时节奏校准",
        summary: `「${l.title}」实际用时 ${actualMinutes} 分钟（原计划 ${plannedMinutes} 分钟）`,
      };
      setS((prev) => {
        const log = {
          id: `exec-${Date.now()}`,
          lessonId: l.id,
          lessonTitle: l.title,
          plannedMinutes,
          actualMinutes,
          interruptions,
          energy,
          completedAt: new Date().toISOString(),
        };
        const recal = recalibrateForOvertime(
          prev,
          l.id,
          plannedMinutes,
          actualMinutes,
          now,
        );
        const next: Store = {
          ...prev,
          blocks: recal.updatedBlocks,
          paceFactor: recal.newPaceFactor,
          executionLogs: [log, ...(prev.executionLogs || [])].slice(0, 50),
          decision: recal.summary,
        };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        trace.summary = recal.summary;
        setToast(recal.summary);
        return { ...next, decisionTrace: trace };
      });
    },
    [now],
  );

  const applyFeasibilityFix = useCallback(
    (fixId: "extend_deadline" | "protect_reviews_only" | "compress_micro") => {
      lastTriggerRef.current = {
        trigger: "负荷减负调整",
        summary:
          fixId === "compress_micro"
            ? "切换 20 分钟微学习压缩模式"
            : fixId === "protect_reviews_only"
              ? "本周保复习、新课顺延至下周"
              : "延长周期并平滑顺延超负荷课程",
      };
      setS((prev) => {
        const waking = getWakingBounds(prev.scheduleSettings);
        const prefs = extractMemoryPreferences(prev.memories);
        const endLimit = Math.min(waking.wakeEnd, prefs.preferredEnd ?? waking.wakeEnd);
        const startPref = Math.max(waking.wakeStart, prefs.preferredStart ?? 1140);

        let blocks = [...prev.blocks];
        let summary = "";

        if (fixId === "compress_micro") {
          blocks = blocks.map((b) =>
            !b.done && !b.locked && b.kind === "学习" && b.day >= now && b.minutes > 20
              ? { ...b, minutes: 20 }
              : b,
          );
          summary = "已切换 20 分钟微学习模式，压缩超长课时以适配本周空档。";
        } else if (fixId === "protect_reviews_only") {
          const toPush = blocks.filter(
            (b) => !b.done && !b.locked && b.kind === "学习" && b.day >= now && b.day < offset(now, 7),
          );
          for (const b of toPush) {
            const slot = findSlot(blocks, offset(now, 7), startPref, b.minutes, b.id, endLimit);
            if (slot) {
              blocks = blocks.map((x) => (x.id === b.id ? { ...x, ...slot } : x));
            }
          }
          summary = `已优先保留本周 FSRS 复习，并将 ${toPush.length} 节新课顺延至下周。`;
        } else {
          // extend_deadline: push half of upcoming learning blocks 7 days out
          const toPush = blocks
            .filter(
              (b) => !b.done && !b.locked && b.kind === "学习" && b.day >= now && b.day < offset(now, 7),
            )
            .sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start);
          const overflow = toPush.slice(Math.floor(toPush.length / 2));
          for (const b of overflow) {
            const slot = findSlot(blocks, offset(b.day, 7), startPref, b.minutes, b.id, endLimit);
            if (slot) {
              blocks = blocks.map((x) => (x.id === b.id ? { ...x, ...slot } : x));
            }
          }
          summary = `已将学习周期延长 7 天，把 ${overflow.length} 节超负荷课程平滑顺延。`;
        }

        const next: Store = { ...prev, blocks, decision: summary };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        trace.summary = summary;
        setToast(summary);
        return { ...next, decisionTrace: trace };
      });
    },
    [now],
  );

  const updateScheduleSettings = useCallback(
    (settings: ScheduleSettings) => {
      setS((prev) => {
        const next: Store = { ...prev, scheduleSettings: settings };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        return { ...next, decisionTrace: trace };
      });
      setToast(
        `已更新睡眠红线（${time(settings.sleepStart)}–${time(settings.sleepEnd)} 绝不排课）。`,
      );
    },
    [now],
  );

  const recordFSRSReview = useCallback(
    (lessonId: string, rating: FSRSRating) => {
      const targetLesson = getLessonById(s, lessonId);
      if (!targetLesson) return null;
      const calc = computeFSRSReviewUpdate(s, targetLesson, rating, now);
      const ratingName = { 1: "忘记", 2: "困难", 3: "良好", 4: "容易" }[rating];

      setS((prev) => {
        const mastery = { ...prev.mastery, [lessonId]: calc.after };
        const masteryMeta = {
          ...(prev.masteryMeta || {}),
          [lessonId]: calc.meta,
        };
        const reviewBlock = prev.blocks.find(
          (b) =>
            b.day === now &&
            b.kind === "复习" &&
            b.lesson === lessonId &&
            !b.done,
        );
        const blocks = prev.blocks.map((b) =>
          b.id === reviewBlock?.id ? { ...b, done: true } : b,
        );
        const summary = `主动回忆「${targetLesson.title}」评分：${ratingName}，掌握度 ${calc.before}% → ${calc.after}%，FSRS 下次复习 ${calc.nextReviewDay.slice(5)}。`;
        const returnTrackId = returnTrackAfterReviewRef.current;
        returnTrackAfterReviewRef.current = null;
        const nextActiveTrackId =
          returnTrackId &&
          prev.goalPlans?.some((p) => p.id === returnTrackId && !p.archived)
            ? returnTrackId
            : prev.activeTrackId;
        const next: Store = {
          ...prev,
          activeTrackId: nextActiveTrackId,
          mastery,
          masteryMeta,
          blocks,
          decision: summary,
          memories: [
            {
              id: `fsrs-${lessonId}-${Date.now()}`,
              label: "学习记录",
              category: "record",
              text: `${now} · ${summary}`,
              createdAt: now,
            },
            ...prev.memories,
          ],
        };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        trace.summary = summary;
        return { ...next, decisionTrace: trace };
      });
      if (returnTrackAfterReviewRef.current === null) {
        // returned cleanly if cross-track review finished
      }

      setToast(
        `FSRS 复习已记录：下次复习 ${calc.nextReviewDay.slice(5)}（${calc.nextIntervalDays} 天后）。`,
      );
      return {
        after: calc.after,
        nextReviewDay: calc.nextReviewDay,
        nextIntervalDays: calc.nextIntervalDays,
      };
    },
    [s, now],
  );

  const applyRescheduleOption = useCallback(
    (opt: RescheduleOption): boolean => {
      lastTriggerRef.current = {
        trigger: "ReAct 动态重排",
        summary: `采纳方案「${opt.label}」`,
      };
      let applied = false;
      setS((prev) => {
        const prereqCheck = validateRescheduleOption(prev, opt);
        if (!prereqCheck.ok) {
          setToast(prereqCheck.reason || "该重排方案违反先修依赖顺序，已拒绝应用。");
          return prev;
        }
        const movedIds = new Set(opt.changes.map((c) => c.blockId));
        // Validate every moved block still exists & isn't done
        for (const c of opt.changes) {
          const orig = prev.blocks.find((b) => b.id === c.blockId);
          if (!orig || orig.done) {
            setToast("原日程已发生变化或已完成，请让 Agent 重新规划。");
            return prev;
          }
        }

        const remaining = prev.blocks.filter((b) => !movedIds.has(b.id));
        const additions: Block[] = [];

        if (opt.insertEvent) {
          if (
            !free(
              remaining,
              opt.insertEvent.day,
              opt.insertEvent.start,
              opt.insertEvent.minutes,
            )
          ) {
            setToast("目标会议时段已被其他固定安排占用，请重新规划。");
            return prev;
          }
          additions.push(opt.insertEvent);
        }

        for (const c of opt.changes) {
          const orig = prev.blocks.find((b) => b.id === c.blockId)!;
          if (c.newSlots.length === 1) {
            const ns = c.newSlots[0];
            if (
              !free([...remaining, ...additions], ns.day, ns.start, ns.minutes)
            ) {
              setToast("目标空档已被占用，请让 Agent 重新生成方案。");
              return prev;
            }
            additions.push({
              ...orig,
              day: ns.day,
              start: ns.start,
              minutes: ns.minutes,
            });
          } else {
            const splitGroup = orig.id;
            for (const [idx, ns] of c.newSlots.entries()) {
              if (
                !free(
                  [...remaining, ...additions],
                  ns.day,
                  ns.start,
                  ns.minutes,
                )
              ) {
                setToast("拆分时段存在冲突，请让 Agent 重新生成方案。");
                return prev;
              }
              additions.push({
                ...orig,
                id: `${orig.id}-split-${idx + 1}`,
                title: ns.title || `${orig.title}（${idx + 1}）`,
                day: ns.day,
                start: ns.start,
                minutes: ns.minutes,
                splitGroup,
              });
            }
          }
        }

        const blocks = [...remaining, ...additions];
        const summary =
          `已采纳「${opt.label}」：` +
          opt.changes
            .map(
              (c) =>
                `「${c.title}」移至 ${c.newSlots
                  .map((ns) => `${ns.day.slice(5)} ${time(ns.start)}`)
                  .join(" & ")}`,
            )
            .join("；") +
          (opt.insertEvent
            ? `，并插入「${opt.insertEvent.title}」。`
            : "。");

        const next: Store = { ...prev, blocks, decision: summary };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        trace.summary = summary;
        const firstDay =
          opt.changes[0]?.newSlots[0]?.day || opt.insertEvent?.day || now;
        const movedMap: ScheduleChangeHighlight["movedMap"] = {};
        const addedIds: string[] = [];
        if (opt.insertEvent) addedIds.push(opt.insertEvent.id);
        for (const c of opt.changes) {
          if (c.newSlots.length === 1) {
            movedMap[c.blockId] = {
              title: c.title,
              oldDay: c.oldDay,
              oldStart: c.oldStart,
              oldMinutes: c.oldMinutes,
              newDay: c.newSlots[0].day,
              newStart: c.newSlots[0].start,
            };
          } else {
            c.newSlots.forEach((ns, idx) => {
              const splitId = `${c.blockId}-split-${idx + 1}`;
              movedMap[splitId] = {
                title: ns.title || `${c.title}（${idx + 1}）`,
                oldDay: c.oldDay,
                oldStart: c.oldStart,
                oldMinutes: c.oldMinutes,
                newDay: ns.day,
                newStart: ns.start,
              };
            });
          }
        }
        setRecentScheduleHighlight({
          trigger: `Agent 重排 · ${opt.label}`,
          summary,
          addedIds,
          movedMap,
          timestamp: Date.now(),
        });
        setDay(firstDay);
        setPreviewOption(null);
        setToast("重排方案已应用到日历。");
        applied = true;
        return { ...next, decisionTrace: trace };
      });
      return applied;
    },
    [now],
  );

  const deleteBlock = useCallback(
    (blockId: string) => {
      lastTriggerRef.current = { trigger: "删除日程", summary: "手动删除日程块" };
      setS((prev) => {
        const blocks = prev.blocks.filter((b) => b.id !== blockId);
        const next: Store = { ...prev, blocks };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        return { ...next, decisionTrace: trace };
      });
      setToast("日程已删除。");
    },
    [now],
  );

  const toggleBlockDone = useCallback((blockId: string) => {
    setS((prev) => ({
      ...prev,
      blocks: prev.blocks.map((b) =>
        b.id === blockId ? { ...b, done: !b.done } : b,
      ),
    }));
  }, []);

  const addMemory = useCallback(
    (
      category: MemoryCategory,
      text: string,
      label?: string,
      expiresAt?: string,
    ) => {
      const clean = text.trim();
      if (!clean) return;
      const norm = clean.toLowerCase().replace(/\s+/g, " ");
      let isDuplicate = false;
      const entry: Memory = {
        id: "mem-" + crypto.randomUUID().slice(0, 8),
        category,
        label: label || categoryLabel(category),
        text: clean,
        constraint: parseMemoryConstraint(clean),
        source: "user",
        confidence: 1.0,
        expiresAt: expiresAt || parseMemoryExpiry(clean, now),
        createdAt: now,
      };
      lastTriggerRef.current = { trigger: "长期记忆更新" };
      setS((prev) => {
        const exists = prev.memories.some(
          (m) =>
            (m.category || "preference") === category &&
            m.text.trim().toLowerCase().replace(/\s+/g, " ") === norm,
        );
        if (exists) {
          isDuplicate = true;
          return prev;
        }
        const next: Store = { ...prev, memories: [entry, ...prev.memories] };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        return { ...next, decisionTrace: trace };
      });
      setToast(
        isDuplicate
          ? "已存在相同的长期记忆，未重复添加。"
          : entry.expiresAt
            ? `已写入临时记忆（有效期至 ${entry.expiresAt.slice(5)}）。`
            : "已写入长期记忆，并同步生效至规划与辅导。",
      );
    },
    [now],
  );

  const updateMemory = useCallback(
    (
      id: string,
      text: string,
      category?: MemoryCategory,
      expiresAt?: string,
    ) => {
      const clean = text.trim();
      if (!clean) return;
      lastTriggerRef.current = { trigger: "长期记忆更新" };
      setS((prev) => {
        const memories = prev.memories.map((m) =>
          m.id === id
            ? {
                ...m,
                text: clean,
                category: category || m.category,
                label: category ? categoryLabel(category) : m.label,
                constraint: parseMemoryConstraint(clean),
                expiresAt: expiresAt !== undefined ? (expiresAt || undefined) : m.expiresAt,
              }
            : m,
        );
        const next: Store = { ...prev, memories };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        return { ...next, decisionTrace: trace };
      });
      setToast("记忆已更新。");
    },
    [now],
  );

  const deleteMemory = useCallback(
    (id: string) => {
      lastTriggerRef.current = { trigger: "长期记忆清理" };
      setS((prev) => {
        const next: Store = {
          ...prev,
          memories: prev.memories.filter((m) => m.id !== id),
        };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        return { ...next, decisionTrace: trace };
      });
      setToast("已移除该条记忆。");
    },
    [now],
  );

  const purgeExpiredMemories = useCallback(() => {
    let removed = 0;
    setS((prev) => {
      const kept = prev.memories.filter((m) => !isMemoryExpired(m, now));
      removed = prev.memories.length - kept.length;
      if (!removed) return prev;
      lastTriggerRef.current = { trigger: "清理过期记忆" };
      const next: Store = { ...prev, memories: kept };
      const trace = buildDecisionTrace(next, now, next.activeTrackId);
      return { ...next, decisionTrace: trace };
    });
    setToast(
      removed > 0
        ? `已清理 ${removed} 条已过期临时记忆。`
        : "当前没有已过期的记忆条目。",
    );
  }, [now]);

  const applyMemoryProposal = useCallback(
    (proposal: MemoryProposal, editedText?: string) => {
      const finalText = (editedText ?? proposal.text).trim();
      if (proposal.action === "remove" && proposal.targetId) {
        deleteMemory(proposal.targetId);
      } else if (proposal.action === "update" && proposal.targetId) {
        updateMemory(proposal.targetId, finalText, proposal.category);
      } else {
        addMemory(proposal.category, finalText, proposal.label);
      }
    },
    [addMemory, deleteMemory, updateMemory],
  );

  const commitAutoMemory = useCallback(
    (card: MemorySavedCard) => {
      const clean = card.text.trim();
      if (!clean && card.action !== "remove") return;
      lastTriggerRef.current = { trigger: "Agent 自主记忆" };
      setS((prev) => {
        if (card.action === "remove") {
          const next: Store = {
            ...prev,
            memories: prev.memories.filter((m) => m.id !== card.memoryId),
          };
          const trace = buildDecisionTrace(next, now, next.activeTrackId);
          return { ...next, decisionTrace: trace };
        }

        const existing =
          prev.memories.find((m) => m.id === card.memoryId) ||
          (card.category === "goal"
            ? prev.memories.find((m) => m.category === "goal")
            : prev.memories.find(
                (m) => m.category === card.category && m.text.trim() === clean,
              ));

        const constraint = card.constraint || parseMemoryConstraint(clean);
        const expiresAt = card.expiresAt || parseMemoryExpiry(clean, now);
        let memories: Memory[];
        if (existing) {
          if (
            existing.text.trim() === clean &&
            existing.category === card.category &&
            existing.expiresAt === expiresAt
          )
            return prev;
          memories = prev.memories.map((m) =>
            m.id === existing.id
              ? {
                  ...m,
                  id: card.memoryId,
                  category: card.category,
                  label: card.label,
                  text: clean,
                  constraint,
                  expiresAt,
                  source: card.source || "agent",
                  confidence: card.confidence ?? 0.9,
                }
              : m,
          );
        } else {
          memories = [
            {
              id: card.memoryId,
              category: card.category,
              label: card.label,
              text: clean,
              constraint,
              expiresAt,
              source: card.source || "agent",
              confidence: card.confidence ?? 0.9,
              createdAt: now,
            },
            ...prev.memories,
          ];
        }

        const next: Store = { ...prev, memories };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        return { ...next, decisionTrace: trace };
      });
    },
    [now],
  );

  const commitAgentAssessment = useCallback(
    (card: MasteryUpdateCard) => {
      const lesson = getLessonById(s, card.lessonId);
      if (!lesson) return;
      if (card.skip) {
        skipAsMastered(lesson);
      } else {
        recordFeedback(lesson, card.correct, card.attemptId, "quiz");
      }
    },
    [s, skipAsMastered, recordFeedback],
  );

  const applyCalendarAction = useCallback(
    (card: CalendarUpdatedCard) => {
      lastTriggerRef.current = {
        trigger: "Agent 日程操作",
        summary: card.summary,
      };
      setS((prev) => {
        let blocks = prev.blocks;
        const oldBlock = prev.blocks.find((b) => b.id === card.block.id);
        if (card.action === "delete") {
          blocks = prev.blocks.filter((b) => b.id !== card.block.id);
        } else if (card.action === "add") {
          if (prev.blocks.some((b) => b.id === card.block.id)) return prev;
          blocks = [...prev.blocks, card.block];
          setRecentScheduleHighlight({
            trigger: "Agent 新增日程",
            summary: card.summary,
            addedIds: [card.block.id],
            movedMap: {},
            timestamp: Date.now(),
          });
        } else {
          blocks = prev.blocks.some((b) => b.id === card.block.id)
            ? prev.blocks.map((b) => (b.id === card.block.id ? card.block : b))
            : [...prev.blocks, card.block];
          if (
            oldBlock &&
            (oldBlock.day !== card.block.day ||
              oldBlock.start !== card.block.start)
          ) {
            setRecentScheduleHighlight({
              trigger: "Agent 调整日程",
              summary: card.summary,
              addedIds: [],
              movedMap: {
                [card.block.id]: {
                  title: card.block.title,
                  oldDay: oldBlock.day,
                  oldStart: oldBlock.start,
                  oldMinutes: oldBlock.minutes,
                  newDay: card.block.day,
                  newStart: card.block.start,
                },
              },
              timestamp: Date.now(),
            });
          }
        }
        const next: Store = { ...prev, blocks };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        return { ...next, decisionTrace: trace };
      });
      setDay(card.block.day);
    },
    [now],
  );

  const clearScheduleHighlight = useCallback(() => {
    setRecentScheduleHighlight(null);
  }, []);

  const setCheckDraft = useCallback((checkId: string, draft: CheckDraft) => {
    setCheckDrafts((prev) => {
      const next = {
        ...prev,
        [checkId]: { ...prev[checkId], ...draft },
      };
      try {
        localStorage.setItem(CHECK_DRAFTS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const clearCheckDraft = useCallback((checkId: string) => {
    setCheckDrafts((prev) => {
      if (!(checkId in prev)) return prev;
      const next = { ...prev };
      delete next[checkId];
      try {
        localStorage.setItem(CHECK_DRAFTS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const setChatDraft = useCallback((val: string) => {
    setChatDraftState(val);
    try {
      if (val) localStorage.setItem(CHAT_DRAFT_KEY, val);
      else localStorage.removeItem(CHAT_DRAFT_KEY);
    } catch {}
  }, []);

  const moveBlockToSlot = useCallback(
    (
      blockId: string,
      newDay: string,
      newStart: number,
    ): { ok: boolean; reason?: string } => {
      const target = s.blocks.find((b) => b.id === blockId);
      if (!target) return { ok: false, reason: "未找到该日程块。" };
      if (isLockedBlock(target)) {
        return { ok: false, reason: "该日程已锁定，解锁后方可拖动调整。" };
      }
      if (
        (target.kind === "学习" || target.kind === "复习") &&
        isWithinSleep(newStart, target.minutes, s.scheduleSettings)
      ) {
        const msg = "触及睡眠保护红线（23:00–07:00），已阻止排入深夜。";
        setToast(msg);
        return { ok: false, reason: msg };
      }
      const others = s.blocks.filter((b) => b.id !== blockId);
      if (!free(others, newDay, newStart, target.minutes)) {
        const msg = `${newDay.slice(5)} ${time(newStart)} 与已有日程冲突。`;
        setToast(msg);
        return { ok: false, reason: msg };
      }

      const oldDay = target.day;
      const oldStart = target.start;
      if (oldDay === newDay && oldStart === newStart) {
        return { ok: true };
      }

      const summary = `将「${target.title}」由 ${oldDay.slice(5)} ${time(oldStart)} 移至 ${newDay.slice(5)} ${time(newStart)}`;
      lastTriggerRef.current = {
        trigger: "拖拽调整日程",
        summary,
      };
      setS((prev) => {
        const blocks = prev.blocks.map((b) =>
          b.id === blockId ? { ...b, day: newDay, start: newStart } : b,
        );
        const next: Store = { ...prev, blocks, decision: summary };
        const trace = buildDecisionTrace(next, now, next.activeTrackId);
        return { ...next, decisionTrace: trace };
      });
      setRecentScheduleHighlight({
        trigger: "手动拖拽调整",
        summary,
        addedIds: [],
        movedMap: {
          [blockId]: {
            title: target.title,
            oldDay,
            oldStart,
            oldMinutes: target.minutes,
            newDay,
            newStart,
          },
        },
        timestamp: Date.now(),
      });
      setDay(newDay);
      setToast(`已移动「${target.title}」至 ${newDay.slice(5)} ${time(newStart)}。`);
      return { ok: true };
    },
    [s.blocks, s.scheduleSettings, now],
  );

  const setActiveThreadId = useCallback((threadId: string) => {
    const clean = threadId.trim() || "agent-main";
    setActiveThreadIdState(clean);
    try {
      localStorage.setItem(ACTIVE_THREAD_KEY, clean);
    } catch {}
  }, []);

  const refreshThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/chats?list=1&includeArchived=1", {
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as { threads?: ChatThreadMeta[] };
        if (Array.isArray(data.threads)) {
          setThreads(data.threads);
        }
      }
    } catch {}
  }, []);

  const createNewThread = useCallback(
    async (opts?: { title?: string; trackId?: string; lessonId?: string }) => {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          title: opts?.title,
          trackId: opts?.trackId,
          lessonId: opts?.lessonId,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          threadId: string;
          meta: ChatThreadMeta;
        };
        setActiveThreadId(data.threadId);
        await refreshThreads();
        setToast("已新建干净对话（知识图谱、日程与长期记忆均完整保留）。");
        return data.threadId;
      }
      const fallbackId = `chat-${crypto.randomUUID().slice(0, 8)}`;
      setActiveThreadId(fallbackId);
      return fallbackId;
    },
    [setActiveThreadId, refreshThreads],
  );

  const switchToTrackThread = useCallback(
    async (trackId: string, trackTitle: string) => {
      const trackThreadId = `track-${trackId}`;
      try {
        await fetch("/api/chats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "create",
            threadId: trackThreadId,
            title: `轨道 · ${trackTitle}`,
            trackId,
          }),
        });
      } catch {}
      setActiveThreadId(trackThreadId);
      await refreshThreads();
    },
    [setActiveThreadId, refreshThreads],
  );

  const deleteThread = useCallback(
    async (threadId: string) => {
      await getClientTaskManager().clearThread(threadId);
      if (activeThreadId === threadId) {
        setActiveThreadId("agent-main");
      }
      await refreshThreads();
      setToast("已删除该对话记录（知识图谱、日程与长期记忆不受影响）。");
    },
    [activeThreadId, setActiveThreadId, refreshThreads],
  );

  const renameThread = useCallback(
    async (threadId: string, title: string) => {
      const clean = title.trim();
      if (!clean) return;
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", threadId, title: clean }),
      });
      if (res.ok) {
        await refreshThreads();
        setToast(`已重命名对话为「${clean}」。`);
      }
    },
    [refreshThreads],
  );

  const archiveThread = useCallback(
    async (threadId: string) => {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "archive", threadId }),
      });
      if (res.ok) {
        if (activeThreadId === threadId) {
          setActiveThreadId("agent-main");
        }
        await refreshThreads();
        setToast("已归档该对话，可在「已归档」筛选中随时恢复。");
      }
    },
    [activeThreadId, setActiveThreadId, refreshThreads],
  );

  const restoreThread = useCallback(
    async (threadId: string) => {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", threadId }),
      });
      if (res.ok) {
        await refreshThreads();
        setToast("已恢复该归档对话。");
      }
    },
    [refreshThreads],
  );

  const compactThread = useCallback(
    async (threadId: string) => {
      try {
        const res = await fetch("/api/chats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "compact", threadId }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            stats?: { savedPct?: number; savedTokens?: number };
          };
          await refreshThreads();
          const pct = data.stats?.savedPct ?? 0;
          setToast(
            pct > 0
              ? `已将早期对话浓缩为滚动摘要，节省约 ${pct}% 上下文 Token。`
              : "已生成并更新本会话滚动摘要。",
          );
        }
      } catch {}
    },
    [refreshThreads],
  );

  const cancelActiveLlmTask = useCallback(
    (taskIdOrThreadId?: string) => {
      const tm = getClientTaskManager();
      const target =
        taskIdOrThreadId ||
        tm.getStatus().activeTasks[0]?.taskId ||
        activeThreadId;
      void tm.cancel(target);
    },
    [activeThreadId],
  );

  // Keep latest handlers in a ref so the root LLMTaskManager subscription
  // NEVER tears down & re-subscribes mid-stream when `s` changes (e.g. after parallel tool #1 commits).
  const toolHandlersRef = useRef({
    now,
    refreshThreads,
    commitAutoMemory,
    savePlan,
    commitAgentAssessment,
    applyCalendarAction,
  });
  toolHandlersRef.current = {
    now,
    refreshThreads,
    commitAutoMemory,
    savePlan,
    commitAgentAssessment,
    applyCalendarAction,
  };

  // Hydrate persisted thread messages ONLY on thread switch (never mark in-progress tool calls as processed)
  useEffect(() => {
    const tm = getClientTaskManager();
    void toolHandlersRef.current.refreshThreads();
    void tm.hydrateThread(activeThreadId).then((msgs) => {
      const runningNow = tm.getStatus(activeThreadId).isRunning;
      if (!runningNow) {
        for (const m of msgs) {
          if (m.role !== "assistant") continue;
          for (const p of m.parts) {
            if (
              "toolCallId" in p &&
              typeof p.toolCallId === "string" &&
              "state" in p &&
              (p as { state?: string }).state === "output-available"
            ) {
              processedToolCallsRef.current.add(p.toolCallId);
            }
          }
        }
      }
      setLlmTaskStatus(tm.getStatus());
    });
  }, [activeThreadId]);

  // Mount-once root-level subscription to LLMTaskManager so background streaming tasks
  // continue updating global status and committing ALL parallel tool outputs reliably
  // even when the Chat/Agent view unmounts, `s` updates mid-turn, or user switches threads!
  useEffect(() => {
    const tm = getClientTaskManager();

    const unsub = tm.subscribe((ev) => {
      setLlmTaskStatus(tm.getStatus());
      const h = toolHandlersRef.current;

      if (
        ev.type === "started" ||
        ev.type === "completed" ||
        ev.type === "cancelled" ||
        ev.type === "failed"
      ) {
        void h.refreshThreads();
      }

      if (ev.type === "tool_output" && ev.toolCallId && ev.toolOutput) {
        if (processedToolCallsRef.current.has(ev.toolCallId)) return;
        const out = ev.toolOutput as AgentCard | undefined;
        if (!out || typeof out !== "object" || !("kind" in out)) return;

        if (out.kind === "memory_saved") {
          processedToolCallsRef.current.add(ev.toolCallId);
          skipNextSaveRef.current = true;
          h.commitAutoMemory(out);
        } else if (out.kind === "track_created") {
          processedToolCallsRef.current.add(ev.toolCallId);
          skipNextSaveRef.current = true;
          h.savePlan(out.plan);
        } else if (out.kind === "mastery_update") {
          processedToolCallsRef.current.add(ev.toolCallId);
          skipNextSaveRef.current = true;
          h.commitAgentAssessment(out);
        } else if (out.kind === "calendar_updated") {
          processedToolCallsRef.current.add(ev.toolCallId);
          skipNextSaveRef.current = true;
          h.applyCalendarAction(out);
        }
      }

      // Authoritative reconciliation: after a task finishes, re-read SQLite state
      // so any server-persisted tracks/blocks/memories/mastery are 100% synced into React.
      if (ev.type === "completed") {
        void fetch(`/api/state?day=${encodeURIComponent(h.now)}`, {
          cache: "no-store",
        })
          .then((r) => (r.ok ? r.json() : null))
          .then(
            (
              data: { store?: Store; dbInfo?: DbInfo; stateVersion?: number } | null,
            ) => {
              if (!data?.store) return;
              latestStateVersionRef.current =
                data.stateVersion ?? data.store.stateVersion;
              skipNextSaveRef.current = true;
              setS(data.store);
              if (data.dbInfo) setDbInfo(data.dbInfo);
            },
          )
          .catch(() => {});
      }
    });

    return () => unsub();
  }, []);

  const resetDemo = useCallback(() => {
    void (async () => {
      try {
        await fetch("/api/state", { method: "DELETE" });
      } catch {}
      try {
        const keysToClear: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith("xushi.") && k !== "xushi.model-config.v1")
            keysToClear.push(k);
        }
        keysToClear.forEach((k) => localStorage.removeItem(k));
      } catch {}
      skipNextSaveRef.current = true;
      const fresh = initial(now);
      setS(fresh);
      setDay(now);
      setPreviewOption(null);
      setToast("已清空本机 SQLite 全部数据，恢复空白空间。");
      if (typeof window !== "undefined") {
        window.location.hash = "today";
        window.location.reload();
      }
    })();
  }, [now]);

  const value = useMemo<LearningStoreValue>(
    () => ({
      now,
      live: effectiveLive,
      activeModelName,
      modelConfig,
      setModelConfig,
      dbInfo,
      s,
      loaded,
      day,
      setDay,
      workspaceTab,
      setWorkspaceTab,
      focusedLessonId,
      setFocusedLessonId,
      learnModeRequest,
      clearLearnModeRequest,
      openLessonInLearn,
      syncStoreFromServer,
      recentScheduleHighlight,
      clearScheduleHighlight,
      moveBlockToSlot,
      attachedContext,
      attachContext: setAttachedContext,
      checkDrafts,
      setCheckDraft,
      clearCheckDraft,
      chatDraft,
      setChatDraft,
      calendarViewMode,
      setCalendarViewMode,
      llmTaskStatus,
      cancelActiveLlmTask,
      activeThreadId,
      threads,
      setActiveThreadId,
      refreshThreads,
      createNewThread,
      switchToTrackThread,
      deleteThread,
      renameThread,
      archiveThread,
      restoreThread,
      compactThread,
      setActiveTrackId,
      copilotOpen,
      setCopilotOpen,
      copilotTrigger,
      clearCopilotTrigger,
      askCopilot,
      previewOption,
      setPreviewOption,
      toast,
      showToast,
      savePlan,
      removePlan,
      archiveTrack,
      restoreTrack,
      permanentDeleteTrack,
      adjustTrackScope,
      recordFeedback,
      commitAgentAssessment,
      applyCalendarAction,
      skipAsMastered,
      markLessonSkipped,
      declareSelfReportedMastery,
      autoScheduleDueReviews,
      handleMissedSession,
      completeSessionTiming,
      applyFeasibilityFix,
      updateScheduleSettings,
      recordFSRSReview,
      applyRescheduleOption,
      saveStoreState,
      deleteBlock,
      toggleBlockDone,
      addMemory,
      updateMemory,
      deleteMemory,
      purgeExpiredMemories,
      applyMemoryProposal,
      commitAutoMemory,
      resetDemo,
    }),
    [
      now,
      effectiveLive,
      activeModelName,
      modelConfig,
      setModelConfig,
      dbInfo,
      s,
      loaded,
      day,
      workspaceTab,
      focusedLessonId,
      recentScheduleHighlight,
       clearScheduleHighlight,
      moveBlockToSlot,
      attachedContext,
      checkDrafts,
      setCheckDraft,
      clearCheckDraft,
      chatDraft,
      setChatDraft,
      calendarViewMode,
      llmTaskStatus,
      cancelActiveLlmTask,
      activeThreadId,
      threads,
      setActiveThreadId,
      refreshThreads,
      createNewThread,
      switchToTrackThread,
      deleteThread,
      renameThread,
      archiveThread,
      restoreThread,
      compactThread,
      setActiveTrackId,
      copilotOpen,
      copilotTrigger,
      clearCopilotTrigger,
      askCopilot,
      previewOption,
      toast,
      showToast,
      savePlan,
      removePlan,
      archiveTrack,
      restoreTrack,
      permanentDeleteTrack,
      adjustTrackScope,
      recordFeedback,
      commitAgentAssessment,
      applyCalendarAction,
      skipAsMastered,
      markLessonSkipped,
      declareSelfReportedMastery,
      autoScheduleDueReviews,
      handleMissedSession,
      completeSessionTiming,
      applyFeasibilityFix,
      updateScheduleSettings,
      recordFSRSReview,
      applyRescheduleOption,
      saveStoreState,
      deleteBlock,
      toggleBlockDone,
      addMemory,
      updateMemory,
      deleteMemory,
      purgeExpiredMemories,
      applyMemoryProposal,
      commitAutoMemory,
      resetDemo,
    ],
  );

  // Guard helper reference to keep getAllLessons tree-shaken cleanly
  void getAllLessons;

  return (
    <LearningStoreContext.Provider value={value}>
      {children}
    </LearningStoreContext.Provider>
  );
}

export function useLearningStore() {
  const ctx = useContext(LearningStoreContext);
  if (!ctx)
    throw new Error("useLearningStore must be used inside LearningStoreProvider");
  return ctx;
}
