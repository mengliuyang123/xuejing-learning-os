"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRight,
  CalendarDays,
  ChevronRight,
  Lock,
  Sparkles,
} from "lucide-react";
import ActiveRecallCard from "../gen-ui/ActiveRecallCard";
import FeasibilityAlertCard from "../gen-ui/FeasibilityAlertCard";
import MissedSessionsBanner from "../gen-ui/MissedSessionsBanner";
import KnowledgeFlowMap from "../KnowledgeFlowMap";
import LearnWorkspace from "../LearnWorkspace";
import { useLearningStore } from "../LearningStore";
import { Agenda, CalendarBacklogPanel } from "../Planner";
import {
  buildActiveRecallCard,
  dueReviews,
  formatDayWithWeekday,
  getLessonById,
  getMissedSessions,
  getTrackForLesson,
  time,
  type Block,
  type DbInfo,
  type Lesson,
  type Store,
} from "../../lib/learning";
import type { PlanDraftRecord } from "../../lib/learning-engine-types";
import { analyzeScheduleFeasibility, isLockedBlock } from "../../lib/scheduler";
import { TRANSITION_FAST, TRANSITION_STATE } from "../../lib/motion";

export function PageHeading({
  id,
  title,
  context,
  actions,
}: {
  id: string;
  title: string;
  context?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="wb-view-heading">
      <div>
        <h1 id={id}>{title}</h1>
        {context && <p>{context}</p>}
      </div>
      {actions && <div className="wb-toolbar">{actions}</div>}
    </header>
  );
}

/** 课堂像阅读器 */
export function Classroom({ openSettings }: { openSettings: () => void }) {
  return (
    <div className="wb-classroom" aria-label="课程目录、课堂阅读与学习助手">
      <LearnWorkspace onOpenModelSettings={openSettings} />
    </div>
  );
}

/** 图谱像地图 — 去掉重复大标题，直接展开空间地图 */
export function StudyGraph({
  openLesson,
}: {
  openLesson: (lesson: Lesson) => void;
}) {
  return (
    <section className="wb-study-view wb-graph-view" aria-label="知识图谱">
      <div className="wb-graph-module">
        <KnowledgeFlowMap onStartStudyLesson={openLesson} />
      </div>
    </section>
  );
}

