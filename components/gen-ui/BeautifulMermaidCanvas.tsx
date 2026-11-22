"use client";
import { useEffect, useId, useMemo, useState } from "react";
import { renderMermaidSVG } from "beautiful-mermaid";
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Eye,
  Maximize2,
  X,
} from "lucide-react";

function detectDarkTheme(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-theme") === "dark";
}

export default function BeautifulMermaidCanvas({
  code,
  caption,
}: {
  code: string;
  caption?: string;
}) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const cleanCode = code.trim();

  // Primary synchronous render via beautiful-mermaid using live CSS variables (light & dark reactive!)
  const primaryResult = useMemo(() => {
    if (!cleanCode) return { svg: "", error: "" };
    try {
      const svg = renderMermaidSVG(cleanCode, {
        bg: "var(--ve-canvas)",
        fg: "var(--ve-ink)",
        surface: "var(--ve-surface)",
        border: "var(--ve-border)",
        line: "var(--ve-line)",
        accent: "var(--ve-accent)",
        muted: "var(--ve-muted)",
        font: "Inter, 'PingFang SC', 'Microsoft YaHei UI', sans-serif",
        padding: 28,
        nodeSpacing: 28,
        layerSpacing: 42,
        transparent: true,
        interactive: true,
      });
      return { svg, error: "" };
    } catch (err) {
      return {
        svg: "",
        error: err instanceof Error ? err.message : "unsupported",
      };
    }
  }, [cleanCode]);

  const [fallbackSvg, setFallbackSvg] = useState("");
  const [fallbackError, setFallbackError] = useState("");
  const [fallbackLoading, setFallbackLoading] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [copied, setCopied] = useState(false);

  // Automatic fallback to mermaid v12 for diagram types not yet supported by beautiful-mermaid (e.g., mindmap/pie/gantt/timeline)
  useEffect(() => {
    if (!cleanCode || primaryResult.svg) {
      setFallbackSvg("");
      setFallbackError("");
      setFallbackLoading(false);
      return;
    }

    let cancelled = false;
    setFallbackLoading(true);
    const timer = setTimeout(async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        const isDark = detectDarkTheme();
        mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          securityLevel: "strict",
          fontFamily:
            "Inter, 'PingFang SC', 'Microsoft YaHei UI', sans-serif",
          themeVariables: isDark
            ? {
                primaryColor: "#1c222d",
                primaryTextColor: "#e8ecf4",
                primaryBorderColor: "#6091ff",
                lineColor: "#8290a8",
                secondaryColor: "#232a37",
                tertiaryColor: "#141820",
                background: "#141820",
              }
            : {
                primaryColor: "#eef2ff",
                primaryTextColor: "#16181d",
                primaryBorderColor: "#2563eb",
                lineColor: "#64748b",
                secondaryColor: "#ecfdf5",
                tertiaryColor: "#f8fafc",
                background: "#fafbfd",
              },
        });
        const renderId = `mmd-fb-${rawId}-${Date.now().toString(36)}`;
        const res = await mermaid.render(renderId, cleanCode);
        if (!cancelled) {
          setFallbackSvg(res.svg);
          setFallbackError("");
          setFallbackLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setFallbackSvg("");
          setFallbackError(
            err instanceof Error ? err.message : "Mermaid 图表语法解析失败",
          );
          setFallbackLoading(false);
        }
      }
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cleanCode, primaryResult.svg, rawId]);

  const effectiveSvg = primaryResult.svg || fallbackSvg;
  const effectiveError = !effectiveSvg ? fallbackError : "";

  function handleCopy() {
    void navigator.clipboard?.writeText(cleanCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <>
      <div className="group relative my-2.5 overflow-hidden rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] transition-colors">
        {/* Minimal floating top-right actions (no heavy header chrome) */}
        <div className="pointer-events-auto absolute top-2 right-2 z-10 flex items-center gap-1 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)]/90 px-1 py-0.5 shadow-2xs backdrop-blur-xs opacity-85 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
            title={showSource ? "查看图表" : "查看源码"}
          >
            {showSource ? <Eye size={11} /> : <Code2 size={11} />}
            <span>{showSource ? "图表" : "源码"}</span>
          </button>
          {effectiveSvg && !showSource && (
            <button
              type="button"
              onClick={() => setZoomed(true)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
              title="全屏放大查看"
            >
              <Maximize2 size={11} />
              <span>放大</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
            title="复制 Mermaid 源码"
          >
            {copied ? (
              <Check size={11} className="text-[var(--ve-emerald)]" />
            ) : (
              <Copy size={11} />
            )}
            <span>{copied ? "已复制" : "复制"}</span>
          </button>
        </div>

        {showSource || !effectiveSvg ? (
          <div className="p-4 pt-10">
            {effectiveError && !fallbackLoading && (
              <div
                role="alert"
                className="mb-2.5 flex items-start gap-2 rounded-lg border border-rose-300/60 bg-[var(--ve-rose-soft)] px-3 py-2 text-[11.5px] text-[var(--ve-ink)]"
              >
                <AlertTriangle
                  size={13}
                  className="mt-0.5 shrink-0 text-[var(--ve-rose)]"
                />
                <div className="min-w-0">
                  <div className="font-semibold">
                    Mermaid 语法解析失败（已降级展示源码）
                  </div>
                  <div className="mt-0.5 break-all font-mono text-[10.5px] text-[var(--ve-muted)]">
                    {effectiveError.slice(0, 180)}
                  </div>
                </div>
              </div>
            )}
            <pre className="m-0 overflow-x-auto whitespace-pre border-0 bg-transparent p-0 font-mono text-xs leading-relaxed text-[var(--ve-ink)]">
              <code>{cleanCode}</code>
            </pre>
            {fallbackLoading && !effectiveSvg && (
              <p className="mt-2 text-[11px] text-[var(--ve-muted)]">
                正在渲染图表结构…
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto px-4 pt-9 pb-4">
            <div
              className="ve-mermaid-canvas flex min-w-fit justify-center"
              dangerouslySetInnerHTML={{ __html: effectiveSvg }}
            />
          </div>
        )}

        {caption && (
          <div className="border-t border-[var(--ve-border)]/70 px-4 py-2 text-[11.5px] text-[var(--ve-muted)]">
            {caption}
          </div>
        )}
      </div>

      {zoomed && effectiveSvg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-6 backdrop-blur-xs"
          onClick={() => setZoomed(false)}
          role="dialog"
          aria-label="图表全屏放大预览"
        >
          <div
            className="relative max-h-[92vh] max-w-[92vw] overflow-auto rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setZoomed(false)}
              className="absolute top-3 right-3 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] p-1.5 text-[var(--ve-muted)] hover:text-[var(--ve-ink)]"
              aria-label="关闭预览"
            >
              <X size={16} />
            </button>
            <div
              className="ve-mermaid-canvas min-w-[460px] pt-4"
              dangerouslySetInnerHTML={{ __html: effectiveSvg }}
            />
          </div>
        </div>
      )}
    </>
  );
}
