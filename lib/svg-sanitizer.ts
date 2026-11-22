/**
 * Strict Whitelist SVG Sanitizer for LearnOS Visual Explainer (Level 2).
 * Pure TypeScript (zero DOM / CDN dependency) — runs identically on server and client.
 *
 * Security invariants:
 * - Strictly allowlists safe vector tags & presentation/geometry attributes
 * - Strips <script>, <foreignObject>, <style>, <iframe>, <object>, <embed>, <image>, <link>, <meta>, <animate*>, <set>
 * - Strips ALL `on*` event handlers, `javascript:`, `vbscript:`, `data:` URIs, and external `http(s)://` / `//` URLs
 * - Only local fragment references (`#id` and `url(#id)`) are permitted
 */

export interface SvgSanitizeResult {
  ok: boolean;
  sanitizedSvg: string;
  strippedElements: string[];
  strippedAttributes: string[];
  warnings: string[];
  stepNumbers: number[];
}

const ALLOWED_TAGS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "marker",
  "clippath",
  "mask",
  "pattern",
  "symbol",
  "use",
  "title",
  "desc",
]);

/** Container elements whose inner content must be completely dropped (not unwrapped). */
const DROP_WITH_CONTENT_TAGS = new Set([
  "script",
  "style",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "applet",
  "audio",
  "video",
  "canvas",
  "noscript",
  "template",
]);

const ALLOWED_ATTRS = new Set([
  "xmlns",
  "viewbox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "dx",
  "dy",
  "d",
  "points",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-miterlimit",
  "opacity",
  "visibility",
  "font-size",
  "font-weight",
  "font-family",
  "font-style",
  "letter-spacing",
  "text-anchor",
  "text-decoration",
  "dominant-baseline",
  "alignment-baseline",
  "marker-end",
  "marker-start",
  "marker-mid",
  "markerwidth",
  "markerheight",
  "markerunits",
  "refx",
  "refy",
  "orient",
  "clip-path",
  "clip-rule",
  "mask",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "spreadmethod",
  "patternunits",
  "preserveaspectratio",
  "id",
  "class",
  "role",
  "aria-label",
  "aria-labelledby",
  "aria-hidden",
  "data-step",
  "data-highlight",
  "data-role",
  "href",
  "xlink:href",
]);

/** Canonical camelCase attribute output names for SVG compatibility. */
const CANONICAL_ATTR_NAMES: Record<string, string> = {
  viewbox: "viewBox",
  markerwidth: "markerWidth",
  markerheight: "markerHeight",
  markerunits: "markerUnits",
  refx: "refX",
  refy: "refY",
  gradientunits: "gradientUnits",
  gradienttransform: "gradientTransform",
  spreadmethod: "spreadMethod",
  patternunits: "patternUnits",
  preserveaspectratio: "preserveAspectRatio",
};

const CANONICAL_TAG_NAMES: Record<string, string> = {
  lineargradient: "linearGradient",
  radialgradient: "radialGradient",
  clippath: "clipPath",
};

