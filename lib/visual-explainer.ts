import crypto from "node:crypto";
import { generateText, type LanguageModel } from "ai";
import { z } from "zod";
import {
  DEFAULT_LEARNOS_CAPABILITIES,
  type RuntimeCapability,
  resolveAndValidateTeachingActivity,
} from "./activity-registry";
import {
  buildDeepSeekCallConfig,
  extractModelIdFromInstance,
  isDeepSeekModelInstance,
} from "./deepseek-config";
import {
  getVisualExplainerCacheFromDb,
  saveTeachingActivityToDb,
  saveVisualExplainerCacheToDb,
} from "./db";
import type {
  Lesson,
  LessonContract,
  VisualExplanationCardData,
  VisualExplanationStep,
  VisualExplanationType,
  VisualExplanationWidgetSpec,
} from "./learning";
import { getTeachingSkillRegistry } from "./skill-loader";
import { sanitizeSvgStrict } from "./svg-sanitizer";
import { validateMathFormula } from "./safe-math-eval";

export interface RunVisualExplainerInput {
  lessonId: string;
  lessonTitle?: string;
  conceptId?: string;
  conceptSummary?: string;
  title?: string;
  summary?: string;
  caption?: string;
  visualType?: VisualExplanationType;
  mermaid?: string;
  svg?: string;
  widget?: VisualExplanationWidgetSpec;
  steps?: VisualExplanationStep[];
  contract?: LessonContract | null;
  contractVersion?: number;
  learningSessionId?: string | null;
  decisionId?: string | null;
  userRequest?: string;
  forceRefresh?: boolean;
  persistActivity?: boolean;
  availableCapabilities?: readonly RuntimeCapability[];
  model?: LanguageModel | string | null;
  customGenerator?: (prompt: {
    system: string;
    user: string;
  }) => Promise<string>;
  abortSignal?: AbortSignal;
}

export interface RunVisualExplainerResult {
  card: VisualExplanationCardData;
  cacheHit: boolean;
  activityId: string;
  skillLoaded: boolean;
  sanitizationWarnings: string[];
  contractBoundaryNotes: string[];
}

const llmVisualOutputSchema = z.object({
  title: z.string().min(2),
  summary: z.string().optional(),
  caption: z.string().optional(),
  visualType: z.enum(["mermaid", "svg", "interactive_widget"]),
  mermaid: z.string().optional(),
  svg: z.string().optional(),
  widget: z
    .object({
      widgetType: z.enum(["timeline", "parameter_explorer"]),
      config: z.record(z.string(), z.unknown()),
    })
    .optional(),
  steps: z
    .array(
      z.object({
        stepNumber: z.number().int().min(1),
        title: z.string().min(1),
        explanation: z.string().min(2),
        highlightIds: z.array(z.string().min(1)).optional(),
        mermaid: z.string().optional(),
      }),
    )
    .optional(),
});

export function buildVisualCacheKey(opts: {
  lessonId: string;
  contractVersion: number;
  conceptId: string;
  visualType: string;
}): string {
  const norm = [
    opts.lessonId.trim(),
    `v${Math.max(1, opts.contractVersion)}`,
    opts.conceptId.trim().toLowerCase().replace(/\s+/g, " "),
    opts.visualType.trim().toLowerCase(),
  ].join("::");
  const hash = crypto.createHash("sha256").update(norm).digest("hex").slice(0, 24);
  return `ve-${hash}`;
}

function normalizeSteps(
  steps?: VisualExplanationStep[],
): VisualExplanationStep[] | undefined {
  if (!Array.isArray(steps) || steps.length === 0) return undefined;
  return steps.map((s, idx) => ({
    stepNumber: Number.isInteger(s.stepNumber) && s.stepNumber > 0 ? s.stepNumber : idx + 1,
    title: String(s.title || `第 ${idx + 1} 步`).trim(),
    explanation: String(s.explanation || "").trim(),
    highlightIds: Array.isArray(s.highlightIds)
      ? s.highlightIds.map((id) => String(id).trim()).filter(Boolean)
      : undefined,
    mermaid: s.mermaid?.trim() || undefined,
  }));
}

