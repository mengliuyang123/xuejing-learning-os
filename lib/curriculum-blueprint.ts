import crypto from "node:crypto";
import type { LanguageModel } from "ai";
import { z } from "zod";
import {
  type AgentTaskDefinition,
  type AgentTaskIdentity,
  type RuntimeModelExecutor,
  executeAgentTask,
} from "./agent-runtime";
import {
  deriveGraphLessonContracts,
  groupLessonsIntoStages,
  normalizeLessonGoalFields,
  recommendLessonCount,
  reconcileTrackUnitsAndSchedule,
  scheduleTrackUnitsInOrder,
} from "./curriculum-planner";
import { saveCurriculumBlueprintToDb } from "./db";
import {
  type Block,
  type GoalPlan,
  type Lesson,
  type LessonContract,
  type PriorKnowledgeLevel,
  type Store,
  type TrackDepth,
} from "./learning";
import type { ResearchPackage } from "./research-planner";

export interface LearningOutcome {
  id: string;
  description: string;
  expectedPerformance: string;
  assessmentStrategy: string;
}

export interface PrerequisiteEdge {
  from: string;
  to: string;
  kind: "required" | "recommended";
}

export interface CurriculumLessonBlueprint {
  id: string;
  title: string;
  objective: string;
  completionCriteria: string;
  concept: string;
  minutes: number;
  outcomeIds: string[];
  recommendedActivities: string[];
  example?: string;
  practiceType?: "code" | "text";
  practiceLanguage?: string;
  contract?: LessonContract;
}

export interface CurriculumModule {
  id: string;
  title: string;
  summary: string;
  lessons: CurriculumLessonBlueprint[];
}

export interface CurriculumStage {
  id: string;
  title: string;
  goalSummary: string;
  /** Large goals may outline later stages at a high level and detail modules on demand. */
  deferred?: boolean;
  modules: CurriculumModule[];
}

export interface CurriculumBlueprint {
  id: string;
  goalId: string;
  title: string;
  outcomes: LearningOutcome[];
  stages: CurriculumStage[];
  prerequisiteEdges: PrerequisiteEdge[];
  estimatedMinutes: number;
  researchPackageId: string;
  version: number;
  depth?: TrackDepth;
  timeBudgetWarning?: string;
}

export interface CurriculumValidationReport {
  ok: boolean;
  deterministicErrors: string[];
  semanticWarnings: string[];
  timeBudgetWarning?: string;
  needsMoreResearch: boolean;
  missingResearchOutcomes: string[];
  topologicalOrder: string[];
  totalLessonCount: number;
  estimatedMinutes: number;
}

const blueprintLlmOutputSchema = z.object({
  title: z.string().min(2),
  outcomes: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string().min(4),
        expectedPerformance: z.string().min(4),
        assessmentStrategy: z.string().min(2),
      }),
    )
    .min(1),
  stages: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(2),
        goalSummary: z.string().min(4),
        deferred: z.boolean().optional(),
        modules: z.array(
          z.object({
            id: z.string().min(1),
            title: z.string().min(2),
            summary: z.string().min(2),
            lessons: z.array(
              z.object({
                id: z.string().min(1),
                title: z.string().min(2),
                objective: z.string().min(4),
                completionCriteria: z.string().min(4),
                concept: z.string().min(4),
                minutes: z.number().int().min(10).max(120),
                outcomeIds: z.array(z.string()),
                recommendedActivities: z.array(z.string()).optional(),
                example: z.string().optional(),
                practiceType: z.string().optional(),
                practiceLanguage: z.string().optional(),
              }),
            ),
          }),
        ),
      }),
    )
    .min(1),
  prerequisiteEdges: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      kind: z.enum(["required", "recommended"]),
    }),
  ),
});

export function flattenBlueprintLessons(
  blueprint: CurriculumBlueprint,
): CurriculumLessonBlueprint[] {
  const list: CurriculumLessonBlueprint[] = [];
  for (const stage of blueprint.stages) {
    for (const mod of stage.modules) {
      for (const lesson of mod.lessons) {
        list.push(lesson);
      }
    }
  }
  return list;
}

/**
 * Deterministic + Semantic Curriculum Validator (Section 8.4).
 * Checks ID uniqueness, edge references, DAG acyclicity, valid durations,
 * outcome coverage, time budget feasibility, and research sufficiency.
 */
