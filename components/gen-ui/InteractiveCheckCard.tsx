"use client";
import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  Code2,
  FileText,
  HelpCircle,
  Lightbulb,
  ListOrdered,
  RotateCcw,
  Sparkles,
  TextCursorInput,
} from "lucide-react";
import type {
  InteractiveBlankSlot,
  InteractiveCheckCard as InteractiveCheckData,
  InteractiveCheckMode,
} from "../../lib/learning";
import { useLearningStore } from "../LearningStore";
import RichMarkdown from "./RichMarkdown";
import CodeEditorBox from "./CodeEditorBox";

export type PersistedCheckState = {
  savedChoiceIndex?: number;
  savedChoiceIndices?: number[];
  savedBlanks?: Record<string, string>;
  savedOrder?: string[];
  savedUserAnswer?: string;
};

const MODE_META: Record<
  InteractiveCheckMode,
  { label: string; badgeClass: string; icon: typeof Code2 }
> = {
  choice: {
    label: "单选辨析",
    badgeClass: "bg-[var(--ve-accent-soft)] text-[var(--ve-accent)] border-[var(--ve-accent)]/35",
    icon: HelpCircle,
  },
  multi_choice: {
    label: "多选综合判断",
    badgeClass: "bg-[var(--ve-purple-soft)] text-[var(--ve-purple)] border-[var(--ve-purple)]/35",
    icon: CheckCircle2,
  },
  fill_blank: {
    label: "代码 / 概念填空",
    badgeClass: "bg-[var(--ve-amber-soft)] text-[var(--ve-amber)] border-[var(--ve-amber)]/35",
    icon: TextCursorInput,
  },
  code: {
    label: "动手编程实战",
    badgeClass: "bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)] border-[var(--ve-emerald)]/35",
    icon: Code2,
  },
  order_steps: {
    label: "执行流程排序",
    badgeClass: "bg-[var(--ve-accent-soft)] text-[var(--ve-accent)] border-[var(--ve-accent)]/35",
    icon: ListOrdered,
  },
  short_answer: {
    label: "费曼原理解释",
    badgeClass: "bg-[var(--ve-rose-soft)] text-[var(--ve-rose)] border-[var(--ve-rose)]/35",
    icon: FileText,
  },
};

function deriveBlankSlots(card: InteractiveCheckData): InteractiveBlankSlot[] {
  if (card.blanks && card.blanks.length > 0) {
    return card.blanks;
  }
  const source = `${card.starterCode || ""}\n${card.prompt || ""}`;
  const numberedMatches = Array.from(
    source.matchAll(/___(\d+)___|{{\s*(\d+)\s*}}|\[\[\s*(\d+)\s*\]\]/g),
  );
  if (numberedMatches.length > 0) {
    const seen = new Set<string>();
    const slots: InteractiveBlankSlot[] = [];
    for (const m of numberedMatches) {
      const num = m[1] || m[2] || m[3] || String(slots.length + 1);
      const id = `blank-${num}`;
      if (!seen.has(id)) {
        seen.add(id);
        slots.push({
          id,
          label: `空 (${num})`,
          placeholder: `填写第 ${num} 处缺失内容…`,
        });
      }
    }
    return slots;
  }
  const genericMatches = source.match(/_{3,}/g);
  if (genericMatches && genericMatches.length > 0) {
    return genericMatches.slice(0, 6).map((_, i) => ({
      id: `blank-${i + 1}`,
      label: `空 (${i + 1})`,
      placeholder: `填写第 ${i + 1} 处代码或概念…`,
    }));
  }
  return [
    {
      id: "blank-1",
      label: "填空 (1)",
      placeholder: "输入缺失的关键代码、表达式或概念…",
    },
  ];
}

