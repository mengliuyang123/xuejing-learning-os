"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Code2, Copy, Eye, Maximize2, X } from "lucide-react";
import { sanitizeSvgStrict } from "../../lib/svg-sanitizer";

export default function SandboxedSvgCanvas({
  svg,
  activeStep,
  highlightIds,
  caption,
}: {
  svg: string;
  activeStep?: number | null;
  highlightIds?: string[];
  caption?: string;
}) {
  const inlineRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const [showSource, setShowSource] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [copied, setCopied] = useState(false);

  // Defense-in-depth client-side whitelist sanitization
  const sanitized = useMemo(() => sanitizeSvgStrict(svg), [svg]);

  // Apply progressive step reveal attributes (`data-ve-step-state="past" | "current" | "future"`)
  // purely via declarative data attributes — zero inline JS inside SVG!
  useEffect(() => {
    const containers = [inlineRef.current, modalRef.current].filter(
      (el): el is HTMLDivElement => Boolean(el),
    );
    const hlSet = new Set(highlightIds || []);

    for (const container of containers) {
      const stepNodes = container.querySelectorAll<SVGElement>("[data-step]");
      stepNodes.forEach((node) => {
        const raw = node.getAttribute("data-step");
        const num = raw ? parseInt(raw, 10) : NaN;
        if (!activeStep || !Number.isFinite(num)) {
          node.removeAttribute("data-ve-step-state");
          return;
        }
        if (num < activeStep) {
          node.setAttribute("data-ve-step-state", "past");
        } else if (num === activeStep) {
          node.setAttribute("data-ve-step-state", "current");
        } else {
          node.setAttribute("data-ve-step-state", "future");
        }
      });

      if (hlSet.size > 0) {
        const idNodes = container.querySelectorAll<SVGElement>("[id]");
        idNodes.forEach((node) => {
          const id = node.getAttribute("id") || "";
          if (hlSet.has(id)) {
            node.setAttribute("data-ve-step-state", "current");
          }
        });
      }
    }
  }, [activeStep, highlightIds, sanitized.sanitizedSvg, zoomed, showSource]);

  function handleCopy() {
    void navigator.clipboard?.writeText(sanitized.sanitizedSvg || svg);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  if (!sanitized.ok || !sanitized.sanitizedSvg) {
    return (
      <div className="my-2.5 rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-4 text-xs text-[var(--ve-muted)]">
        SVG 图形未通过安全白名单校验，已拦截渲染。
      </div>
    );
  }

  return (
    <>
      <div className="group relative my-2.5 overflow-hidden rounded-xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] transition-colors">
        {/* Frameless floating top-right actions */}
        <div className="pointer-events-auto absolute top-2 right-2 z-10 flex items-center gap-1 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)]/90 px-1 py-0.5 shadow-2xs backdrop-blur-xs opacity-85 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
          >
            {showSource ? <Eye size={11} /> : <Code2 size={11} />}
            <span>{showSource ? "图形" : "源码"}</span>
          </button>
          {!showSource && (
            <button
              type="button"
              onClick={() => setZoomed(true)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
            >
              <Maximize2 size={11} />
              <span>放大</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)] hover:text-[var(--ve-ink)]"
          >
            {copied ? (
              <Check size={11} className="text-[var(--ve-emerald)]" />
            ) : (
              <Copy size={11} />
            )}
            <span>{copied ? "已复制" : "复制"}</span>
          </button>
        </div>

        {showSource ? (
          <div className="p-4 pt-10">
            <pre className="m-0 max-h-[360px] overflow-auto whitespace-pre-wrap break-all border-0 bg-transparent p-0 font-mono text-[11.5px] leading-relaxed text-[var(--ve-ink)]">
              <code>{sanitized.sanitizedSvg}</code>
            </pre>
          </div>
        ) : (
          <div className="overflow-x-auto px-4 pt-9 pb-4">
            <div
              ref={inlineRef}
              className="ve-svg-canvas mx-auto w-full"
              dangerouslySetInnerHTML={{ __html: sanitized.sanitizedSvg }}
            />
          </div>
        )}

        {caption && (
          <div className="border-t border-[var(--ve-border)]/70 px-4 py-2 text-[11.5px] text-[var(--ve-muted)]">
            {caption}
          </div>
        )}
      </div>

      {zoomed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-6 backdrop-blur-xs"
          onClick={() => setZoomed(false)}
          role="dialog"
          aria-label="矢量图解全屏放大预览"
        >
          <div
            className="relative max-h-[92vh] w-[min(92vw,980px)] overflow-auto rounded-2xl border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-6 shadow-2xl"
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
              ref={modalRef}
              className="ve-svg-canvas pt-4"
              dangerouslySetInnerHTML={{ __html: sanitized.sanitizedSvg }}
            />
          </div>
        </div>
      )}
    </>
  );
}
