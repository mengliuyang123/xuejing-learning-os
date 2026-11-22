"use client";
import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { java } from "@codemirror/lang-java";
import { json } from "@codemirror/lang-json";
import { sql } from "@codemirror/lang-sql";
import { cpp } from "@codemirror/lang-cpp";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { Check, Code2, Copy, RotateCcw } from "lucide-react";

export type CodeLanguageId =
  | "python"
  | "typescript"
  | "javascript"
  | "java"
  | "json"
  | "sql"
  | "cpp"
  | "html"
  | "css"
  | "markdown"
  | "plaintext";

export const CODE_LANGUAGES: Array<{ id: CodeLanguageId; label: string }> = [
  { id: "python", label: "Python" },
  { id: "typescript", label: "TypeScript" },
  { id: "javascript", label: "JavaScript" },
  { id: "java", label: "Java" },
  { id: "json", label: "JSON" },
  { id: "sql", label: "SQL" },
  { id: "cpp", label: "C / C++" },
  { id: "html", label: "HTML" },
  { id: "css", label: "CSS" },
  { id: "markdown", label: "Markdown" },
  { id: "plaintext", label: "Plain Text" },
];

export function normalizeCodeLanguage(raw?: string | null): CodeLanguageId {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return "python";
  if (s === "py" || s === "python" || s === "python3") return "python";
  if (s === "ts" || s === "tsx" || s === "typescript") return "typescript";
  if (s === "js" || s === "jsx" || s === "javascript" || s === "node") {
    return "javascript";
  }
  if (s === "java") return "java";
  if (s === "json" || s === "jsonc") return "json";
  if (s === "sql" || s === "sqlite" || s === "mysql" || s === "postgres") {
    return "sql";
  }
  if (s === "c" || s === "cpp" || s === "c++" || s === "cc") return "cpp";
  if (s === "html" || s === "xml") return "html";
  if (s === "css" || s === "scss") return "css";
  if (s === "md" || s === "markdown") return "markdown";
  return "plaintext";
}

function getLanguageExtension(lang: CodeLanguageId) {
  switch (lang) {
    case "python":
      return [python()];
    case "typescript":
      return [javascript({ typescript: true, jsx: true })];
    case "javascript":
      return [javascript({ jsx: true })];
    case "java":
      return [java()];
    case "json":
      return [json()];
    case "sql":
      return [sql()];
    case "cpp":
      return [cpp()];
    case "html":
      return [html()];
    case "css":
      return [css()];
    case "markdown":
      return [markdown()];
    default:
      return [];
  }
}

function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const sync = () => {
      setDark(document.documentElement.dataset.theme === "dark");
    };
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  return dark;
}

const xuejingLightTheme = EditorView.theme({
  "&": {
    fontSize: "12.5px",
    backgroundColor: "#ffffff",
    color: "#182230",
  },
  ".cm-content": {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    padding: "10px 0",
    lineHeight: "1.65",
  },
  ".cm-gutters": {
    backgroundColor: "#f7f9fc",
    color: "#8894a8",
    borderRight: "1px solid #dfe5ef",
    fontSize: "11px",
    minWidth: "36px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "#eaf0ff",
    color: "#2444c9",
    fontWeight: "600",
  },
  ".cm-activeLine": {
    backgroundColor: "#f5f8ff",
  },
  ".cm-cursor": {
    borderLeftColor: "#2444c9",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "#dbe6ff !important",
  },
});

const xuejingDarkTheme = EditorView.theme(
  {
    "&": {
      fontSize: "12.5px",
      backgroundColor: "#141820",
      color: "#e8ecf4",
    },
    ".cm-content": {
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      padding: "10px 0",
      lineHeight: "1.65",
      caretColor: "#6091ff",
    },
    ".cm-gutters": {
      backgroundColor: "#19202c",
      color: "#768399",
      borderRight: "1px solid #2a3345",
      fontSize: "11px",
      minWidth: "36px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(96, 145, 255, 0.16)",
      color: "#9bb8ff",
      fontWeight: "600",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(96, 145, 255, 0.08)",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#6091ff",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(96, 145, 255, 0.28) !important",
    },
  },
  { dark: true },
);