export default function InteractiveCheckCard({
  card,
  disabled,
  onSubmitAnswer,
  onRequestModeSwitch,
}: {
  card: InteractiveCheckData;
  disabled?: boolean;
  onSubmitAnswer: (
    answerText: string,
    persistedState: PersistedCheckState,
  ) => void;
  onRequestModeSwitch?: (targetMode: InteractiveCheckMode, prompt: string) => void;
}) {
  const { checkDrafts, setCheckDraft, clearCheckDraft } = useLearningStore();
  const sharedDraft = checkDrafts[card.checkId];

  const [submittedLocal, setSubmittedLocal] = useState(false);
  const [showHint, setShowHint] = useState(false);

  const isSubmitted =
    submittedLocal ||
    card.savedChoiceIndex !== undefined ||
    (card.savedChoiceIndices && card.savedChoiceIndices.length > 0) ||
    (card.savedBlanks && Object.keys(card.savedBlanks).length > 0) ||
    (card.savedOrder && card.savedOrder.length > 0) ||
    Boolean(card.savedUserAnswer);

  const selectedChoice =
    card.savedChoiceIndex ?? sharedDraft?.choiceIndex ?? null;

  const selectedChoices: number[] =
    card.savedChoiceIndices ?? sharedDraft?.choiceIndices ?? [];

  const blankSlots = useMemo(() => deriveBlankSlots(card), [card]);
  const blankValues: Record<string, string> =
    card.savedBlanks ?? sharedDraft?.blanks ?? {};

  const initialSteps = useMemo(
    () =>
      card.steps && card.steps.length > 0
        ? card.steps
        : card.choices && card.choices.length > 0
          ? card.choices
          : [],
    [card.steps, card.choices],
  );
  const orderedSteps: string[] =
    card.savedOrder ??
    (sharedDraft?.order && sharedDraft.order.length === initialSteps.length
      ? sharedDraft.order
      : initialSteps);

  const textAnswer =
    card.savedUserAnswer ?? sharedDraft?.text ?? card.starterCode ?? "";

  const cleanLessonName = card.lessonTitle
    ? card.lessonTitle
        .replace(/^问题\s*\d+[：:\s]*/, "")
        .replace(/^第[一二三四五六七八九十0-9]+[课节章][：:\s]*/, "")
        .trim()
    : "";
  const headerTitle = cleanLessonName
    ? `互动练习 · ${cleanLessonName}`
    : "互动练习";

  const modeInfo = MODE_META[card.mode] || MODE_META.choice;
  const ModeIcon = modeInfo.icon;

  // --- Handlers for each mode ---

  function handleSelectOption(idx: number) {
    if (disabled || isSubmitted) return;
    setCheckDraft(card.checkId, { choiceIndex: idx });
  }

  function handleToggleMultiOption(idx: number) {
    if (disabled || isSubmitted) return;
    const exists = selectedChoices.includes(idx);
    const next = exists
      ? selectedChoices.filter((i) => i !== idx)
      : [...selectedChoices, idx].sort((a, b) => a - b);
    setCheckDraft(card.checkId, { choiceIndices: next });
  }

  function handleCheckChoiceAnswer() {
    if (
      disabled ||
      isSubmitted ||
      selectedChoice === null ||
      !card.choices?.[selectedChoice]
    )
      return;
    const choiceText = card.choices[selectedChoice];
    const letter = String.fromCharCode(65 + selectedChoice);
    setSubmittedLocal(true);
    clearCheckDraft(card.checkId);
    onSubmitAnswer(
      `[单选作答 · ${card.lessonTitle || "互动练习"}] 我选择 ${letter}. ${choiceText}`,
      {
        savedChoiceIndex: selectedChoice,
        savedUserAnswer: `${letter}. ${choiceText}`,
      },
    );
  }

  function handleCheckMultiChoiceAnswer() {
    if (
      disabled ||
      isSubmitted ||
      selectedChoices.length === 0 ||
      !card.choices
    )
      return;
    const picks = selectedChoices.map((idx) => {
      const letter = String.fromCharCode(65 + idx);
      const clean = (card.choices![idx] || "").replace(/^[A-E][.、\s]+/, "");
      return `${letter}. ${clean}`;
    });
    const summary = picks.join("；");
    setSubmittedLocal(true);
    clearCheckDraft(card.checkId);
    onSubmitAnswer(
      `[多选作答 · ${card.lessonTitle || "互动练习"}] 我选择：${summary}`,
      {
        savedChoiceIndices: selectedChoices,
        savedUserAnswer: summary,
      },
    );
  }

  function handleBlankChange(slotId: string, val: string) {
    if (disabled || isSubmitted) return;
    setCheckDraft(card.checkId, {
      blanks: { ...blankValues, [slotId]: val },
    });
  }

  function handleSubmitBlanks(e: React.FormEvent) {
    e.preventDefault();
    if (disabled || isSubmitted) return;
    const hasAll = blankSlots.every((s) => (blankValues[s.id] || "").trim());
    if (!hasAll) return;

    const pairs = blankSlots.map(
      (s, i) => `${s.label || `空${i + 1}`}: \`${(blankValues[s.id] || "").trim()}\``,
    );
    const formatted = pairs.join("，");
    setSubmittedLocal(true);
    clearCheckDraft(card.checkId);
    onSubmitAnswer(
      `[代码/概念填空 · ${card.lessonTitle || "互动练习"}] 我的填写：${formatted}`,
      {
        savedBlanks: blankValues,
        savedUserAnswer: formatted,
      },
    );
  }

  function moveStep(idx: number, dir: -1 | 1) {
    if (disabled || isSubmitted) return;
    const target = idx + dir;
    if (target < 0 || target >= orderedSteps.length) return;
    const next = [...orderedSteps];
    const tmp = next[idx];
    next[idx] = next[target];
    next[target] = tmp;
    setCheckDraft(card.checkId, { order: next });
  }

  function handleSubmitOrder() {
    if (disabled || isSubmitted || orderedSteps.length === 0) return;
    const formatted = orderedSteps
      .map((st, idx) => `${idx + 1}. ${st}`)
      .join("\n");
    setSubmittedLocal(true);
    clearCheckDraft(card.checkId);
    onSubmitAnswer(
      `[流程排序作答 · ${card.lessonTitle || "互动练习"}]\n${formatted}`,
      {
        savedOrder: orderedSteps,
        savedUserAnswer: formatted,
      },
    );
  }

  function handleSubmitText(e: React.FormEvent) {
    e.preventDefault();
    const clean = textAnswer.trim();
    if (!clean || disabled || isSubmitted) return;
    setSubmittedLocal(true);
    clearCheckDraft(card.checkId);
    if (card.mode === "code") {
      onSubmitAnswer(
        `[提交代码 · ${card.lessonTitle || "互动练习"}]\n\`\`\`${card.language || ""}\n${clean}\n\`\`\``,
        { savedUserAnswer: clean },
      );
    } else {
      onSubmitAnswer(
        `[费曼简答 · ${card.lessonTitle || "互动练习"}]\n${clean}`,
        { savedUserAnswer: clean },
      );
    }
  }

  const hasDraft =
    !isSubmitted &&
    Boolean(
      sharedDraft?.text ||
        sharedDraft?.choiceIndex !== undefined ||
        (sharedDraft?.choiceIndices && sharedDraft.choiceIndices.length > 0) ||
        (sharedDraft?.blanks && Object.keys(sharedDraft.blanks).length > 0) ||
        (sharedDraft?.order && sharedDraft.order.length > 0),
    );

  const alternateModes: Array<{
    mode: InteractiveCheckMode;
    label: string;
    prompt: string;
  }> = (
    [
      {
        mode: "fill_blank" as const,
        label: "代码填空题",
        prompt: `请针对「${cleanLessonName || "当前知识点"}」给我出一道代码/概念填空题（mode: "fill_blank"），让我亲手填入关键语法或参数。`,
      },
      {
        mode: "code" as const,
        label: "动手编程/改错",
        prompt: `请针对「${cleanLessonName || "当前知识点"}」给我出一道动手编写代码或修复 Bug 的练习题（mode: "code"，附带 starterCode 与 expectedOutput）。`,
      },
      {
        mode: "order_steps" as const,
        label: "执行流程排序",
        prompt: `请针对「${cleanLessonName || "当前知识点"}」的执行顺序或核心步骤出一道流程排序题（mode: "order_steps"）。`,
      },
      {
        mode: "short_answer" as const,
        label: "费曼简答思考",
        prompt: `请针对「${cleanLessonName || "当前知识点"}」出一道费曼原理解释简答题（mode: "short_answer"，附带 rubricPoints 考察要点）。`,
      },
      {
        mode: "multi_choice" as const,
        label: "多选易错辨析",
        prompt: `请针对「${cleanLessonName || "当前知识点"}」的常见易错点出一道多选综合判断题（mode: "multi_choice"）。`,
      },
    ] as const
  ).filter((item) => item.mode !== card.mode);

  return (
    <div
      id={`check-card-${card.checkId}`}
      className="my-4 overflow-hidden rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-5 shadow-2xs transition-all duration-200 sm:p-6"
    >
      {/* Top Row: Mode Badge + Question Title on Left, Draft + Hint + Score on Right */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold " +
              modeInfo.badgeClass
            }
          >
            <ModeIcon size={12} />
            {modeInfo.label}
          </span>
          <div className="text-[14px] font-bold text-[var(--ve-ink)]">
            {headerTitle}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasDraft && (
            <span className="rounded-full bg-[var(--ve-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--ve-accent)]">
              草稿已自动保存
            </span>
          )}
          {card.hint && (
            <button
              type="button"
              onClick={() => setShowHint((v) => !v)}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--ve-canvas)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]"
            >
              <Lightbulb size={11} />
              {showHint ? "收起提示" : "提示"}
            </button>
          )}
          <span className="rounded-full bg-[var(--ve-surface-alt)] px-2.5 py-0.5 text-xs font-semibold text-[var(--ve-muted)]">
            10 分
          </span>
        </div>
      </div>

      {/* Question Stem (supports highlighted code blocks, bold, tables, Mermaid) */}
      <div className="mt-3 text-[var(--ve-ink)]">
        <RichMarkdown content={card.prompt} />
      </div>

      {/* Optional Rubric Points / Checkpoints for Short Answer or Code */}
      {card.rubricPoints && card.rubricPoints.length > 0 && (
        <div className="mt-3 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-accent-soft)] px-3.5 py-2.5">
          <div className="text-[11px] font-semibold text-[var(--ve-ink)]">
            考察要点 / 自检清单：
          </div>
          <ul className="mt-1.5 space-y-1 text-xs text-[var(--ve-muted)]">
            {card.rubricPoints.map((pt, idx) => (
              <li key={`${idx}-${pt}`} className="flex items-start gap-1.5">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ve-accent-solid)]" />
                <span>{pt}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Optional Expected Output for Code Mode */}
      {card.mode === "code" && card.expectedOutput && (
        <div className="mt-3 rounded-xl border border-[var(--ve-emerald)]/35 bg-[var(--ve-emerald-soft)] px-3.5 py-2 text-xs">
          <span className="font-semibold text-[var(--ve-emerald)]">
            目标输出 / 验收标准：
          </span>
          <code className="ml-1.5 rounded bg-[var(--ve-surface)] px-1.5 py-0.5 font-mono text-[11.5px] text-[var(--ve-emerald)]">
            {card.expectedOutput}
          </code>
        </div>
      )}

      {showHint && card.hint && (
        <div className="mt-3 rounded-xl border border-[var(--ve-amber)]/35 bg-[var(--ve-amber-soft)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--ve-amber)]">
          <RichMarkdown content={card.hint} compact />
        </div>
      )}

      {/* 1. Single Choice Mode */}
      {card.mode === "choice" && card.choices && card.choices.length > 0 && (
        <div className="mt-4 space-y-3">
          <div className="space-y-2">
            {card.choices.map((c, idx) => {
              const letter = String.fromCharCode(65 + idx);
              const cleanChoice = c.replace(/^[A-E][.、\s]+/, "");
              const picked = selectedChoice === idx;
              const isKnownCorrect =
                isSubmitted &&
                card.correctChoiceIndex !== undefined &&
                card.correctChoiceIndex === idx;
              const isKnownWrongPick =
                isSubmitted &&
                picked &&
                card.correctChoiceIndex !== undefined &&
                card.correctChoiceIndex !== idx;

              return (
                <button
                  id={idx === 0 ? `check-input-${card.checkId}` : undefined}
                  key={`${idx}-${c}`}
                  type="button"
                  disabled={disabled || isSubmitted}
                  onClick={() => handleSelectOption(idx)}
                  className={
                    "group flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left text-[13.5px] transition disabled:cursor-default " +
                    (isKnownCorrect
                      ? "border-[var(--ve-emerald)]/45 bg-[var(--ve-emerald-soft)] text-[var(--ve-emerald)]"
                      : isKnownWrongPick
                        ? "border-[var(--ve-amber)]/45 bg-[var(--ve-amber-soft)] text-[var(--ve-amber)]"
                        : picked
                          ? "border-[var(--ve-accent-solid)] bg-[var(--ve-canvas)] font-semibold text-[var(--ve-ink)]"
                          : "border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-ink)] hover:border-[var(--ve-line)] hover:bg-[var(--ve-surface-alt)]")
                  }
                >
                  <span className="flex items-center gap-3">
                    <span
                      className={
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition " +
                        (isKnownCorrect
                          ? "border-[var(--ve-emerald)] bg-emerald-600 text-white"
                          : picked
                            ? "border-[var(--ve-accent-solid)] bg-[var(--ve-accent-solid)]"
                            : "border-[var(--ve-border)] bg-[var(--ve-surface)] group-hover:border-[var(--ve-line)]")
                      }
                    >
                      {picked && (
                        <span className="h-2 w-2 rounded-full bg-[var(--ve-surface)]" />
                      )}
                    </span>
                    <span>
                      {letter}. {cleanChoice}
                    </span>
                  </span>
                  {isKnownCorrect && (
                    <span className="shrink-0 rounded-full bg-[var(--ve-emerald-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--ve-emerald)]">
                      正确答案
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="pt-1">
            {isSubmitted ? (
              <div className="flex w-full items-center justify-center gap-1.5 rounded-full bg-[var(--ve-surface-alt)] py-2.5 text-xs font-semibold text-[var(--ve-ink)]">
                <CheckCircle2 size={14} className="text-[var(--ve-emerald)]" />
                已提交（{card.savedUserAnswer || "已作答"}）
              </div>
            ) : (
              <button
                type="button"
                disabled={disabled || selectedChoice === null}
                onClick={handleCheckChoiceAnswer}
                className={
                  "w-full rounded-full py-2.5 text-[13.5px] font-semibold transition " +
                  (selectedChoice !== null
                    ? "bg-[var(--ve-accent-solid)] text-white hover:opacity-90"
                    : "bg-[var(--ve-surface-alt)] text-[var(--ve-muted)]")
                }
              >
                检查答案
              </button>
            )}
          </div>
        </div>
      )}

      {/* 2. Multi-Choice Mode */}
      {card.mode === "multi_choice" &&
        card.choices &&
        card.choices.length > 0 && (
          <div className="mt-4 space-y-3">
            <div className="text-xs font-medium text-[var(--ve-muted)]">
              本题为多选题，请勾选所有符合条件的选项：
            </div>
            <div className="space-y-2">
              {card.choices.map((c, idx) => {
                const letter = String.fromCharCode(65 + idx);
                const cleanChoice = c.replace(/^[A-E][.、\s]+/, "");
                const picked = selectedChoices.includes(idx);
                return (
                  <button
                    id={idx === 0 ? `check-input-${card.checkId}` : undefined}
                    key={`${idx}-${c}`}
                    type="button"
                    disabled={disabled || isSubmitted}
                    onClick={() => handleToggleMultiOption(idx)}
                    className={
                      "group flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left text-[13.5px] transition disabled:cursor-default " +
                      (picked
                        ? "border-[var(--ve-purple)] bg-[var(--ve-purple-soft)] font-semibold text-[var(--ve-ink)]"
                        : "border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-ink)] hover:border-[var(--ve-line)] hover:bg-[var(--ve-surface-alt)]")
                    }
                  >
                    <span
                      className={
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition " +
                        (picked
                          ? "border-[var(--ve-purple)] bg-purple-600 text-white"
                          : "border-[var(--ve-border)] bg-[var(--ve-surface)] group-hover:border-[var(--ve-line)]")
                      }
                    >
                      {picked && <Check size={12} />}
                    </span>
                    <span>
                      {letter}. {cleanChoice}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="pt-1">
              {isSubmitted ? (
                <div className="flex w-full items-center justify-center gap-1.5 rounded-full bg-[var(--ve-surface-alt)] py-2.5 text-xs font-semibold text-[var(--ve-ink)]">
                  <CheckCircle2 size={14} className="text-[var(--ve-emerald)]" />
                  已提交多选（{card.savedUserAnswer || "已作答"}）
                </div>
              ) : (
                <button
                  type="button"
                  disabled={disabled || selectedChoices.length === 0}
                  onClick={handleCheckMultiChoiceAnswer}
                  className={
                    "w-full rounded-full py-2.5 text-[13.5px] font-semibold transition " +
                    (selectedChoices.length > 0
                      ? "bg-[var(--ve-accent-solid)] text-white hover:opacity-90"
                      : "bg-[var(--ve-surface-alt)] text-[var(--ve-muted)]")
                  }
                >
                  检查答案（已选 {selectedChoices.length} 项）
                </button>
              )}
            </div>
          </div>
        )}

      {/* 3. Fill-in-the-Blank Mode (Code Cloze / Concept Blanks) */}
      {card.mode === "fill_blank" && (
        <form onSubmit={handleSubmitBlanks} className="mt-4 space-y-3">
          {card.starterCode && (
            <div className="overflow-hidden rounded-xl border border-[var(--ve-border)]">
              <RichMarkdown
                content={`\`\`\`${card.language || "java"}\n${card.starterCode}\n\`\`\``}
              />
            </div>
          )}

          <div className="space-y-2.5 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-3.5">
            <div className="text-xs font-semibold text-[var(--ve-ink)]">
              请依次填入空白处的代码或核心概念：
            </div>
            {blankSlots.map((slot, idx) => {
              const val = blankValues[slot.id] || "";
              const isSlotCorrect =
                isSubmitted &&
                slot.answer &&
                val.trim().toLowerCase() === slot.answer.trim().toLowerCase();
              return (
                <div
                  key={slot.id}
                  className="flex flex-col gap-1.5 sm:flex-row sm:items-center"
                >
                  <label
                    htmlFor={
                      idx === 0
                        ? `check-input-${card.checkId}`
                        : `check-blank-${card.checkId}-${slot.id}`
                    }
                    className="min-w-[88px] shrink-0 font-mono text-xs font-semibold text-[var(--ve-accent)]"
                  >
                    {slot.label || `空 (${idx + 1})`}
                  </label>
                  <input
                    id={
                      idx === 0
                        ? `check-input-${card.checkId}`
                        : `check-blank-${card.checkId}-${slot.id}`
                    }
                    type="text"
                    value={val}
                    disabled={disabled || isSubmitted}
                    onChange={(e) => handleBlankChange(slot.id, e.target.value)}
                    placeholder={
                      slot.placeholder || "输入此处缺失的关键代码或概念…"
                    }
                    className={
                      "flex-1 rounded-lg border px-3 py-1.5 font-mono text-[13px] text-[var(--ve-ink)] outline-none transition " +
                      (isSlotCorrect
                        ? "border-[var(--ve-emerald)]/60 bg-[var(--ve-emerald-soft)]"
                        : "border-[var(--ve-border)] bg-[var(--ve-surface)] focus:border-[var(--ve-accent)]")
                    }
                  />
                  {isSubmitted && slot.answer && (
                    <span className="font-mono text-[11px] text-[var(--ve-emerald)]">
                      参考：{slot.answer}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {isSubmitted ? (
            <div className="flex w-full items-center justify-center gap-1.5 rounded-full bg-[var(--ve-surface-alt)] py-2.5 text-xs font-semibold text-[var(--ve-ink)]">
              <CheckCircle2 size={14} className="text-[var(--ve-emerald)]" />
              已提交填空（{card.savedUserAnswer || "已作答"}）
            </div>
          ) : (
            <button
              type="submit"
              disabled={
                disabled ||
                !blankSlots.every((s) => (blankValues[s.id] || "").trim())
              }
              className={
                "w-full rounded-full py-2.5 text-[13.5px] font-semibold transition " +
                (blankSlots.every((s) => (blankValues[s.id] || "").trim())
                  ? "bg-[var(--ve-accent-solid)] text-white hover:opacity-90"
                  : "bg-[var(--ve-surface-alt)] text-[var(--ve-muted)]")
              }
            >
              检查填空答案
            </button>
          )}
        </form>
      )}

      {/* 4. Order Steps Mode (Execution Flow / Algorithm Step Ordering) */}
      {card.mode === "order_steps" && orderedSteps.length > 0 && (
        <div className="mt-4 space-y-3">
          <div className="text-xs font-medium text-[var(--ve-muted)]">
            请使用右侧上下按钮，将以下步骤调整为正确的先后执行顺序：
          </div>
          <div className="space-y-2">
            {orderedSteps.map((stepText, idx) => (
              <div
                key={`${idx}-${stepText}`}
                className="flex items-center justify-between gap-2 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-3.5 py-2.5 text-[13px] text-[var(--ve-ink)]"
              >
                <div className="flex items-center gap-2.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[var(--ve-accent-solid)] font-mono text-xs font-bold text-white">
                    {idx + 1}
                  </span>
                  <span className="font-medium">{stepText}</span>
                </div>
                {!isSubmitted && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      id={idx === 0 ? `check-input-${card.checkId}` : undefined}
                      type="button"
                      disabled={disabled || idx === 0}
                      onClick={() => moveStep(idx, -1)}
                      title="上移一步"
                      aria-label="上移一步"
                      className="rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] p-1 text-[var(--ve-muted)] hover:bg-[var(--ve-accent-soft)] hover:text-[var(--ve-accent)] disabled:opacity-35"
                    >
                      <ArrowUp size={13} />
                    </button>
                    <button
                      type="button"
                      disabled={disabled || idx === orderedSteps.length - 1}
                      onClick={() => moveStep(idx, 1)}
                      title="下移一步"
                      aria-label="下移一步"
                      className="rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] p-1 text-[var(--ve-muted)] hover:bg-[var(--ve-accent-soft)] hover:text-[var(--ve-accent)] disabled:opacity-35"
                    >
                      <ArrowDown size={13} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {isSubmitted ? (
            <div className="flex w-full items-center justify-center gap-1.5 rounded-full bg-[var(--ve-surface-alt)] py-2.5 text-xs font-semibold text-[var(--ve-ink)]">
              <CheckCircle2 size={14} className="text-[var(--ve-emerald)]" />
              已提交步骤顺序
            </div>
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={handleSubmitOrder}
              className="w-full rounded-full bg-[var(--ve-accent-solid)] py-2.5 text-[13.5px] font-semibold text-white transition hover:opacity-90"
            >
              确认顺序并检查答案
            </button>
          )}
        </div>
      )}

      {/* 5 & 6. Hands-on Code Sandbox (CodeMirror 6) or Feynman Short Answer (Prose Textarea) */}
      {(card.mode === "short_answer" || card.mode === "code") && (
        <form onSubmit={handleSubmitText} className="mt-4 space-y-3">
          {card.mode === "code" ? (
            <CodeEditorBox
              id={`check-input-${card.checkId}`}
              value={textAnswer}
              onChange={(val) => setCheckDraft(card.checkId, { text: val })}
              language={card.language || "python"}
              starterCode={card.starterCode}
              readOnly={Boolean(disabled || isSubmitted)}
              label="动手编程编辑器（切页自动保留草稿）"
              placeholder="在这里编写或补全你的代码（支持语法高亮、行号与自动缩进）…"
              minHeight="180px"
            />
          ) : (
            <textarea
              id={`check-input-${card.checkId}`}
              value={textAnswer}
              onChange={(e) =>
                setCheckDraft(card.checkId, { text: e.target.value })
              }
              disabled={disabled || isSubmitted}
              rows={4}
              placeholder="用你自己的话解释核心原理、推导过程或设计思路（切页不会丢失草稿）…"
              className="w-full rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-3 text-[13.5px] leading-relaxed text-[var(--ve-ink)] outline-none focus:border-[var(--ve-accent)] focus:bg-[var(--ve-surface)]"
            />
          )}
          {isSubmitted ? (
            <div className="flex w-full items-center justify-center gap-1.5 rounded-full bg-[var(--ve-surface-alt)] py-2.5 text-xs font-semibold text-[var(--ve-ink)]">
              <CheckCircle2 size={14} className="text-[var(--ve-emerald)]" />
              已提交作答
            </div>
          ) : (
            <button
              type="submit"
              disabled={disabled || !textAnswer.trim()}
              className={
                "w-full rounded-full py-2.5 text-[13.5px] font-semibold transition " +
                (textAnswer.trim()
                  ? "bg-[var(--ve-accent-solid)] text-white hover:opacity-90"
                  : "bg-[var(--ve-surface-alt)] text-[var(--ve-muted)]")
              }
            >
              {card.mode === "code" ? "提交代码并运行评估" : "提交回答并评估掌握度"}
            </button>
          )}
        </form>
      )}

      {/* Instant In-Card Explanation after submission */}
      {isSubmitted && card.explanation && (
        <div className="mt-3.5 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-accent-soft)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--ve-accent)]">
          <div className="mb-1 font-semibold">参考解析：</div>
          <RichMarkdown content={card.explanation} compact />
        </div>
      )}

      {/* Interactive Exercise Format Switcher: user can switch away from multiple-choice anytime */}
      {onRequestModeSwitch && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-[var(--ve-border)] pt-3">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--ve-muted)]">
            <Sparkles size={11} className="text-[var(--ve-accent)]" />
            切换练习题型：
          </span>
          {alternateModes.map((alt) => (
            <button
              key={alt.mode}
              type="button"
              disabled={disabled}
              onClick={() => onRequestModeSwitch(alt.mode, alt.prompt)}
              className="rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-2 py-0.5 text-[11px] font-medium text-[var(--ve-muted)] transition hover:border-[var(--ve-accent)] hover:bg-[var(--ve-accent-soft)] hover:text-[var(--ve-accent)] disabled:opacity-40"
            >
              {alt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
