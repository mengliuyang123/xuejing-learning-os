"use client";
import { useState } from "react";
import {
  Database,
  ExternalLink,
  Image as ImageIcon,
  Maximize2,
  X,
} from "lucide-react";
import type {
  VisualResourceCardData,
  VisualResourceItem,
} from "../../lib/learning";

export default function VisualResourceCard({
  card,
}: {
  card: VisualResourceCardData;
}) {
  const [zoomed, setZoomed] = useState<VisualResourceItem | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  if (!card.items?.length) return null;
  const current = card.items[activeIdx] || card.items[0];

  return (
    <>
      <div className="my-2 overflow-hidden rounded-xl border border-[var(--ve-border)] bg-[var(--ve-surface)] shadow-2xs transition-all duration-200">
        <div className="flex items-center justify-between border-b border-[var(--ve-border)] bg-[var(--ve-accent-soft)] px-3.5 py-2 text-xs">
          <div className="flex items-center gap-1.5 font-semibold text-[var(--ve-ink)]">
            <ImageIcon size={13} className="text-[var(--ve-accent)]" />
            <span>视觉图解 · {card.query}</span>
          </div>
          <div className="flex items-center gap-2">
            {current.cached && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--ve-emerald-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--ve-emerald)]">
                <Database size={10} /> 本地缓存
              </span>
            )}
            <button
              type="button"
              onClick={() => setZoomed(current)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-accent-soft)] hover:text-[var(--ve-accent)]"
            >
              <Maximize2 size={11} /> 放大
            </button>
          </div>
        </div>

        <div className="p-3">
          <div
            onClick={() => setZoomed(current)}
            className="group relative flex max-h-60 min-h-[160px] cursor-zoom-in items-center justify-center overflow-hidden rounded-lg border border-[var(--ve-border)] bg-[var(--ve-canvas)] p-2"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={current.imageUrl}
              alt={current.title}
              loading="lazy"
              className="max-h-52 w-auto max-w-full rounded object-contain transition-transform duration-200 group-hover:scale-[1.015]"
            />
          </div>

          <div className="mt-2.5 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h4 className="truncate text-xs font-semibold text-[var(--ve-ink)]">
                {current.title}
              </h4>
              {current.description && (
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-[var(--ve-muted)]">
                  {current.description}
                </p>
              )}
            </div>
            {current.sourceUrl && (
              <a
                href={current.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--ve-border)] bg-[var(--ve-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]"
              >
                {current.sourceName} <ExternalLink size={10} />
              </a>
            )}
          </div>

          {card.items.length > 1 && (
            <div className="mt-2.5 flex items-center gap-1.5 overflow-x-auto border-t border-[var(--ve-border)] pt-2">
              {card.items.map((it, idx) => (
                <button
                  key={`${it.title}-${idx}`}
                  type="button"
                  onClick={() => setActiveIdx(idx)}
                  className={
                    "flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition " +
                    (idx === activeIdx
                      ? "border-[var(--ve-accent)] bg-[var(--ve-accent-soft)] font-semibold text-[var(--ve-accent)]"
                      : "border-[var(--ve-border)] bg-[var(--ve-surface)] text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]")
                  }
                >
                  <span className="max-w-[120px] truncate">{it.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {zoomed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-6 backdrop-blur-xs"
          onClick={() => setZoomed(null)}
          role="dialog"
          aria-label="视觉资源放大预览"
        >
          <div
            className="relative max-h-[90vh] max-w-[88vw] overflow-auto rounded-2xl bg-[var(--ve-surface)] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-4 border-b border-[var(--ve-border)] pb-2.5">
              <div>
                <h3 className="text-sm font-semibold text-[var(--ve-ink)]">
                  {zoomed.title}
                </h3>
                <p className="text-[11px] text-[var(--ve-muted)]">
                  来源：{zoomed.sourceName}
                  {zoomed.cached ? " · 已缓存至本机" : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {zoomed.sourceUrl && (
                  <a
                    href={zoomed.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg border border-[var(--ve-border)] px-2.5 py-1 text-xs font-medium text-[var(--ve-accent)] hover:bg-[var(--ve-accent-soft)]"
                  >
                    访问原链接 <ExternalLink size={12} />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setZoomed(null)}
                  className="rounded-lg border border-[var(--ve-border)] p-1.5 text-[var(--ve-muted)] hover:bg-[var(--ve-surface-alt)]"
                  aria-label="关闭"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={zoomed.imageUrl}
              alt={zoomed.title}
              className="mx-auto max-h-[75vh] max-w-[82vw] object-contain"
            />
            {zoomed.description && (
              <p className="mt-3 max-w-2xl text-xs leading-relaxed text-[var(--ve-muted)]">
                {zoomed.description}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
