import type { VisualResourceCardData, VisualResourceItem } from "./learning";

const visualMemoryCache = new Map<string, VisualResourceItem[]>();

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generates a high-contrast vector schematic diagram SVG data URL when external
 * encyclopedia search has no photo or is unreachable offline.
 */
function buildConceptSvgDataUrl(
  query: string,
  points: string[],
): VisualResourceItem {
  const safeTitle = escapeXml(query.slice(0, 36));
  const steps = (
    points.length >= 2
      ? points.slice(0, 4)
      : ["输入与上下文解析", "核心结构 / 算法处理", "输出验证与状态闭环"]
  ).map((s) => escapeXml(s.slice(0, 26)));

  const boxWidth = 170;
  const gap = 36;
  const totalWidth = steps.length * boxWidth + (steps.length - 1) * gap;
  const startX = Math.max(30, Math.round((760 - totalWidth) / 2));

  const nodesSvg = steps
    .map((label, idx) => {
      const x = startX + idx * (boxWidth + gap);
      const y = 118;
      const arrow =
        idx < steps.length - 1
          ? `<line x1="${x + boxWidth + 4}" y1="${y + 36}" x2="${x + boxWidth + gap - 6}" y2="${y + 36}" stroke="#2E5BFF" stroke-width="2" stroke-dasharray="4 3" />
             <polygon points="${x + boxWidth + gap - 6},${y + 32} ${x + boxWidth + gap},${y + 36} ${x + boxWidth + gap - 6},${y + 40}" fill="#2E5BFF" />`
          : "";
      return `
        <rect x="${x}" y="${y}" width="${boxWidth}" height="74" rx="12" fill="#FFFFFF" stroke="#4B6BFB" stroke-width="1.6"/>
        <circle cx="${x + 22}" cy="${y + 24}" r="11" fill="#EEF2FF"/>
        <text x="${x + 22}" y="${y + 28}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" font-weight="700" fill="#2E5BFF">${idx + 1}</text>
        <text x="${x + 14}" y="${y + 54}" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#121826">${label}</text>
        ${arrow}
      `;
    })
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 245" width="760" height="245">
    <rect width="760" height="245" rx="16" fill="#F8FAFF" stroke="#DCE3F2" stroke-width="1.5"/>
    <text x="30" y="42" font-family="system-ui, sans-serif" font-size="11" font-weight="700" fill="#2E5BFF">CONCEPT SCHEMATIC · 知识结构图解</text>
    <text x="30" y="68" font-family="system-ui, sans-serif" font-size="18" font-weight="700" fill="#121826">${safeTitle}</text>
    <line x1="30" y1="86" x2="730" y2="86" stroke="#E5EAF5" stroke-width="1"/>
    ${nodesSvg}
  </svg>`;

  return {
    title: `${query} · 核心机制结构图`,
    imageUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    sourceUrl: `https://zh.wikipedia.org/wiki/${encodeURIComponent(query)}`,
    sourceName: "LearnOS 矢量图解 / Wikipedia",
    description: `结构化分解：${steps.join(" → ")}`,
    cached: false,
  };
}

async function queryWikipediaImages(
  query: string,
  lang: "zh" | "en",
): Promise<VisualResourceItem[]> {
  const endpoint = `https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
    query,
  )}&gsrlimit=3&prop=pageimages|extracts|info&inprop=url&exintro=1&explaintext=1&exchars=140&piprop=original|thumbnail&pithumbsize=800&format=json&origin=*`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3800);
  try {
    const res = await fetch(endpoint, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "XushiLearnOS/1.0 (Local Educational Desktop Agent)",
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      query?: {
        pages?: Record<
          string,
          {
            title?: string;
            extract?: string;
            fullurl?: string;
            original?: { source?: string };
            thumbnail?: { source?: string };
          }
        >;
      };
    };
    const pages = Object.values(data.query?.pages || {});
    const items: VisualResourceItem[] = [];
    for (const p of pages) {
      const img = p.thumbnail?.source || p.original?.source;
      if (!img || /\.pdf$|\.djvu$|\.ogv$|\.webm$/i.test(img)) continue;
      items.push({
        title: p.title || query,
        imageUrl: img,
        sourceUrl:
          p.fullurl ||
          `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title || query)}`,
        sourceName: lang === "zh" ? "维基百科 (ZH)" : "Wikipedia (EN)",
        description: p.extract?.trim(),
        cached: false,
      });
    }
    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function searchVisualResources(
  query: string,
  keyPoints: string[] = [],
): Promise<VisualResourceCardData> {
  const key = query.trim().toLowerCase();
  const cached = visualMemoryCache.get(key);
  if (cached && cached.length > 0) {
    return {
      kind: "visual_resource",
      query,
      items: cached.map((it) => ({ ...it, cached: true })),
    };
  }

  const [zhItems, enItems] = await Promise.all([
    queryWikipediaImages(query, "zh"),
    queryWikipediaImages(query, "en"),
  ]);

  const seenUrls = new Set<string>();
  const combined: VisualResourceItem[] = [];
  for (const it of [...zhItems, ...enItems]) {
    if (seenUrls.has(it.imageUrl)) continue;
    seenUrls.add(it.imageUrl);
    combined.push(it);
    if (combined.length >= 3) break;
  }

  // Always include or fall back to a crisp vector concept schematic so technical concepts always have an inspectable diagram
  const schematic = buildConceptSvgDataUrl(query, keyPoints);
  const finalItems = combined.length > 0 ? [...combined, schematic].slice(0, 3) : [schematic];

  visualMemoryCache.set(key, finalItems);
  return {
    kind: "visual_resource",
    query,
    items: finalItems,
  };
}