function checkContractBoundaryNotes(
  textBlob: string,
  contract?: LessonContract | null,
): string[] {
  if (!contract?.deferredTo?.length || !textBlob) return [];
  const notes: string[] = [];
  const lower = textBlob.toLowerCase();
  for (const def of contract.deferredTo) {
    const cleanTitle = (def.targetLessonTitle || "")
      .replace(/^第[\d一二三四五六七八九十]+[课节章·\s:-]+/, "")
      .split(/[：:（(]/)[0]
      ?.trim();
    if (cleanTitle && cleanTitle.length >= 4 && lower.includes(cleanTitle.toLowerCase())) {
      notes.push(
        `图解提及了后继节点《${def.targetLessonTitle}》，已提醒仅作衔接占位不提前展开。`,
      );
    }
  }
  return notes;
}

function extractJsonObject(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const s = cleaned.indexOf("{");
    const e = cleaned.lastIndexOf("}");
    if (s >= 0 && e > s) {
      return JSON.parse(cleaned.slice(s, e + 1));
    }
    throw new Error("Visual Explainer 未返回可解析的 JSON 对象");
  }
}

function buildFallbackVisualSpec(input: {
  lessonTitle: string;
  conceptSummary: string;
  visualType: VisualExplanationType;
}): {
  title: string;
  summary: string;
  visualType: VisualExplanationType;
  mermaid?: string;
  svg?: string;
  steps: VisualExplanationStep[];
} {
  const safeLabel = (input.lessonTitle || "核心概念")
    .replace(/["<>]/g, "")
    .slice(0, 24);
  if (input.visualType === "svg") {
    const svg = `<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${safeLabel}">
  <defs>
    <marker id="ve-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--ve-line)" />
    </marker>
  </defs>
  <rect x="0" y="0" width="760" height="280" rx="16" fill="var(--ve-canvas)" />
  <g data-step="1">
    <rect x="36" y="88" width="188" height="96" rx="14" fill="var(--ve-accent-soft)" stroke="var(--ve-accent)" stroke-width="1.8" />
    <text x="130" y="128" text-anchor="middle" font-size="15" font-weight="600" fill="var(--ve-ink)">1. 输入与前提</text>
    <text x="130" y="154" text-anchor="middle" font-size="12" fill="var(--ve-muted)">明确问题与前置条件</text>
  </g>
  <g data-step="2">
    <line x1="224" y1="136" x2="278" y2="136" stroke="var(--ve-line)" stroke-width="2" marker-end="url(#ve-arrow)" />
    <rect x="286" y="78" width="204" height="116" rx="14" fill="var(--ve-surface)" stroke="var(--ve-border)" stroke-width="1.8" />
    <text x="388" y="124" text-anchor="middle" font-size="15" font-weight="600" fill="var(--ve-ink)">2. ${safeLabel}</text>
    <text x="388" y="152" text-anchor="middle" font-size="12" fill="var(--ve-muted)">核心机制与边界约束</text>
  </g>
  <g data-step="3">
    <line x1="490" y1="136" x2="544" y2="136" stroke="var(--ve-line)" stroke-width="2" marker-end="url(#ve-arrow)" />
    <rect x="552" y="88" width="172" height="96" rx="14" fill="var(--ve-emerald-soft)" stroke="var(--ve-emerald)" stroke-width="1.8" />
    <text x="638" y="128" text-anchor="middle" font-size="15" font-weight="600" fill="var(--ve-ink)">3. 最小验证</text>
    <text x="638" y="154" text-anchor="middle" font-size="12" fill="var(--ve-muted)">观察结果与纠偏</text>
  </g>
</svg>`;
    return {
      title: `${safeLabel} · 分步机制示意`,
      summary: input.conceptSummary || `分三步建立对「${safeLabel}」的直觉理解。`,
      visualType: "svg",
      svg,
      steps: [
        {
          stepNumber: 1,
          title: "明确输入与前提",
          explanation: "先看清问题边界与已有的前置条件，避免跳步。",
        },
        {
          stepNumber: 2,
          title: `拆解「${safeLabel}」核心机制`,
          explanation: input.conceptSummary || "聚焦本节范围内的核心因果与转换步骤。",
        },
        {
          stepNumber: 3,
          title: "最小闭环验证",
          explanation: "用最小案例核对预期输出，并检查边界异常情况。",
        },
      ],
    };
  }

  const mermaid = `flowchart LR
  A["1. 前置输入与问题边界"] --> B["2. ${safeLabel}"]
  B --> C{"3. 最小结果验证"}
  C -- "符合预期" --> D["形成稳定直觉"]
  C -- "存在偏差" --> E["回溯定位误区"]
  E --> B`;
  return {
    title: `${safeLabel} · 结构流程图解`,
    summary: input.conceptSummary || `用结构流程图梳理「${safeLabel}」的关键环节。`,
    visualType: "mermaid",
    mermaid,
    steps: [
      {
        stepNumber: 1,
        title: "问题边界与输入",
        explanation: "先界定本节需要处理的输入与前提条件。",
      },
      {
        stepNumber: 2,
        title: "核心机制转换",
        explanation: input.conceptSummary || `观察「${safeLabel}」如何将输入转化为目标结果。`,
      },
      {
        stepNumber: 3,
        title: "验证与反馈闭环",
        explanation: "用最小可验证案例确认理解无误，遇到偏差及时纠偏。",
      },
    ],
  };
}

function validateControlledWidgetSpec(
  widget?: VisualExplanationWidgetSpec,
): {
  ok: boolean;
  sanitized?: VisualExplanationWidgetSpec;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!widget || typeof widget !== "object") {
    return { ok: false, warnings: ["缺少受控交互组件配置。"] };
  }
  const cfg =
    widget.config && typeof widget.config === "object"
      ? { ...widget.config }
      : {};

  if (widget.widgetType === "timeline") {
    const rawEvents = Array.isArray(cfg.events) ? cfg.events : [];
    const validEvents = rawEvents
      .filter((e): e is Record<string, unknown> => Boolean(e && typeof e === "object"))
      .slice(0, 12)
      .map((e, idx) => ({
        time: String(e.time || `阶段 ${idx + 1}`).trim().slice(0, 40),
        label: String(e.label || `节点 ${idx + 1}`).trim().slice(0, 80),
        detail: String(e.detail || "").trim().slice(0, 400),
        ...(typeof e.cause === "string" && e.cause.trim()
          ? { cause: e.cause.trim().slice(0, 200) }
          : {}),
        ...(typeof e.impact === "string" && e.impact.trim()
          ? { impact: e.impact.trim().slice(0, 200) }
          : {}),
        ...(typeof e.keyTakeaway === "string" && e.keyTakeaway.trim()
          ? { keyTakeaway: e.keyTakeaway.trim().slice(0, 200) }
          : {}),
        ...(Array.isArray(e.tags)
          ? {
              tags: e.tags
                .map((t) => String(t).trim().slice(0, 24))
                .filter(Boolean)
                .slice(0, 4),
            }
          : {}),
      }));
    if (validEvents.length < 2) {
      return {
        ok: false,
        warnings: ["时间线组件至少需要 2 个演进节点。"],
      };
    }
    return {
      ok: true,
      sanitized: { widgetType: "timeline", config: { events: validEvents } },
      warnings,
    };
  }

  if (widget.widgetType === "parameter_explorer") {
    const rawParams = Array.isArray(cfg.parameters) ? cfg.parameters : [];
    const sampleVars: Record<string, number> = {};
    const validParams = rawParams
      .filter(
        (p): p is Record<string, unknown> =>
          Boolean(p && typeof p === "object" && typeof p.name === "string" && p.name.trim()),
      )
      .slice(0, 8)
      .map((p, idx) => {
        const min = typeof p.min === "number" && Number.isFinite(p.min) ? p.min : 0;
        const max =
          typeof p.max === "number" && Number.isFinite(p.max) && p.max > min
            ? p.max
            : min + 100;
        const step =
          typeof p.step === "number" && Number.isFinite(p.step) && p.step > 0
            ? p.step
            : (max - min) / 20;
        const defaultValue =
          typeof p.defaultValue === "number" && Number.isFinite(p.defaultValue)
            ? Math.min(max, Math.max(min, p.defaultValue))
            : min;
        const rawKey =
          typeof p.key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(p.key.trim())
            ? p.key.trim()
            : `p${idx + 1}`;
        sampleVars[rawKey] = defaultValue;
        const name = String(p.name).trim().slice(0, 60);
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          sampleVars[name] = defaultValue;
        }
        return {
          name,
          key: rawKey,
          min,
          max,
          step,
          defaultValue,
          ...(typeof p.unit === "string" && p.unit.trim()
            ? { unit: p.unit.trim().slice(0, 20) }
            : {}),
          ...(typeof p.effect === "string" && p.effect.trim()
            ? { effect: p.effect.trim().slice(0, 180) }
            : {}),
        };
      });

    if (validParams.length === 0) {
      return { ok: false, warnings: ["参数模拟组件缺少有效参数定义。"] };
    }

    const rawOutputs = Array.isArray(cfg.outputs) ? cfg.outputs : [];
    const validOutputs = rawOutputs
      .filter((o): o is Record<string, unknown> =>
        Boolean(
          o &&
            typeof o === "object" &&
            typeof o.label === "string" &&
            typeof o.formula === "string",
        ),
      )
      .slice(0, 6)
      .filter((o) => {
        const okFormula = validateMathFormula(String(o.formula), sampleVars);
        if (!okFormula) {
          warnings.push(`已跳过未通过安全公式校验的输出项「${String(o.label)}」。`);
        }
        return okFormula;
      });

    let validCurve: Record<string, unknown> | undefined;
    if (cfg.curve && typeof cfg.curve === "object") {
      const c = cfg.curve as Record<string, unknown>;
      if (
        typeof c.xVar === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.xVar.trim()) &&
        typeof c.xMin === "number" &&
        typeof c.xMax === "number" &&
        c.xMax > c.xMin &&
        typeof c.yFormula === "string" &&
        validateMathFormula(c.yFormula, {
          ...sampleVars,
          [c.xVar.trim()]: (c.xMin + c.xMax) / 2,
        })
      ) {
        validCurve = c;
      } else {
        warnings.push("曲线公式未通过安全校验，已自动省略曲线视图。");
      }
    }

    const validPresets = Array.isArray(cfg.presets)
      ? cfg.presets
          .filter(
            (pr): pr is Record<string, unknown> =>
              Boolean(
                pr &&
                  typeof pr === "object" &&
                  typeof pr.label === "string" &&
                  pr.values &&
                  typeof pr.values === "object",
              ),
          )
          .slice(0, 5)
      : undefined;

    return {
      ok: true,
      sanitized: {
        widgetType: "parameter_explorer",
        config: {
          parameters: validParams,
          ...(validOutputs.length ? { outputs: validOutputs } : {}),
          ...(validCurve ? { curve: validCurve } : {}),
          ...(validPresets && validPresets.length ? { presets: validPresets } : {}),
        },
      },
      warnings,
    };
  }

  return { ok: false, warnings: ["不支持的受控交互组件类型。"] };
}

