"use client";
import dynamic from "next/dynamic";
import type { CodeEditorBoxProps } from "./CodeEditorInner";

export type { CodeEditorBoxProps, CodeLanguageId } from "./CodeEditorInner";
export { CODE_LANGUAGES, normalizeCodeLanguage } from "./CodeEditorInner";

const DynamicCodeEditorInner = dynamic(() => import("./CodeEditorInner"), {
  ssr: false,
  loading: () => (
    <div className="rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-surface)] p-4 font-mono text-xs text-[var(--ve-muted)]">
      正在加载代码编辑器…
    </div>
  ),
});

export default function CodeEditorBox(props: CodeEditorBoxProps) {
  return <DynamicCodeEditorInner {...props} />;
}
