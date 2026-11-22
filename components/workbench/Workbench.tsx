"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  ArrowRight,
  BookOpen,
  Brain,
  CalendarDays,
  Command,
  Database,
  FolderOpen,
  GitFork,
  History,
  House,
  Layers3,
  Loader2,
  MessagesSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Plus,
  Search,
  Settings,
  Sparkles,
  Square,
  Sun,
  X,
} from "lucide-react";
import {
  available,
  dueReviews,
  formatDayWithWeekday,
  getActiveMemories,
  getActiveTrack,
  getAllLessons,
  getLessonById,
  getTrackForLesson,
  getTracks,
  isRemedialBlock,
  time,
  type Block,
  type Lesson,
} from "../../lib/learning";
import { AddEvent } from "../Planner";
import {
  LearningStoreProvider,
  useLearningStore,
  type WorkspaceTab,
} from "../LearningStore";
import Agent from "../Agent";
import ModelSettingsDialog from "../ModelSettingsDialog";
import { ConfirmDangerDialog } from "../gen-ui/ConfirmDangerDialog";
import {
  Classroom,
  ReviewQueue,
  StudyCalendar,
  StudyGraph,
} from "./StudyViews";
import { WorkspaceArchive, WorkspaceMemory } from "./WorkspaceViews";
import GoalSetup from "./GoalSetup";
import {
  SPRING_CRISP,
  SPRING_PANEL,
  TRANSITION_FAST,
  TRANSITION_STATE,
} from "../../lib/motion";

const primaryNavigation = [
  { id: "today", label: "今日工作台", icon: House, shortcut: "Ctrl+1" },
  { id: "study", label: "课堂", icon: BookOpen, shortcut: "Ctrl+2" },
  { id: "graph", label: "知识图谱", icon: GitFork, shortcut: "Ctrl+3" },
  { id: "calendar", label: "学习日历", icon: CalendarDays, shortcut: "Ctrl+4" },
  { id: "review", label: "复习队列", icon: Brain, shortcut: "Ctrl+5" },
] as const;

const secondaryNavigation = [
  { id: "memory", label: "学习记忆", icon: Layers3, shortcut: "Ctrl+6" },
  { id: "conversations", label: "历史对话", icon: MessagesSquare, shortcut: "Ctrl+7" },
  { id: "audit", label: "运行轨迹", icon: History, shortcut: "Ctrl+8" },
] as const;

const allNavigation = [...primaryNavigation, ...secondaryNavigation] as const;

type Screen = WorkspaceTab | "review";
type Modal = "goal" | "settings" | "add" | "edit" | "block" | "command";
type Props = { now: string; live: boolean; serverModelName?: string };

type DesktopBridge = {
  isDesktop?: boolean;
  platform?: string;
  openDataFolder?: () => Promise<{ ok: boolean; path: string }>;
  setTheme?: (theme: "light" | "dark") => Promise<{ ok: boolean }>;
};

const AGENT_WIDTH_KEY = "xushi.desktop-agent-width.v1";
const SIDEBAR_COLLAPSED_KEY = "xushi.desktop-sidebar-collapsed.v1";
const THEME_KEY = "xushi.theme.v1";

type CommandItem = {
  id: string;
  group: "快捷操作" | "页面导航" | "直达课程";
  label: string;
  meta?: string;
  run: () => void;
};

function ModalFrame({
  title,
  close,
  closeLocked = false,
  children,
}: {
  title: string;
  close: () => void;
  closeLocked?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      className="wb-dialog"
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeLocked) close();
      }}
      onClick={(event) => {
        if (closeLocked || event.target !== ref.current) return;
        const rect = ref.current.getBoundingClientRect();
        const outside =
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom;
        if (outside) close();
      }}
    >
      <div className="wb-dialog-head">
        <h2>{title}</h2>
        <button
          type="button"
          className="wb-icon"
          onClick={close}
          disabled={closeLocked}
          aria-label="关闭"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <motion.div
        className="wb-dialog-body"
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={TRANSITION_FAST}
      >
        {children}
      </motion.div>
    </dialog>
  );
}

