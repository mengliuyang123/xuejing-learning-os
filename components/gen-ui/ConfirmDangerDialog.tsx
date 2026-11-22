"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, X } from "lucide-react";
import { TRANSITION_FAST } from "../../lib/motion";

export type ConfirmDangerDialogProps = {
  open: boolean;
  title: string;
  description: string;
  impacts?: string[];
  preservedNote?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmKeyword?: string;
  tone?: "danger" | "warning";
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
};

export function ConfirmDangerDialog({
  open,
  title,
  description,
  impacts = [],
  preservedNote,
  confirmLabel = "确认执行",
  cancelLabel = "取消",
  confirmKeyword,
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDangerDialogProps) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) {
      setTyped("");
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onCancel]);

  const keywordMatched =
    !confirmKeyword ||
    typed.trim().toUpperCase() === confirmKeyword.toUpperCase();
  const isDanger = tone === "danger";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="confirm-danger-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={TRANSITION_FAST}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-danger-title"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) onCancel();
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={TRANSITION_FAST}
            className="w-full max-w-md overflow-hidden rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] shadow-xl"
          >
            <div className="flex items-start justify-between gap-3 border-b border-[var(--ve-border)] bg-[var(--ve-canvas)] px-4 py-3.5">
              <div className="flex items-start gap-2.5">
                <div
                  className={
                    "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg " +
                    (isDanger
                      ? "bg-[var(--ve-rose-soft)] text-[var(--ve-rose)]"
                      : "bg-[var(--ve-amber-soft)] text-[var(--ve-amber)]")
                  }
                >
                  <AlertTriangle size={15} aria-hidden="true" />
                </div>
                <div>
                  <h3
                    id="confirm-danger-title"
                    className="text-sm font-semibold text-[var(--ve-ink)]"
                  >
                    {title}
                  </h3>
                  <p className="mt-0.5 text-xs leading-relaxed text-[var(--ve-muted)]">
                    {description}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                aria-label="关闭确认对话框"
                className="rounded-md p-1 text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)] disabled:opacity-50"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            <div className="space-y-3 p-4">
              {impacts.length > 0 && (
                <div className="rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-3.5 py-2.5">
                  <div className="text-[11px] font-semibold text-[var(--ve-muted)]">
                    影响范围
                  </div>
                  <ul className="mt-1.5 space-y-1 text-xs text-[var(--ve-ink)]">
                    {impacts.map((line, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--ve-muted)]" />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preservedNote && (
                <div className="rounded-lg bg-[var(--ve-emerald-soft)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--ve-emerald)]">
                  {preservedNote}
                </div>
              )}

              {confirmKeyword && (
                <div>
                  <label
                    htmlFor="confirm-danger-keyword"
                    className="block text-xs font-medium text-[var(--ve-muted)]"
                  >
                    请输入{" "}
                    <code className="rounded border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-1.5 py-0.5 font-mono text-[var(--ve-ink)]">
                      {confirmKeyword}
                    </code>{" "}
                    以确认此操作
                  </label>
                  <input
                    id="confirm-danger-keyword"
                    type="text"
                    autoFocus
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={`输入 ${confirmKeyword}`}
                    className="mt-1.5 w-full rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-3 py-1.5 font-mono text-xs text-[var(--ve-ink)] outline-none focus:border-[var(--ve-accent)]"
                  />
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={busy}
                  className="rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-3.5 py-1.5 text-xs font-medium text-[var(--ve-ink)] hover:bg-[var(--ve-surface-alt)] disabled:opacity-50"
                >
                  {cancelLabel}
                </button>
                <button
                  type="button"
                  disabled={busy || !keywordMatched}
                  onClick={() => void onConfirm()}
                  className={
                    "rounded-lg px-3.5 py-1.5 text-xs font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-45 " +
                    (isDanger
                      ? "bg-[#c8283a] hover:bg-[#ad1f30]"
                      : "bg-[#b4690e] hover:bg-[#99570a]")
                  }
                >
                  {busy ? "执行中…" : confirmLabel}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