export function validateCurriculumBlueprint(
  blueprint: CurriculumBlueprint,
  opts: {
    days?: number;
    dailyMinutes?: number;
    researchPackage?: ResearchPackage | null;
    priorKnowledge?: PriorKnowledgeLevel;
  } = {},
): CurriculumValidationReport {
  const deterministicErrors: string[] = [];
  const semanticWarnings: string[] = [];

  if (!blueprint.title?.trim()) {
    deterministicErrors.push("课程蓝图缺少总标题。");
  }
  if (!Array.isArray(blueprint.outcomes) || blueprint.outcomes.length === 0) {
    deterministicErrors.push("课程蓝图必须包含至少 1 项可验证的学习成果（outcomes）。");
  }
  if (!Array.isArray(blueprint.stages) || blueprint.stages.length === 0) {
    deterministicErrors.push("课程蓝图必须包含至少 1 个阶段（stages）。");
  }

  const lessons = flattenBlueprintLessons(blueprint);
  if (lessons.length === 0) {
    deterministicErrors.push("课程蓝图未包含任何可执行课程（lessons）。");
  }

  const seenLessonIds = new Set<string>();
  const outcomeIds = new Set((blueprint.outcomes || []).map((o) => o.id));
  const coveredOutcomeIds = new Set<string>();
  let totalMinutes = 0;

  for (const l of lessons) {
    if (!l.id?.trim()) {
      deterministicErrors.push("存在缺少 id 的课程节点。");
    } else if (seenLessonIds.has(l.id)) {
      deterministicErrors.push(`课程 ID 重复：${l.id}`);
    } else {
      seenLessonIds.add(l.id);
    }

    if (!l.title?.trim()) {
      deterministicErrors.push(`课程 ${l.id} 缺少标题。`);
    }
    if (!l.objective?.trim()) {
      deterministicErrors.push(`课程「${l.title || l.id}」缺少学习目标。`);
    }
    if (!l.completionCriteria?.trim()) {
      deterministicErrors.push(`课程「${l.title || l.id}」缺少完成条件。`);
    }
    if (!Number.isFinite(l.minutes) || l.minutes < 10 || l.minutes > 120) {
      deterministicErrors.push(
        `课程「${l.title || l.id}」时长非法（${l.minutes} 分钟，应为 10–120 分钟）。`,
      );
    } else {
      totalMinutes += l.minutes;
    }

    for (const oid of l.outcomeIds || []) {
      if (!outcomeIds.has(oid)) {
        semanticWarnings.push(`课程「${l.title}」引用了未定义的学习成果 ${oid}。`);
      } else {
        coveredOutcomeIds.add(oid);
      }
    }
  }

  // Check every LearningOutcome is covered by at least one lesson (CP-05)
  for (const o of blueprint.outcomes || []) {
    if (!coveredOutcomeIds.has(o.id)) {
      deterministicErrors.push(
        `学习成果「${o.description}」（${o.id}）未被任何课程覆盖。`,
      );
    }
  }

  // Validate prerequisite edges + Kahn's topological cycle check (CP-03 / CP-04)
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of seenLessonIds) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }

  for (const edge of blueprint.prerequisiteEdges || []) {
    if (!seenLessonIds.has(edge.from)) {
      deterministicErrors.push(`先修边引用了不存在的起点课程：${edge.from}`);
      continue;
    }
    if (!seenLessonIds.has(edge.to)) {
      deterministicErrors.push(`先修边引用了不存在的终点课程：${edge.to}`);
      continue;
    }
    if (edge.from === edge.to) {
      deterministicErrors.push(`课程 ${edge.from} 不能依赖自身。`);
      continue;
    }
    adj.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const queue = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([id]) => id);
  const topologicalOrder: string[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    topologicalOrder.push(curr);
    for (const nxt of adj.get(curr) || []) {
      const deg = (inDegree.get(nxt) ?? 1) - 1;
      inDegree.set(nxt, deg);
      if (deg === 0) queue.push(nxt);
    }
  }
  if (
    seenLessonIds.size > 0 &&
    topologicalOrder.length !== seenLessonIds.size
  ) {
    deterministicErrors.push("先修依赖图存在循环依赖（Cycle），无法拓扑排序。");
  }

  // Time budget feasibility check (CP-07)
  let timeBudgetWarning: string | undefined;
  if (opts.days && opts.dailyMinutes) {
    const budgetMinutes = opts.days * opts.dailyMinutes;
    if (totalMinutes > budgetMinutes * 1.15) {
      timeBudgetWarning = `当前蓝图总预计时长 ${totalMinutes} 分钟，超出 ${opts.days} 天 × ${opts.dailyMinutes} 分钟（${budgetMinutes} 分钟）预算，建议精简范围或延长周期。`;
      semanticWarnings.push(timeBudgetWarning);
    }
  }

  // Research sufficiency check (CP-08)
  const missingResearchOutcomes =
    opts.researchPackage?.coverageReport.missingOutcomes || [];
  const needsMoreResearch = Boolean(
    opts.researchPackage &&
      (opts.researchPackage.coverageReport.recommendation ===
        "continue_research" ||
        missingResearchOutcomes.length >= 2),
  );
  if (needsMoreResearch) {
    semanticWarnings.push(
      `研究覆盖度不足（缺失 ${missingResearchOutcomes.length} 项学习成果证据），建议由 Research Planner 补充研究后再细化相关课程。`,
    );
  }

  return {
    ok: deterministicErrors.length === 0,
    deterministicErrors,
    semanticWarnings,
    timeBudgetWarning,
    needsMoreResearch,
    missingResearchOutcomes,
    topologicalOrder,
    totalLessonCount: lessons.length,
    estimatedMinutes: totalMinutes,
  };
}

