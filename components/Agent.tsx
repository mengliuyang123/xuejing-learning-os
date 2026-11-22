"use client";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { TRANSITION_FAST } from "../lib/motion";
import {
  getToolName,
  isToolUIPart,
  type UIMessage,
} from "ai";
import {
  AlertCircle,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  GitFork,
  Layers3,
  Loader2,
  MessageSquarePlus,
  MessagesSquare,
  Minimize2,
  PanelRightClose,
  Paperclip,
  Pencil,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  focusLesson,
  getActiveTrack,
  getLessonById,
  getTracks,
  time,
  type AgentCard,
  type InteractiveCheckCard as InteractiveCheckData,
} from "../lib/learning";
import { getClientTaskManager } from "../lib/llm-task-manager";
import { useLearningStore } from "./LearningStore";
import ReActTrace, {
  isObservationTool,
  type TraceStep,
} from "./gen-ui/ReActTrace";
import RichMarkdown from "./gen-ui/RichMarkdown";
import { InkWashStreamText } from "./gen-ui/InkWashStreamText";
import { triggerSpringPop } from "../lib/spring";
import RescheduleCard from "./gen-ui/RescheduleCard";
import MemorySavedPill from "./gen-ui/MemorySavedPill";
import TrackCreatedCardView from "./gen-ui/TrackCreatedCard";
import ActiveRecallCard from "./gen-ui/ActiveRecallCard";
import InteractiveCheckCard, {
  type PersistedCheckState,
} from "./gen-ui/InteractiveCheckCard";
import MasteryUpdatePill from "./gen-ui/MasteryUpdatePill";
import CalendarUpdatedPill from "./gen-ui/CalendarUpdatedPill";
import VisualResourceCard from "./gen-ui/VisualResourceCard";
import VisualExplanationCard from "./gen-ui/VisualExplanationCard";
import OnboardingSurveyCard from "./gen-ui/OnboardingSurveyCard";
import RoadmapStagesCard from "./gen-ui/RoadmapStagesCard";
import DataChartCard from "./gen-ui/DataChartCard";

const ACTION_TOOL_STATUS: Record<string, string> = {
  save_memory: "正在同步长期记忆…",
  research_learning_topic: "正在研究学习主题并综合结构化知识…",
  fetch_reference_url: "正在读取参考网页摘录…",
  plan_teaching_move: "正在基于真实学习证据规划下一步教学动作…",
  visual_explainer: "正在按当前课程契约构建可分步揭示的高清图解…",
  create_learning_track: "正在构建先修知识图谱并排入无冲突日程…",
  adjust_track_scope: "正在无损调整学习范围、深度与未来排程…",
  manage_calendar_block: "正在更新日历时段…",
  propose_reschedule: "正在核算无冲突重排方案…",
  propose_batch_reschedule: "正在跨日扫描空闲窗口…",
  present_learning_roadmap: "正在整理阶段学习路线…",
  present_onboarding_survey: "正在生成个性化起点问卷…",
  present_data_chart: "正在绘制数据示例表格与坐标图…",
  search_visual_resource: "正在检索百科视觉图解与概念结构图…",
  present_interactive_check: "正在生成交互式测验…",
  record_learning_assessment: "正在以 BKT 与 FSRS 更新掌握度…",
  start_active_recall: "正在准备 FSRS 主动回忆闪卡…",
};

function formatApiError(err: Error | undefined): string {
  if (!err) return "";
  const raw = err.message || "";
  try {
    const parsed = JSON.parse(raw) as { error?: string; message?: string };
    if (parsed.error) return parsed.error;
    if (parsed.message) return parsed.message;
  } catch {}
  if (/401|Authentication Fails|invalid.*api.*key/i.test(raw)) {
    return "大模型鉴权失败（401）：当前 API Key 无效或已过期，请点击「模型设置」检查并更新。";
  }
  if (/429|rate limit/i.test(raw)) {
    return "模型接口触发频率限制（429），请稍后重试。";
  }
  return raw || "大模型请求失败，请检查模型配置与网络连接。";
}