export type CodeEditorBoxProps = {
  id?: string;
  value: string;
  onChange: (val: string) => void;
  language?: string;
  allowLanguageSwitch?: boolean;
  onLanguageChange?: (lang: CodeLanguageId) => void;
  placeholder?: string;
  starterCode?: string;
  readOnly?: boolean;
  minHeight?: string;
  maxHeight?: string;
  label?: string;
};

export default function CodeEditorInner({
  id,
  value,
  onChange,
  language = "python",
  allowLanguageSwitch = true,
  onLanguageChange,
  placeholder = "// 在此编写代码…",
  starterCode,
  readOnly = false,
  minHeight = "180px",
  maxHeight = "380px",
  label,
}: CodeEditorBoxProps) {
  const [localLang, setLocalLang] = useState<CodeLanguageId>(() =>
    normalizeCodeLanguage(language),
  );
  const [copied, setCopied] = useState(false);
  const isDark = useIsDarkTheme();

  const activeLang = onLanguageChange
    ? normalizeCodeLanguage(language)
    : localLang;

  const extensions = useMemo(
    () => [
      ...getLanguageExtension(activeLang),
      isDark ? xuejingDarkTheme : xuejingLightTheme,
      EditorView.lineWrapping,
    ],
    [activeLang, isDark],
  );

  const lineCount = useMemo(
    () => (value ? value.split("\n").length : 1),
    [value],
  );

  function handleCopy() {
    if (!value) return;
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      id={id}
      className="overflow-hidden rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] transition focus-within:border-[var(--ve-accent)] focus-within:ring-2 focus-within:ring-[var(--ve-accent)]/15"
    >
      {/* Code Editor Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--ve-border)] bg-[var(--ve-surface)] px-3.5 py-2">
        <div className="flex items-center gap-2">
          <Code2 size={13} className="text-[var(--ve-accent)]" />
          <span className="text-[11.5px] font-semibold text-[var(--ve-ink)]">
            {label || "代码编辑器"}
          </span>
          {allowLanguageSwitch && !readOnly ? (
            <select
              aria-label="选择编程语言"
              value={activeLang}
              onChange={(e) => {
                const next = e.target.value as CodeLanguageId;
                setLocalLang(next);
                onLanguageChange?.(next);
              }}
              className="rounded-md border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-2 py-0.5 font-mono text-[10.5px] font-semibold text-[var(--ve-ink)] outline-none hover:border-[var(--ve-accent)]"
            >
              {CODE_LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="rounded-md border border-[var(--ve-border)] bg-[var(--ve-canvas)] px-2 py-0.5 font-mono text-[10.5px] font-semibold text-[var(--ve-muted)]">
              {CODE_LANGUAGES.find((l) => l.id === activeLang)?.label ||
                activeLang}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-[10.5px] text-[var(--ve-muted)]">
          <span className="font-mono">
            {lineCount} 行 · {value.length} 字符
          </span>
          {starterCode !== undefined && !readOnly && value !== starterCode && (
            <button
              type="button"
              onClick={() => onChange(starterCode)}
              title="恢复初始模板代码"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
            >
              <RotateCcw size={11} /> 重置模板
            </button>
          )}
          {value.length > 0 && (
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-accent)]"
            >
              {copied ? (
                <Check size={11} className="text-[var(--ve-emerald)]" />
              ) : (
                <Copy size={11} />
              )}
              {copied ? "已复制" : "复制"}
            </button>
          )}
        </div>
      </div>

      {/* CodeMirror 6 Real Editor (Dynamic Light / Dark Theme) */}
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={isDark ? "dark" : "light"}
        extensions={extensions}
        editable={!readOnly}
        readOnly={readOnly}
        placeholder={placeholder}
        minHeight={minHeight}
        maxHeight={maxHeight}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          highlightActiveLine: true,
          foldGutter: false,
          autocompletion: true,
          bracketMatching: true,
          closeBrackets: true,
          indentOnInput: true,
          tabSize: 2,
        }}
      />
    </div>
  );
}
