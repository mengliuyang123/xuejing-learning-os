"use client";
import { useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js";
import "highlight.js/styles/github.css";
import {
  Check,
  Code2,
  Copy,
  ImageOff,
  RotateCcw,
  X,
} from "lucide-react";
import BeautifulMermaidCanvas from "./BeautifulMermaidCanvas";
import SandboxedSvgCanvas from "./SandboxedSvgCanvas";

/**
 * RICH-14: Lightweight deterministic LaTeX-to-Unicode math formatter for inline $...$ and display $$...$$
 * outside fenced code blocks so formulas render cleanly without raw '$' leakage or external CDN dependencies.
 */
function formatLatexMath(expr: string): string {
  const supMap: Record<string, string> = {
    "0": "⁰",
    "1": "¹",
    "2": "²",
    "3": "³",
    "4": "⁴",
    "5": "⁵",
    "6": "⁶",
    "7": "⁷",
    "8": "⁸",
    "9": "⁹",
    "+": "⁺",
    "-": "⁻",
    n: "ⁿ",
    i: "ⁱ",
  };
  const subMap: Record<string, string> = {
    "0": "₀",
    "1": "₁",
    "2": "₂",
    "3": "₃",
    "4": "₄",
    "5": "₅",
    "6": "₆",
    "7": "₇",
    "8": "₈",
    "9": "₉",
    i: "ᵢ",
    n: "ₙ",
  };
  return expr
    .trim()
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)")
    .replace(/\\sqrt\{([^{}]+)\}/g, "√($1)")
    .replace(/\\sum/g, "∑")
    .replace(/\\prod/g, "∏")
    .replace(/\\int/g, "∫")
    .replace(/\\infty/g, "∞")
    .replace(/\\times/g, "×")
    .replace(/\\cdot/g, "·")
    .replace(/\\pm/g, "±")
    .replace(/\\le/g, "≤")
    .replace(/\\ge/g, "≥")
    .replace(/\\neq/g, "≠")
    .replace(/\\approx/g, "≈")
    .replace(/\\to|\\rightarrow/g, "→")
    .replace(/\\alpha/g, "α")
    .replace(/\\beta/g, "β")
    .replace(/\\gamma/g, "γ")
    .replace(/\\delta/g, "δ")
    .replace(/\\theta/g, "θ")
    .replace(/\\lambda/g, "λ")
    .replace(/\\mu/g, "μ")
    .replace(/\\pi/g, "π")
    .replace(/\\sigma/g, "σ")
    .replace(/\^\{([0-9+\-ni]+)\}/g, (_, g: string) =>
      g
        .split("")
        .map((c) => supMap[c] || c)
        .join(""),
    )
    .replace(/\^([0-9ni])/g, (_, c: string) => supMap[c] || `^${c}`)
    .replace(/_\{([0-9in]+)\}/g, (_, g: string) =>
      g
        .split("")
        .map((c) => subMap[c] || c)
        .join(""),
    )
    .replace(/_([0-9in])/g, (_, c: string) => subMap[c] || `_${c}`);
}

function preprocessMarkdownMath(raw: string): string {
  // Split by fenced code blocks so we never alter code inside ``` ... ```
  const parts = raw.split(/(```[\s\S]*?```)/g);
  return parts
    .map((segment, idx) => {
      if (idx % 2 === 1) return segment;
      return segment
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, inner: string) => {
          const pretty = formatLatexMath(inner);
          return `\n\`${pretty}\`\n`;
        })
        .replace(
          /(^|[^\\$])\$([^$\n]+?)\$/g,
          (_, prefix: string, inner: string) => {
            if (!inner.trim() || /^\d+(\.\d+)?$/.test(inner.trim())) {
              return `${prefix}$${inner}$`;
            }
            const pretty = formatLatexMath(inner);
            return `${prefix}\`${pretty}\``;
          },
        );
    })
    .join("");
}