export default function Agent({
  mode = "dock",
  onOpenModelSettings,
  onCollapseDock,
}: {
  mode?: "studio" | "dock";
  onOpenModelSettings: () => void;
  onCollapseDock?: () => void;
}) {
  const {
    s,
    now,
    day,
    live,
    activeModelName,
    modelConfig,
    setDay,
    workspaceTab,
    setWorkspaceTab,
    focusedLessonId,
    setFocusedLessonId,
    openLessonInLearn,
    attachedContext,
    attachContext,
    chatDraft: input,
    setChatDraft: setInput,
    copilotTrigger,
    clearCopilotTrigger,
    removePlan,
    applyRescheduleOption,
    deleteMemory,
    recordFSRSReview,
    setPreviewOption,
    activeThreadId,
    threads,
    setActiveThreadId,
    createNewThread,
    switchToTrackThread,
    deleteThread,
    compactThread,
    setActiveTrackId,
    llmTaskStatus,
  } = useLearningStore();

  const taskManager = getClientTaskManager();
  const [messages, setMessages] = useState<UIMessage[]>(() =>
    taskManager.getThreadMessages(activeThreadId),
  );
  const [taskStatus, setTaskStatus] = useState(() =>
    taskManager.getStatus(activeThreadId),
  );

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [quickPromptsOpen, setQuickPromptsOpen] = useState(false);

  const allTracks = getTracks(s);
  const activeThreadMeta = threads.find((t) => t.threadId === activeThreadId);
  const activeThreadTitle =
    activeThreadMeta?.title ||
    (activeThreadId === "agent-main"
      ? "默认学习对话"
      : activeThreadId.startsWith("track-")
        ? `轨道 · ${
            allTracks.find((t) => `track-${t.id}` === activeThreadId)?.title ||
            "专属对话"
          }`
        : "当前对话");
  const runningThreadIds = new Set(
    llmTaskStatus.activeTasks.map((t) => t.threadId),
  );

  // Find latest unanswered interactive check card across the thread
  const activeUnansweredCheck = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      for (let j = m.parts.length - 1; j >= 0; j--) {
        const p = m.parts[j];
        if (!isToolUIPart(p) || p.state !== "output-available") continue;
        const out = p.output as AgentCard | undefined;
        if (
          out &&
          typeof out === "object" &&
          "kind" in out &&
          out.kind === "interactive_check" &&
          out.savedChoiceIndex === undefined &&
          !(out.savedChoiceIndices && out.savedChoiceIndices.length > 0) &&
          !(out.savedBlanks && Object.keys(out.savedBlanks).length > 0) &&
          !(out.savedOrder && out.savedOrder.length > 0) &&
          !out.savedUserAnswer
        ) {
          return out as InteractiveCheckData;
        }
      }
    }
    return null;
  })();

  function scrollToAndFocusCheck(checkId: string) {
    const cardEl = document.getElementById(`check-card-${checkId}`);
    if (cardEl) {
      cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
      cardEl.classList.add("ring-3", "ring-[#2e5bff]");
      setTimeout(() => {
        cardEl.classList.remove("ring-3", "ring-[#2e5bff]");
      }, 1800);
    }
    setTimeout(() => {
      const inputEl = document.getElementById(
        `check-input-${checkId}`,
      ) as HTMLElement | null;
      inputEl?.focus();
    }, 280);
  }

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastNonceRef = useRef<number>(0);
  const sendStartedAtRef = useRef<number>(0);

  const busy = taskStatus.isRunning;
  const error =
    taskStatus.status === "failed" && taskStatus.errorMessage
      ? new Error(taskStatus.errorMessage)
      : undefined;
  const activeTrack = getActiveTrack(s);
  const currentFocusLesson = activeTrack
    ? focusLesson(s, activeTrack.id)
    : null;
  const selectedLesson =
    (focusedLessonId ? getLessonById(s, focusedLessonId) : undefined) ||
    currentFocusLesson;

  // Dynamic Context-Aware Panel metadata driven by actual selected workspace objects
  const contextPanelMeta = (() => {
    const [, mm = "01", dd = "01"] = (day || now).split("-");
    const dayLabel = `${Number(mm)} 月 ${Number(dd)} 日学习日程`;
    const dayBlockCount = s.blocks.filter((b) => b.day === day).length;
    const todayBlockCount = s.blocks.filter((b) => b.day === now).length;

    if (workspaceTab === "study") {
      const lessonTitle = selectedLesson?.title || activeTrack?.title || "尚未选择课程";
      return {
        contextTitle: selectedLesson
          ? `课程：${selectedLesson.title}`
          : activeTrack
            ? `轨道：${activeTrack.title}`
            : "尚未建立学习轨道",
        contextSub: selectedLesson
          ? `当前掌握度 ${s.mastery[selectedLesson.id] ?? 0}% · 预计 ${selectedLesson.minutes} 分钟`
          : "输入学习目标即可生成结构化课程与日程",
        heading: "关于这节课，你可以问我：",
        prompts: selectedLesson
          ? [
              {
                label: `用图解解释「${selectedLesson.title}」`,
                text: `请用 Mermaid 流程图直观解释「${selectedLesson.title}」的核心执行机制，并配合一个简短例子。`,
              },
              {
                label: "给我一道理解测验",
                text: `请针对「${selectedLesson.title}」给我出一道互动理解测验题（使用 present_interactive_check），并在我作答后评估更新掌握度。`,
              },
            ]
          : [
              {
                label: "帮我规划一个可执行的学习轨道",
                text: "我想系统学习一个新主题，请先了解我的基础和每天可投入时间，再帮我建立课程轨道与日程。",
              },
              {
                label: "从零学习 AI Agent 开发",
                text: "我想从零系统学习 AI Agent 开发（Tool Calling 与 ReAct），请先了解我的基础并帮我规划可执行课程轨道。",
              },
            ],
      };
    }

    if (workspaceTab === "calendar") {
      return {
        contextTitle: dayLabel,
        contextSub:
          dayBlockCount > 0
            ? `该日已安排 ${dayBlockCount} 项日程 · 自动避开睡眠红线`
            : "该日目前空闲，可直接让 AI 安排学习时段",
        heading: "我可以帮助调整学习时间",
        prompts: [
          {
            label: "把今天的课程推迟 30 分钟",
            text: `请帮我把 ${day} 的学习课程推迟 30 分钟，检查是否有冲突或触及睡眠红线。`,
          },
          {
            label: "分析本周学习时间缺口",
            text: "请读取我本周的日程安排和学习轨道，分析是否存在过载或时间缺口，并给出可执行的排期建议。",
          },
        ],
      };
    }

    if (workspaceTab === "graph") {
      const nodeTitle = selectedLesson?.title || activeTrack?.title || "知识图谱";
      return {
        contextTitle: selectedLesson ? `知识点：${nodeTitle}` : "知识路径与先修关系",
        contextSub: selectedLesson
          ? `已验证 BKT 掌握度 ${s.mastery[selectedLesson.id] ?? 0}%`
          : "选中任意知识节点可深入探索其依赖关系",
        heading: "探索当前知识点",
        prompts: selectedLesson
          ? [
              {
                label: "这个知识点有哪些先修关系？",
                text: `请结合我的知识图谱，解释「${selectedLesson.title}」依赖哪些先修知识，以及掌握它之后能解锁哪些进阶主题。`,
              },
              {
                label: "给我一个应用实例",
                text: `请给我一个贴近真实工程场景的「${selectedLesson.title}」应用实例，帮助我理解为什么需要学它。`,
              },
            ]
          : [
              {
                label: "帮我建立一套带先修依赖的学习路线",
                text: "请先了解我的学习目标和基础，为我创建一套带清晰先修关系的知识路径。",
              },
              {
                label: "检查我的薄弱知识节点",
                text: "请读取我的工作区状态，分析目前最需要优先补强的薄弱知识点。",
              },
            ],
      };
    }

    if (
      workspaceTab === "conversations" ||
      workspaceTab === "audit" ||
      workspaceTab === "memory"
    ) {
      return {
        contextTitle: "学习轨迹与全局上下文",
        contextSub: `${allTracks.length} 个轨道 · ${s.blocks.length} 项日程 · ${s.memories.length} 条记忆`,
        heading: "需要我帮你复盘什么？",
        prompts: [
          {
            label: "总结我最近的学习进展与薄弱点",
            text: "请读取我的工作区状态和掌握度记录，帮我总结当前的学习进展、薄弱点和下一步重点。",
          },
          {
            label: "检查最近计划是否需要微调",
            text: "请检查我近期的学习日程和目标进度，看看是否需要调整节奏或补安排复习。",
          },
        ],
      };
    }

    // Default: Today
    return {
      contextTitle: "今日学习计划",
      contextSub:
        todayBlockCount > 0
          ? `今日已排 ${todayBlockCount} 项日程${currentFocusLesson ? ` · 推荐：${currentFocusLesson.title}` : ""}`
          : currentFocusLesson
            ? `下一步推荐：${currentFocusLesson.title}`
            : "尚未建立学习目标，随时可从这里开始",
      heading: "今天需要我帮你做什么？",
      prompts: [
        {
          label: "为什么推荐当前任务？",
          text: "请结合我的先修依赖、当前 BKT 掌握度、到期复习和今日空闲时间，解释为什么推荐当前这个学习任务。",
        },
        {
          label: "今天只有 15 分钟，学什么？",
          text: "我今天只有 15 分钟碎片时间，请根据我当前的学习轨道和掌握度，帮我挑一个最值得立刻完成的 15 分钟微学习或复习任务。",
        },
      ],
    };
  })();

  // Subscribe to decoupled LLMTaskManager for activeThreadId; switching threads or unmounting ONLY unsubscribes, NEVER aborts the stream
  useEffect(() => {
    const tm = getClientTaskManager();
    setMessages(tm.getThreadMessages(activeThreadId));
    setTaskStatus(tm.getStatus(activeThreadId));

    const unsub = tm.subscribe(
      (ev) => {
        setMessages(ev.messages);
        setTaskStatus(tm.getStatus(activeThreadId));
      },
      { threadId: activeThreadId },
    );

    void tm.hydrateThread(activeThreadId).then((msgs) => {
      setMessages(msgs);
      setTaskStatus(tm.getStatus(activeThreadId));
    });

    return () => {
      unsub();
    };
  }, [activeThreadId]);

  useEffect(() => {
    if (attachedContext) {
      inputRef.current?.focus();
    }
  }, [attachedContext]);

  // Handle external triggers when needed
  useEffect(() => {
    if (
      copilotTrigger &&
      copilotTrigger.nonce !== lastNonceRef.current &&
      !busy
    ) {
      lastNonceRef.current = copilotTrigger.nonce;
      const { prompt } = copilotTrigger;
      clearCopilotTrigger();
      send(prompt);
    }
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, busy]);

  function send(text: string) {
    const clean = text.trim();
    if (!clean || busy) return;
    setPreviewOption(null);
    const ctxSnapshot = attachedContext;
    void taskManager.start({
      threadId: activeThreadId,
      userText: clean,
      modelLabel: activeModelName || "Live LLM",
      requestPayload: {
        state: s,
        day: now,
        activeTrackId: s.activeTrackId,
        attachedContext: ctxSnapshot,
        clientModelConfig: modelConfig,
      },
    });
    setInput("");
    if (ctxSnapshot) attachContext(null);
  }

  function retryCurrentTask() {
    if (busy) return;
    void taskManager.retry(activeThreadId, {
      state: s,
      day: now,
      activeTrackId: s.activeTrackId,
      attachedContext,
      clientModelConfig: modelConfig,
    });
  }

  function handleEditSubmit(msgId: string) {
    const clean = editingText.trim();
    if (!clean || busy) return;
    const idx = messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    const truncated = messages.slice(0, idx);
    setEditingMsgId(null);
    setEditingText("");
    void taskManager.start({
      threadId: activeThreadId,
      userText: clean,
      baseMessages: truncated,
      modelLabel: activeModelName || "Live LLM",
      requestPayload: {
        state: s,
        day: now,
        activeTrackId: s.activeTrackId,
        attachedContext,
        clientModelConfig: modelConfig,
      },
    });
  }

  function persistInteractiveCheckAnswer(
    toolCallId: string,
    persistedState: PersistedCheckState,
  ) {
    taskManager.updateToolOutput(activeThreadId, toolCallId, persistedState);
  }

  function copyMessageText(msgId: string, text: string) {
    void navigator.clipboard?.writeText(text);
    setCopiedId(msgId);
    setTimeout(() => setCopiedId(null), 1800);
  }

  function clearHistory() {
    setPreviewOption(null);
    void taskManager.clearThread(activeThreadId);
  }

  function renderActionCard(
    card: AgentCard | { error?: string },
    toolCallId: string,
  ) {
    if (!card || typeof card !== "object") return null;
    if ("error" in card && card.error && !("kind" in card)) {
      return (
        <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
          {card.error}
        </div>
      );
    }
    if (!("kind" in card)) return null;

    if (card.kind === "reschedule") {
      return (
        <RescheduleCard
          proposal={card}
          onApply={(opt) => applyRescheduleOption(opt)}
          onPreview={(opt) => {
            setPreviewOption(opt);
            if (opt) {
              setWorkspaceTab("calendar");
              const firstDay =
                opt.changes[0]?.newSlots[0]?.day || opt.insertEvent?.day;
              if (firstDay) setDay(firstDay);
            }
          }}
        />
      );
    }
    if (card.kind === "memory_saved") {
      return (
        <MemorySavedPill card={card} onUndo={(id) => deleteMemory(id)} />
      );
    }
    if (card.kind === "track_created") {
      return (
        <TrackCreatedCardView
          card={card}
          onOpenLesson={(lessonId) => {
            openLessonInLearn(lessonId, {
              trackId: card.plan.id,
              mode: "learn",
            });
          }}
          onOpenMap={() => setWorkspaceTab("graph")}
          onUndo={(planId) => removePlan(planId)}
        />
      );
    }
    if (card.kind === "visual_resource") {
      return <VisualResourceCard card={card} />;
    }
    if (card.kind === "visual_explanation") {
      return <VisualExplanationCard card={card} compact />;
    }
    if (card.kind === "roadmap_stages") {
      return <RoadmapStagesCard card={card} />;
    }
    if (card.kind === "data_chart") {
      return <DataChartCard card={card} />;
    }
    if (card.kind === "onboarding_survey") {
      return (
        <OnboardingSurveyCard
          card={card}
          disabled={busy}
          onSubmitSurvey={(msg, selections) => {
            taskManager.updateToolOutput(activeThreadId, toolCallId, {
              savedSelections: selections,
            });
            send(msg);
          }}
        />
      );
    }
    if (card.kind === "interactive_check") {
      const targetLessonId =
        card.lessonId || selectedLesson?.id || currentFocusLesson?.id || "";
      const exId = card.exerciseId || card.checkId;
      const modeNameMap: Record<string, string> = {
        order_steps: "流程排序练习",
        choice: "单选辨析练习",
        multi_choice: "多选综合练习",
        fill_blank: "代码 / 概念填空",
        code: "动手编程实战",
        short_answer: "原理解释练习",
      };
      return (
        <div className="rounded-xl border border-[#e5e7eb] bg-[#f7f8fa] p-3.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 font-semibold text-[#16181d]">
              <BookOpen size={13} className="text-[#1f4fd6]" />
              {modeNameMap[card.mode] || "互动练习"}
            </span>
            <span className="font-mono text-[10px] text-[#8a909d]">
              {exId}
            </span>
          </div>
          <p className="mt-1.5 line-clamp-2 leading-relaxed text-[#525866]">
            {card.prompt}
          </p>
          <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-[#e5e7eb] pt-2.5">
            <span className="text-[11px] text-[#636975]">
              已在 Learn 练习区就绪（确定性评分）
            </span>
            <button
              type="button"
              onClick={() => {
                if (targetLessonId) {
                  openLessonInLearn(targetLessonId, {
                    mode: "practice",
                    exerciseId: exId,
                  });
                } else {
                  setWorkspaceTab("study");
                }
              }}
              className="rounded-md bg-[var(--ve-accent)] px-3 py-1 text-[11px] font-medium text-white hover:opacity-90"
            >
              在课堂中作答
            </button>
          </div>
        </div>
      );
    }
    if (card.kind === "mastery_update") {
      return (
        <MasteryUpdatePill
          card={card}
          onOpenGraph={(lid) => {
            if (lid) setFocusedLessonId(lid);
            setWorkspaceTab("graph");
          }}
          onSelectNextStep={(step) => {
            if (step.targetLessonId) {
              const target = getLessonById(s, step.targetLessonId);
              if (target) {
                attachContext({
                  type: "lesson",
                  lessonId: target.id,
                  title: target.title,
                  mastery: s.mastery[target.id] ?? 0,
                });
              }
            }
            if (step.prompt) send(step.prompt);
          }}
        />
      );
    }
    if (card.kind === "calendar_updated") {
      return (
        <CalendarUpdatedPill
          card={card}
          onFocusCalendar={(targetDay) => {
            setDay(targetDay);
            setWorkspaceTab("calendar");
          }}
        />
      );
    }
    if (card.kind === "active_recall") {
      return (
        <ActiveRecallCard
          card={card}
          onRate={(lessonId, rating) => recordFSRSReview(lessonId, rating)}
        />
      );
    }
    return null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ve-canvas)] text-[var(--ve-ink)]">
      {/* Header with Clean Session / Track Thread Switcher */}
      <div className="relative flex h-12 shrink-0 items-center justify-between gap-2 border-b border-[var(--ve-border)] bg-[var(--ve-canvas)] px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            data-testid="thread-switcher-btn"
            aria-expanded={threadMenuOpen}
            aria-haspopup="menu"
            onClick={() => setThreadMenuOpen((v) => !v)}
            className="flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1.5 text-left text-xs font-semibold text-[var(--ve-ink)] transition hover:border-[var(--ve-accent)]"
          >
            <MessagesSquare
              size={13}
              aria-hidden="true"
              className="shrink-0 text-[var(--ve-accent)]"
            />
            <span className="truncate">{activeThreadTitle}</span>
            <span className="shrink-0 font-mono text-[10.5px] font-medium text-[var(--ve-muted)]">
              {messages.length}
            </span>
            {activeThreadMeta?.hasSummary && (
              <span
                title="早期对话已自动浓缩为摘要"
                className="hidden shrink-0 rounded bg-[var(--ve-accent-soft)] px-1 py-0.2 text-[9.5px] font-medium text-[var(--ve-accent)] sm:inline"
              >
                摘要
              </span>
            )}
            <ChevronDown
              size={13}
              aria-hidden="true"
              className={
                "shrink-0 text-[var(--ve-muted)] transition-transform duration-150 " +
                (threadMenuOpen ? "rotate-180" : "")
              }
            />
          </button>

          {mode !== "dock" && (
            <span
              className={
                "hidden shrink-0 rounded-full px-1.5 py-0.2 text-[10px] font-medium sm:inline " +
                (live
                  ? "bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]"
                  : "bg-[var(--ve-amber-soft)] text-[var(--ve-amber)]")
              }
            >
              {live ? activeModelName || "已连接" : "未配置"}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            data-testid="new-chat-btn"
            onClick={() => void createNewThread()}
            title="新建干净对话（不影响轨道、日历与记忆）"
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--ve-ink)] transition hover:border-[var(--ve-accent)] hover:text-[var(--ve-accent)]"
          >
            <MessageSquarePlus size={12} aria-hidden="true" />
            <span className="hidden sm:inline">新对话</span>
          </button>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clearHistory}
              title="清空当前对话消息"
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11.5px] font-medium text-[var(--ve-muted)] transition hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
            >
              <Trash2 size={12} aria-hidden="true" />
              <span className="hidden md:inline">清空</span>
            </button>
          )}
          {mode === "dock" && onCollapseDock && (
            <button
              type="button"
              onClick={onCollapseDock}
              title="收起学习助手"
              aria-label="收起学习助手"
              className="rounded-lg p-1.5 text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)] md:hidden"
            >
              <PanelRightClose size={15} aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Full-Width Aligned Popover Menu (Never Clips Off Screen) */}
        <AnimatePresence>
          {threadMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                onClick={() => setThreadMenuOpen(false)}
              />
              <motion.div
                key="thread-switcher-menu"
                data-testid="thread-switcher-menu"
                role="menu"
                initial={{ opacity: 0, y: -4, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.985 }}
                transition={TRANSITION_FAST}
                className="absolute inset-x-3 top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] shadow-xl"
              >
                {/* Track-Scoped Threads */}
                {allTracks.length > 0 && (
                  <div className="border-b border-[var(--ve-border)] p-1.5">
                    <div className="flex items-center justify-between px-2 py-1 text-[10.5px] font-semibold text-[var(--ve-muted)]">
                      <span>轨道专属对话</span>
                      <span className="font-mono font-normal">
                        {allTracks.length}
                      </span>
                    </div>
                    <div className="max-h-36 space-y-0.5 overflow-y-auto">
                      {allTracks.map((tr) => {
                        const tid = `track-${tr.id}`;
                        const meta = threads.find((t) => t.threadId === tid);
                        const isCurrent = activeThreadId === tid;
                        const isGen = runningThreadIds.has(tid);
                        return (
                          <button
                            key={tr.id}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setActiveTrackId(tr.id);
                              void switchToTrackThread(tr.id, tr.title);
                              setThreadMenuOpen(false);
                            }}
                            className={
                              "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition " +
                              (isCurrent
                                ? "bg-[var(--ve-accent-soft)] font-semibold text-[var(--ve-accent)]"
                                : "text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]")
                            }
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <GitFork
                                size={12}
                                aria-hidden="true"
                                className={
                                  isCurrent
                                    ? "shrink-0 text-[var(--ve-accent)]"
                                    : "shrink-0 text-[var(--ve-muted)]"
                                }
                              />
                              <span className="truncate">{tr.title}</span>
                              {meta?.hasSummary && (
                                <span className="shrink-0 rounded bg-[var(--ve-canvas)] px-1 py-0.2 text-[9.5px] font-medium text-[var(--ve-accent)]">
                                  摘要
                                </span>
                              )}
                            </span>
                            {isGen ? (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--ve-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ve-accent)]">
                                <Loader2
                                  size={9}
                                  className="animate-spin"
                                  aria-hidden="true"
                                />
                                生成中
                              </span>
                            ) : (
                              <span className="shrink-0 font-mono text-[10.5px] font-normal text-[var(--ve-muted)]">
                                {meta?.messageCount ?? 0} 条
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* General / Non-Track Chat Threads (Deduplicated from Track-Scoped list) */}
                {(() => {
                  const trackThreadIds = new Set(
                    allTracks.map((tr) => `track-${tr.id}`),
                  );
                  const generalThreads = threads.filter(
                    (th) => !trackThreadIds.has(th.threadId),
                  );
                  const showDefaultFallback = !generalThreads.some(
                    (t) => t.threadId === "agent-main",
                  );
                  const displayCount =
                    generalThreads.length + (showDefaultFallback ? 1 : 0);
                  return (
                    <div className="p-1.5">
                      <div className="flex items-center justify-between px-2 py-1 text-[10.5px] font-semibold text-[var(--ve-muted)]">
                        <span>自由对话</span>
                        <span className="font-mono font-normal">
                          {displayCount}
                        </span>
                      </div>
                      <div className="max-h-48 space-y-0.5 overflow-y-auto">
                        {showDefaultFallback && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setActiveThreadId("agent-main");
                              setThreadMenuOpen(false);
                            }}
                            className={
                              "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition " +
                              (activeThreadId === "agent-main"
                                ? "bg-[var(--ve-accent-soft)] font-semibold text-[var(--ve-accent)]"
                                : "text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]")
                            }
                          >
                            <span className="truncate">默认学习对话</span>
                            <span className="font-mono text-[10.5px] text-[var(--ve-muted)]">
                              0 条
                            </span>
                          </button>
                        )}
                        {generalThreads.map((th) => {
                          const isCurrent = th.threadId === activeThreadId;
                          const isGen = runningThreadIds.has(th.threadId);
                          return (
                            <div
                              key={th.threadId}
                              className={
                                "group flex items-center justify-between gap-1 rounded-lg px-2.5 py-1.5 transition " +
                                (isCurrent
                                  ? "bg-[var(--ve-accent-soft)] text-[var(--ve-accent)]"
                                  : "text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]")
                              }
                            >
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setActiveThreadId(th.threadId);
                                  if (th.trackId) setActiveTrackId(th.trackId);
                                  setThreadMenuOpen(false);
                                }}
                                className="min-w-0 flex-1 text-left"
                              >
                                <div className="flex items-center gap-1.5 text-xs font-medium">
                                  <span className="truncate">{th.title}</span>
                                  {th.hasSummary && (
                                    <span className="shrink-0 rounded bg-[var(--ve-canvas)] px-1 py-0.2 text-[9.5px] text-[var(--ve-accent)]">
                                      摘要
                                    </span>
                                  )}
                                  {isGen && (
                                    <Loader2
                                      size={10}
                                      className="shrink-0 animate-spin text-[var(--ve-accent)]"
                                      aria-hidden="true"
                                    />
                                  )}
                                </div>
                                <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-[var(--ve-muted)]">
                                  <span className="shrink-0 font-mono">
                                    {th.messageCount} 条
                                  </span>
                                  {th.preview && (
                                    <span className="truncate opacity-80">
                                      · {th.preview}
                                    </span>
                                  )}
                                </div>
                              </button>
                              {th.threadId !== "agent-main" && (
                                <button
                                  type="button"
                                  title="删除此对话"
                                  aria-label={`删除对话 ${th.title}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void deleteThread(th.threadId);
                                  }}
                                  className="rounded p-1 text-[var(--ve-muted)] opacity-0 transition hover:bg-[var(--ve-rose-soft)] hover:text-[var(--ve-rose)] group-hover:opacity-100 focus-visible:opacity-100"
                                >
                                  <Trash2 size={12} aria-hidden="true" />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* Compact Contextual Footer (Only when compaction is useful) */}
                {messages.length >= 6 && (
                  <div className="flex items-center justify-end border-t border-[var(--ve-border)] bg-[var(--ve-canvas)] px-2.5 py-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        void compactThread(activeThreadId);
                        setThreadMenuOpen(false);
                      }}
                      title="将早期对话浓缩为滚动摘要，节省上下文占用"
                      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--ve-ink)] transition hover:border-[var(--ve-accent)] hover:text-[var(--ve-accent)]"
                    >
                      <Minimize2 size={11} aria-hidden="true" /> 压缩当前上下文
                    </button>
                  </div>
                )}
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      {/* Studio Context Strip when inside Study Studio and an active track exists */}
      {mode === "studio" && activeTrack && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--ve-border)] bg-[var(--ve-surface)] px-5 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-[var(--ve-ink)]">
              当前轨道：{activeTrack.title}
            </span>
            {currentFocusLesson && (
              <span className="text-[var(--ve-muted)]">
                · 焦点节点：「{currentFocusLesson.title}」（掌握度{" "}
                {s.mastery[currentFocusLesson.id] ?? 0}%）
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {currentFocusLesson && (
              <button
                type="button"
                onClick={() =>
                  attachContext({
                    type: "lesson",
                    lessonId: currentFocusLesson.id,
                    title: currentFocusLesson.title,
                    mastery: s.mastery[currentFocusLesson.id] ?? 0,
                  })
                }
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-2.5 py-1 text-[11px] font-medium text-[var(--ve-accent)] hover:bg-[var(--ve-accent-soft)]"
              >
                <BookOpen size={11} /> 引用焦点课程
              </button>
            )}
            <button
              type="button"
              onClick={() => setWorkspaceTab("graph")}
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-2.5 py-1 text-[11px] font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
            >
              <GitFork size={11} /> 打开知识图谱
            </button>
          </div>
        </div>
      )}

      {/* Message Stream */}
      <div
        className="flex-1 overflow-y-auto px-4 py-5 sm:px-6"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <div className="mx-auto flex h-full max-w-md flex-col justify-center py-4">
            <div className="space-y-4">
              <div className="rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-4 py-3">
                <div className="text-[11px] text-[var(--ve-muted)]">当前上下文</div>
                <div className="mt-0.5 text-[13.5px] font-semibold text-[var(--ve-ink)]">
                  {contextPanelMeta.contextTitle}
                </div>
                <div className="mt-0.5 text-xs text-[var(--ve-muted)]">
                  {contextPanelMeta.contextSub}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-[var(--ve-muted)]">
                  {contextPanelMeta.heading}
                </div>
                <div className="divide-y divide-[var(--ve-border)] overflow-hidden rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)]">
                  {contextPanelMeta.prompts.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      disabled={busy}
                      onClick={() => send(p.text)}
                      className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left text-xs font-medium text-[var(--ve-ink)] transition hover:bg-[var(--ve-surface-alt)] disabled:opacity-40"
                    >
                      <span>{p.label}</span>
                      <ArrowUpRight
                        size={13}
                        className="shrink-0 text-[var(--ve-muted)]"
                      />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {!live && (
              <div className="mt-5 w-full rounded-xl border border-amber-200 bg-amber-50/75 p-3.5 text-left">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                  <AlertCircle size={14} className="text-amber-600" />
                  尚未配置有效大模型 API Key
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-amber-800/90">
                  所有教学、Mermaid 图解、出题与排程均由真实大模型实时生成。请先配置并测试连接。
                </p>
                <button
                  type="button"
                  onClick={onOpenModelSettings}
                  className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-[#121826] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1f2937]"
                >
                  <Cpu size={13} /> 打开模型设置
                </button>
              </div>
            )}
          </div>
        ) : (
          <div
            className={
              "mx-auto space-y-5 " +
              (mode === "studio" ? "max-w-3xl" : "max-w-xl")
            }
          >
            {messages.map((m, msgIdx) => {
              if (m.role === "user") {
                const text = m.parts
                  .filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join("");
                const isEditing = editingMsgId === m.id;

                return (
                  <div
                    key={m.id}
                    className="group animate-msg-in flex flex-col items-end"
                  >
                    {isEditing ? (
                      <div className="w-full max-w-[90%] rounded-2xl border border-[var(--ve-accent)] bg-[var(--ve-surface)] p-3 shadow-xs">
                        <textarea
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          rows={3}
                          className="w-full resize-none bg-transparent text-xs leading-relaxed text-[var(--ve-ink)] outline-none"
                        />
                        <div className="mt-2 flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setEditingMsgId(null)}
                            className="rounded-lg border border-[var(--ve-border)] px-2.5 py-1 text-[11px] text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            onClick={() => handleEditSubmit(m.id)}
                            className="rounded-lg bg-[var(--ve-accent)] px-3 py-1 text-[11px] font-medium text-white hover:opacity-90"
                          >
                            重新发送
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="max-w-[85%] whitespace-pre-wrap rounded-3xl bg-[var(--ve-accent-soft)] px-4 py-2.5 text-[14px] font-medium leading-relaxed text-[var(--ve-ink)]">
                          {text}
                        </div>
                        <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setEditingMsgId(m.id);
                              setEditingText(text);
                            }}
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
                            title="编辑并重新提问"
                          >
                            <Pencil size={10} /> 编辑
                          </button>
                          <button
                            type="button"
                            onClick={() => copyMessageText(m.id, text)}
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
                            title="复制"
                          >
                            {copiedId === m.id ? (
                              <Check size={10} className="text-[var(--ve-emerald)]" />
                            ) : (
                              <Copy size={10} />
                            )}
                            {copiedId === m.id ? "已复制" : "复制"}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              }

              // Assistant message
              const obsSteps: TraceStep[] = [];
              const thoughts: string[] = [];
              let thinking = false;
              const renderedItems: React.ReactNode[] = [];
              const plainTexts: string[] = [];
              const isActivelyStreaming =
                busy && msgIdx === messages.length - 1;
              const interruptedToolLabels: string[] = [];

              m.parts.forEach((p, idx) => {
                if (p.type === "reasoning") {
                  if (p.text) thoughts.push(p.text);
                  if (p.state === "streaming" && isActivelyStreaming) {
                    thinking = true;
                  }
                  return;
                }
                if (isToolUIPart(p)) {
                  const name = getToolName(p);
                  if (isObservationTool(name)) {
                    obsSteps.push({
                      id: p.toolCallId,
                      toolName: name,
                      state: p.state,
                      input: p.input,
                      output:
                        p.state === "output-available" ? p.output : undefined,
                    });
                  } else if (p.state === "output-available") {
                    const node = renderActionCard(
                      p.output as AgentCard,
                      p.toolCallId,
                    );
                    if (node) {
                      renderedItems.push(
                        <div
                          key={p.toolCallId}
                          className="animate-msg-in mt-2.5"
                        >
                          {node}
                        </div>,
                      );
                    }
                  } else if (p.state === "output-error") {
                    const errText =
                      "errorText" in p && typeof p.errorText === "string"
                        ? p.errorText
                        : "工具调用未能完成，请点击「重新生成」重试。";
                    renderedItems.push(
                      <div
                        key={p.toolCallId}
                        className="mt-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/90 px-3 py-2 text-xs text-amber-900"
                      >
                        <AlertCircle
                          size={13}
                          className="mt-0.5 shrink-0 text-amber-600"
                        />
                        <span>{errText}</span>
                      </div>,
                    );
                  } else if (isActivelyStreaming) {
                    renderedItems.push(
                      <div
                        key={p.toolCallId}
                        className="mt-2 flex items-center gap-2 rounded-xl border border-[#e5eaf5] bg-[#f8faff] px-3 py-2 text-xs text-[#4b5d83]"
                      >
                        <Loader2
                          size={13}
                          className="animate-spin text-[#2e5bff]"
                        />
                        {ACTION_TOOL_STATUS[name] || "正在执行工具…"}
                      </div>,
                    );
                  } else {
                    // Stream already finished/interrupted while this tool call was still pending:
                    // NEVER show an eternal spinner — collect into a single clear recovery notice.
                    const label = (
                      ACTION_TOOL_STATUS[name] || name
                    ).replace(/…$/, "");
                    if (!interruptedToolLabels.includes(label)) {
                      interruptedToolLabels.push(label);
                    }
                  }
                } else if (p.type === "text" && p.text.trim()) {
                  const cleanedText = p.text.replace(
                    /在右侧(作答|回答|输入框)/g,
                    "在题目卡片中$1",
                  );
                  plainTexts.push(cleanedText);
                  renderedItems.push(
                    <div key={`text-${idx}`} className="mt-2">
                      {isActivelyStreaming ? (
                        <InkWashStreamText text={cleanedText} />
                      ) : (
                        <RichMarkdown content={cleanedText} />
                      )}
                    </div>,
                  );
                }
              });

              if (interruptedToolLabels.length > 0) {
                renderedItems.push(
                  <div
                    key={`${m.id}-interrupted-tools`}
                    className="mt-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/90 px-3 py-2.5 text-xs text-amber-900"
                  >
                    <AlertCircle
                      size={14}
                      className="mt-0.5 shrink-0 text-amber-600"
                    />
                    <div>
                      <div className="font-medium">
                        以下操作因输出截断或流中断未能执行：
                        {interruptedToolLabels.join("、")}
                      </div>
                      <div className="mt-0.5 text-[11px] text-amber-800/85">
                        已自动放宽思考与输出令牌预算，请点击下方「重新生成」立即继续建轨。
                      </div>
                    </div>
                  </div>,
                );
              }

              const combinedText = plainTexts.join("\n\n");
              const isLastAssistant = msgIdx === messages.length - 1;

              return (
                <div
                  key={m.id}
                  className="group animate-msg-in space-y-3 py-2"
                >
                  {(obsSteps.length > 0 || thoughts.length > 0 || thinking) && (
                    <ReActTrace
                      steps={obsSteps}
                      thoughts={thoughts}
                      thinking={thinking}
                    />
                  )}
                  {renderedItems}

                  {/* Message Action Toolbar (Copy / Retry / Jump to Check) */}
                  {!busy && (combinedText || renderedItems.length > 0) && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--ve-border)] pt-2 opacity-85 transition-opacity group-hover:opacity-100">
                      {isLastAssistant && activeUnansweredCheck && (
                        <button
                          type="button"
                          onClick={() =>
                            scrollToAndFocusCheck(activeUnansweredCheck.checkId)
                          }
                          className="inline-flex items-center gap-1 rounded-md bg-[var(--ve-accent-soft)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--ve-accent)] hover:opacity-90"
                        >
                          去作答
                        </button>
                      )}
                      {combinedText && (
                        <button
                          type="button"
                          onClick={() => copyMessageText(m.id, combinedText)}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
                        >
                          {copiedId === m.id ? (
                            <Check size={11} className="text-[var(--ve-emerald)]" />
                          ) : (
                            <Copy size={11} />
                          )}
                          {copiedId === m.id ? "已复制全文" : "复制"}
                        </button>
                      )}
                      {isLastAssistant && (
                        <button
                          type="button"
                          onClick={retryCurrentTask}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
                        >
                          <RotateCcw size={11} /> 重新生成
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {busy && (() => {
              const lastMsg = messages.at(-1);
              const hasActiveChildIndicator =
                lastMsg?.role === "assistant" &&
                lastMsg.parts.some((p) => {
                  if (p.type === "reasoning" && p.text?.trim()) return true;
                  if (p.type === "text" && p.text?.trim()) return true;
                  if (
                    (p.type.startsWith("tool-") || p.type === "dynamic-tool") &&
                    "state" in p &&
                    (p.state === "input-streaming" ||
                      p.state === "input-available")
                  ) {
                    return true;
                  }
                  return false;
                });
              if (hasActiveChildIndicator) return null;
              return (
                <div className="flex items-center gap-2 rounded-xl bg-[var(--surface-1)] px-3 py-2 text-xs text-[var(--muted)]">
                  <Loader2
                    size={13}
                    className="animate-spin text-[var(--blue)]"
                  />
                  <span>正在分析与准备响应…</span>
                </div>
              );
            })()}

            {!busy &&
              (taskStatus.status === "interrupted" ||
                taskStatus.status === "cancelled") && (
                <div className="rounded-xl border border-amber-200 bg-amber-50/85 p-3 text-xs text-amber-900">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <AlertCircle
                        size={14}
                        className="shrink-0 text-amber-600"
                      />
                      <span>
                        {taskStatus.status === "interrupted"
                          ? "上次生成任务在应用关闭或进程重启时中断（已保留已输出内容，状态已标记为 interrupted）。"
                          : "本次生成已由用户手动取消（已保留已输出内容）。"}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={retryCurrentTask}
                      className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
                    >
                      <RotateCcw size={11} /> 重新生成
                    </button>
                  </div>
                </div>
              )}

            {error && (
              <div className="rounded-xl border border-rose-200 bg-rose-50/85 p-3.5 text-xs text-rose-900">
                <div className="flex items-start gap-2">
                  <AlertCircle
                    size={15}
                    className="mt-0.5 shrink-0 text-rose-600"
                  />
                  <div className="flex-1 space-y-2">
                    <p className="leading-relaxed font-medium">
                      {formatApiError(error)}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={onOpenModelSettings}
                        className="inline-flex items-center gap-1 rounded-lg bg-rose-700 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-rose-800"
                      >
                        <Cpu size={12} /> 检查模型设置
                      </button>
                      <button
                        type="button"
                        onClick={retryCurrentTask}
                        className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-medium text-rose-800 hover:bg-rose-100"
                      >
                        <RotateCcw size={12} /> 重试
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Bottom Composer */}
      <div className="shrink-0 border-t border-[var(--ve-border)] bg-[var(--ve-canvas)] px-4 py-3">
        <div
          className={
            "mx-auto " + (mode === "studio" ? "max-w-3xl" : "max-w-xl")
          }
        >
          {activeUnansweredCheck && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-accent-soft)] px-3 py-1.5 text-xs text-[var(--ve-ink)]">
              <span className="truncate">
                当前有待完成题目
                {activeUnansweredCheck.lessonTitle
                  ? `「${activeUnansweredCheck.lessonTitle}」`
                  : ""}
                （在题目卡片内提交才会更新掌握度）
              </span>
              <button
                type="button"
                onClick={() =>
                  scrollToAndFocusCheck(activeUnansweredCheck.checkId)
                }
                className="shrink-0 rounded-lg bg-[var(--ve-accent)] px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90"
              >
                去作答
              </button>
            </div>
          )}

          {attachedContext && (
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-accent-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--ve-ink)]">
                <Paperclip size={11} />
                {attachedContext.type === "lesson" ? (
                  <>
                    <BookOpen size={11} />
                    课程：{attachedContext.title}（掌握度{" "}
                    {attachedContext.mastery}%）
                  </>
                ) : (
                  <>
                    <CalendarDays size={11} />
                    日程：{attachedContext.day.slice(5)}{" "}
                    {time(attachedContext.start)} {attachedContext.title}
                  </>
                )}
                <button
                  type="button"
                  onClick={() => attachContext(null)}
                  aria-label="移除上下文"
                  className="ml-0.5 rounded p-0.5 hover:bg-[#dfe8ff]"
                >
                  <X size={11} />
                </button>
              </span>
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="composer-shell flex items-end gap-2 rounded-2xl px-3.5 py-2"
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  e.nativeEvent.keyCode !== 229
                ) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder={live ? "输入消息…" : "请先配置 API Key"}
              rows={2}
              className="max-h-40 min-h-[42px] flex-1 resize-none bg-transparent py-1 text-[13px] leading-relaxed text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
            />
            {busy ? (
              <button
                type="button"
                onClick={() => {
                  // TASK-11: Ignore accidental second click from double-clicking the Send button
                  if (Date.now() - sendStartedAtRef.current < 450) return;
                  void taskManager.cancel(activeThreadId);
                }}
                aria-label="停止生成"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--ink)] text-[var(--surface-2)] hover:opacity-90"
              >
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                aria-label="发送"
                onClick={(e) => {
                  sendStartedAtRef.current = Date.now();
                  triggerSpringPop(e.currentTarget);
                }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--blue)] text-white hover:opacity-90 disabled:opacity-35"
              >
                <ArrowUp size={15} />
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
