import { type Block, type Store, migrateStore, offset } from "./learning";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function resolveTimeZone(explicitTz?: string): string {
  if (explicitTz && explicitTz.trim()) return explicitTz.trim();
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch {}
  return "Asia/Shanghai";
}

function formatICSDateTime(day: string, minutesFromMidnight: number): string {
  const total = Math.max(0, Math.round(minutesFromMidnight));
  const extraDays = Math.floor(total / 1440);
  const rem = total % 1440;
  const effectiveDay = extraDays > 0 ? offset(day, extraDays) : day;
  const cleanDay = effectiveDay.replace(/-/g, "");
  const h = Math.floor(rem / 60);
  const m = rem % 60;
  return `${cleanDay}T${pad(h)}${pad(m)}00`;
}

function escapeICS(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Exports all scheduled blocks into an RFC 5545 compliant .ics calendar string
 * compatible with Apple Calendar, Google Calendar, and Outlook.
 * Correctly handles exact midnight end times (1440 -> next day 00:00:00) and cross-midnight spans.
 */
export function exportBlocksToICS(blocks: Block[], timeZone?: string): string {
  const tz = resolveTimeZone(timeZone);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Xuejing//Personal AI Learning OS//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:学径 学习计划",
    `X-WR-TIMEZONE:${escapeICS(tz)}`,
  ];

  const sorted = [...blocks].sort(
    (a, b) => a.day.localeCompare(b.day) || a.start - b.start,
  );

  for (const b of sorted) {
    const dtStart = formatICSDateTime(b.day, b.start);
    const dtEnd = formatICSDateTime(b.day, b.start + b.minutes);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeICS(b.id)}@xushi.learnos`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=${escapeICS(tz)}:${dtStart}`,
      `DTEND;TZID=${escapeICS(tz)}:${dtEnd}`,
      `SUMMARY:${escapeICS(`[${b.kind}] ${b.title}`)}`,
      `DESCRIPTION:${escapeICS(
        `由 学径 联合规划生成 · 时长 ${b.minutes} 分钟${b.done ? "（已完成）" : ""}`,
      )}`,
      `CATEGORIES:${escapeICS(b.kind)}`,
      b.done ? "STATUS:COMPLETED" : "STATUS:CONFIRMED",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

export function exportWorkspaceJSON(s: Store): string {
  return JSON.stringify(
    {
      schema: "xushi.learnos.backup.v2",
      exportedAt: new Date().toISOString(),
      store: s,
    },
    null,
    2,
  );
}

export function parseWorkspaceBackup(
  rawText: string,
  day: string,
): Store | null {
  try {
    const parsed = JSON.parse(rawText);
    const candidate = parsed?.store ?? parsed;
    return migrateStore(candidate, day);
  } catch {
    return null;
  }
}
