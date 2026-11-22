"use client";
import { useEffect, useRef } from "react";

/**
 * Ink-wash blur-to-sharp streaming text renderer:
 * Newly arrived characters emerge from 6px Gaussian blur to razor sharp with
 * cubic-bezier(0.16, 1, 0.3, 1) and 30ms stagger wave, while already-settled
 * earlier text remains static DOM so long responses stay 60fps smooth.
 */
export function InkWashStreamText({
  text,
  compact = false,
}: {
  text: string;
  compact?: boolean;
}) {
  const settledLenRef = useRef(0);
  const prevTextRef = useRef("");

  // Reset if a completely new stream starts
  if (!text.startsWith(prevTextRef.current.slice(0, 16))) {
    settledLenRef.current = 0;
  }

  // Keep at most the latest 48 characters in the active ink-wash wave window
  const waveWindow = 48;
  const activeStart = Math.max(settledLenRef.current, text.length - waveWindow);
  const settledPart = text.slice(0, activeStart);
  const freshPart = text.slice(activeStart);
  const freshChars = Array.from(freshPart);

  useEffect(() => {
    prevTextRef.current = text;
    const timer = setTimeout(() => {
      settledLenRef.current = text.length;
    }, 520);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <div
      className={
        "whitespace-pre-wrap leading-relaxed text-[var(--ink)] [text-wrap:pretty] " +
        (compact ? "text-xs" : "text-[14.5px]")
      }
    >
      {settledPart}
      {freshChars.map((ch, idx) => (
        <span
          key={`${activeStart + idx}`}
          className="ink-wash-char"
          style={{ animationDelay: `${(idx % 12) * 30}ms` }}
        >
          {ch}
        </span>
      ))}
    </div>
  );
}
