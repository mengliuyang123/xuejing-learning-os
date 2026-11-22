/**
 * Security & Reliability utilities for Agent Execution Traces:
 * - Redacts API keys, Bearer tokens, passwords, and credentials recursively
 * - Bounds payload string length, array size, object depth, and serialized byte size
 * - Prevents raw secrets or unbounded payloads from bloating SQLite or leaking into the Trace Inspector
 */

const SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|secret|access[-_]?token|refresh[-_]?token|auth[-_]?token|authorization|password|passwd|credential|private[-_]?key|cookie|session[-_]?key)/i;

const SECRET_VALUE_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  { regex: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { regex: /\bsk-proj-[A-Za-z0-9_-]{12,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { regex: /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi, replacement: "Bearer [REDACTED]" },
  { regex: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED_TOKEN]" },
  { regex: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_KEY]" },
  {
    regex: /(["']?(?:api[_-]?key|authorization|secret|token|password)["']?\s*[:=]\s*["']?)([^\s"',;}{]{6,})/gi,
    replacement: "$1[REDACTED]",
  },
];

export type SanitizeOptions = {
  maxStringChars?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxDepth?: number;
  maxTotalBytes?: number;
};

const DEFAULT_OPTS: Required<SanitizeOptions> = {
  maxStringChars: 4000,
  maxArrayItems: 40,
  maxObjectKeys: 60,
  maxDepth: 6,
  maxTotalBytes: 24 * 1024,
};

export function redactSensitiveString(input: string): string {
  let out = input;
  for (const { regex, replacement } of SECRET_VALUE_PATTERNS) {
    out = out.replace(regex, replacement);
  }
  return out;
}

function sanitizeNode(
  value: unknown,
  opts: Required<SanitizeOptions>,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    const redacted = redactSensitiveString(value);
    if (redacted.length > opts.maxStringChars) {
      return `${redacted.slice(0, opts.maxStringChars)}… [truncated: ${redacted.length} chars]`;
    }
    return redacted;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveString(value.message),
    };
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  if (depth >= opts.maxDepth) {
    if (Array.isArray(value)) {
      return `[Array(${value.length}) truncated at depth ${depth}]`;
    }
    return `[Object truncated at depth ${depth}]`;
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const sliced = value
        .slice(0, opts.maxArrayItems)
        .map((item) => sanitizeNode(item, opts, depth + 1, seen));
      if (value.length > opts.maxArrayItems) {
        sliced.push(`[+${value.length - opts.maxArrayItems} more items truncated]`);
      }
      return sliced;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    const limit = Math.min(entries.length, opts.maxObjectKeys);

    for (let i = 0; i < limit; i++) {
      const [k, v] = entries[i];
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitizeNode(v, opts, depth + 1, seen);
      }
    }

    if (entries.length > opts.maxObjectKeys) {
      out._truncatedKeys = entries.length - opts.maxObjectKeys;
    }

    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Recursively redacts credentials and enforces strict size/depth limits
 * so Trace payloads are safe to persist in SQLite and render in UI.
 */
export function sanitizeTracePayload<T = unknown>(
  value: T,
  options?: SanitizeOptions,
): unknown {
  const opts: Required<SanitizeOptions> = { ...DEFAULT_OPTS, ...(options || {}) };
  const sanitized = sanitizeNode(value, opts, 0, new WeakSet());

  try {
    const json = JSON.stringify(sanitized);
    if (json && Buffer.byteLength(json, "utf8") > opts.maxTotalBytes) {
      const preview = json.slice(0, Math.min(2000, opts.maxStringChars));
      return {
        _truncated: true,
        _originalBytes: Buffer.byteLength(json, "utf8"),
        _maxBytes: opts.maxTotalBytes,
        preview: `${preview}…`,
      };
    }
  } catch {
    return { _unserializable: true, summary: String(value).slice(0, 500) };
  }

  return sanitized;
}

/**
 * Safe JSON stringify for SQLite storage with guaranteed redaction & size cap.
 */
export function safeTraceJson(
  value: unknown,
  options?: SanitizeOptions,
): string {
  const sanitized = sanitizeTracePayload(value, options);
  try {
    return JSON.stringify(sanitized ?? null);
  } catch {
    return JSON.stringify({ _error: "serialization_failed" });
  }
}
