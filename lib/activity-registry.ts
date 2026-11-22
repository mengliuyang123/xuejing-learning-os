import { z } from "zod";
import type { InteractiveCheckMode } from "./learning";
import { sanitizeSvgStrict } from "./svg-sanitizer";

export type ActivityGradingMode =
  | "deterministic"
  | "tool_verified"
  | "rubric_assisted"
  | "self_reflection";

export type RuntimeCapability =
  | "markdown"
  | "mermaid"
  | "svg_canvas"
  | "code_editor"
  | "deterministic_quiz"
  | "web_research"
  | "image_understanding"
  | "audio_listening"
  | "speech_recognition";

export const DEFAULT_LEARNOS_CAPABILITIES: readonly RuntimeCapability[] = [
  "markdown",
  "mermaid",
  "svg_canvas",
  "code_editor",
  "deterministic_quiz",
  "web_research",
];

export interface LearningActivityDefinition<TSpec = unknown> {
  type: string;
  schemaVersion: number;
  renderer: string;
  gradingMode: ActivityGradingMode;
  requiredCapabilities: RuntimeCapability[];
  /** Maps assessable activity types to canonical Exercise Engine modes when applicable. */
  canonicalExerciseMode?: InteractiveCheckMode;
  schema: z.ZodType<TSpec>;
  validate(input: unknown): TSpec;
}

const baseTitlePrompt = {
  title: z.string().min(1).optional(),
  prompt: z.string().min(2),
};

const visualStepSchema = z.object({
  stepNumber: z.number().int().min(1),
  title: z.string().min(1),
  explanation: z.string().min(2),
  highlightIds: z.array(z.string().min(1)).optional(),
  mermaid: z.string().min(6).optional(),
});

const visualWidgetSchema = z.object({
  widgetType: z.enum(["timeline", "parameter_explorer"]),
  config: z.record(z.string(), z.unknown()),
});

const visualPayloadSchema = z.object({
  ...baseTitlePrompt,
  visualType: z.enum(["mermaid", "svg", "interactive_widget"]).optional(),
  mermaid: z.string().min(6).optional(),
  svg: z.string().min(20).optional(),
  widget: visualWidgetSchema.optional(),
  steps: z.array(visualStepSchema).optional(),
  summary: z.string().optional(),
  caption: z.string().optional(),
  visualId: z.string().optional(),
  lessonId: z.string().optional(),
  conceptId: z.string().optional(),
  contractVersion: z.number().int().min(1).optional(),
});

function validateAndNormalizeVisualSpec(input: unknown) {
  const parsed = visualPayloadSchema.parse(input);
  const inferredType =
    parsed.visualType ||
    (parsed.svg ? "svg" : parsed.widget ? "interactive_widget" : "mermaid");

  if (inferredType === "mermaid") {
    const hasStepMermaid = Boolean(parsed.steps?.some((s) => s.mermaid?.trim()));
    if (!parsed.mermaid?.trim() && !hasStepMermaid) {
      throw new Error("Mermaid 可视化活动缺少有效的 mermaid 语法源码");
    }
    return {
      ...parsed,
      visualType: "mermaid" as const,
    };
  }

  if (inferredType === "svg") {
    if (!parsed.svg?.trim()) {
      throw new Error("SVG 可视化活动缺少 svg 源码");
    }
    const clean = sanitizeSvgStrict(parsed.svg);
    if (!clean.ok || !clean.sanitizedSvg) {
      throw new Error(
        `SVG 安全净化未通过：${clean.warnings.join("；") || "结构非法"}`,
      );
    }
    return {
      ...parsed,
      visualType: "svg" as const,
      svg: clean.sanitizedSvg,
      sanitizationWarnings: clean.warnings.length ? clean.warnings : undefined,
    };
  }

  if (!parsed.widget) {
    throw new Error("interactive_widget 可视化活动缺少 widget 参数");
  }
  return {
    ...parsed,
    visualType: "interactive_widget" as const,
  };
}