/**
 * Deterministic blueprint builder (used when offline / no LLM model is supplied)
 * dynamically sizing small vs large goals (staged structure for large goals,
 * never forcing 6 lessons!).
 */
function buildDeterministicBlueprint(opts: {
  goalId: string;
  goal: string;
  researchPackage: ResearchPackage;
  priorKnowledge: PriorKnowledgeLevel;
  days?: number;
  dailyMinutes?: number;
  depth?: TrackDepth;
  version: number;
}): CurriculumBlueprint {
  const { goalId, goal, researchPackage, priorKnowledge, days, dailyMinutes, depth } =
    opts;
  const sizing = recommendLessonCount({
    goal,
    priorKnowledge,
    days,
    dailyMinutes,
    depth,
    dependencyCount: Math.max(0, researchPackage.prerequisites.length - 1),
  });

  const targetCount = sizing.recommended;
  const blueprintId = `bp-${crypto.randomUUID().slice(0, 10)}`;
  const isLargeGoal = targetCount >= 7 || sizing.depth === "deep";
  const modalities = researchPackage.capabilityProfile.recommendedModalities;
  const isCoding =
    researchPackage.capabilityProfile.dimensions.includes("programming");

  const outcomes: LearningOutcome[] = (
    researchPackage.learningOutcomes.length > 0
      ? researchPackage.learningOutcomes
      : [`掌握「${researchPackage.topic}」核心机制`, `完成「${researchPackage.topic}」实际应用验证`]
  ).map((desc, idx) => ({
    id: `out-${idx + 1}`,
    description: desc,
    expectedPerformance: `能够独立完成与「${desc}」对应的实践与迁移验证`,
    assessmentStrategy: modalities[idx % modalities.length] || "short_answer",
  }));

  const activeLessonCount = isLargeGoal ? Math.min(targetCount, 6) : targetCount;
  const perLessonMin = Math.max(
    15,
    Math.min(60, dailyMinutes ? Math.min(dailyMinutes, 45) : 30),
  );

  const lessons: CurriculumLessonBlueprint[] = [];
  for (let i = 0; i < activeLessonCount; i++) {
    const conceptObj =
      researchPackage.concepts[i % researchPackage.concepts.length];
    const outcome = outcomes[i % outcomes.length];
    const stageRole =
      i === 0
        ? "基础认知与前置准备"
        : i === activeLessonCount - 1
          ? "综合应用与边界验证"
          : `核心机制拆解 ${i}`;
    lessons.push({
      id: `${blueprintId}-l${i + 1}`,
      title:
        activeLessonCount === 1
          ? `${researchPackage.topic}：核心原理与快速验证`
          : `${researchPackage.topic}（${i + 1}）：${conceptObj?.name || stageRole}`,
      objective:
        conceptObj?.learningOutcomes[0] ||
        `${outcome.description}（聚焦：${stageRole}）`,
      completionCriteria: `通过「${outcome.assessmentStrategy}」类活动验证并达到掌握标准（≥ 80%）`,
      concept:
        conceptObj?.definition ||
        `${researchPackage.topic} 的关键组成与运行规律。`,
      minutes: perLessonMin,
      outcomeIds: [outcome.id],
      recommendedActivities: [
        modalities[i % modalities.length] || "worked_example",
        modalities[(i + 1) % modalities.length] || "short_answer",
      ],
      example: conceptObj?.examples[0],
      practiceType: isCoding ? "code" : "text",
      practiceLanguage: isCoding ? "python" : undefined,
    });
  }

  // Ensure every outcome is covered by at least one lesson
  outcomes.forEach((o, idx) => {
    const l = lessons[idx % lessons.length];
    if (!l.outcomeIds.includes(o.id)) l.outcomeIds.push(o.id);
  });

  const prerequisiteEdges: PrerequisiteEdge[] = [];
  for (let i = 1; i < lessons.length; i++) {
    prerequisiteEdges.push({
      from: lessons[i - 1].id,
      to: lessons[i].id,
      kind: "required",
    });
  }

  const stages: CurriculumStage[] = isLargeGoal
    ? [
        {
          id: `${blueprintId}-stage-1`,
          title: "阶段 1 · 核心基础与最小闭环",
          goalSummary: `建立「${researchPackage.topic}」基础心智模型与可执行实践`,
          modules: [
            {
              id: `${blueprintId}-mod-1`,
              title: "基础原理与核心实践",
              summary: "先打牢前置概念并跑通最小闭环",
              lessons: lessons.slice(0, Math.ceil(lessons.length / 2)),
            },
          ],
        },
        {
          id: `${blueprintId}-stage-2`,
          title: "阶段 2 · 进阶应用与综合实战",
          goalSummary: "在真实约束下完成迁移应用与排错",
          modules: [
            {
              id: `${blueprintId}-mod-2`,
              title: "进阶深化与边界处理",
              summary: "系统处理复杂场景与常见误区",
              lessons: lessons.slice(Math.ceil(lessons.length / 2)),
            },
          ],
        },
        {
          id: `${blueprintId}-stage-3`,
          title: "阶段 3 · 后续扩展（按需细化）",
          goalSummary: "完成前两阶段后根据真实掌握表现动态生成高阶专题模块",
          deferred: true,
          modules: [],
        },
      ]
    : [
        {
          id: `${blueprintId}-stage-1`,
          title: `核心学习路径 · ${researchPackage.topic}`,
          goalSummary: goal,
          modules: [
            {
              id: `${blueprintId}-mod-1`,
              title: researchPackage.topic,
              summary: "按先修依赖递进学习",
              lessons,
            },
          ],
        },
      ];

  const estimatedMinutes = lessons.reduce((acc, l) => acc + l.minutes, 0);

  return {
    id: blueprintId,
    goalId,
    title: `${researchPackage.topic}学习路径`,
    outcomes,
    stages,
    prerequisiteEdges,
    estimatedMinutes,
    researchPackageId: researchPackage.id,
    version: opts.version,
    depth: sizing.depth,
  };
}