function MarkdownImage({
  src,
  alt,
  onZoom,
}: {
  src: string;
  alt?: string;
  onZoom: (src: string, alt: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  if (failed) {
    return (
      <span className="my-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50/60 px-3.5 py-2.5 text-xs text-amber-950">
        <span className="flex min-w-0 items-center gap-2">
          <ImageOff size={15} className="shrink-0 text-amber-700" />
          <span className="min-w-0">
            <span className="block font-medium">
              图片加载失败{alt ? `：${alt}` : ""}
            </span>
            <span className="block truncate font-mono text-[10.5px] text-amber-800/80">
              {src}
            </span>
          </span>
        </span>
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setRetryNonce((n) => n + 1);
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-50"
        >
          <RotateCcw size={11} /> 重新加载
        </button>
      </span>
    );
  }

  return (
    <span className="my-2.5 block overflow-hidden rounded-xl border border-[#e2e7f2] bg-[#f8faff]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={retryNonce}
        src={src}
        alt={alt || "教学插图"}
        loading="lazy"
        onError={() => setFailed(true)}
        onClick={() => onZoom(src, alt || "")}
        className="max-h-64 w-full cursor-zoom-in bg-white object-contain p-2"
      />
      {alt && (
        <span className="block border-t border-[#edf1f8] px-3 py-1.5 text-[11px] text-[#526079]">
          {alt}（点击图片放大）
        </span>
      )}
    </span>
  );
}

function CodeBlockCard({
  language,
  code,
}: {
  language: string;
  code: string;
}) {
  const [copied, setCopied] = useState(false);

  const { html, displayLang } = useMemo(() => {
    const cleanLang = (language || "").trim().toLowerCase();
    try {
      if (cleanLang && hljs.getLanguage(cleanLang)) {
        const res = hljs.highlight(code, {
          language: cleanLang,
          ignoreIllegals: true,
        });
        const langObj = hljs.getLanguage(cleanLang);
        return {
          html: res.value,
          displayLang: langObj?.name || language,
        };
      }
      const auto = hljs.highlightAuto(code);
      const detected = auto.language
        ? hljs.getLanguage(auto.language)?.name || auto.language
        : language || "Code";
      return {
        html: auto.value,
        displayLang: detected,
      };
    } catch {
      return {
        html: "",
        displayLang: language || "Code",
      };
    }
  }, [code, language]);

  function handleCopy() {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="my-3.5 overflow-hidden rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-canvas)]">
      <div className="flex items-center justify-between px-4 pt-2.5 pb-1 text-xs text-[var(--ve-muted)]">
        <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--ve-ink)]">
          <Code2 size={14} className="text-[var(--ve-muted)]" />
          <span>{displayLang}</span>
        </span>
        <button
          type="button"
          onClick={handleCopy}
          title="复制代码"
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
        >
          {copied ? (
            <Check size={12} className="text-[var(--ve-emerald)]" />
          ) : (
            <Copy size={12} />
          )}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre className="m-0 overflow-x-auto whitespace-pre border-0 bg-transparent px-4 pt-1 pb-3.5 font-mono text-[13px] leading-relaxed text-[var(--ve-ink)]">
        {html ? (
          <code
            className="hljs !bg-transparent !p-0 whitespace-pre"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <code className="whitespace-pre">{code}</code>
        )}
      </pre>
    </div>
  );
}

export default function RichMarkdown({
  content,
  compact = false,
}: {
  content: string;
  compact?: boolean;
}) {
  const [lightboxImg, setLightboxImg] = useState<{
    src: string;
    alt?: string;
  } | null>(null);

  return (
    <div
      className={
        "prose-chat leading-relaxed text-[var(--ink)] " +
        (compact ? "text-xs" : "text-[14.5px]")
      }
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-([\w+#.-]+)/.exec(className || "");
            const raw = String(children).replace(/\n$/, "");
            const isBlock = Boolean(match) || raw.includes("\n");

            if (!isBlock) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }

            const lang = (match?.[1] || "").toLowerCase();
            if (lang === "mermaid") {
              return <BeautifulMermaidCanvas code={raw} />;
            }
            if (lang === "svg" && raw.includes("<svg")) {
              return <SandboxedSvgCanvas svg={raw} />;
            }
            return <CodeBlockCard language={lang} code={raw} />;
          },
          pre({ children }) {
            return <>{children}</>;
          },
          table({ children }) {
            return (
              <div className="my-2.5 max-w-full overflow-x-auto rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)]">
                <table className="w-full min-w-[320px] border-collapse text-left text-xs">
                  {children}
                </table>
              </div>
            );
          },
          thead({ children }) {
            return (
              <thead className="border-b border-[var(--ve-border)] bg-[var(--ve-surface-alt)] font-semibold text-[var(--ve-ink)]">
                {children}
              </thead>
            );
          },
          th({ children }) {
            return (
              <th className="min-w-[84px] break-words px-3 py-2 text-[11px] font-semibold text-[var(--ve-ink)]">
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td className="min-w-[84px] break-words border-t border-[var(--ve-border)]/70 px-3 py-2 align-top text-xs leading-relaxed text-[var(--ve-ink)]">
                {children}
              </td>
            );
          },
          img({ src, alt }) {
            if (!src || typeof src !== "string") return null;
            return (
              <MarkdownImage
                src={src}
                alt={alt}
                onZoom={(s, a) => setLightboxImg({ src: s, alt: a })}
              />
            );
          },
        }}
      >
        {preprocessMarkdownMath(content)}
      </Markdown>

      {lightboxImg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-6 backdrop-blur-xs"
          onClick={() => setLightboxImg(null)}
          role="dialog"
          aria-label="图片放大预览"
        >
          <div
            className="relative max-h-[90vh] max-w-[90vw] overflow-hidden rounded-2xl bg-white p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setLightboxImg(null)}
              className="absolute top-3 right-3 rounded-lg border border-[#e5e7eb] bg-white p-1.5 text-[#374151] hover:bg-[#f3f4f6]"
              aria-label="关闭"
            >
              <X size={16} />
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightboxImg.src}
              alt={lightboxImg.alt || "预览"}
              className="max-h-[80vh] max-w-[85vw] object-contain"
            />
            {lightboxImg.alt && (
              <p className="mt-2 text-center text-xs text-[#4b5563]">
                {lightboxImg.alt}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