function Commands({ commands }: { commands: CommandItem[] }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const q = query.trim().toLowerCase();

  const matches = useMemo(() => {
    if (!q) return commands.slice(0, 18);
    return commands
      .filter(
        (cmd) =>
          cmd.label.toLowerCase().includes(q) ||
          (cmd.meta && cmd.meta.toLowerCase().includes(q)) ||
          cmd.group.toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [commands, q]);

  useEffect(() => {
    setActiveIndex(0);
  }, [q]);

  const grouped = useMemo(() => {
    const order: CommandItem["group"][] = ["快捷操作", "页面导航", "直达课程"];
    return order
      .map((group) => ({
        group,
        items: matches.filter((m) => m.group === group),
      }))
      .filter((g) => g.items.length > 0);
  }, [matches]);

  const flatVisible = useMemo(
    () => grouped.flatMap((g) => g.items),
    [grouped],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!flatVisible.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % flatVisible.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(
        (prev) => (prev - 1 + flatVisible.length) % flatVisible.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      flatVisible[activeIndex]?.run();
    }
  };

  let cursor = -1;

  return (
    <div className="wb-commands">
      <label className="wb-filter-search">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          autoFocus
          aria-label="搜索页面、课程或快捷操作"
          placeholder="搜索页面、具体课时或快捷操作（↑↓ 选择，Enter 执行）"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      {grouped.length > 0 ? (
        <ul>
          {grouped.map((section) => (
            <li key={section.group}>
              <div className="wb-commands-group-label">{section.group}</div>
              {section.items.map((command) => {
                cursor += 1;
                const idx = cursor;
                return (
                  <button
                    key={command.id}
                    type="button"
                    data-active={idx === activeIndex ? "true" : undefined}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={command.run}
                  >
                    <span>{command.label}</span>
                    {command.meta && (
                      <span className="wb-commands-meta">{command.meta}</span>
                    )}
                    <ArrowRight size={13} aria-hidden="true" />
                  </button>
                );
              })}
            </li>
          ))}
        </ul>
      ) : (
        <p className="wb-panel-empty">没有匹配的页面、课程或操作。</p>
      )}
    </div>
  );
}

function WorkbenchShell() {
  const store = useLearningStore();
  const {
    s,
    now,
    loaded,
    dbInfo,
    workspaceTab,
    setWorkspaceTab,
    day,
    copilotOpen,
    llmTaskStatus,
  } = store;
  const [review, setReview] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [blockId, setBlockId] = useState<string | null>(null);
  const [startMin, setStartMin] = useState<number>();
  const [reset, setReset] = useState(false);
  const [goalBusy, setGoalBusy] = useState(false);
  const [routingReady, setRoutingReady] = useState(false);

  // Desktop UX persistence: theme, collapsible sidebar, draggable AI dock width, Electron bridge
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [agentWidth, setAgentWidth] = useState(404);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const [isElectronWindow, setIsElectronWindow] = useState(false);

  const main = useRef<HTMLElement>(null);
  const screen: Screen =
    workspaceTab === "today" && review ? "review" : workspaceTab;
  const tracks = getTracks(s);
  const active = getActiveTrack(s);
  const reviews = dueReviews(s, now);
  const activeMemCount = getActiveMemories(s.memories, now).length;
  const selectedBlock = s.blocks.find((b) => b.id === blockId);
  const dateLabel = formatDayWithWeekday(now);

  useEffect(() => {
    try {
      const savedTheme = localStorage.getItem(THEME_KEY);
      const preferred =
        savedTheme === "dark" || savedTheme === "light"
          ? savedTheme
          : window.matchMedia?.("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
      setTheme(preferred);
      document.documentElement.dataset.theme = preferred;

      if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1") {
        setSidebarCollapsed(true);
      }
      const savedW = Number(localStorage.getItem(AGENT_WIDTH_KEY));
      if (savedW >= 320 && savedW <= 640) setAgentWidth(savedW);

      const bridge = (window as unknown as { learnosDesktop?: DesktopBridge })
        .learnosDesktop;
      if (bridge?.isDesktop) {
        setIsElectronWindow(true);
        void bridge.setTheme?.(preferred);
      }
    } catch {}
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(THEME_KEY, next);
        document.documentElement.dataset.theme = next;
        const bridge = (window as unknown as { learnosDesktop?: DesktopBridge })
          .learnosDesktop;
        void bridge?.setTheme?.(next);
      } catch {}
      return next;
    });
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  const go = useCallback(
    (next: Screen) => {
      setReview(next === "review");
      setWorkspaceTab(next === "review" ? "today" : next);
      if (typeof window !== "undefined" && location.hash !== "#" + next) {
        history.pushState(null, "", "#" + next);
      }
      main.current?.scrollTo(0, 0);
    },
    [setWorkspaceTab],
  );

  useEffect(() => {
    function followLink() {
      const hash = window.location.hash.slice(1);
      const target = hash
        ? allNavigation.find((item) => item.id === hash)?.id
        : "today";
      if (!target) return;
      setReview(target === "review");
      setWorkspaceTab(target === "review" ? "today" : target);
    }
    if (location.hash) followLink();
    setRoutingReady(true);
    window.addEventListener("hashchange", followLink);
    return () => window.removeEventListener("hashchange", followLink);
  }, [setWorkspaceTab]);

  useEffect(() => {
    if (routingReady && location.hash !== "#" + screen) {
      history.replaceState(null, "", "#" + screen);
    }
  }, [routingReady, screen]);

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.repeat) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "k") {
        if (document.querySelector("dialog[open]:not([aria-label='查找命令'])"))
          return;
        event.preventDefault();
        setModal((current) => (current === "command" ? null : "command"));
        return;
      }
      if (document.querySelector("dialog[open]")) return;
      if (key === "b") {
        event.preventDefault();
        toggleSidebar();
      } else if (key === "/") {
        event.preventDefault();
        store.setCopilotOpen(!store.copilotOpen);
      } else if (key === ",") {
        event.preventDefault();
        setModal("settings");
      } else if (/^[1-8]$/.test(key)) {
        const target = allNavigation[Number(key) - 1];
        if (target) {
          event.preventDefault();
          go(target.id);
        }
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [go, store, toggleSidebar]);

  const startSplitDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = agentWidth;
      setDraggingSplit(true);
      const onMove = (ev: PointerEvent) => {
        const next = Math.max(
          320,
          Math.min(640, startWidth + (startX - ev.clientX)),
        );
        setAgentWidth(next);
      };
      const onUp = () => {
        setDraggingSplit(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setAgentWidth((finalW) => {
          try {
            localStorage.setItem(AGENT_WIDTH_KEY, String(Math.round(finalW)));
          } catch {}
          return finalW;
        });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [agentWidth],
  );

  const openLesson = useCallback(
    async (lesson: Lesson) => {
      const track = getTrackForLesson(s, lesson.id);
      if (track) {
        store.setActiveTrackId(track.id);
        await store.switchToTrackThread(track.id, track.title);
      }
      store.attachContext({
        type: "lesson",
        lessonId: lesson.id,
        title: lesson.title,
        mastery: s.mastery[lesson.id] ?? 0,
      });
      setReview(false);
      store.openLessonInLearn(lesson.id, { trackId: track?.id });
      if (location.hash !== "#study") history.pushState(null, "", "#study");
    },
    [s, store],
  );

  const askAssistantWithLesson = useCallback(
    (lesson: Lesson, prompt: string) => {
      if (!store.live) {
        store.showToast("请先在设置中配置可用模型。");
        setModal("settings");
        return;
      }
      store.attachContext({
        type: "lesson",
        lessonId: lesson.id,
        title: lesson.title,
        mastery: s.mastery[lesson.id] ?? 0,
      });
      store.setCopilotOpen(true);
      store.askCopilot(prompt);
    },
    [s.mastery, store],
  );

  const askAssistantQuick = useCallback(
    (prompt: string) => {
      if (!store.live) {
        store.showToast("请先在设置中配置可用模型。");
        setModal("settings");
        return;
      }
      store.setCopilotOpen(true);
      store.askCopilot(prompt);
    },
    [store],
  );

  const handleOpenDataFolder = useCallback(async () => {
    const bridge = (window as unknown as { learnosDesktop?: DesktopBridge })
      .learnosDesktop;
    if (bridge?.openDataFolder) {
      const res = await bridge.openDataFolder();
      if (res?.ok) {
        store.showToast(`已打开数据目录：${res.path}`);
        return;
      }
    }
    store.showToast(
      `本机存储位置：${dbInfo?.path || "data/learnos.sqlite"}`,
    );
  }, [dbInfo?.path, store]);

  function showBlock(block: Block) {
    setBlockId(block.id);
    setModal("block");
  }
  function showAdd(start?: number) {
    setStartMin(start);
    setModal("add");
  }
  function startGoal(prompt: string) {
    setModal(null);
    if (!store.live) {
      store.showToast("设置可用模型后再提交学习目标。");
      setModal("settings");
      return;
    }
    if (screen === "study") go("today");
    store.setCopilotOpen(true);
    store.askCopilot(prompt);
  }
  const openSettings = () => setModal("settings");
  const close = () => setModal(null);

  const todayBlocks = s.blocks
    .filter((block) => block.day === now)
    .sort((a, b) => a.start - b.start);
  const canContinue = (lesson: Lesson) =>
    available(s, lesson) && (s.mastery[lesson.id] ?? 0) < 80;

  // #6: Keep Focus Hero aligned with the active track (or explicitly explain if recommending a scheduled block from another track)
  const activeTrackTodayBlock = active
    ? todayBlocks.find((block) => {
        if (block.done || block.kind !== "学习" || isRemedialBlock(block) || !block.lesson)
          return false;
        const lesson = getLessonById(s, block.lesson);
        return Boolean(
          lesson &&
            getTrackForLesson(s, lesson.id)?.id === active.id &&
            canContinue(lesson),
        );
      })
    : undefined;

  const anyTodayBlock = todayBlocks.find((block) => {
    if (block.done || block.kind !== "学习" || isRemedialBlock(block) || !block.lesson)
      return false;
    const lesson = getLessonById(s, block.lesson);
    return Boolean(lesson && canContinue(lesson));
  });

  const activeTrackNextLesson = active?.units.find(canContinue);

  let nextLesson: Lesson | undefined;
  let focusEyebrow = "开启新的学习轨道";
  if (activeTrackTodayBlock?.lesson) {
    nextLesson = getLessonById(s, activeTrackTodayBlock.lesson);
    focusEyebrow = `今日 ${time(activeTrackTodayBlock.start)} 日程`;
  } else if (activeTrackNextLesson) {
    nextLesson = activeTrackNextLesson;
    focusEyebrow = "当前轨道下一课";
  } else if (anyTodayBlock?.lesson) {
    nextLesson = getLessonById(s, anyTodayBlock.lesson);
    focusEyebrow = `今日 ${time(anyTodayBlock.start)} 日程`;
  }

  const nextTrack = nextLesson ? getTrackForLesson(s, nextLesson.id) : undefined;
  const showAgent = copilotOpen && screen !== "study";
  const label =
    allNavigation.find((item) => item.id === screen)?.label || "工作区";

  const activeMasteredCount = active
    ? active.units.filter((u) => (s.mastery[u.id] ?? 0) >= 80).length
    : 0;

  const commands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [
      {
        id: "ax-new-goal",
        group: "快捷操作",
        label: "新建学习目标",
        meta: "新建",
        run: () => setModal("goal"),
      },
      {
        id: "ax-add-event",
        group: "快捷操作",
        label: "添加学习日程",
        meta: "日历",
        run: () => {
          go("calendar");
          showAdd();
        },
      },
      {
        id: "ax-toggle-theme",
        group: "快捷操作",
        label: theme === "dark" ? "切换浅色模式" : "切换暗色模式",
        meta: "外观",
        run: () => {
          toggleTheme();
          close();
        },
      },
      {
        id: "ax-settings",
        group: "快捷操作",
        label: "设置与本机数据",
        meta: "Ctrl+,",
        run: openSettings,
      },
    ];
    if (nextLesson) {
      items.push({
        id: "ax-visual-next",
        group: "快捷操作",
        label: `用图解释「${nextLesson.title}」`,
        meta: "学习助手",
        run: () => {
          close();
          askAssistantWithLesson(
            nextLesson,
            `请用分步可视化图解（visual_explainer）帮我建立「${nextLesson.title}」的核心直觉。`,
          );
        },
      });
    }
    for (const item of allNavigation) {
      items.push({
        id: `nav-${item.id}`,
        group: "页面导航",
        label: item.label,
        meta: item.shortcut,
        run: () => {
          close();
          go(item.id);
        },
      });
    }
    for (const lesson of getAllLessons(s)) {
      const tr = getTrackForLesson(s, lesson.id);
      items.push({
        id: `lesson-${lesson.id}`,
        group: "直达课程",
        label: lesson.title,
        meta: `${tr?.title ?? "课程"} · ${s.mastery[lesson.id] ?? 0}%`,
        run: () => {
          close();
          void openLesson(lesson);
        },
      });
    }
    return items;
  }, [askAssistantWithLesson, go, nextLesson, openLesson, s, theme, toggleTheme]);

  const renderNavLink = (
    item: (typeof allNavigation)[number],
  ) => {
    const { id, label: navLabel, icon: Icon, shortcut } = item;
    const count =
      id === "review"
        ? reviews.length
        : id === "memory"
          ? activeMemCount
          : 0;
    const isCurrent = screen === id;
    return (
      <a
        key={id}
        href={"#" + id}
        title={`${navLabel} (${shortcut})`}
        aria-label={sidebarCollapsed ? navLabel : undefined}
        aria-current={isCurrent ? "page" : undefined}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            event.shiftKey
          )
            return;
          event.preventDefault();
          go(id);
        }}
      >
        {isCurrent && (
          <motion.span
            layoutId="wb-nav-pill"
            className="wb-nav-pill"
            transition={SPRING_CRISP}
          />
        )}
        <span className="wb-nav-inner">
          <Icon size={16} aria-hidden="true" />
          {!sidebarCollapsed && <span>{navLabel}</span>}
          {!sidebarCollapsed && count > 0 && <small>{count}</small>}
        </span>
        {sidebarCollapsed && id === "review" && reviews.length > 0 && (
          <span className="wb-badge-dot" aria-hidden="true" />
        )}
      </a>
    );
  };

  return (
    <div
      className="wb"
      data-sidebar-collapsed={sidebarCollapsed ? "true" : undefined}
      data-dragging={draggingSplit ? "true" : undefined}
    >
      {/* 1. LEFT SIDEBAR RAIL (Quiet Light-Gray Rail, Cobalt Active Pill) */}
      <aside className="wb-sidebar" aria-label="工作区侧边栏">
        <div className="wb-brand">
          <span className="wb-mark" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/icons/xuejing-150.png"
              alt=""
              width={28}
              height={28}
              draggable={false}
            />
          </span>
          {!sidebarCollapsed && <strong>学径</strong>}
        </div>

        <button
          type="button"
          className="wb-button wb-new"
          onClick={() => setModal("goal")}
          title="新建学习目标"
          aria-label="新建学习目标"
        >
          <Plus size={16} aria-hidden="true" />
          {!sidebarCollapsed && <span>新建学习目标</span>}
        </button>

        {/* Primary Learning Views */}
        <nav aria-label="核心学习导航">
          {primaryNavigation.map(renderNavLink)}
        </nav>

        {/* Track Switcher (In-Place Switch, No Forced Navigation Jump) */}
        {!sidebarCollapsed && tracks.length > 0 && (
          <div className="wb-tracks" aria-label="学习轨道列表">
            <h2>学习轨道</h2>
            {tracks.map((track) => {
              const mastered = track.units.filter(
                (unit) => (s.mastery[unit.id] ?? 0) >= 80,
              ).length;
              const isCurrent = track.id === active?.id;
              return (
                <button
                  key={track.id}
                  type="button"
                  title={track.title}
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => {
                    if (!isCurrent) store.attachContext(null);
                    store.setActiveTrackId(track.id);
                    void store.switchToTrackThread(track.id, track.title);
                  }}
                >
                  {isCurrent && (
                    <motion.span
                      layoutId="wb-track-pill"
                      className="wb-track-pill"
                      transition={SPRING_CRISP}
                    />
                  )}
                  <span className="wb-track-inner">
                    <i
                      className={isCurrent ? "wb-track-active" : ""}
                      aria-hidden="true"
                    />
                    <span>{track.title}</span>
                    <small>
                      {mastered}/{track.units.length}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Secondary Records & Diagnostics */}
        <div className="wb-secondary-nav">
          {!sidebarCollapsed && <h2>记录与后台</h2>}
          <nav aria-label="记录与后台导航">
            {secondaryNavigation.map(renderNavLink)}
          </nav>
        </div>

        <button
          type="button"
          className="wb-button wb-settings"
          onClick={openSettings}
          title="设置与数据 (Ctrl+,)"
          aria-label="设置与数据"
        >
          <Settings size={16} aria-hidden="true" />
          {!sidebarCollapsed && <span>设置与数据</span>}
        </button>
      </aside>

      {/* 2. CLEAN TOP BAR */}
      <header
        className="wb-top"
        data-electron={isElectronWindow ? "true" : undefined}
      >
        <div className="wb-top-left">
          <button
            type="button"
            className="wb-icon"
            onClick={toggleSidebar}
            title={`${sidebarCollapsed ? "展开" : "折叠"}侧边栏 (Ctrl+B)`}
            aria-label={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"}
            aria-expanded={!sidebarCollapsed}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen size={15} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={15} aria-hidden="true" />
            )}
          </button>

          <div className="wb-crumb">
            <strong>{label}</strong>
          </div>
        </div>

        <div className="wb-top-actions">
          {llmTaskStatus.isRunning && (
            <div
              className="wb-top-running"
              data-testid="global-task-indicator"
              role="status"
            >
              <Loader2
                size={12}
                className="animate-spin"
                aria-hidden="true"
              />
              <button
                type="button"
                onClick={() => {
                  if (llmTaskStatus.threadId) {
                    store.setActiveThreadId(llmTaskStatus.threadId);
                  }
                  if (screen === "study") return;
                  store.setCopilotOpen(true);
                }}
              >
                生成中
                {llmTaskStatus.previewText
                  ? ` (${llmTaskStatus.previewText.length}字)`
                  : "…"}
              </button>
              <button
                type="button"
                className="wb-stop-mini"
                onClick={() => void store.cancelActiveLlmTask()}
                aria-label="停止后台生成"
              >
                <Square size={9} fill="currentColor" aria-hidden="true" /> 停止
              </button>
            </div>
          )}

          {!store.live && (
            <button
              type="button"
              className="wb-button wb-model"
              onClick={openSettings}
            >
              <i data-live="false" aria-hidden="true" />
              <span>配置模型</span>
            </button>
          )}

          <button
            type="button"
            className="wb-button wb-find"
            aria-label="查找命令"
            onClick={() => setModal("command")}
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Command size={14} aria-hidden="true" />
            <span>查找</span>
            <kbd className="wb-kbd">Ctrl+K</kbd>
          </button>

          <button
            type="button"
            className="wb-icon"
            onClick={toggleTheme}
            title={theme === "dark" ? "切换浅色模式" : "切换暗色模式"}
            aria-label={theme === "dark" ? "切换浅色模式" : "切换暗色模式"}
          >
            {theme === "dark" ? (
              <Sun size={15} aria-hidden="true" />
            ) : (
              <Moon size={15} aria-hidden="true" />
            )}
          </button>

          {screen !== "study" && (
            <button
              type="button"
              className={showAgent ? "wb-button wb-primary" : "wb-button"}
              aria-expanded={showAgent}
              aria-controls={showAgent ? "wb-agent" : undefined}
              title="切换学习助手 (Ctrl+/)"
              onClick={() => store.setCopilotOpen(!copilotOpen)}
            >
              <PanelRight size={15} aria-hidden="true" />
              <span>学习助手</span>
            </button>
          )}
        </div>
      </header>

      {/* 3. MAIN VIEWPORT + RIGHT AGENT DOCK / INSPECTOR */}
      <div className="wb-content">
        <main
          className={screen === "study" ? "wb-main wb-study" : "wb-main"}
          ref={main}
          aria-label={label}
          data-screen={screen}
        >
          {screen === "study" ? (
            <Classroom openSettings={openSettings} />
          ) : (
            <div className="wb-page">
              {llmTaskStatus.isRunning && (
                <div
                  className="wb-task"
                  data-testid="workspace-task-banner"
                  role="status"
                >
                  <Loader2
                    size={14}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                  <span>
                    学习助手正在后台生成
                    {llmTaskStatus.previewText
                      ? `，已收到 ${llmTaskStatus.previewText.length} 字`
                      : "…"}
                  </span>
                  <button
                    type="button"
                    className="wb-button"
                    onClick={() => store.setCopilotOpen(true)}
                  >
                    查看进度
                  </button>
                  <button
                    type="button"
                    className="wb-button wb-danger"
                    onClick={() => void store.cancelActiveLlmTask()}
                  >
                    停止生成
                  </button>
                </div>
              )}

              {screen === "today" && (
                <>
                  <header className="wb-greeting">
                    <p>{dateLabel}</p>
                    <h1>今天学什么？</h1>
                    {!loaded && <p role="status">正在载入本机工作区…</p>}
                  </header>

                  <article className="wb-focus" aria-label="今日首要学习焦点">
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.div
                        key={nextLesson?.id || "empty-goal"}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={TRANSITION_STATE}
                      >
                        <p>
                          <span aria-hidden="true" />
                          {focusEyebrow}
                        </p>
                        <h2>{nextLesson?.title || "从一个学习目标开始"}</h2>
                        {nextLesson ? (
                          <p>
                            {nextTrack?.title ?? "学习轨道"} · 预计{" "}
                            {nextLesson.minutes} 分钟 · 掌握度{" "}
                            {s.mastery[nextLesson.id] ?? 0}%
                          </p>
                        ) : (
                          <p>
                            输入学习目标，系统将自动联网研究、规划知识图谱并排入无冲突日程。
                          </p>
                        )}
                        <div className="wb-focus-actions">
                          <button
                            type="button"
                            className="wb-button wb-focus-action"
                            onClick={() =>
                              nextLesson
                                ? void openLesson(nextLesson)
                                : setModal("goal")
                            }
                          >
                            {nextLesson ? "进入课堂学习" : "新建学习目标"}
                            <ArrowRight size={15} aria-hidden="true" />
                          </button>
                          {nextLesson && (
                            <button
                              type="button"
                              className="wb-button wb-focus-ghost"
                              onClick={() =>
                                askAssistantWithLesson(
                                  nextLesson,
                                  `请先用一句话告诉我「${nextLesson.title}」解决什么真实问题，并问我一个诊断小问题判断起点。`,
                                )
                              }
                            >
                              <Sparkles size={14} aria-hidden="true" />{" "}
                              让助手先带学热身
                            </button>
                          )}
                        </div>
                      </motion.div>
                    </AnimatePresence>
                    <div className="wb-decoration" aria-hidden="true">
                      <span />
                      <span />
                      <span>
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                      </span>
                    </div>
                  </article>

                  <section className="wb-agenda" aria-labelledby="wb-today-agenda">
                    <header>
                      <h2 id="wb-today-agenda">今日安排</h2>
                      <div className="wb-toolbar">
                        <button
                          type="button"
                          className="wb-button"
                          onClick={() => {
                            store.setDay(now);
                            showAdd();
                          }}
                        >
                          <Plus size={14} aria-hidden="true" /> 添加日程
                        </button>
                        <button
                          type="button"
                          className="wb-button"
                          onClick={() => go("calendar")}
                        >
                          完整日历 <ArrowRight size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </header>
                    {todayBlocks.length ? (
                      <ul>
                        {todayBlocks.map((block) => {
                          const linkedLesson = block.lesson
                            ? getLessonById(s, block.lesson)
                            : undefined;
                          return (
                            <li key={block.id}>
                              <time>{time(block.start)}</time>
                              <i data-done={!!block.done} aria-hidden="true" />
                              <div>
                                <strong>{block.title}</strong>
                                <small>
                                  {block.minutes} 分钟 ·{" "}
                                  {block.done ? "已完成" : block.kind}
                                </small>
                              </div>
                              <div className="wb-toolbar">
                                {linkedLesson && !block.done && (
                                  <button
                                    type="button"
                                    className="wb-button wb-subtle-action"
                                    onClick={() => void openLesson(linkedLesson)}
                                  >
                                    去上课
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="wb-button"
                                  onClick={() => showBlock(block)}
                                >
                                  详情
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <div className="wb-empty">
                        <span>今天还没有排定日程。</span>
                        <button
                          type="button"
                          className="wb-button"
                          onClick={() => {
                            store.setDay(now);
                            showAdd();
                          }}
                        >
                          添加今日安排
                        </button>
                      </div>
                    )}
                  </section>
                </>
              )}

              {screen === "review" && (
                <ReviewQueue
                  openCalendar={() => go("calendar")}
                  onAskLesson={(lesson) =>
                    askAssistantWithLesson(
                      lesson,
                      `我正在复习「${lesson.title}」，请帮我用直观类比或分步图解重新串讲它的核心机制，并给我一道变式检验题。`,
                    )
                  }
                />
              )}

              {screen === "graph" && <StudyGraph openLesson={openLesson} />}

              {screen === "calendar" && (
                <StudyCalendar
                  onBlock={showBlock}
                  onAdd={showAdd}
                  onAskSchedule={() =>
                    askAssistantQuick(
                      `请查看我 ${formatDayWithWeekday(day)} 及未来一周的日历安排，检查是否有冲突或错过学习块，给出最稳妥的重排方案。`,
                    )
                  }
                />
              )}

              {screen === "memory" && <WorkspaceMemory />}
              {screen === "conversations" && <WorkspaceArchive />}
              {screen === "audit" && <WorkspaceArchive audit />}
            </div>
          )}
        </main>

        {/* Draggable Split Resizer for Right AI Assistant Dock */}
        {showAgent && (
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="拖动或按左右方向键调整学习助手宽度，双击恢复默认"
            aria-valuenow={agentWidth}
            aria-valuemin={320}
            aria-valuemax={640}
            className="wb-resizer"
            data-dragging={draggingSplit ? "true" : undefined}
            onPointerDown={startSplitDrag}
            onDoubleClick={() => {
              setAgentWidth(404);
              try {
                localStorage.setItem(AGENT_WIDTH_KEY, "404");
              } catch {}
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                setAgentWidth((w) => Math.min(640, w + 24));
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                setAgentWidth((w) => Math.max(320, w - 24));
              }
            }}
          />
        )}

        {/* Right AI Assistant Dock (Smooth Motion Presence) */}
        <AnimatePresence initial={false}>
          {showAgent && (
            <motion.aside
              key="wb-agent-dock"
              id="wb-agent"
              className="wb-agent"
              style={{ width: `${agentWidth}px` }}
              aria-label="学习助手"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={SPRING_PANEL}
            >
              <div className="wb-agent-body">
                <Agent
                  mode="dock"
                  onOpenModelSettings={openSettings}
                  onCollapseDock={() => store.setCopilotOpen(false)}
                />
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* Today Right Inspector (Quiet Overview, Zero Duplicate CTAs) */}
        {!showAgent && screen === "today" && (
          <aside className="wb-inspector" aria-label="学习概况">
            <h2>当前轨道</h2>
            {active ? (
              <>
                <strong>{active.title}</strong>
                <div className="wb-inspector-stat">
                  <span>已掌握知识点</span>
                  <span>
                    {activeMasteredCount} / {active.units.length}
                  </span>
                </div>
                <progress
                  aria-label="已掌握知识点"
                  max={active.units.length || 1}
                  value={activeMasteredCount}
                />
                <button
                  type="button"
                  className="wb-button"
                  onClick={() => go("graph")}
                >
                  打开知识图谱 <ArrowRight size={14} aria-hidden="true" />
                </button>
              </>
            ) : (
              <p>创建学习目标后，这里会实时展示当前轨道进度。</p>
            )}
            <hr />
            <h2>到期复习</h2>
            <p>
              {reviews.length
                ? `${reviews.length} 个知识点已到最佳回忆窗口`
                : "目前没有到期的复习知识点"}
            </p>
            <button
              type="button"
              className="wb-button"
              onClick={() => go("review")}
            >
              查看复习队列 <ArrowRight size={14} aria-hidden="true" />
            </button>
          </aside>
        )}
      </div>

      {/* 4. CALM BOTTOM STATUS FOOTER (Human Language, Engineering Details Moved to Settings) */}
      <footer className="wb-footer">
        <div className="wb-footer-group">
          <button
            type="button"
            className="wb-footer-btn"
            onClick={openSettings}
            title="管理模型与本机存储"
          >
            <span>
              {loaded
                ? `本地已保存 · ${s.blocks.length} 项日程`
                : "正在载入本机数据…"}
            </span>
          </button>
        </div>
        <div className="wb-footer-group">
          <span data-testid="statusbar-task-state">
            {llmTaskStatus.isRunning
              ? "后台生成中…"
              : llmTaskStatus.status === "failed"
                ? "上次生成失败"
                : "就绪"}
          </span>
        </div>
      </footer>

      {/* 5. MODALS & CONFIRMATIONS */}
      {modal && (
        <ModalFrame
          title={
            {
              goal: "新建学习目标",
              settings: "设置与数据",
              add: "添加日程",
              edit: "编辑日程",
              block: "日程详情",
              command: "查找命令",
            }[modal]
          }
          close={close}
          closeLocked={modal === "goal" && goalBusy}
        >
          {modal === "goal" && (
            <GoalSetup
              onDiscuss={startGoal}
              onBusyChange={setGoalBusy}
              onFinish={() => {
                close();
                go("graph");
              }}
            />
          )}
          {modal === "command" && <Commands commands={commands} />}
          {modal === "settings" && (
            <div className="wb-settings-content">
              <ModelSettingsDialog onClose={close} />

              <div className="wb-settings-storage">
                <div>
                  <h3>本机存储</h3>
                  <p className="wb-form-hint">
                    {dbInfo?.path || "data/learnos.sqlite"}
                    {dbInfo?.sizeBytes
                      ? ` · ${Math.max(4, Math.round(dbInfo.sizeBytes / 1024))} KB`
                      : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className="wb-button"
                  onClick={() => void handleOpenDataFolder()}
                >
                  {isElectronWindow ? (
                    <FolderOpen size={14} aria-hidden="true" />
                  ) : (
                    <Database size={14} aria-hidden="true" />
                  )}
                  <span>{isElectronWindow ? "打开目录" : "查看路径"}</span>
                </button>
              </div>

              <div className="wb-settings-reset">
                <div>
                  <h3>重置工作区</h3>
                  <p className="wb-form-hint">清空轨道、日程、记忆与对话（会先自动备份）</p>
                </div>
                <button
                  type="button"
                  className="wb-button wb-danger"
                  onClick={() => {
                    setModal(null);
                    setReset(true);
                  }}
                >
                  重置数据
                </button>
              </div>
            </div>
          )}
          {(modal === "add" || modal === "edit") && (
            <AddEvent
              s={s}
              day={day}
              initialStart={modal === "add" ? startMin : undefined}
              editing={modal === "edit" ? selectedBlock : null}
              save={(next, targetDay) => {
                store.saveStoreState(next, targetDay, "日程已保存。");
                close();
              }}
            />
          )}
          {modal === "block" && selectedBlock && (
            <div className="wb-block">
              <h3>{selectedBlock.title}</h3>
              <p>
                {formatDayWithWeekday(selectedBlock.day)} ·{" "}
                {time(selectedBlock.start)}–
                {time(selectedBlock.start + selectedBlock.minutes)}
              </p>
              <div className="wb-toolbar">
                {selectedBlock.lesson && (
                  <button
                    type="button"
                    className="wb-button wb-primary"
                    onClick={() => {
                      const lesson = getLessonById(s, selectedBlock.lesson!);
                      close();
                      if (lesson) void openLesson(lesson);
                    }}
                  >
                    进入课堂
                  </button>
                )}
                <button
                  type="button"
                  className="wb-button"
                  onClick={() => {
                    store.attachContext({
                      type: "block",
                      blockId: selectedBlock.id,
                      title: selectedBlock.title,
                      day: selectedBlock.day,
                      start: selectedBlock.start,
                      minutes: selectedBlock.minutes,
                    });
                    store.setCopilotOpen(true);
                    close();
                  }}
                >
                  引用到学习助手
                </button>
                <button
                  type="button"
                  className="wb-button"
                  onClick={() => {
                    store.toggleBlockDone(selectedBlock.id);
                    close();
                  }}
                >
                  {selectedBlock.done ? "标记为未完成" : "标记为已完成"}
                </button>
                <button
                  type="button"
                  className="wb-button"
                  onClick={() => setModal("edit")}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="wb-button wb-danger"
                  onClick={() => {
                    store.deleteBlock(selectedBlock.id);
                    close();
                  }}
                >
                  删除日程
                </button>
              </div>
            </div>
          )}
        </ModalFrame>
      )}

      <ConfirmDangerDialog
        open={reset}
        title="重置本机学习数据？"
        description="重置会清空轨道、日程、记忆和对话。服务端会先创建数据库备份。"
        impacts={[
          `学习轨道：${tracks.length}`,
          `日程：${s.blocks.length}`,
          `学习记忆：${s.memories.length}`,
        ]}
        confirmKeyword="RESET"
        confirmLabel="确认重置"
        onCancel={() => setReset(false)}
        onConfirm={() => {
          setReset(false);
          store.resetDemo();
        }}
      />

      <AnimatePresence>
        {store.toast && (
          <motion.div
            key="wb-toast"
            className="wb-toast"
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={TRANSITION_FAST}
          >
            {store.toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Workbench(props: Props) {
  return (
    <MotionConfig reducedMotion="user">
      <LearningStoreProvider {...props}>
        <WorkbenchShell />
      </LearningStoreProvider>
    </MotionConfig>
  );
}