/**
 * Structured Curriculum Planner (Section 8):
 * ResearchPackage -> Structured LLM Generation -> Deterministic & Semantic Validation
 * -> Bounded Repair Loop (max 2 repairs) -> SQLite Blueprint Persistence.
 */
export async function runCurriculumPlanner(opts: {
  goalId: string;
  goal: string;
  researchPackage: ResearchPackage;
  priorKnowledge?: PriorKnowledgeLevel;
  days?: number;
  dailyMinutes?: number;
  depth?: TrackDepth;
  existingBlueprintVersion?: number;
  identity?: Partial<AgentTaskIdentity>;
  model?: LanguageModel | string | null;
  modelLabel?: string;
  providerName?: string;
  abortSignal?: AbortSignal;
  customExecutor?: RuntimeModelExecutor;
  maxRepairAttempts?: number;
}): Promise<{
  blueprint: CurriculumBlueprint;
  validation: CurriculumValidationReport;
  repairAttempts: number;
}> {
  const priorKnowledge: PriorKnowledgeLevel = opts.priorKnowledge || "intermediate";
  const version = (opts.existingBlueprintVersion ?? 0) + 1;
  const maxRepairs = Math.max(0, Math.min(3, opts.maxRepairAttempts ?? 2));
  let repairAttempts = 0;

  if (!opts.model && !opts.customExecutor) {
    const bp = buildDeterministicBlueprint({
      goalId: opts.goalId,
      goal: opts.goal,
      researchPackage: opts.researchPackage,
      priorKnowledge,
      days: opts.days,
      dailyMinutes: opts.dailyMinutes,
      depth: opts.depth,
      version,
    });
    const validation = validateCurriculumBlueprint(bp, {
      days: opts.days,
      dailyMinutes: opts.dailyMinutes,
      researchPackage: opts.researchPackage,
      priorKnowledge,
    });
    if (validation.timeBudgetWarning) {
      bp.timeBudgetWarning = validation.timeBudgetWarning;
    }
    try {
      saveCurriculumBlueprintToDb({
        blueprintId: bp.id,
        goalId: bp.goalId,
        version: bp.version,
        researchPackageId: bp.researchPackageId,
        status: validation.ok ? "ready" : "needs_repair",
        blueprint: bp,
        validationReport: validation,
      });
    } catch {}
    return { blueprint: bp, validation, repairAttempts: 0 };
  }

  let validationFeedback = "";
  let lastBlueprint: CurriculumBlueprint | null = null;
  let lastValidation: CurriculumValidationReport | null = null;

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    if (attempt > 0) repairAttempts++;
    const taskDef: AgentTaskDefinition<
      { feedback: string },
      z.infer<typeof blueprintLlmOutputSchema>
    > = {
      name: "curriculum_planner",
      kind: "curriculum",
      mode: "structured",
      maxSteps: 1,
      timeoutMs: 35000,
      tokenBudget: 12000,
      allowedTools: [],
      buildContext: async ({ feedback }) => ({
        system: [
          "你是「学径」的 Curriculum Planner（结构化课程规划师）。",
          "核心原则：",
          "1. 章节与课时完全自由编排（拒绝写死节数或固定阶段模板）：根据学科内在知识体系、学习目标复杂度、已有基础与先修依赖自由发挥，决定总课时数量（多少节都可以）以及两级目录层级：",
          "   - stages 代表「大章节」（Major Chapters，数量与命名完全由该领域真实知识主干决定，如《第一章 · LLM 通信底座与消息协议》《第二章 · 工具调用与环境交互》等，严禁套用千篇一律的通用阶段模板）；",
          "   - modules 代表每个大章节下的「小章节 / 子专题」（Sub-chapters / Sections，如《1.1 请求生命周期与上下文窗口》《1.2 结构化输出与 JSON Schema》）；",
          "   - lessons 代表每个小章节下的具体「课时节点」（每个小章节可包含 1 至多节课时）。",
          "2. 跨学科适配：根据能力画像选择合适活动类型（reading/explanation/diagram/worked_example/guided_practice/multiple_choice/fill_blank/order_steps/short_answer/code_exercise/math_problem/flashcard/essay/project），不要给非编程学科强加代码题。",
          "3. 真实知识图谱 DAG：每项 outcome 至少被 1 节课的 outcomeIds 覆盖；prerequisiteEdges 引用真实存在的 lesson id 且严格无环（DAG，支持多个独立小章节/课时并行分支并在综合课时汇聚，不要把所有课机械串成一条单链）。",
          "4. 只输出合法 JSON 对象，字段结构：",
          `{
  "title": "学习路径名称",
  "outcomes": [{ "id": "out-1", "description": "学习成果", "expectedPerformance": "可观察表现", "assessmentStrategy": "验证方式" }],
  "stages": [{ "id": "st-1", "title": "大章节标题（自由命名）", "goalSummary": "本大章节目标与解决的核心问题", "deferred": false, "modules": [{ "id": "m-1", "title": "小章节标题（自由命名）", "summary": "本小节概要", "lessons": [{ "id": "l-1", "title": "课时标题", "objective": "学习目标", "completionCriteria": "完成条件", "concept": "核心概念", "minutes": 30, "outcomeIds": ["out-1"], "recommendedActivities": ["explanation", "guided_practice"], "practiceType": "text" }] }] }],
  "prerequisiteEdges": [{ "from": "l-1", "to": "l-2", "kind": "required" }]
}`,
        ].join("\n"),
        prompt: [
          `学习目标：${opts.goal}`,
          `学习者基础：${priorKnowledge}`,
          opts.days ? `周期：${opts.days} 天` : "",
          opts.dailyMinutes ? `每日可用时间：${opts.dailyMinutes} 分钟` : "",
          opts.depth ? `深度偏好：${opts.depth}` : "",
          `能力画像维度：${opts.researchPackage.capabilityProfile.dimensions.join(", ")}`,
          `研究概念（${opts.researchPackage.concepts.length} 项）：${JSON.stringify(
            opts.researchPackage.concepts.map((c) => ({
              name: c.name,
              definition: c.definition,
              prerequisites: c.prerequisites,
            })),
          ).slice(0, 2400)}`,
          `研究学习成果：${opts.researchPackage.learningOutcomes.join("；")}`,
          `研究先修建议：${opts.researchPackage.prerequisites.join("；")}`,
          feedback ? `\n【校验失败反馈，请定点修复以下问题】\n${feedback}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      }),
      validateOutput: (raw) => blueprintLlmOutputSchema.parse(raw),
    };

    const res = await executeAgentTask({
      definition: taskDef,
      input: { feedback: validationFeedback },
      identity: { ...opts.identity, kind: "curriculum", goalId: opts.goalId },
      model: opts.model,
      modelLabel: opts.modelLabel,
      providerName: opts.providerName,
      abortSignal: opts.abortSignal,
      customExecutor: opts.customExecutor,
      maxRepairAttempts: 0,
    });

    const out = res.output;
    const blueprintId = `bp-${crypto.randomUUID().slice(0, 10)}`;
    const normalizedStages: CurriculumStage[] = out.stages.map((st) => ({
      ...st,
      modules: st.modules.map((m) => ({
        ...m,
        lessons: m.lessons.map((l) => ({
          ...l,
          practiceType:
            l.practiceType === "code"
              ? "code"
              : l.practiceType
                ? "text"
                : undefined,
          recommendedActivities: l.recommendedActivities?.length
            ? l.recommendedActivities
            : l.practiceType && l.practiceType !== "code" && l.practiceType !== "text"
              ? [l.practiceType]
              : ["explanation"],
        })),
      })),
    }));
    const flat = normalizedStages.flatMap((s) =>
      s.modules.flatMap((m) => m.lessons),
    );
    const bp: CurriculumBlueprint = {
      id: blueprintId,
      goalId: opts.goalId,
      title: out.title,
      outcomes: out.outcomes,
      stages: normalizedStages,
      prerequisiteEdges: out.prerequisiteEdges,
      estimatedMinutes: flat.reduce((acc, l) => acc + l.minutes, 0),
      researchPackageId: opts.researchPackage.id,
      version,
      depth: opts.depth,
    };

    const validation = validateCurriculumBlueprint(bp, {
      days: opts.days,
      dailyMinutes: opts.dailyMinutes,
      researchPackage: opts.researchPackage,
      priorKnowledge,
    });
    if (validation.timeBudgetWarning) {
      bp.timeBudgetWarning = validation.timeBudgetWarning;
    }

    lastBlueprint = bp;
    lastValidation = validation;

    if (validation.ok) {
      try {
        saveCurriculumBlueprintToDb({
          blueprintId: bp.id,
          goalId: bp.goalId,
          version: bp.version,
          researchPackageId: bp.researchPackageId,
          status: "ready",
          blueprint: bp,
          validationReport: validation,
        });
      } catch {}
      return { blueprint: bp, validation, repairAttempts };
    }

    validationFeedback = validation.deterministicErrors.join("\n");
  }

  // Reached max repair attempts without infinite loop (CP-10)
  if (lastBlueprint && lastValidation) {
    try {
      saveCurriculumBlueprintToDb({
        blueprintId: lastBlueprint.id,
        goalId: lastBlueprint.goalId,
        version: lastBlueprint.version,
        researchPackageId: lastBlueprint.researchPackageId,
        status: "failed",
        blueprint: lastBlueprint,
        validationReport: lastValidation,
      });
    } catch {}
    throw new Error(
      `课程蓝图校验在修复 ${repairAttempts} 次后仍未通过：${lastValidation.deterministicErrors.join("；")}`,
    );
  }
  throw new Error("课程蓝图生成失败。");
}

/**
 * Projects a validated CurriculumBlueprint into LearnOS's existing GoalPlan + conflict-free
 * calendar slots so all 6 UI views and legacy SQLite tables stay 100% compatible.
 */
export function blueprintToGoalPlan(opts: {
  blueprint: CurriculumBlueprint;
  goal: string;
  day: string;
  existingBlocks: Block[];
  scheduleSettings?: Store["scheduleSettings"];
  days?: number;
  dailyMinutes?: number;
  startMin?: number;
  endMin?: number;
  priorKnowledge?: PriorKnowledgeLevel;
  trackId?: string;
}): { plan: GoalPlan; slots: Block[] } {
  const { blueprint } = opts;
  const trackId = opts.trackId || `track-${crypto.randomUUID().slice(0, 8)}`;
  const flatLessons = flattenBlueprintLessons(blueprint);
  const requiredByTarget = new Map<string, string[]>();
  for (const e of blueprint.prerequisiteEdges) {
    if (e.kind !== "required") continue;
    const arr = requiredByTarget.get(e.to) || [];
    if (!arr.includes(e.from)) arr.push(e.from);
    requiredByTarget.set(e.to, arr);
  }

  const stageAndModuleByLesson = new Map<
    string,
    {
      stageTitle: string;
      stageSubtitle?: string;
      moduleTitle: string;
      moduleSubtitle?: string;
    }
  >();
  for (const st of blueprint.stages) {
    for (const mod of st.modules) {
      for (const l of mod.lessons) {
        stageAndModuleByLesson.set(l.id, {
          stageTitle: st.title,
          stageSubtitle: st.goalSummary,
          moduleTitle: mod.title,
          moduleSubtitle: mod.summary,
        });
      }
    }
  }

  const rawUnits: Lesson[] = flatLessons.map((l) => {
    const loc = stageAndModuleByLesson.get(l.id);
    return normalizeLessonGoalFields({
      id: l.id,
      title: l.title,
      subtitle: l.objective.slice(0, 44),
      minutes: l.minutes,
      requires: requiredByTarget.get(l.id) || [],
      concept: l.concept,
      objective: l.objective,
      completionCriteria: l.completionCriteria,
      example: l.example || "",
      question: "",
      choices: [],
      answer: 0,
      feedback: "",
      practiceType: l.practiceType,
      practiceLanguage: l.practiceLanguage,
      contract: l.contract,
      stageTitle: loc?.stageTitle,
      stageSubtitle: loc?.stageSubtitle,
      moduleTitle: loc?.moduleTitle,
      moduleSubtitle: loc?.moduleSubtitle,
      outcomeIds: l.outcomeIds,
      recommendedActivities: l.recommendedActivities,
    });
  });

  const units = deriveGraphLessonContracts(rawUnits, {
    blueprintVersion: blueprint.version,
  });

  const daily = opts.dailyMinutes ?? 45;
  const start = opts.startMin ?? 1140;
  const end = opts.endMin ?? 1350;
  const slots = scheduleTrackUnitsInOrder(units, opts.existingBlocks, opts.day, {
    startMin: start,
    endMin: end,
    dailyMinutes: daily,
    scheduleSettings: opts.scheduleSettings,
  });

  const plan: GoalPlan = {
    id: trackId,
    version: `${trackId}-v${blueprint.version}`,
    goal: opts.goal,
    title: blueprint.title,
    days: opts.days ?? Math.max(3, Math.ceil(units.length * 1.5)),
    daily,
    start,
    depth: blueprint.depth ?? "standard",
    priorKnowledge: opts.priorKnowledge,
    blueprintId: blueprint.id,
    blueprintVersion: blueprint.version,
    researchPackageId: blueprint.researchPackageId || undefined,
    units,
    slots,
  };

  try {
    saveCurriculumBlueprintToDb({
      blueprintId: blueprint.id,
      goalId: blueprint.goalId,
      trackId,
      version: blueprint.version,
      researchPackageId: blueprint.researchPackageId,
      status: "ready",
      blueprint,
    });
  } catch {}

  return { plan, slots };
}

/**
 * Unifies Chat-created / Scope-adjusted GoalPlans with CurriculumBlueprint in SQLite
 * so the Knowledge Graph and CurriculumBlueprint share a single versioned source of truth.
 */
export function syncGoalPlanToCurriculumBlueprint(opts: {
  plan: GoalPlan;
  researchPackageId?: string | null;
  mastery?: Record<string, number>;
}): { plan: GoalPlan; blueprint: CurriculumBlueprint } {
  const version = Math.max(1, opts.plan.blueprintVersion ?? 1);
  const blueprintId =
    opts.plan.blueprintId || `bp-${opts.plan.id}-v${version}`;
  const researchPackageId =
    opts.researchPackageId ?? opts.plan.researchPackageId ?? "local-research";

  const unitsWithContracts = deriveGraphLessonContracts(opts.plan.units, {
    blueprintVersion: version,
    mastery: opts.mastery,
    preserveMasteredContracts: true,
  });

  const outcomes: LearningOutcome[] = unitsWithContracts.map((u, idx) => ({
    id: `out-${idx + 1}`,
    description: u.objective || `掌握「${u.title}」`,
    expectedPerformance:
      u.completionCriteria || `能够完成「${u.title}」核心实践与检验`,
    assessmentStrategy:
      u.practiceType === "code" ? "代码实操与确定性检验" : "概念应用与互动检测",
  }));

  const prerequisiteEdges: PrerequisiteEdge[] = [];
  for (const u of unitsWithContracts) {
    for (const req of u.requires || []) {
      prerequisiteEdges.push({
        from: req,
        to: u.id,
        kind: "required",
      });
    }
  }

  const bpLessons: CurriculumLessonBlueprint[] = unitsWithContracts.map(
    (u, idx) => ({
      id: u.id,
      title: u.title,
      objective: u.objective || u.concept,
      completionCriteria: u.completionCriteria || "完成本节练习并通过掌握度检验",
      concept: u.concept,
      minutes: u.minutes,
      outcomeIds: u.outcomeIds?.length ? u.outcomeIds : [`out-${idx + 1}`],
      recommendedActivities: u.recommendedActivities?.length
        ? u.recommendedActivities
        : u.practiceType === "code"
          ? ["explanation", "worked_example", "code_exercise"]
          : ["explanation", "worked_example", "guided_practice"],
      example: u.example,
      practiceType: u.practiceType,
      practiceLanguage: u.practiceLanguage,
      contract: u.contract,
    }),
  );

  const bpLessonById = new Map<string, CurriculumLessonBlueprint>();
  for (const l of bpLessons) {
    bpLessonById.set(l.id, l);
  }

  const groupedStages = groupLessonsIntoStages(unitsWithContracts);
  const stages: CurriculumStage[] =
    groupedStages.length > 0
      ? groupedStages.map((stg, sIdx) => ({
          id: `${opts.plan.id}-stage-${sIdx + 1}`,
          title: stg.stageTitle,
          goalSummary: stg.stageSubtitle || opts.plan.goal,
          deferred: false,
          modules: stg.sections.map((sec, mIdx) => ({
            id: `${opts.plan.id}-stage-${sIdx + 1}-mod-${mIdx + 1}`,
            title: `${sec.globalSectionCode} ${sec.sectionTitle}`,
            summary:
              sec.sectionSubtitle ||
              sec.units.map((u) => u.title).join(" · "),
            lessons: sec.units
              .map((u) => bpLessonById.get(u.id))
              .filter((x): x is CurriculumLessonBlueprint => Boolean(x)),
          })),
        }))
      : [
          {
            id: `${opts.plan.id}-stage-1`,
            title: opts.plan.title,
            goalSummary: opts.plan.goal,
            deferred: false,
            modules: [
              {
                id: `${opts.plan.id}-mod-1`,
                title: "核心知识图谱路径",
                summary: opts.plan.scopeNote || opts.plan.goal,
                lessons: bpLessons,
              },
            ],
          },
        ];

  const blueprint: CurriculumBlueprint = {
    id: blueprintId,
    goalId: opts.plan.id,
    title: opts.plan.title,
    outcomes,
    stages,
    prerequisiteEdges,
    estimatedMinutes: unitsWithContracts.reduce((s, u) => s + u.minutes, 0),
    researchPackageId,
    version,
    depth: opts.plan.depth,
  };

  try {
    saveCurriculumBlueprintToDb({
      blueprintId: blueprint.id,
      goalId: opts.plan.id,
      trackId: opts.plan.id,
      version: blueprint.version,
      researchPackageId: blueprint.researchPackageId,
      status: "ready",
      blueprint,
    });
  } catch {}

  const syncedPlan: GoalPlan = {
    ...opts.plan,
    version: `${opts.plan.id}-v${version}`,
    blueprintId: blueprint.id,
    blueprintVersion: version,
    researchPackageId:
      researchPackageId !== "local-research"
        ? researchPackageId
        : opts.plan.researchPackageId,
    units: unitsWithContracts,
  };

  return { plan: syncedPlan, blueprint };
}

/**
 * Applies a revised CurriculumBlueprint onto an existing track while strictly preserving
 * completed/mastered lessons, historical IDs, attempts, and completed blocks (CP-06 / Section 8.6).
 */
export function applyBlueprintRevisionPreservingHistory(opts: {
  store: Store;
  trackId: string;
  nextBlueprint: CurriculumBlueprint;
  day: string;
}): {
  store: Store;
  preservedMasteredIds: string[];
  addedLessonIds: string[];
  removedLessonIds: string[];
} {
  const existingTrack = (opts.store.goalPlans || []).find(
    (p) => p.id === opts.trackId,
  );
  if (!existingTrack) {
    throw new Error(`未找到轨道 ${opts.trackId}`);
  }

  const { plan: projected } = blueprintToGoalPlan({
    blueprint: opts.nextBlueprint,
    goal: existingTrack.goal,
    day: opts.day,
    existingBlocks: opts.store.blocks,
    scheduleSettings: opts.store.scheduleSettings,
    days: existingTrack.days,
    dailyMinutes: existingTrack.daily,
    startMin: existingTrack.start,
    trackId: opts.trackId,
  });

  // Always retain already mastered/completed lessons even if the new blueprint omitted them
  const nextIds = new Set(projected.units.map((u) => u.id));
  const preservedMasteredUnits = existingTrack.units.filter(
    (u) => (opts.store.mastery[u.id] ?? 0) >= 80 && !nextIds.has(u.id),
  );
  const mergedUnits = [...preservedMasteredUnits, ...projected.units];

  const res = reconcileTrackUnitsAndSchedule(opts.store, {
    trackId: opts.trackId,
    day: opts.day,
    depth: opts.nextBlueprint.depth,
    nextUnits: mergedUnits,
  });

  return {
    store: res.store,
    preservedMasteredIds: res.preservedMasteredIds,
    addedLessonIds: res.addedLessonIds,
    removedLessonIds: res.removedLessonIds,
  };
}