const ACTIVITY_DEFINITIONS: LearningActivityDefinition[] = [
  {
    type: "reading",
    schemaVersion: 1,
    renderer: "MarkdownBlockRenderer",
    gradingMode: "self_reflection",
    requiredCapabilities: ["markdown"],
    schema: z.object({ ...baseTitlePrompt, markdown: z.string().min(4) }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "explanation",
    schemaVersion: 1,
    renderer: "MarkdownBlockRenderer",
    gradingMode: "self_reflection",
    requiredCapabilities: ["markdown"],
    schema: z.object({
      ...baseTitlePrompt,
      markdown: z.string().min(4),
      keyTakeaways: z.array(z.string()).optional(),
    }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "diagram",
    schemaVersion: 2,
    renderer: "VisualExplanationRenderer",
    gradingMode: "self_reflection",
    requiredCapabilities: ["mermaid"],
    schema: visualPayloadSchema,
    validate(i) {
      return validateAndNormalizeVisualSpec(i);
    },
  },
  {
    type: "visual_explanation",
    schemaVersion: 2,
    renderer: "VisualExplanationRenderer",
    gradingMode: "self_reflection",
    requiredCapabilities: ["mermaid", "svg_canvas"],
    schema: visualPayloadSchema,
    validate(i) {
      return validateAndNormalizeVisualSpec(i);
    },
  },
  {
    type: "worked_example",
    schemaVersion: 1,
    renderer: "WorkedExampleRenderer",
    gradingMode: "self_reflection",
    requiredCapabilities: ["markdown"],
    schema: z.object({
      ...baseTitlePrompt,
      steps: z.array(z.string().min(2)).min(1),
      artifact: z.string().optional(),
      language: z.string().optional(),
    }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "guided_practice",
    schemaVersion: 1,
    renderer: "GuidedPracticeRenderer",
    gradingMode: "rubric_assisted",
    requiredCapabilities: ["markdown"],
    canonicalExerciseMode: "short_answer",
    schema: z.object({
      ...baseTitlePrompt,
      scaffolds: z.array(z.string().min(2)).min(1),
      rubricPoints: z.array(z.string().min(2)).optional(),
    }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "multiple_choice",
    schemaVersion: 1,
    renderer: "InteractiveCheckRenderer",
    gradingMode: "deterministic",
    requiredCapabilities: ["deterministic_quiz"],
    canonicalExerciseMode: "choice",
    schema: z.object({
      ...baseTitlePrompt,
      choices: z.array(z.string().min(1)).min(2),
      correctChoiceIndex: z.number().int().min(0),
      explanation: z.string().optional(),
    }),
    validate(i) {
      const parsed = this.schema.parse(i) as {
        choices: string[];
        correctChoiceIndex: number;
      };
      if (parsed.correctChoiceIndex >= parsed.choices.length) {
        throw new Error("correctChoiceIndex 超出选项范围");
      }
      return parsed;
    },
  },
  {
    type: "multi_choice",
    schemaVersion: 1,
    renderer: "InteractiveCheckRenderer",
    gradingMode: "deterministic",
    requiredCapabilities: ["deterministic_quiz"],
    canonicalExerciseMode: "multi_choice",
    schema: z.object({
      ...baseTitlePrompt,
      choices: z.array(z.string().min(1)).min(2),
      correctChoiceIndices: z.array(z.number().int().min(0)).min(1),
      explanation: z.string().optional(),
    }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "fill_blank",
    schemaVersion: 1,
    renderer: "InteractiveCheckRenderer",
    gradingMode: "deterministic",
    requiredCapabilities: ["deterministic_quiz"],
    canonicalExerciseMode: "fill_blank",
    schema: z.object({
      ...baseTitlePrompt,
      blanks: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
            answer: z.string().min(1),
            placeholder: z.string().optional(),
          }),
        )
        .min(1),
      explanation: z.string().optional(),
    }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "order_steps",
    schemaVersion: 1,
    renderer: "InteractiveCheckRenderer",
    gradingMode: "deterministic",
    requiredCapabilities: ["deterministic_quiz"],
    canonicalExerciseMode: "order_steps",
    schema: z.object({
      ...baseTitlePrompt,
      steps: z.array(z.string().min(1)).min(2),
      correctStepsOrder: z.array(z.string().min(1)).min(2),
      explanation: z.string().optional(),
    }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "short_answer",
    schemaVersion: 1,
    renderer: "InteractiveCheckRenderer",
    gradingMode: "rubric_assisted",
    requiredCapabilities: ["markdown"],
    canonicalExerciseMode: "short_answer",
    schema: z.object({
      ...baseTitlePrompt,
      rubricPoints: z.array(z.string().min(2)).min(1),
      hint: z.string().optional(),
    }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "code_exercise",
    schemaVersion: 1,
    renderer: "CodeExerciseRenderer",
    gradingMode: "tool_verified",
    requiredCapabilities: ["code_editor"],
    canonicalExerciseMode: "code",
    schema: z.object({
      ...baseTitlePrompt,
      language: z.string().min(1),
      starterCode: z.string().optional(),
      expectedOutput: z.string().optional(),
      rubricPoints: z.array(z.string().min(2)).min(1),
    }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "math_problem",
    schemaVersion: 1,
    renderer: "InteractiveCheckRenderer",
    gradingMode: "deterministic",
    requiredCapabilities: ["markdown", "deterministic_quiz"],
    canonicalExerciseMode: "fill_blank",
    schema: z.object({
      ...baseTitlePrompt,
      givenConditions: z.array(z.string()).optional(),
      expectedExpression: z.string().min(1),
      derivationSteps: z.array(z.string()).optional(),
      counterexampleNote: z.string().optional(),
    }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "flashcard",
    schemaVersion: 1,
    renderer: "ActiveRecallRenderer",
    gradingMode: "self_reflection",
    requiredCapabilities: ["markdown"],
    schema: z.object({
      ...baseTitlePrompt,
      front: z.string().min(2),
      back: z.string().min(2),
      cue: z.string().optional(),
    }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "essay",
    schemaVersion: 1,
    renderer: "InteractiveCheckRenderer",
    gradingMode: "rubric_assisted",
    requiredCapabilities: ["markdown"],
    canonicalExerciseMode: "short_answer",
    schema: z.object({
      ...baseTitlePrompt,
      perspectivesToAddress: z.array(z.string().min(2)).min(1),
      rubricPoints: z.array(z.string().min(2)).min(1),
    }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "project",
    schemaVersion: 1,
    renderer: "ProjectTaskRenderer",
    gradingMode: "rubric_assisted",
    requiredCapabilities: ["markdown"],
    canonicalExerciseMode: "short_answer",
    schema: z.object({
      ...baseTitlePrompt,
      deliverables: z.array(z.string().min(2)).min(1),
      checklist: z.array(z.string().min(2)).min(1),
      rubricPoints: z.array(z.string().min(2)).optional(),
    }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "simulation",
    schemaVersion: 1,
    renderer: "MarkdownBlockRenderer",
    gradingMode: "self_reflection",
    requiredCapabilities: ["markdown"],
    schema: z.object({
      ...baseTitlePrompt,
      scenario: z.string().min(4),
      parameters: z.array(z.string().min(1)).min(1),
      observationGuide: z.string().min(4),
    }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  // Capability-gated future modalities (NEVER faked when runtime lacks vision/audio!)
  {
    type: "image_analysis",
    schemaVersion: 1,
    renderer: "ImageAnalysisRenderer",
    gradingMode: "rubric_assisted",
    requiredCapabilities: ["image_understanding"],
    schema: z.object({
      ...baseTitlePrompt,
      criteria: z.array(z.string().min(2)).min(1),
    }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "listening",
    schemaVersion: 1,
    renderer: "AudioListeningRenderer",
    gradingMode: "deterministic",
    requiredCapabilities: ["audio_listening"],
    schema: z.object({ ...baseTitlePrompt, audioUrl: z.string().min(4) }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
  {
    type: "speaking",
    schemaVersion: 1,
    renderer: "SpeechPracticeRenderer",
    gradingMode: "rubric_assisted",
    requiredCapabilities: ["speech_recognition"],
    schema: z.object({ ...baseTitlePrompt, targetPhrase: z.string().min(1) }),
    validate(i) {
      return this.schema.parse(i);
    },
  },
];

const REGISTRY_MAP = new Map<string, LearningActivityDefinition>(
  ACTIVITY_DEFINITIONS.map((d) => [d.type, d]),
);

export function listRegisteredActivityTypes(): string[] {
  return [...REGISTRY_MAP.keys()];
}

export function getActivityDefinition(
  type: string,
): LearningActivityDefinition | undefined {
  return REGISTRY_MAP.get(type);
}

export function listSupportedActivityTypesForCapabilities(
  capabilities: readonly RuntimeCapability[] = DEFAULT_LEARNOS_CAPABILITIES,
): string[] {
  const capSet = new Set(capabilities);
  return ACTIVITY_DEFINITIONS.filter((d) =>
    d.requiredCapabilities.every((c) => capSet.has(c)),
  ).map((d) => d.type);
}

export type ResolvedTeachingActivity = {
  requestedType: string;
  effectiveType: string;
  schemaVersion: number;
  renderer: string;
  gradingMode: ActivityGradingMode;
  canonicalExerciseMode?: InteractiveCheckMode;
  spec: Record<string, unknown>;
  degraded: boolean;
  degradationReason?: string;
};

/**
 * Validates a LLM-proposed teaching activity against the extensible Activity Registry.
 * - Rejects arbitrary executable JS / unsafe types
 * - Detects unavailable capabilities (e.g., image_analysis / speaking without vision/ASR)
 * - Degrades cleanly to safe Markdown/Explanation or Guided Checklist with explicit disclosure (TP-09)
 */
export function resolveAndValidateTeachingActivity(opts: {
  requestedType: string;
  rawSpec: unknown;
  availableCapabilities?: readonly RuntimeCapability[];
}): ResolvedTeachingActivity {
  const caps = new Set<RuntimeCapability>(
    opts.availableCapabilities || DEFAULT_LEARNOS_CAPABILITIES,
  );
  const def = REGISTRY_MAP.get(opts.requestedType);

  if (!def) {
    const fallbackPrompt =
      opts.rawSpec &&
      typeof opts.rawSpec === "object" &&
      "prompt" in opts.rawSpec
        ? String((opts.rawSpec as { prompt?: unknown }).prompt || "")
        : `围绕当前主题开展引导学习（原请求活动类型「${opts.requestedType}」尚未支持，已安全降级为结构化讲解）。`;
    return {
      requestedType: opts.requestedType,
      effectiveType: "explanation",
      schemaVersion: 1,
      renderer: "MarkdownBlockRenderer",
      gradingMode: "self_reflection",
      spec: {
        title: "安全降级教学说明",
        prompt: fallbackPrompt || "请阅读下方讲解并结合本课要点进行思考。",
        markdown:
          typeof opts.rawSpec === "object" &&
          opts.rawSpec &&
          "markdown" in opts.rawSpec
            ? String((opts.rawSpec as { markdown?: unknown }).markdown)
            : fallbackPrompt,
      },
      degraded: true,
      degradationReason: `活动类型「${opts.requestedType}」未在 Activity Registry 注册，已安全降级为 Markdown 讲解（绝不执行未授权动态脚本）。`,
    };
  }

  const missingCaps = def.requiredCapabilities.filter((c) => !caps.has(c));
  if (missingCaps.length > 0) {
    const rawPrompt =
      opts.rawSpec &&
      typeof opts.rawSpec === "object" &&
      "prompt" in opts.rawSpec
        ? String((opts.rawSpec as { prompt?: unknown }).prompt || "")
        : "完成对应实践并按检查清单自评。";
    return {
      requestedType: opts.requestedType,
      effectiveType: "project",
      schemaVersion: 1,
      renderer: "ProjectTaskRenderer",
      gradingMode: "self_reflection",
      spec: {
        title: "实操自检任务（能力降级提示）",
        prompt: rawPrompt,
        deliverables: ["按参数/步骤完成实际操作并记录观察结果"],
        checklist: [
          `说明：当前运行环境未启用 ${missingCaps.join(", ")} 能力，系统不会假装已读取你的照片或音频。`,
          "请对照本课参数/要点逐项自检，或把你的参数与现象用文字告诉 AI Tutor 获取针对性指导。",
        ],
      },
      degraded: true,
      degradationReason: `活动「${opts.requestedType}」需要 ${missingCaps.join(", ")} 能力，当前环境未具备，已明确降级为实操自检清单（严禁假装已观察图像/音频）。`,
    };
  }

  try {
    const validated = def.validate(opts.rawSpec) as Record<string, unknown>;
    return {
      requestedType: opts.requestedType,
      effectiveType: def.type,
      schemaVersion: def.schemaVersion,
      renderer: def.renderer,
      gradingMode: def.gradingMode,
      canonicalExerciseMode: def.canonicalExerciseMode,
      spec: validated,
      degraded: false,
    };
  } catch (err) {
    const rawPrompt =
      opts.rawSpec &&
      typeof opts.rawSpec === "object" &&
      "prompt" in opts.rawSpec
        ? String((opts.rawSpec as { prompt?: unknown }).prompt || "")
        : "请结合本课核心概念完成思考与练习。";
    return {
      requestedType: opts.requestedType,
      effectiveType: "explanation",
      schemaVersion: 1,
      renderer: "MarkdownBlockRenderer",
      gradingMode: "self_reflection",
      spec: {
        title: "结构化引导说明",
        prompt: rawPrompt,
        markdown: rawPrompt,
      },
      degraded: true,
      degradationReason: `活动「${opts.requestedType}」参数校验未通过（${err instanceof Error ? err.message : "格式错误"}），已降级为安全讲解块。`,
    };
  }
}
