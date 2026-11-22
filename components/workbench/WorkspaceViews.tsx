"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Plus, Search } from "lucide-react";
import { useLearningStore } from "../LearningStore";
import ConversationsView from "../ConversationsView";
import ActivityAudit from "../ActivityAudit";
import {
  categoryLabel,
  isMemoryExpired,
  time,
  type Memory,
  type MemoryCategory,
} from "../../lib/learning";
import { SPRING_CRISP, TRANSITION_FAST } from "../../lib/motion";

const categories: MemoryCategory[] = [
  "constraint",
  "preference",
  "goal",
  "weakness",
  "record",
];
type MemoryFilter = "active" | "expired" | "all";
const sourceNames = {
  agent: "学习助手",
  user: "手动录入",
  system: "系统",
} as const;

export function WorkspaceArchive({ audit = false }: { audit?: boolean }) {
  return (
    <section
      className="wb-study-view wb-archive"
      aria-label={audit ? "运行轨迹" : "历史对话"}
    >
      <div className={audit ? "wb-audit-module" : "wb-conversations-module"}>
        {audit ? <ActivityAudit /> : <ConversationsView />}
      </div>
    </section>
  );
}

export function WorkspaceMemory() {
  const {
    s,
    now,
    loaded,
    addMemory,
    updateMemory,
    deleteMemory,
    purgeExpiredMemories,
  } = useLearningStore();
  const segId = useId();
  const [filter, setFilter] = useState<MemoryFilter>("all");
  const [category, setCategory] = useState<MemoryCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<
    { mode: "new" } | { mode: "edit"; id: string } | null
  >(null);
  const [pending, setPending] = useState<
    { kind: "delete"; id: string } | { kind: "purge" } | null
  >(null);
  const formRef = useRef<HTMLFormElement>(null);
  const expired = s.memories.filter((memory) => isMemoryExpired(memory, now));
  const current =
    editor?.mode === "edit"
      ? s.memories.find((memory) => memory.id === editor.id)
      : undefined;
  const term = query.trim().toLocaleLowerCase();
  const matches = s.memories.filter((memory) => {
    const ended = isMemoryExpired(memory, now);
    return (
      (filter === "all" || (filter === "expired" ? ended : !ended)) &&
      (category === "all" || (memory.category ?? "preference") === category) &&
      (!term ||
        (memory.label + " " + memory.text).toLocaleLowerCase().includes(term))
    );
  });
  const pendingMemory =
    pending?.kind === "delete"
      ? s.memories.find((memory) => memory.id === pending.id)
      : undefined;

  function openEditor(memory?: Memory) {
    setPending(null);
    setEditor(memory ? { mode: "edit", id: memory.id } : { mode: "new" });
    requestAnimationFrame(() =>
      formRef.current?.querySelector("textarea")?.focus(),
    );
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const text = String(fields.get("memory")).trim();
    if (!text) {
      const textarea = event.currentTarget.querySelector("textarea");
      textarea?.setCustomValidity("请输入记忆内容。");
      textarea?.reportValidity();
      return;
    }
    const nextCategory = String(fields.get("category")) as MemoryCategory;
    const expiresAt = String(fields.get("expires"));
    if (current)
      updateMemory(
        current.id,
        text,
        nextCategory === (current.category ?? "preference")
          ? undefined
          : nextCategory,
        expiresAt || "",
      );
    else {
      addMemory(nextCategory, text, undefined, expiresAt || undefined);
      setFilter("all");
      setCategory("all");
      setQuery("");
    }
    setEditor(null);
  }
  function remove() {
    if (pending?.kind === "purge") purgeExpiredMemories();
    else if (pendingMemory) {
      deleteMemory(pendingMemory.id);
      if (current?.id === pendingMemory.id) setEditor(null);
    }
    setPending(null);
  }

  return (
    <section className="wb-study-view" aria-label="学习记忆">
      <div className="wb-memory-layout" data-editing={!!editor}>
        <section className="wb-work-panel" aria-label="记忆列表">
          <div className="wb-record-toolbar">
            <div className="wb-segmented" role="group" aria-label="有效状态">
              {(
                [
                  ["all", "全部"],
                  ["active", "有效"],
                  ["expired", "已过期"],
                ] as const
              ).map(([value, label]) => {
                const active = filter === value;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilter(value)}
                    className="wb-seg-btn"
                  >
                    {active && (
                      <motion.span
                        layoutId={`mem-filter-${segId}`}
                        className="wb-seg-pill"
                        transition={SPRING_CRISP}
                      />
                    )}
                    <span className="wb-seg-label">
                      {label}
                      {value === "expired" && expired.length > 0
                        ? ` (${expired.length})`
                        : ""}
                    </span>
                  </button>
                );
              })}
            </div>
            <label className="wb-filter-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索记忆"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索记忆"
              />
            </label>
            <select
              aria-label="记忆类别筛选"
              value={category}
              onChange={(event) =>
                setCategory(event.target.value as MemoryCategory | "all")
              }
            >
              <option value="all">全部类别</option>
              {categories.map((value) => (
                <option key={value} value={value}>
                  {categoryLabel(value)}
                </option>
              ))}
            </select>
            {filter === "expired" && expired.length > 0 && (
              <button
                type="button"
                className="wb-button wb-danger"
                onClick={() => setPending({ kind: "purge" })}
              >
                清理已过期
              </button>
            )}
            <button
              type="button"
              className="wb-button wb-primary"
              onClick={() => openEditor()}
            >
              <Plus size={14} aria-hidden="true" /> 添加记忆
            </button>
          </div>

          <AnimatePresence initial={false}>
            {pending && (
              <motion.div
                key="confirm-bar"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={TRANSITION_FAST}
                style={{ overflow: "hidden" }}
              >
                <div
                  className="wb-inline-confirm"
                  role="group"
                  aria-label="确认删除记忆"
                >
                  <p>
                    {pending.kind === "purge"
                      ? `清理 ${expired.length} 条已过期记忆？`
                      : `删除「${pendingMemory?.label ?? "选中的记忆"}」？`}
                  </p>
                  <button
                    type="button"
                    className="wb-button wb-danger"
                    onClick={remove}
                  >
                    确认删除
                  </button>
                  <button
                    type="button"
                    className="wb-button"
                    onClick={() => setPending(null)}
                  >
                    取消
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {matches.length ? (
            <ul className="wb-memory-list">
              {matches.map((memory) => (
                <li key={memory.id} data-selected={current?.id === memory.id}>
                  <div className="wb-memory-text">
                    <div className="wb-memory-meta">
                      <strong>{memory.label}</strong>
                      <span>{categoryLabel(memory.category ?? "preference")}</span>
                      {memory.source && <span>{sourceNames[memory.source]}</span>}
                    </div>
                    <p>{memory.text}</p>
                    {(memory.expiresAt || memory.constraint) && (
                      <div className="wb-memory-meta">
                        {memory.expiresAt && (
                          <span>
                            {isMemoryExpired(memory, now)
                              ? "已过期"
                              : "有效期至"}{" "}
                            {memory.expiresAt}
                          </span>
                        )}
                        {memory.constraint?.preferredStart !== undefined && (
                          <span>
                            {time(memory.constraint.preferredStart)} 后学习
                          </span>
                        )}
                        {memory.constraint?.maxSessionMinutes && (
                          <span>
                            每次最多 {memory.constraint.maxSessionMinutes} 分钟
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="wb-toolbar">
                    <button
                      type="button"
                      className="wb-button"
                      aria-label={`编辑 ${memory.label}`}
                      onClick={() => openEditor(memory)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="wb-button"
                      aria-label={`删除 ${memory.label}`}
                      onClick={() =>
                        setPending({ kind: "delete", id: memory.id })
                      }
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="wb-panel-empty">
              {!loaded
                ? "正在加载记忆…"
                : s.memories.length
                  ? "没有匹配的记忆。"
                  : "还没有学习记忆。"}
            </p>
          )}
        </section>

        <AnimatePresence initial={false}>
          {editor && (
            <motion.section
              key="memory-editor"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={TRANSITION_FAST}
              className="wb-work-panel"
              aria-labelledby="wb-memory-editor-title"
            >
              <header className="wb-panel-heading">
                <h2 id="wb-memory-editor-title">
                  {current ? "编辑记忆" : "添加记忆"}
                </h2>
              </header>
              <form
                className="wb-form wb-memory-form"
                ref={formRef}
                key={current?.id ?? "new"}
                onSubmit={save}
                aria-labelledby="wb-memory-editor-title"
              >
                <label>
                  类别
                  <select
                    name="category"
                    defaultValue={current?.category ?? "constraint"}
                  >
                    {categories.map((value) => (
                      <option key={value} value={value}>
                        {categoryLabel(value)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  记忆内容
                  <textarea
                    name="memory"
                    defaultValue={current?.text}
                    required
                    rows={4}
                    onInput={(event) =>
                      event.currentTarget.setCustomValidity("")
                    }
                  />
                </label>
                <label>
                  有效期（可选）
                  <input
                    name="expires"
                    type="date"
                    defaultValue={current?.expiresAt ?? ""}
                  />
                </label>
                <div className="wb-toolbar">
                  <button className="wb-button wb-primary" type="submit">
                    保存记忆
                  </button>
                  <button
                    className="wb-button"
                    type="button"
                    onClick={() => setEditor(null)}
                  >
                    取消
                  </button>
                </div>
              </form>
            </motion.section>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
