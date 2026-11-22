"use client";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  CalendarClock,
  Check,
  Clock3,
  FastForward,
  Flag,
  GitFork,
  LockKeyhole,
  Pencil,
  Plus,
  RotateCcw,
  Route,
  Save,
  Sparkles,
  Target,
  Trash2,
} from "lucide-react";
import {
  type MemoryCategory,
  available,
  categoryLabel,
  diffDays,
  focusLesson,
  getActiveTrack,
  getLessonById,
  getLessonRetrievability,
  getMissingPrerequisites,
  getTracks,
  isMemoryExpired,
  offset,
  time,
} from "../lib/learning";
import { computeLearnerStatus, learnerStatusLabel } from "../lib/pedagogy";
import { layoutKnowledgeGraph } from "../lib/graph";
import { useLearningStore } from "./LearningStore";
import RetentionCurveChart from "./gen-ui/RetentionCurveChart";
import { ConfirmDangerDialog } from "./gen-ui/ConfirmDangerDialog";

export function MapView() {
  const {
    s,
    now,
    setActiveTrackId,
    attachContext,
    skipAsMastered,
    removePlan,
  } = useLearningStore();
  const tracks = useMemo(() => getTracks(s), [s]);
  const activeTrack = useMemo(() => getActiveTrack(s), [s]);
  const layout = useMemo(
    () => (activeTrack ? layoutKnowledgeGraph(activeTrack.units, s) : null),
    [activeTrack, s],
  );

  const [selectedId, setSelectedId] = useState(
    () => (activeTrack ? focusLesson(s, activeTrack.id)?.id || "" : ""),
  );

  useEffect(() => {
    if (!activeTrack) {
      setSelectedId("");
      return;
    }
    if (!activeTrack.units.some((u) => u.id === selectedId)) {
      setSelectedId(focusLesson(s, activeTrack.id)?.id || activeTrack.units[0]?.id || "");
    }
  }, [activeTrack, selectedId, s]);

  if (!activeTrack || !layout) {
    return (
      <section className="panel detail mx-auto max-w-xl py-16 text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-[#e5e9f2] bg-[#f8faff] text-[#395de7]">
          <GitFork size={20} />
        </div>
        <h2 className="justify-center text-sm font-semibold text-[#111827]">
          还没有知识图谱
        </h2>
        <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-[#6b7280]">
          在左侧对话中直接说出你想学习的方向或目标，Agent 会为你定制先修图谱微课并实时渲染到这里。
        </p>
      </section>
    );
  }

  const l =
    activeTrack.units.find((x) => x.id === selectedId) || activeTrack.units[0];
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
    meta && mastery > 0 && (diffDays(meta.nextReviewDay, now) >= 0 || retrievability <= 88);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
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
                "inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-medium transition " +
                (isCurrent
                  ? "border-[#4b6de8] bg-[#edf2ff] text-[#2f4fd4] shadow-2xs"
                  : "border-[#dce2ee] bg-white text-[#52607a] hover:bg-[#f5f7fc]")
              }
            >
              <GitFork size={13} />
              <span>{tr.title}</span>
              <span
                className={
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold " +
                  (isCurrent
                    ? "bg-white text-[#395de7]"
                    : "bg-[#f0f3f9] text-[#6d7b94]")
                }
              >
                {masteredCount}/{tr.units.length}
              </span>
            </button>
          );
        })}
      </div>

      <div className="space-y-4">
        <section className="panel detail">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2>
              <GitFork /> {activeTrack.title} · 先修图谱
            </h2>
            <div className="flex items-center gap-3 text-[11px] text-[#6c7991]">
              <span className="inline-flex items-center gap-1">
                <i className="h-2 w-2 rounded-full bg-emerald-500" /> 已掌握 ≥80%
              </span>
              <span className="inline-flex items-center gap-1">
                <i className="h-2 w-2 rounded-full bg-[#395de7]" /> 可学习
              </span>
              <span className="inline-flex items-center gap-1">
                <i className="h-2 w-2 rounded-full bg-[#c4cddf]" /> 待解锁
              </span>
            </div>
          </div>

          <div
            className="graph-board"
            style={{ height: layout.boardHeight + "px" }}
          >
            <svg
              className="graph-edges"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {layout.edges.map((e) => (
                <path
                  key={e.id}
                  d={e.path}
                  fill="none"
                  stroke={e.satisfied ? "#5f82eb" : "#c5d1ea"}
                  strokeWidth={e.satisfied ? "0.7" : "0.55"}
                  strokeDasharray={e.satisfied ? undefined : "1.8 1.4"}
                />
              ))}
            </svg>

            {layout.nodes.map((node) => {
              const x = node.lesson;
              const nodeMeta = s.masteryMeta?.[x.id];
              const due =
                nodeMeta &&
                node.mastery > 0 &&
                diffDays(nodeMeta.nextReviewDay, now) >= 0;
              return (
                <button
                  key={x.id}
                  type="button"
                  className={
                    "graph-node " +
                    (l?.id === x.id ? "selected " : "") +
                    (node.status === "mastered"
                      ? "!border-emerald-300"
                      : node.status === "locked"
                        ? "opacity-80"
                        : "")
                  }
                  style={{
                    left: node.x + "%",
                    top: node.y + "%",
                  }}
                  aria-pressed={l?.id === x.id}
                  onClick={() => setSelectedId(x.id)}
                >
                  <span>
                    {node.status === "locked" ? (
                      <LockKeyhole />
                    ) : node.status === "mastered" ? (
                      <Check className="text-emerald-600" />
                    ) : (
                      <Route className="text-[#395de7]" />
                    )}
                    {node.status === "mastered"
                      ? "已掌握"
                      : node.status === "available"
                        ? "可学习"
                        : "待解锁"}
                    {due && (
                      <em className="ml-1 rounded bg-amber-100 px-1 py-0.2 not-italic text-[9px] font-semibold text-amber-800">
                        待复习
                      </em>
                    )}
                  </span>
                  <strong>{x.title}</strong>
                  <div className="mx-1 mt-0.5 h-1.5 overflow-hidden rounded-full bg-[#e6ebf5]">
                    <div
                      className={
                        "h-full rounded-full " +
                        (node.mastery >= 80
                          ? "bg-emerald-500"
                          : "bg-[#395de7]")
                      }
                      style={{ width: node.mastery + "%" }}
                    />
                  </div>
                  <small>
                    {node.mastery}% · {x.minutes} 分钟
                  </small>
                </button>
              );
            })}
          </div>
        </section>

        {l && (
          <aside className="panel detail space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="section-kicker">
                <Target size={15} /> 知识点详情
              </div>
              <span className="rounded-full bg-[#edf2ff] px-2 py-0.5 text-[11px] font-semibold text-[#3655c7]">
                {learnerStatusLabel(learnerStatus)}
              </span>
            </div>
            <div>
              <h2>{l.title}</h2>
              <p className="mt-2">{l.concept}</p>
            </div>

            <div className="rounded-xl border border-[#e5eaf5] bg-[#f8faff] p-3.5">
              <div className="flex items-center justify-between text-xs font-semibold text-[#2d3b59]">
                <span>掌握度估计</span>
                <span>{mastery}%</span>
              </div>
              <div className="progress mt-2">
                <i style={{ width: mastery + "%" }} />
              </div>
              <div className="mt-2.5 flex flex-wrap gap-2 text-[11px] text-[#5e6e8a]">
                <span className="inline-flex items-center gap-1">
                  <Clock3 size={12} /> 预计 {l.minutes} 分钟
                </span>
                {meta && (
                  <span className="inline-flex items-center gap-1">
                    <CalendarClock size={12} /> 建议复习：
                    {meta.nextReviewDay.slice(5)}（稳定期 {meta.stabilityDays} 天）
                  </span>
                )}
              </div>
              {isDueReview && (
                <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-medium text-amber-800">
                  <AlertTriangle size={12} /> 当前记忆保持率 {retrievability}%，建议进行主动回忆
                </div>
              )}
            </div>

            {meta && mastery > 0 && (
              <RetentionCurveChart
                stabilityDays={meta.stabilityDays}
                elapsedAlready={elapsedDays}
              />
            )}

            <div className="text-xs leading-relaxed text-[#55647f]">
              <strong className="text-[#27344d]">先修知识：</strong>
              {l.requires.length
                ? l.requires
                    .map((r) => {
                      const req = getLessonById(s, r);
                      return `${req?.title || r} (${s.mastery[r] ?? 0}%)`;
                    })
                    .join("、")
                : "无前置要求"}
              。
              {available(s, l)
                ? "已满足学习条件。"
                : missingPrereqs.length
                  ? `还需先补齐 ${missingPrereqs.map((m) => `「${m.title}」`).join(" → ")}（达 80% 后解锁）。`
                  : "先修掌握度达到 80% 后自动解锁。"}
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                className="primary"
                onClick={() =>
                  attachContext({
                    type: "lesson",
                    lessonId: l.id,
                    title: l.title,
                    mastery,
                  })
                }
              >
                带入左侧对话 <ArrowRight size={14} />
              </button>
              {mastery < 80 && available(s, l) && (
                <button
                  type="button"
                  onClick={() => skipAsMastered(l)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                >
                  <FastForward size={13} /> 标记已掌握并释放日程
                </button>
              )}
              {!activeTrack.builtIn && (
                <button
                  type="button"
                  onClick={() => removePlan(activeTrack.id)}
                  className="ml-auto inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50/70 px-2.5 py-2 text-xs font-medium text-rose-700 hover:bg-rose-100"
                >
                  <Trash2 size={12} /> 删除此轨道
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

const CATEGORIES: Array<{ id: "all" | MemoryCategory; name: string }> = [
  { id: "all", name: "全部" },
  { id: "goal", name: "学习目标" },
  { id: "constraint", name: "时间约束" },
  { id: "preference", name: "学习偏好" },
  { id: "weakness", name: "薄弱点" },
  { id: "record", name: "学习记录" },
];

export function MemoryView() {
  const {
    s,
    now,
    addMemory,
    updateMemory,
    deleteMemory,
    purgeExpiredMemories,
  } = useLearningStore();
  const [filter, setFilter] = useState<"all" | MemoryCategory>("all");
  const [showExpired, setShowExpired] = useState(true);
  const [editId, setEditId] = useState("");
  const [editValue, setEditValue] = useState("");
  const [newCategory, setNewCategory] = useState<MemoryCategory>("constraint");
  const [newText, setNewText] = useState("");
  const [ttlDays, setTtlDays] = useState<"forever" | "3" | "7" | "14">("forever");
  const [pendingDeleteMem, setPendingDeleteMem] = useState<{
    id: string;
    label: string;
    text: string;
    category?: MemoryCategory;
  } | null>(null);

  const expiredCount = s.memories.filter((m) => isMemoryExpired(m, now)).length;
  const filtered = s.memories.filter((m) => {
    if (!showExpired && isMemoryExpired(m, now)) return false;
    return filter === "all" ? true : (m.category || "preference") === filter;
  });

  function effectBadge(cat?: MemoryCategory, hasConstraint?: boolean) {
    if (hasConstraint || cat === "constraint")
      return { text: "约束日历排程", cls: "bg-emerald-50 text-emerald-700" };
    if (cat === "preference" || cat === "weakness")
      return { text: "注入导师风格", cls: "bg-[#edf2ff] text-[#3a59c7]" };
    if (cat === "goal")
      return { text: "校准长期路径", cls: "bg-purple-50 text-purple-700" };
    return { text: "学习历史依据", cls: "bg-slate-100 text-slate-600" };
  }

  return (
    <div className="max-w-4xl space-y-5">
      <section className="panel detail space-y-3">
        <div className="flex items-center justify-between">
          <h2>
            <Plus /> 新增长期记忆
          </h2>
          <span className="text-xs text-[#6d7b95]">
            写入后实时影响 Agent 排程与导师对话
          </span>
        </div>

        <form
          className="flex flex-col gap-2.5 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newText.trim()) return;
            const expiresAt =
              ttlDays === "forever" ? undefined : offset(now, Number(ttlDays));
            addMemory(newCategory, newText, undefined, expiresAt);
            setNewText("");
            setTtlDays("forever");
          }}
        >
          <select
            aria-label="记忆类别"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as MemoryCategory)}
            className="sm:w-32"
          >
            <option value="constraint">时间约束</option>
            <option value="preference">学习偏好</option>
            <option value="goal">学习目标</option>
            <option value="weakness">薄弱点</option>
          </select>
          <input
            aria-label="新记忆内容"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder="例如：本周出差晚上没空，或长期偏好晚上 8 点后学习…"
            className="flex-1"
          />
          <select
            aria-label="记忆有效期"
            value={ttlDays}
            onChange={(e) =>
              setTtlDays(e.target.value as "forever" | "3" | "7" | "14")
            }
            className="sm:w-28"
          >
            <option value="forever">长期有效</option>
            <option value="3">3 天有效</option>
            <option value="7">7 天有效</option>
            <option value="14">14 天有效</option>
          </select>
          <button type="submit" className="primary shrink-0">
            <Plus size={14} /> 添加记忆
          </button>
        </form>
      </section>

      <section className="panel detail">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2>
              <Brain /> 已保存记忆（{filtered.length}）
            </h2>
            {expiredCount > 0 && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowExpired((v) => !v)}
                  className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                >
                  {showExpired ? `隐藏 ${expiredCount} 条已过期` : `显示 ${expiredCount} 条已过期`}
                </button>
                <button
                  type="button"
                  onClick={() => purgeExpiredMemories()}
                  className="rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700 hover:bg-rose-100"
                >
                  清理已过期
                </button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setFilter(c.id)}
                className={
                  "rounded-lg px-2.5 py-1 text-xs font-medium " +
                  (filter === c.id
                    ? "bg-[#395de7] text-white"
                    : "bg-[#f2f4f9] text-[#586780] hover:bg-[#e7ecf6]")
                }
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-[#76849d]">
            该分类下暂无记忆条目。
          </p>
        ) : (
          filtered.map((m) => {
            const cat = m.category || "preference";
            const badge = effectBadge(cat, Boolean(m.constraint));
            const expired = isMemoryExpired(m, now);
            return (
              <div
                className={"memory-row " + (expired ? "opacity-55" : "")}
                key={m.id}
              >
                <div className="memory-icon">
                  {cat === "goal" ? (
                    <Flag />
                  ) : cat === "constraint" ? (
                    <Clock3 />
                  ) : cat === "preference" ? (
                    <Target />
                  ) : cat === "weakness" ? (
                    <AlertTriangle />
                  ) : (
                    <RotateCcw />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <small>{m.label}</small>
                    <span
                      className={
                        "rounded-md px-1.5 py-0.5 text-[10px] font-semibold " +
                        badge.cls
                      }
                    >
                      {badge.text}
                    </span>
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                      {m.source === "agent" ? "Agent 提取" : "手动录入"}
                    </span>
                    {m.expiresAt && (
                      <span
                        className={
                          "rounded-md px-1.5 py-0.5 text-[10px] font-medium " +
                          (expired
                            ? "bg-rose-100 text-rose-700"
                            : "bg-amber-50 text-amber-800")
                        }
                      >
                        {expired
                          ? `已过期（${m.expiresAt.slice(5)}）`
                          : `有效期至 ${m.expiresAt.slice(5)}`}
                      </span>
                    )}
                    {m.constraint?.preferredStart !== undefined && (
                      <span className="rounded-md bg-[#eef2ff] px-1.5 py-0.5 text-[10px] text-[#3c5bc9]">
                        偏好 {time(m.constraint.preferredStart)} 后
                      </span>
                    )}
                    {m.constraint?.maxSessionMinutes && (
                      <span className="rounded-md bg-[#eef2ff] px-1.5 py-0.5 text-[10px] text-[#3c5bc9]">
                        ≤ {m.constraint.maxSessionMinutes}m
                      </span>
                    )}
                  </div>

                  {editId === m.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!editValue.trim()) return;
                        updateMemory(m.id, editValue);
                        setEditId("");
                      }}
                    >
                      <input
                        aria-label="记忆内容"
                        required
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                      />
                      <button aria-label="保存记忆" type="submit">
                        <Save />
                      </button>
                      <button type="button" onClick={() => setEditId("")}>
                        取消
                      </button>
                    </form>
                  ) : (
                    <p>{m.text}</p>
                  )}
                </div>

                {editId !== m.id && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={"编辑" + m.label}
                      onClick={() => {
                        setEditId(m.id);
                        setEditValue(m.text);
                      }}
                    >
                      <Pencil />
                    </button>
                    <button
                      type="button"
                      className="icon-btn hover:!text-rose-600"
                      aria-label={"删除" + m.label}
                      onClick={() =>
                        setPendingDeleteMem({
                          id: m.id,
                          label: m.label,
                          text: m.text,
                          category: m.category,
                        })
                      }
                    >
                      <Trash2 />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>

      <ConfirmDangerDialog
        open={Boolean(pendingDeleteMem)}
        title="确认删除这条记忆 / 学习记录？"
        description={
          pendingDeleteMem
            ? `即将移除「${pendingDeleteMem.label}」：${pendingDeleteMem.text.slice(0, 120)}${pendingDeleteMem.text.length > 120 ? "…" : ""}`
            : ""
        }
        impacts={[
          "该条记录将从长期记忆列表中移除，不再参与后续 Agent 提示注入或排程约束。",
        ]}
        preservedNote="正式测验作答记录（exercise_attempts）、掌握度模型与已保存课程轨道不会被删除。"
        confirmLabel="确认删除"
        onCancel={() => setPendingDeleteMem(null)}
        onConfirm={() => {
          if (pendingDeleteMem) deleteMemory(pendingDeleteMem.id);
          setPendingDeleteMem(null);
        }}
      />
    </div>
  );
}