/** 复习像题卡 — 左侧精简队列 + 右侧专注题卡区（带切换过渡） */
export function ReviewQueue({
  openCalendar,
  onAskLesson,
}: {
  openCalendar: () => void;
  onAskLesson?: (lesson: Lesson) => void;
}) {
  const { s, now, loaded, recordFSRSReview, autoScheduleDueReviews } =
    useLearningStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const queue = dueReviews(s, now);
  const effectiveId =
    selectedId && queue.some((q) => q.lesson.id === selectedId)
      ? selectedId
      : queue[0]?.lesson.id ?? null;
  const current = effectiveId ? getLessonById(s, effectiveId) : undefined;
  const detail = useRef<HTMLDivElement>(null);

  function select(id: string) {
    setSelectedId(id);
    if (window.matchMedia("(max-width: 760px)").matches) {
      requestAnimationFrame(() =>
        detail.current?.scrollIntoView({ block: "nearest" }),
      );
    }
  }

  return (
    <section className="wb-study-view" aria-label="复习题卡">
      <div className="wb-review-split">
        <section className="wb-work-panel" aria-labelledby="wb-due-heading">
          <header className="wb-panel-heading cal-panel-head-row">
            <h2 id="wb-due-heading">
              到期题卡 <span>{queue.length}</span>
            </h2>
            {queue.length > 0 && (
              <button
                type="button"
                className="wb-button cal-mini-btn"
                onClick={() => {
                  autoScheduleDueReviews();
                  openCalendar();
                }}
              >
                <CalendarDays size={13} aria-hidden="true" /> 排入日历
              </button>
            )}
          </header>
          {queue.length ? (
            <ul className="wb-queue-items">
              {queue.map((item) => (
                <li key={item.lesson.id}>
                  <button
                    type="button"
                    className="wb-queue-item"
                    aria-current={
                      current?.id === item.lesson.id ? "true" : undefined
                    }
                    onClick={() => select(item.lesson.id)}
                  >
                    <span>
                      <strong>{item.lesson.title}</strong>
                      <small>
                        {getTrackForLesson(s, item.lesson.id)?.title}
                      </small>
                    </span>
                    <span className="wb-queue-metric">
                      <b>{item.retrievability}%</b>
                      <small>保持率</small>
                    </span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="wb-panel-empty">
              {loaded
                ? "当前没有到期的复习题卡，保持日常节奏即可。"
                : "正在载入复习队列…"}
            </p>
          )}
        </section>

        <div className="wb-review-detail" ref={detail}>
          <AnimatePresence mode="wait">
            {current ? (
              <motion.section
                key={current.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={TRANSITION_STATE}
                aria-label={current.title}
                className="wb-review-card"
              >
                <ActiveRecallCard
                  card={buildActiveRecallCard(s, current, now)}
                  onRate={recordFSRSReview}
                />
                {onAskLesson && (
                  <div className="wb-toolbar">
                    <button
                      type="button"
                      className="wb-button"
                      onClick={() => onAskLesson(current)}
                    >
                      <Sparkles size={13} aria-hidden="true" />{" "}
                      让学习助手串讲此知识点
                    </button>
                  </div>
                )}
              </motion.section>
            ) : (
              <motion.section
                key="review-empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={TRANSITION_FAST}
                className="wb-work-panel wb-review-ready"
              >
                <div>
                  <h2>今天复习已清空</h2>
                  <p className="wb-form-hint">
                    完成新课测验后，系统会按 FSRS 记忆曲线自动生成到期题卡。
                  </p>
                </div>
                <button
                  type="button"
                  className="wb-button"
                  onClick={openCalendar}
                >
                  查看学习日历 <ArrowRight size={14} aria-hidden="true" />
                </button>
              </motion.section>
            )}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}

type DraftLoad =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; drafts: PlanDraftRecord[] };
type DraftReply = {
  draft?: PlanDraftRecord;
  store?: Store;
  dbInfo?: DbInfo;
  error?: string;
};

function CalendarDrafts() {
  const { s, day, now, setDay, syncStoreFromServer, showToast } =
    useLearningStore();
  const stateVersion = s.stateVersion;
  const [query, reload] = useState(0);
  const [list, setList] = useState<DraftLoad>({ state: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const blocking = useRef(false);
  const [actionError, setActionError] = useState("");
  const [lastApplied, setLastApplied] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/learning/plan-drafts", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          drafts?: PlanDraftRecord[];
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error || "无法读取排期草稿。");
        if (!controller.signal.aborted)
          setList({ state: "ready", drafts: payload.drafts ?? [] });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setList({
            state: "error",
            message:
              error instanceof Error ? error.message : "无法读取排期草稿。",
          });
      });
    return () => controller.abort();
  }, [query, stateVersion]);

  async function resolve(draft: PlanDraftRecord, action: "apply" | "dismiss") {
    if (blocking.current) return;
    blocking.current = true;
    setBusy(draft.draft_id);
    setActionError("");
    try {
      const response = await fetch("/api/learning/plan-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId: draft.draft_id, action, day: now }),
      });
      const reply = (await response.json()) as DraftReply;
      if (!response.ok || !reply.draft)
        throw new Error(reply.error || "草稿处理失败。");
      if (reply.store) syncStoreFromServer(reply.store, reply.dbInfo);
      setList((prev) =>
        prev.state === "ready"
          ? {
              state: "ready",
              drafts: prev.drafts.filter(
                (item) => item.draft_id !== draft.draft_id,
              ),
            }
          : prev,
      );
      if (reply.draft.status === "applied") {
        setLastApplied(reply.draft.candidate_activity.title);
        const scheduledDay =
          reply.draft.diff.addedBlocks[0]?.day ??
          reply.draft.diff.movedBlocks[0]?.newDay;
        if (scheduledDay && scheduledDay !== day) setDay(scheduledDay);
      }
      showToast(
        reply.draft.status === "applied"
          ? "排期变更已写入时间轴。"
          : "已忽略这份草稿。",
      );
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "草稿处理失败。",
      );
      reload((value) => value + 1);
    } finally {
      blocking.current = false;
      setBusy(null);
    }
  }

  // Only show full panel when loading/error/non-empty; stay super quiet when empty
  const draftCount = list.state === "ready" ? list.drafts.length : 0;

  return (
    <aside
      className="wb-work-panel wb-drafts"
      aria-labelledby="wb-drafts-heading"
    >
      <header className="wb-panel-heading">
        <h2 id="wb-drafts-heading">
          待确认排期 {list.state === "ready" && <span>{draftCount}</span>}
        </h2>
      </header>
      {list.state === "loading" && (
        <p className="wb-panel-empty" role="status">
          正在读取草稿…
        </p>
      )}
      {list.state === "error" && (
        <div className="wb-panel-empty">
          <p role="alert">{list.message}</p>
          <button
            type="button"
            className="wb-button"
            onClick={() => {
              setList({ state: "loading" });
              reload((value) => value + 1);
            }}
          >
            重试
          </button>
        </div>
      )}
      {actionError && (
        <p className="wb-draft-error" role="alert">
          {actionError}
        </p>
      )}
      {lastApplied && (
        <p className="wb-draft-success" role="status">
          已写入：{lastApplied}
        </p>
      )}
      {list.state === "ready" && !list.drafts.length && !lastApplied && (
        <p className="wb-panel-empty">暂无待确认的排期调整。</p>
      )}
      {list.state === "ready" && (
        <AnimatePresence initial={false} mode="popLayout">
          {list.drafts.map((draft) => (
            <motion.article
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={TRANSITION_FAST}
              className="wb-draft-item"
              key={draft.draft_id}
            >
              <h3>{draft.candidate_activity.title}</h3>
              <p>
                {draft.candidate_activity.reason.replace(
                  /\s*[（(][a-z][a-z0-9_]*[）)]/gi,
                  "",
                )}
              </p>
              <dl>
                {draft.diff.addedBlocks.map((block) => (
                  <div key={block.id}>
                    <dt>新增</dt>
                    <dd>
                      {formatDayWithWeekday(block.day)} · {time(block.start)}–
                      {time(block.start + block.minutes)}
                    </dd>
                  </div>
                ))}
                {draft.diff.movedBlocks.map((block) => (
                  <div key={block.blockId}>
                    <dt>顺延</dt>
                    <dd>
                      {block.title} · {block.oldDay.slice(5)}{" "}
                      {time(block.oldStart)} → {block.newDay.slice(5)}{" "}
                      {time(block.newStart)}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="wb-toolbar">
                <button
                  type="button"
                  className="wb-button wb-primary"
                  disabled={busy !== null}
                  onClick={() => void resolve(draft, "apply")}
                >
                  {busy === draft.draft_id ? "应用中…" : "确认写入"}
                </button>
                <button
                  type="button"
                  className="wb-button"
                  disabled={busy !== null}
                  onClick={() => void resolve(draft, "dismiss")}
                >
                  忽略
                </button>
              </div>
            </motion.article>
          ))}
        </AnimatePresence>
      )}
    </aside>
  );
}

/** 日历像时间轴 — 干净的 2 栏结构：左侧等比时间轴画布 + 右侧精简侧轨 */
export function StudyCalendar({
  onBlock,
  onAdd,
  onAskSchedule,
}: {
  onBlock: (block: Block) => void;
  onAdd: (start?: number) => void;
  onAskSchedule?: () => void;
}) {
  const store = useLearningStore();
  const { s, now, day } = store;
  const blocks = s.blocks.filter((block) => block.day === day);
  const studyMinutes = blocks
    .filter((b) => b.kind === "学习" || b.kind === "复习")
    .reduce((sum, b) => sum + b.minutes, 0);
  const fixed = blocks.filter(isLockedBlock).length;
  const unfinished = blocks.filter((block) => !block.done).length;
  const missed = getMissedSessions(s, now);
  const feasibility = analyzeScheduleFeasibility(s, now, 7);

  return (
    <section className="wb-study-view wb-calendar-view" aria-label="学习日历">
      {(missed.length > 0 || !feasibility.feasible) && (
        <div className="cal-alerts-stack">
          <MissedSessionsBanner
            missed={missed}
            onHandle={store.handleMissedSession}
          />
          <FeasibilityAlertCard
            report={feasibility}
            onApplyFix={store.applyFeasibilityFix}
          />
        </div>
      )}

      <div className="wb-calendar-split">
        <div className="wb-timeboard">
          <Agenda
            s={s}
            day={day}
            setDay={store.setDay}
            now={now}
            onBlock={onBlock}
            onAdd={onAdd}
            onAskSchedule={onAskSchedule}
            large
          />
        </div>

        <div className="wb-calendar-inspector">
          <section className="wb-work-panel" aria-labelledby="wb-day-summary">
            <header className="wb-panel-heading">
              <h2 id="wb-day-summary">{day.slice(5).replace("-", "月")}日概况</h2>
            </header>
            <dl className="wb-day-stats wb-day-stats-3">
              <div>
                <dt>学习时长</dt>
                <dd>{studyMinutes}m</dd>
              </div>
              <div>
                <dt>待完成</dt>
                <dd>
                  {unfinished}/{blocks.length}
                </dd>
              </div>
              <div>
                <dt>
                  <Lock size={11} aria-hidden="true" /> 锁定
                </dt>
                <dd>{fixed}</dd>
              </div>
            </dl>
          </section>

          <CalendarDrafts />
          <CalendarBacklogPanel />
        </div>
      </div>
    </section>
  );
}