/**
 * High-level Visual Explainer Engine:
 * - On-demand loads `skills/visual-explainer/SKILL.md` via TeachingSkillRegistry
 * - Enforces LessonContract scope boundaries (no downstream spoilers)
 * - Strictly sanitizes Level 2 inline SVG via whitelist sanitizer
 * - Caches deterministically in SQLite by (lessonId + contractVersion + conceptId + visualType)
 * - Registers visual activity into `teaching_activities` bound strictly to `lessonId`
 * - NEVER mutates BKT verified mastery!
 */
export async function runVisualExplainer(
  input: RunVisualExplainerInput,
): Promise<RunVisualExplainerResult> {
  const lessonId = input.lessonId.trim();
  const contractVersion = Math.max(
    1,
    input.contractVersion ?? input.contract?.blueprintVersion ?? 1,
  );
  const conceptId = (
    input.conceptId ||
    input.title ||
    input.lessonTitle ||
    lessonId
  ).trim();
  const hasInlineSpec = Boolean(
    input.mermaid?.trim() || input.svg?.trim() || input.widget,
  );
  const requestedType: VisualExplanationType =
    input.visualType ||
    (input.svg?.trim()
      ? "svg"
      : input.widget
        ? "interactive_widget"
        : "mermaid");

  const cacheKey = buildVisualCacheKey({
    lessonId,
    contractVersion,
    conceptId,
    visualType: requestedType,
  });

  // 1. Deterministic SQLite Cache Lookup (auto-invalidates when contractVersion advances)
  if (!input.forceRefresh && !hasInlineSpec) {
    try {
      const cached = getVisualExplainerCacheFromDb(cacheKey);
      if (cached && cached.contractVersion === contractVersion) {
        const cachedSpec = cached.spec;
        const card: VisualExplanationCardData = {
          kind: "visual_explanation",
          visualId: cached.visualId,
          lessonId,
          conceptId: cached.conceptId,
          contractVersion: cached.contractVersion,
          title: String(cachedSpec.title || input.title || input.lessonTitle || "可视化讲解"),
          summary: cachedSpec.summary ? String(cachedSpec.summary) : undefined,
          caption: cachedSpec.caption ? String(cachedSpec.caption) : undefined,
          visualType: cached.visualType as VisualExplanationType,
          mermaid: cachedSpec.mermaid ? String(cachedSpec.mermaid) : undefined,
          svg: cachedSpec.svg ? String(cachedSpec.svg) : undefined,
          widget: cachedSpec.widget as VisualExplanationWidgetSpec | undefined,
          steps: normalizeSteps(cachedSpec.steps as VisualExplanationStep[] | undefined),
          cacheHit: true,
          skillUsed: "visual-explainer",
        };
        return {
          card,
          cacheHit: true,
          activityId: cached.visualId,
          skillLoaded: false,
          sanitizationWarnings: [],
          contractBoundaryNotes: [],
        };
      }
    } catch {
      // Cache lookup is best-effort
    }
  }

  // 2. Load Visual Explainer Teaching Skill on-demand (NOT stuffed into static system prompt!)
  const skillRegistry = getTeachingSkillRegistry();
  const visualSkill = skillRegistry.loadSkill("visual-explainer");
  const skillLoaded = Boolean(visualSkill);

  let effectiveType: VisualExplanationType = requestedType;
  let title = input.title?.trim() || `${input.lessonTitle || conceptId} · 可视化图解`;
  let summary = input.summary?.trim() || input.conceptSummary?.trim();
  let caption = input.caption?.trim();
  let mermaid = input.mermaid?.trim();
  let svg = input.svg?.trim();
  let widget = input.widget;
  let steps = normalizeSteps(input.steps);

  // 3. If no inline visual spec was passed, generate via LLM (or deterministic fallback offline)
  if (!hasInlineSpec) {
    if (input.model || input.customGenerator) {
      const contractSection = input.contract
        ? [
            `【知识图谱边界契约 v${contractVersion}（严禁越界剧透）】`,
            `- 承接前置（assumedPrior）：${(input.contract.assumedPrior ?? []).join("；") || "无"}`,
            `- 本节核心范围（inScope）：${(input.contract.inScope ?? []).join("；") || "当前课时核心概念"}`,
            `- 严禁展开的后续主题（outOfScope / deferredTo）：${
              (input.contract.deferredTo ?? [])
                .map((d) => `《${d.targetLessonTitle}》(${d.topic})`)
                .join("；") ||
              (input.contract.outOfScope ?? []).join("；") ||
              "无"
            }`,
            `- 本节推进定位：${input.contract.progressionStep || "夯实本课核心机制"}`,
          ].join("\n")
        : "";

      const systemPrompt = [
        "你是「学径」的可视化教学设计师。请为当前知识点设计高清晰度、可分步揭示的视觉讲解。",
        visualSkill ? `\n${visualSkill.body}` : "",
        contractSection ? `\n${contractSection}` : "",
        "\n请只输出合法 JSON 对象，格式如下：",
        `{
  "title": "图解标题",
  "summary": "一句话说明这张图帮你看懂什么",
  "caption": "可选图注",
  "visualType": "mermaid | svg | interactive_widget",
  "mermaid": "当 visualType=mermaid 时的完整全景 Mermaid 源码（供全部全景展示；可选递进子图可放进 steps[i].mermaid）",
  "svg": "当 visualType=svg 时的纯矢量 <svg viewBox=\\"0 0 760 400\\" xmlns=\\"http://www.w3.org/2000/svg\\">...</svg>（使用 var(--ve-*) 语义色，并用 data-step=\\"1..N\\" 标注分步元素）",
  "steps": [{ "stepNumber": 1, "title": "步骤标题", "explanation": "本步要点讲解" }]
}`,
      ]
        .filter(Boolean)
        .join("\n");

      const userPrompt = [
        `当前课程：${input.lessonTitle || lessonId}`,
        `聚焦概念：${conceptId}`,
        input.conceptSummary ? `核心机制：${input.conceptSummary}` : "",
        input.userRequest ? `学习者请求：${input.userRequest}` : "",
        input.visualType ? `偏好表达形式：${input.visualType}` : "请你自主选择最贴合该学科概念的表达形式（mermaid 或 svg）。",
      ]
        .filter(Boolean)
        .join("\n");

      try {
        let rawText = "";
        if (input.customGenerator) {
          rawText = await input.customGenerator({
            system: systemPrompt,
            user: userPrompt,
          });
        } else if (input.model) {
          const isDeepSeek = isDeepSeekModelInstance(input.model);
          const callCfg = buildDeepSeekCallConfig("structured_fast", {
            isDeepSeek,
            modelId: extractModelIdFromInstance(input.model),
            maxOutputTokensOverride: 4096,
          });
          const res = await generateText({
            model: input.model,
            system: systemPrompt,
            prompt: userPrompt,
            maxOutputTokens: callCfg.maxOutputTokens,
            temperature: callCfg.temperature,
            providerOptions: callCfg.providerOptions as Parameters<
              typeof generateText
            >[0]["providerOptions"],
            abortSignal: input.abortSignal,
          });
          rawText = res.text;
        }
        const parsed = llmVisualOutputSchema.parse(extractJsonObject(rawText));
        effectiveType = parsed.visualType;
        title = parsed.title.trim();
        summary = parsed.summary?.trim() || summary;
        caption = parsed.caption?.trim() || caption;
        mermaid = parsed.mermaid?.trim();
        svg = parsed.svg?.trim();
        widget = parsed.widget;
        steps = normalizeSteps(parsed.steps);
      } catch {
        const fb = buildFallbackVisualSpec({
          lessonTitle: input.lessonTitle || conceptId,
          conceptSummary: input.conceptSummary || "",
          visualType: requestedType,
        });
        effectiveType = fb.visualType;
        title = fb.title;
        summary = fb.summary;
        mermaid = fb.mermaid;
        svg = fb.svg;
        steps = fb.steps;
      }
    } else {
      const fb = buildFallbackVisualSpec({
        lessonTitle: input.lessonTitle || conceptId,
        conceptSummary: input.conceptSummary || "",
        visualType: requestedType,
      });
      effectiveType = fb.visualType;
      title = fb.title;
      summary = fb.summary;
      mermaid = fb.mermaid;
      svg = fb.svg;
      steps = fb.steps;
    }
  }

  // 4. Strict Security Sanitization (Level 2 SVG + Level 3 Controlled Widget) & Activity Registry Validation
  const sanitizationWarnings: string[] = [];
  if (effectiveType === "svg") {
    const clean = sanitizeSvgStrict(svg || "");
    if (clean.ok && clean.sanitizedSvg) {
      svg = clean.sanitizedSvg;
      sanitizationWarnings.push(...clean.warnings);
    } else {
      // Safe deterministic fallback to Mermaid if SVG fails sanitization
      sanitizationWarnings.push(
        ...clean.warnings,
        "SVG 未通过白名单安全校验，已自动降级为安全的 Mermaid 结构图。",
      );
      const fb = buildFallbackVisualSpec({
        lessonTitle: input.lessonTitle || conceptId,
        conceptSummary: input.conceptSummary || "",
        visualType: "mermaid",
      });
      effectiveType = "mermaid";
      mermaid = mermaid || fb.mermaid;
      svg = undefined;
    }
  } else if (effectiveType === "interactive_widget") {
    const cleanWidget = validateControlledWidgetSpec(widget);
    if (cleanWidget.ok && cleanWidget.sanitized) {
      widget = cleanWidget.sanitized;
      sanitizationWarnings.push(...cleanWidget.warnings);
    } else {
      sanitizationWarnings.push(
        ...cleanWidget.warnings,
        "受控交互组件配置未通过安全校验，已自动降级为安全的 Mermaid 结构图。",
      );
      const fb = buildFallbackVisualSpec({
        lessonTitle: input.lessonTitle || conceptId,
        conceptSummary: input.conceptSummary || "",
        visualType: "mermaid",
      });
      effectiveType = "mermaid";
      mermaid = mermaid || fb.mermaid;
      widget = undefined;
    }
  }

  const resolvedActivity = resolveAndValidateTeachingActivity({
    requestedType: "visual_explanation",
    rawSpec: {
      title,
      prompt: summary || title,
      summary,
      caption,
      visualType: effectiveType,
      mermaid,
      svg,
      widget,
      steps,
      lessonId,
      conceptId,
      contractVersion,
    },
    availableCapabilities:
      input.availableCapabilities || DEFAULT_LEARNOS_CAPABILITIES,
  });

  const contractBoundaryNotes = checkContractBoundaryNotes(
    `${title}\n${summary || ""}\n${mermaid || ""}\n${svg || ""}\n${(steps || []).map((s) => `${s.title} ${s.explanation}`).join("\n")}`,
    input.contract,
  );

  const visualId = `vis-${crypto.randomUUID().slice(0, 10)}`;
  const card: VisualExplanationCardData = {
    kind: "visual_explanation",
    visualId,
    lessonId,
    conceptId,
    contractVersion,
    title,
    summary,
    caption,
    visualType: effectiveType,
    mermaid,
    svg,
    widget,
    steps,
    cacheHit: false,
    skillUsed: skillLoaded ? "visual-explainer" : undefined,
    sanitizationWarnings:
      sanitizationWarnings.length > 0 ? sanitizationWarnings : undefined,
  };

  // 5. Persist in SQLite visual_explainer_cache (for both requested key & effective visualType key)
  const finalCacheKey = buildVisualCacheKey({
    lessonId,
    contractVersion,
    conceptId,
    visualType: effectiveType,
  });
  try {
    saveVisualExplainerCacheToDb({
      cacheKey: finalCacheKey,
      visualId,
      lessonId,
      contractVersion,
      conceptId,
      visualType: effectiveType,
      spec: card as unknown as Record<string, unknown>,
    });
    if (finalCacheKey !== cacheKey) {
      saveVisualExplainerCacheToDb({
        cacheKey,
        visualId,
        lessonId,
        contractVersion,
        conceptId,
        visualType: effectiveType,
        spec: card as unknown as Record<string, unknown>,
      });
    }
  } catch {
    // Best-effort cache write
  }

  // 6. Register as a strictly lessonId-scoped teaching activity so Learn displays it ONLY on this lesson
  if (input.persistActivity !== false) {
    try {
      saveTeachingActivityToDb({
        activityId: visualId,
        lessonId,
        learningSessionId: input.learningSessionId ?? null,
        decisionId: input.decisionId ?? null,
        activityType: resolvedActivity.effectiveType,
        schemaVersion: resolvedActivity.schemaVersion,
        gradingMode: "self_reflection",
        status: "active",
        spec: card as unknown as Record<string, unknown>,
        linkedExerciseId: null,
      });
    } catch {
      // Best-effort activity write
    }
  }

  return {
    card,
    cacheHit: false,
    activityId: visualId,
    skillLoaded,
    sanitizationWarnings,
    contractBoundaryNotes,
  };
}

export function buildVisualExplainerInputFromLesson(
  lesson: Lesson,
  opts?: {
    visualType?: VisualExplanationType;
    contractVersion?: number;
    userRequest?: string;
  },
): RunVisualExplainerInput {
  return {
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    conceptId: lesson.title,
    conceptSummary: lesson.concept,
    contract: lesson.contract ?? null,
    contractVersion: opts?.contractVersion ?? lesson.contract?.blueprintVersion ?? 1,
    visualType: opts?.visualType,
    userRequest: opts?.userRequest,
  };
}