const DANGEROUS_VALUE_RE =
  /(?:javascript\s*:|vbscript\s*:|data\s*:|expression\s*\(|@import|behaviour\s*:|binding\s*:)/i;
const EXTERNAL_URL_RE = /(?:https?:)?\/\/[^\s"'()]+/i;

function decodeNumericEntities(val: string): string {
  return val
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    })
    .replace(/&#(\d+);?/g, (_, dec: string) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    });
}

function isSafeAttributeValue(attrLower: string, rawValue: string): boolean {
  const decoded = decodeNumericEntities(rawValue).replace(/[\u0000-\u001f\u007f]/g, "");
  if (DANGEROUS_VALUE_RE.test(decoded)) return false;

  // Allow xmlns="http://www.w3.org/2000/svg" ONLY on xmlns attribute
  if (attrLower === "xmlns") {
    return decoded.trim() === "http://www.w3.org/2000/svg";
  }

  // External URLs are NEVER allowed anywhere in SVG attributes
  if (EXTERNAL_URL_RE.test(decoded)) return false;

  // href / xlink:href MUST be a local #fragment reference only (e.g. #arrow)
  if (attrLower === "href" || attrLower === "xlink:href") {
    return /^#[A-Za-z_][\w:.-]*$/.test(decoded.trim());
  }

  // url(...) inside fill / stroke / marker-* / clip-path / mask MUST reference local #id only
  const urlCalls = [...decoded.matchAll(/url\s*\(([^)]*)\)/gi)];
  for (const m of urlCalls) {
    const target = (m[1] || "").trim().replace(/^["']|["']$/g, "");
    if (!/^#[A-Za-z_][\w:.-]*$/.test(target)) {
      return false;
    }
  }

  // Validate data-step is a clean positive integer
  if (attrLower === "data-step") {
    return /^[1-9]\d{0,2}$/.test(decoded.trim());
  }

  return true;
}

function escapeAttrValue(val: string): string {
  return val
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseAttributes(
  rawAttrString: string,
  strippedAttributes: string[],
  stepSet: Set<number>,
): { attrs: Map<string, string>; hasViewBox: boolean; widthNum?: number; heightNum?: number } {
  const attrs = new Map<string, string>();
  let hasViewBox = false;
  let widthNum: number | undefined;
  let heightNum: number | undefined;

  const attrRegex =
    /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(rawAttrString)) !== null) {
    const rawName = match[1];
    const lowerName = rawName.toLowerCase();
    const rawVal = match[2] ?? match[3] ?? match[4] ?? "";

    // Explicitly strip all on* event handlers & style attribute (use presentation attrs + CSS vars)
    if (lowerName.startsWith("on") || lowerName === "style") {
      strippedAttributes.push(rawName);
      continue;
    }

    if (!ALLOWED_ATTRS.has(lowerName)) {
      strippedAttributes.push(rawName);
      continue;
    }

    if (!isSafeAttributeValue(lowerName, rawVal)) {
      strippedAttributes.push(rawName);
      continue;
    }

    const outName = CANONICAL_ATTR_NAMES[lowerName] || lowerName;
    attrs.set(outName, rawVal.trim());

    if (lowerName === "viewbox") hasViewBox = true;
    if (lowerName === "width") {
      const n = parseFloat(rawVal);
      if (Number.isFinite(n) && n > 0) widthNum = n;
    }
    if (lowerName === "height") {
      const n = parseFloat(rawVal);
      if (Number.isFinite(n) && n > 0) heightNum = n;
    }
    if (lowerName === "data-step") {
      const stepNum = parseInt(rawVal.trim(), 10);
      if (Number.isFinite(stepNum) && stepNum > 0) {
        stepSet.add(stepNum);
      }
    }
  }

  return { attrs, hasViewBox, widthNum, heightNum };
}

/**
 * Sanitizes raw SVG markup using a strict tag & attribute allowlist.
 */
export function sanitizeSvgStrict(rawInput: string): SvgSanitizeResult {
  const strippedElements: string[] = [];
  const strippedAttributes: string[] = [];
  const warnings: string[] = [];
  const stepSet = new Set<number>();

  if (!rawInput || typeof rawInput !== "string") {
    return {
      ok: false,
      sanitizedSvg: "",
      strippedElements,
      strippedAttributes,
      warnings: ["SVG 内容为空"],
      stepNumbers: [],
    };
  }

  // Extract the first <svg ...>...</svg> block if wrapped in markdown fences or prose
  let working = rawInput
    .trim()
    .replace(/^```(?:svg|xml|html)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Strip XML declarations, DOCTYPE/ENTITY, CDATA, HTML comments
  working = working
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const svgStart = working.search(/<svg\b/i);
  const svgEnd = working.toLowerCase().lastIndexOf("</svg>");
  if (svgStart < 0 || svgEnd < svgStart) {
    return {
      ok: false,
      sanitizedSvg: "",
      strippedElements,
      strippedAttributes,
      warnings: ["未找到合法的 <svg>...</svg> 根元素"],
      stepNumbers: [],
    };
  }
  working = working.slice(svgStart, svgEnd + 6);

  // Drop forbidden elements together with their inner content (handles nested/multiline)
  for (const badTag of DROP_WITH_CONTENT_TAGS) {
    const pairRe = new RegExp(
      `<${badTag}\\b[^>]*>[\\s\\S]*?<\\/${badTag}\\s*>`,
      "gi",
    );
    working = working.replace(pairRe, () => {
      strippedElements.push(badTag);
      return "";
    });
    const selfCloseRe = new RegExp(`<${badTag}\\b[^>]*\\/?>`, "gi");
    working = working.replace(selfCloseRe, () => {
      strippedElements.push(badTag);
      return "";
    });
  }

  // Tokenize remaining tags and keep ONLY strictly allowlisted SVG tags & attributes
  const tagRe = /<\/?([A-Za-z][\w:-]*)(\s[^>]*?)?(\/?)>/g;
  let rootSeen = false;
  let result = "";
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(working)) !== null) {
    // Append text content between tags (escaped of raw '<' / '>')
    const textChunk = working.slice(lastIdx, match.index);
    result += textChunk.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    lastIdx = tagRe.lastIndex;

    const fullTag = match[0];
    const isClosing = fullTag.startsWith("</");
    const rawTagName = match[1];
    const lowerTag = rawTagName.toLowerCase();
    const rawAttrStr = match[2] || "";
    const isSelfClosing = Boolean(match[3]);

    if (!ALLOWED_TAGS.has(lowerTag)) {
      if (!isClosing) strippedElements.push(rawTagName);
      continue;
    }

    const outTag = CANONICAL_TAG_NAMES[lowerTag] || lowerTag;
    if (isClosing) {
      result += `</${outTag}>`;
      continue;
    }

    const parsed = parseAttributes(rawAttrStr, strippedAttributes, stepSet);

    if (lowerTag === "svg" && !rootSeen) {
      rootSeen = true;
      parsed.attrs.set("xmlns", "http://www.w3.org/2000/svg");
      if (!parsed.hasViewBox) {
        const w = Math.round(parsed.widthNum || 760);
        const h = Math.round(parsed.heightNum || 420);
        parsed.attrs.set("viewBox", `0 0 ${w} ${h}`);
      }
      // Remove rigid pixel width/height on root so SVG scales cleanly inside responsive containers
      parsed.attrs.delete("width");
      parsed.attrs.delete("height");
      if (!parsed.attrs.has("role")) {
        parsed.attrs.set("role", "img");
      }
    }

    const attrSerialized = [...parsed.attrs.entries()]
      .map(([k, v]) => `${k}="${escapeAttrValue(v)}"`)
      .join(" ");

    result += `<${outTag}${attrSerialized ? ` ${attrSerialized}` : ""}${isSelfClosing ? " /" : ""}>`;
  }

  result += working.slice(lastIdx).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  result = result.trim();

  if (!rootSeen || !result.startsWith("<svg") || !result.endsWith("</svg>")) {
    return {
      ok: false,
      sanitizedSvg: "",
      strippedElements,
      strippedAttributes,
      warnings: ["SVG 净化后结构不完整"],
      stepNumbers: [],
    };
  }

  // Final defense-in-depth scan: ensure zero residual script/event/protocol tokens
  if (
    /<script\b|<foreignObject\b|\bon[a-z]+\s*=|javascript\s*:|vbscript\s*:/i.test(
      result,
    )
  ) {
    return {
      ok: false,
      sanitizedSvg: "",
      strippedElements,
      strippedAttributes,
      warnings: ["SVG 净化终审拦截到可疑残留内容"],
      stepNumbers: [],
    };
  }

  if (strippedElements.length > 0) {
    warnings.push(
      `已剥离非白名单元素：${[...new Set(strippedElements)].join(", ")}`,
    );
  }
  if (strippedAttributes.length > 0) {
    warnings.push(
      `已剥离危险或非白名单属性：${[...new Set(strippedAttributes)].join(", ")}`,
    );
  }

  const stepNumbers = [...stepSet].sort((a, b) => a - b);

  return {
    ok: true,
    sanitizedSvg: result,
    strippedElements,
    strippedAttributes,
    warnings,
    stepNumbers,
  };
}
