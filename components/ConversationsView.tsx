"use client";
import { useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  Loader2,
  MessageCircle,
  Minimize2,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { getTracks } from "../lib/learning";
import type { ChatThreadMeta } from "../lib/db";
import { useLearningStore } from "./LearningStore";

type ConversationCategory =
  | "all"
  | "course"
  | "planning"
  | "general"
  | "archived";

/**
 * CONV-03 / CONV-06: Respect explicit threadKind first, then planning keywords BEFORE trackId,
 * so a planning discussion associated with a goal track is properly categorized as "planning".
 */
function classifyConversation(
  th: ChatThreadMeta,
): "course" | "planning" | "general" {
  if (th.threadKind === "planning") return "planning";
  if (th.threadKind === "course") return "course";
  if (th.threadKind === "general") return "general";
  const text = `${th.title} ${th.preview || ""}`;
  if (/(规划|计划|排课|日程|时间|周|冲突|调整|加班|重排)/.test(text)) {
    return "planning";
  }
  if (th.lessonId || th.trackId || th.threadId.startsWith("track-")) {
    return "course";
  }
  return "general";
}

function categoryLabel(cat: "course" | "planning" | "general"): string {
  if (cat === "course") return "课程讨论";
  if (cat === "planning") return "规划讨论";
  return "自由对话";
}

function formatRelativeDate(iso: string): string {
  try {
    const dt = new Date(iso);
    const now = new Date();
    const startToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const startTarget = new Date(
      dt.getFullYear(),
      dt.getMonth(),
      dt.getDate(),
    ).getTime();
    const diff = Math.round((startToday - startTarget) / 86400000);
    if (diff === 0) return "今天";
    if (diff === 1) return "昨天";
    return `${dt.getMonth() + 1}月${dt.getDate()}日`;
  } catch {
    return "";
  }
}

export default function ConversationsView() {
  const {
    s,
    threads,
    activeThreadId,
    setActiveThreadId,
    setActiveTrackId,
    setFocusedLessonId,
    setWorkspaceTab,
    createNewThread,
    deleteThread,
    renameThread,
    archiveThread,
    restoreThread,
    compactThread,
    llmTaskStatus,
  } = useLearningStore();

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ConversationCategory>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const tracks = useMemo(() => getTracks(s), [s]);
  const runningThreadIds = useMemo(
    () => new Set(llmTaskStatus.activeTasks.map((t) => t.threadId)),
    [llmTaskStatus.activeTasks],
  );

  const unifiedItems = useMemo(() => {
    const byId = new Map<string, ChatThreadMeta>();
    for (const th of threads) {
      byId.set(th.threadId, th);
    }
    for (const tr of tracks) {
      const tid = `track-${tr.id}`;
      if (!byId.has(tid)) {
        byId.set(tid, {
          threadId: tid,
          title: tr.title,
          scope: "track",
          threadKind: "course",
          archivedAt: null,
          trackId: tr.id,
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          preview: tr.goal,
          hasSummary: false,
          summary: "",
          summaryMsgCount: 0,
        });
      }
    }
    return Array.from(byId.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [threads, tracks]);

  const archivedCount = useMemo(
    () => unifiedItems.filter((th) => Boolean(th.archivedAt)).length,
    [unifiedItems],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return unifiedItems.filter((th) => {
      const isArchived = Boolean(th.archivedAt);
      if (category === "archived") {
        if (!isArchived) return false;
      } else {
        if (isArchived) return false;
        const cat = classifyConversation(th);
        if (category !== "all" && cat !== category) return false;
      }
      if (!q) return true;
      return (
        th.title.toLowerCase().includes(q) ||
        (th.preview || "").toLowerCase().includes(q)
      );
    });
  }, [unifiedItems, category, query]);

  /**
   * CONV-02 / CONV-13: Always open the EXACT clicked threadId and restore its associated
   * trackId & lessonId context — NEVER redirect to track-${trackId} or overwrite its title.
   */
  async function openConversation(th: ChatThreadMeta) {
    if (th.trackId) {
      setActiveTrackId(th.trackId);
    }
    if (th.lessonId) {
      setFocusedLessonId(th.lessonId);
    }
    setActiveThreadId(th.threadId);
    setWorkspaceTab("study");
  }

  return (
    <div className="mx-auto max-w-[820px] space-y-5">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--ve-border)] pb-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-[var(--ink)]">
            历史对话
          </h1>
        </div>
        <button
          type="button"
          onClick={async () => {
            await createNewThread();
            setWorkspaceTab("study");
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ve-accent-solid)] px-3.5 py-2 text-xs font-medium text-white transition hover:opacity-90"
        >
          <Plus size={14} /> 新建对话
        </button>
      </header>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface-alt)] p-0.5">
          {(
            [
              { id: "all", label: "全部" },
              { id: "course", label: "课程讨论" },
              { id: "planning", label: "规划讨论" },
              { id: "general", label: "自由对话" },
              {
                id: "archived",
                label: archivedCount > 0 ? `已归档 (${archivedCount})` : "已归档",
              },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setCategory(tab.id)}
              className={
                "rounded-md px-3 py-1 text-xs transition " +
                (category === tab.id
                  ? "bg-[var(--ve-surface)] font-medium text-[var(--ve-ink)] shadow-2xs"
                  : "text-[var(--ve-muted)] hover:text-[var(--ve-ink)]")
              }
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex w-full items-center gap-2 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-3 py-1.5 sm:w-[230px]">
          <Search size={13} className="shrink-0 text-[var(--ve-muted)]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索对话…"
            className="w-full !border-0 !bg-transparent !p-0 text-xs text-[var(--ve-ink)] outline-none placeholder:text-[var(--ve-muted)]"
          />
        </div>
      </div>

      {/* Single Clean Hairline List Container */}
      <section className="overflow-hidden rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)]">
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-xs text-[var(--ve-muted)]">
            {category === "archived" ? "暂无已归档的对话" : "没有匹配的对话记录"}
          </div>
        ) : (
          <div className="divide-y divide-[var(--ve-border)]">
            {filtered.map((th) => {
              const cat = classifyConversation(th);
              const isCurrent = th.threadId === activeThreadId;
              const isRunning = runningThreadIds.has(th.threadId);
              const isArchived = Boolean(th.archivedAt);
              const isEditing = editingId === th.threadId;
              const canManage =
                th.threadId !== "agent-main" &&
                !th.threadId.startsWith("track-");

              return (
                <div
                  key={th.threadId}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (!isEditing) void openConversation(th);
                  }}
                  onKeyDown={(e) => {
                    if (!isEditing && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      void openConversation(th);
                    }
                  }}
                  className={
                    "group flex cursor-pointer items-center justify-between gap-4 px-4 py-3.5 transition " +
                    (isCurrent
                      ? "bg-[var(--ve-accent-soft)]"
                      : "bg-[var(--ve-surface)] hover:bg-[var(--ve-surface-alt)]")
                  }
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <MessageCircle
                      size={15}
                      className={
                        "shrink-0 " +
                        (isCurrent ? "text-[var(--ve-accent)]" : "text-[var(--ve-muted)]")
                      }
                    />
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <div
                          className="flex items-center gap-1.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="text"
                            autoFocus
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                void renameThread(th.threadId, editingTitle);
                                setEditingId(null);
                              } else if (e.key === "Escape") {
                                setEditingId(null);
                              }
                            }}
                            className="w-full max-w-xs rounded border border-[var(--ve-accent)] bg-[var(--ve-surface)] px-2 py-0.5 text-xs text-[var(--ve-ink)] outline-none"
                          />
                          <button
                            type="button"
                            aria-label="保存标题"
                            onClick={() => {
                              void renameThread(th.threadId, editingTitle);
                              setEditingId(null);
                            }}
                            className="rounded p-1 text-[var(--ve-emerald)] hover:bg-[var(--ve-emerald-soft)]"
                          >
                            <Check size={13} />
                          </button>
                          <button
                            type="button"
                            aria-label="取消重命名"
                            onClick={() => setEditingId(null)}
                            className="rounded p-1 text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13.5px] font-medium text-[var(--ve-ink)]">
                            {th.title}
                          </span>
                          {isRunning && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-[var(--ve-accent-soft)] px-1.5 py-0.2 text-[10px] font-medium text-[var(--ve-accent)]">
                              <Loader2 size={10} className="animate-spin" />{" "}
                              回复中
                            </span>
                          )}
                          {th.hasSummary && (
                            <span className="shrink-0 rounded bg-[var(--ve-surface-alt)] px-1.5 py-0.2 text-[10px] text-[var(--ve-muted)]">
                              已摘要
                            </span>
                          )}
                        </div>
                      )}
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--ve-muted)]">
                        <span className="shrink-0">{categoryLabel(cat)}</span>
                        {th.preview && (
                          <span className="truncate text-[var(--ve-muted)]">
                            {th.preview}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {!isEditing && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingId(th.threadId);
                          setEditingTitle(th.title);
                        }}
                        title="重命名对话"
                        aria-label="重命名对话"
                        className="hidden rounded-md p-1 text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)] group-hover:inline-flex"
                      >
                        <Pencil size={12} />
                      </button>
                    )}
                    {th.messageCount >= 6 && !isArchived && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void compactThread(th.threadId);
                        }}
                        title="压缩较早历史为滚动摘要"
                        className="hidden items-center gap-1 rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2 py-1 text-[11px] font-medium text-[var(--ve-muted)] hover:border-[var(--ve-accent)] hover:text-[var(--ve-ink)] group-hover:inline-flex"
                      >
                        <Minimize2 size={10} /> 整理摘要
                      </button>
                    )}
                    {canManage && !isArchived && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void archiveThread(th.threadId);
                        }}
                        title="归档对话"
                        aria-label="归档对话"
                        className="hidden rounded-md p-1 text-[var(--ve-muted)] hover:bg-[var(--ve-amber-soft)] hover:text-[var(--ve-amber)] group-hover:inline-flex"
                      >
                        <Archive size={13} />
                      </button>
                    )}
                    {isArchived && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void restoreThread(th.threadId);
                        }}
                        title="恢复归档对话"
                        aria-label="恢复归档对话"
                        className="inline-flex items-center gap-1 rounded-md border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2 py-1 text-[11px] font-medium text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)]"
                      >
                        <ArchiveRestore size={11} /> 恢复
                      </button>
                    )}
                    {canManage && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteThread(th.threadId);
                        }}
                        title="删除对话"
                        aria-label="删除对话"
                        className="hidden rounded-md p-1 text-[var(--ve-muted)] hover:bg-[var(--ve-rose-soft)] hover:text-[var(--ve-rose)] group-hover:inline-flex"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                    <span className="font-mono text-xs text-[var(--ve-muted)]">
                      {formatRelativeDate(th.updatedAt)}
                    </span>
                    <ChevronRight size={14} className="text-[var(--ve-muted)]" />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
