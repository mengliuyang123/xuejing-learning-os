import crypto from "node:crypto";
import type { LanguageModel } from "ai";
import { z } from "zod";
import {
  type AgentTaskDefinition,
  type AgentTaskIdentity,
  AgentToolRegistry,
  type RuntimeModelExecutor,
  executeAgentTask,
} from "./agent-runtime";
import {
  DEFAULT_LEARNOS_CAPABILITIES,
  type ResolvedTeachingActivity,
  type RuntimeCapability,
  listSupportedActivityTypesForCapabilities,
  resolveAndValidateTeachingActivity,
} from "./activity-registry";
import {
  listTeachingDecisionsForLessonFromDb,
  saveTeachingActivityToDb,
  saveTeachingDecisionToDb,
} from "./db";
import type { Lesson, LessonContract, MasteryOrigin } from "./learning";
import {
  type ExerciseRecord,
  registerExercise,
} from "./learning-engine";
import {
  type ResearchPackage,
  runResearchPlanner,
} from "./research-planner";
import { getTeachingSkillRegistry } from "./skill-loader";
import { runVisualExplainer } from "./visual-explainer";
import type { WebResearchProvider } from "./web-research";

export type TeachingAction =
  | "explain"
  | "retrieve_knowledge"
  | "show_example"
  | "visualize"
  | "guided_practice"
  | "independent_practice"
  | "assess"
  | "remediate"
  | "review"
  | "advance";

export interface TeachingContext {
  goalId: string;
  trackId?: string;
  lessonId: string;
  lessonTitle: string;
  learningSessionId: string;
  currentOutcome: string;
  knowledgeContext: {
    concept: string;
    objective?: string;
    completionCriteria?: string;
    hasPreparedContent?: boolean;
    missingPrerequisites?: string[];
    /** Downstream Loop #3 (教学消费图谱): Versioned node contract & downstream bridge */
    contract?: LessonContract;
    nextLessonTitle?: string;
    trackPosition?: string;
  };
  learnerEvidence: {
    recentAttempts: Array<{
      attemptId: string;
      correct: boolean;
      score: number;
      errorType?: string;
      feedback?: string;
    }>;
    misconceptions: string[];
    masteryEstimate?: number;
    masteryOrigin?: MasteryOrigin;
    consecutiveFailures?: number;
    consecutivePasses?: number;
  };
  prerequisitesMet: boolean;
  userRequest?: string;
  userSelfReportedMastery?: boolean;
  availableCapabilities: readonly RuntimeCapability[];
  availableMinutes?: number;
}

export interface TeachingDecision {
  decisionId: string;
  action: TeachingAction;
  conceptId: string;
  objective: string;
  rationale: string;
  executionPath: "fast_structured" | "on_demand_react" | "deterministic_policy";
  requestedActivityType?: string;
  activitySpec?: Record<string, unknown>;
  resolvedActivity?: ResolvedTeachingActivity;
  registeredExercise?: ExerciseRecord | null;
  supplementalResearchPackageId?: string;
  /** Explicit flag ensuring self-reported familiarity NEVER mutates verified mastery directly (TP-12). */
  verifiedMasteryMutated: false;
}

const teachingDecisionSchema = z.object({
  action: z.enum([
    "explain",
    "retrieve_knowledge",
    "show_example",
    "visualize",
    "guided_practice",
    "independent_practice",
    "assess",
    "remediate",
    "review",
    "advance",
  ]),
  conceptId: z.string().min(1),
  objective: z.string().min(4),
  rationale: z.string().min(4),
  requestedActivityType: z.string().optional(),
  activitySpec: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Decides whether a teaching turn genuinely needs Bounded ReAct (external retrieval / multi-step tool calls)
 * instead of the fast, low-cost Structured Decision path (Section 9.3).
 */
export function shouldEscalateTeachingToReAct(ctx: TeachingContext): boolean {
  const req = (ctx.userRequest || "").trim();
  if (!ctx.knowledgeContext.hasPreparedContent && /补充|查一下|最新|文档|研究|为什么|原理深入/i.test(req)) {
    return true;
  }
  if (/超出本课|对比.*资料|检索|搜索|查阅权威/i.test(req)) {
    return true;
  }
  if (
    (ctx.learnerEvidence.consecutiveFailures ?? 0) >= 3 &&
    ctx.learnerEvidence.misconceptions.length >= 2
  ) {
    return true;
  }
  return false;
}

/**
 * Deterministic evidence-driven teaching fallback & hard guardrail policy.
 * Guarantees safe behavior offline, enforces prerequisite unlock gates (TP-11),
 * prevents self-reported mastery from mutating verified mastery (TP-12),
 * and adapts to failures, passes, diagrams, and quick review requests.
 */
function buildPolicyTeachingDecision(ctx: TeachingContext): {
  action: TeachingAction;
  conceptId: string;
  objective: string;
  rationale: string;
  requestedActivityType: string;
  activitySpec: Record<string, unknown>;
} {
  const req = (ctx.userRequest || "").trim();
  const mastery = ctx.learnerEvidence.masteryEstimate ?? 0;
  const latestAttempt = ctx.learnerEvidence.recentAttempts[0];
  const failures = ctx.learnerEvidence.consecutiveFailures ?? 0;
  const passes = ctx.learnerEvidence.consecutivePasses ?? 0;

  // TP-11: Unmet prerequisites MUST NOT advance or bypass unlock rules
  if (!ctx.prerequisitesMet) {
    const missing = ctx.knowledgeContext.missingPrerequisites || [];
    return {
      action: "explain",
      conceptId: ctx.lessonId,
      objective: `先补齐前置先修知识：${missing.join("、") || "基础先修"}`,
      rationale: "当前课程存在未达标的先修依赖，按先修解锁规则先完成前置知识理解与验证。",
      requestedActivityType: "explanation",
      activitySpec: {
        title: "先修知识衔接说明",
        prompt: `在正式学习「${ctx.lessonTitle}」前，先补齐前置概念。`,
        markdown: `本课需要先掌握：${missing.join("、") || "前置基础"}。请先完成前置课并通过验证，系统会自动解锁后续进度。`,
      },
    };
  }

  // TP-12: User self-reports mastery -> invite diagnostic assessment, NEVER mutate verified mastery directly!
  if (
    ctx.userSelfReportedMastery ||
    /我已经会了|我早就掌握了|直接跳过|标记已掌握/i.test(req)
  ) {
    return {
      action: "assess",
      conceptId: ctx.lessonId,
      objective: `通过 1 道快速诊断题验证「${ctx.lessonTitle}」真实掌握情况`,
      rationale:
        "自报熟悉不会直接写入正式掌握度（Verified Mastery）；先做 1 道针对性诊断题，通过后再由 Assessment Engine 更新掌握状态。",
      requestedActivityType: "short_answer",
      activitySpec: {
        title: "快速诊断验证",
        prompt: `你表示已熟悉「${ctx.lessonTitle}」。请用 2–3 句话说明它的核心机制与一个常见边界错误：`,
        rubricPoints: [
          "准确说出核心机制",
          "指出至少 1 个真实边界或易错点",
        ],
      },
    };
  }

  // TP-04: User requests visual diagram -> generate Mermaid diagram
  if (/画图|图示|流程图|mermaid|可视化|关系图/i.test(req)) {
    return {
      action: "visualize",
      conceptId: ctx.lessonId,
      objective: `用结构图示直观呈现「${ctx.lessonTitle}」的关键关系`,
      rationale: "学习者明确请求图示理解，生成 Mermaid 关系图辅助建立心智模型。",
      requestedActivityType: "diagram",
      activitySpec: {
        title: `${ctx.lessonTitle} · 关键流程与关系图`,
        prompt: "观察下方图示，核对每一步的输入、判断与输出。",
        mermaid: `flowchart LR\n  A["输入与前置条件"] --> B["${ctx.lessonTitle.replace(/"/g, "'").slice(0, 24)}"]\n  B --> C{"检验是否达标?"}\n  C -- "是" --> D["形成掌握与迁移"]\n  C -- "否" --> E["定位错因并补救"]\n  E --> B`,
      },
    };
  }

  // TP-05: Material insufficient / asks for supplemental research
  if (/资料不够|不够详细|补充研究|查一下最新/i.test(req)) {
    return {
      action: "retrieve_knowledge",
      conceptId: ctx.lessonId,
      objective: `为「${ctx.lessonTitle}」补充检索权威资料并补全缺失解释`,
      rationale: "当前教材对学习者提出的问题覆盖不足，请求 Research Planner 执行按需补充研究。",
      requestedActivityType: "explanation",
      activitySpec: {
        title: "补充研究请求已触发",
        prompt: `正在围绕「${ctx.lessonTitle}」补充检索针对性资料。`,
        markdown: `已触发补充研究任务，以补足「${req || ctx.currentOutcome}」的缺失解释。`,
      },
    };
  }

  // TP-06: Quick review or tight time budget (<= 15m)
  if (
    /快速复习|速复|回顾一下|复习/i.test(req) ||
    (typeof ctx.availableMinutes === "number" && ctx.availableMinutes <= 15)
  ) {
    return {
      action: "review",
      conceptId: ctx.lessonId,
      objective: `高密度主动回忆「${ctx.lessonTitle}」核心要点`,
      rationale: "学习者请求快速复习或时间预算紧凑，跳过冗长铺垫直接进行主动回忆卡检验。",
      requestedActivityType: "flashcard",
      activitySpec: {
        title: `${ctx.lessonTitle} · 快速回忆卡`,
        prompt: `不看教材，先在脑中回忆「${ctx.lessonTitle}」的核心定义与 1 个易错点。`,
        front: `「${ctx.lessonTitle}」解决什么核心问题？最容易混淆什么？`,
        back: `${ctx.knowledgeContext.concept}（完成标准：${ctx.knowledgeContext.completionCriteria || "掌握并能应用"}）`,
      },
    };
  }

  // TP-02: Real wrong attempt -> targeted remediation based on actual error evidence
  if (
    (latestAttempt && !latestAttempt.correct) ||
    failures >= 1
  ) {
    const errDetail =
      ctx.learnerEvidence.misconceptions[0] ||
      latestAttempt?.feedback ||
      latestAttempt?.errorType ||
      "关键概念边界尚不清晰";
    return {
      action: "remediate",
      conceptId: ctx.lessonId,
      objective: `针对真实错因（${errDetail.slice(0, 40)}）进行降难拆解与补救练习`,
      rationale: `基于最近真实评分记录（得分 ${latestAttempt?.score ?? 0}，错因：${errDetail}），优先针对薄弱点补救而非盲目推进。`,
      requestedActivityType: "guided_practice",
      activitySpec: {
        title: "针对错因的分步补救练习",
        prompt: `结合上次错因（${errDetail}），按下方提示分步重新推导「${ctx.lessonTitle}」：`,
        scaffolds: [
          "第 1 步：先写出本问题的前提条件与已知量",
          "第 2 步：对照易错点检查哪一步容易混淆",
          "第 3 步：写出修正后的完整结论或做法",
        ],
        rubricPoints: ["明确修正了上次的错误步骤", "给出清晰依据"],
      },
    };
  }

  // TP-03: Consecutive passes / high mastery -> escalate difficulty or advance
  if (passes >= 2 || mastery >= 85) {
    return {
      action: mastery >= 90 ? "advance" : "independent_practice",
      conceptId: ctx.lessonId,
      objective:
        mastery >= 90
          ? `已扎实掌握「${ctx.lessonTitle}」，推进至下一进阶节点`
          : `在真实复杂约束下提升「${ctx.lessonTitle}」迁移难度`,
      rationale: `连续答对 ${passes} 次且已验证掌握度达 ${mastery}%，提高任务难度检验真实迁移能力。`,
      requestedActivityType: "project",
      activitySpec: {
        title: "进阶迁移挑战",
        prompt: `在不看示例提示的情况下，把「${ctx.lessonTitle}」迁移到一个带边界约束的新场景并说明验证方式。`,
        deliverables: ["完整方案/实现", "至少 1 条边界异常应对说明"],
        checklist: ["不依赖模板直接完成", "能够自证结果正确"],
        rubricPoints: ["独立迁移应用正确", "处理了边界条件"],
      },
    };
  }

  // TP-01: Beginner confused / first touch -> foundational explanation
  if (
    /看不懂|不理解|太难|零基础|基础/i.test(req) ||
    (mastery === 0 && ctx.learnerEvidence.recentAttempts.length === 0)
  ) {
    return {
      action: "explain",
      conceptId: ctx.lessonId,
      objective: `为初学者建立「${ctx.lessonTitle}」的前置直觉与核心概念`,
      rationale: "学习者处于初学或卡壳阶段，先补充直观解释与生活化例证，降低认知断层。",
      requestedActivityType: "worked_example",
      activitySpec: {
        title: `${ctx.lessonTitle} · 零基础分步示例`,
        prompt: "先跟着下面 3 个由浅入深的步骤建立直觉，再尝试动手练习。",
        steps: [
          `明确问题：为什么需要「${ctx.lessonTitle}」`,
          `核心规律：${ctx.knowledgeContext.concept}`,
          "最小验证：用一个最简单的输入观察预期输出",
        ],
      },
    };
  }

  // Default: guided practice moving toward outcome verification
  return {
    action: "guided_practice",
    conceptId: ctx.lessonId,
    objective: `通过引导实践巩固「${ctx.lessonTitle}」并准备正式检验`,
    rationale: "已有基础理解，进入引导实践以将知识转化为可执行技能。",
    requestedActivityType: "short_answer",
    activitySpec: {
      title: "引导实践检验",
      prompt: `请结合「${ctx.lessonTitle}」的核心概念，说明你在实际场景中会如何应用它：`,
      rubricPoints: ["准确运用核心概念", "包含具体执行步骤"],
    },
  };
}

/**
 * Registers an assessable TeachingActivity into the canonical Exercise Engine
 * so Learn keeps a single authoritative exercise_id, attempt lifecycle, and deterministic grader (TP-07).
 */
function registerCanonicalExerciseFromActivity(opts: {
  lessonId: string;
  lessonTitle: string;
  learningSessionId: string;
  activity: ResolvedTeachingActivity;
}): ExerciseRecord | null {
  const mode = opts.activity.canonicalExerciseMode;
  if (!mode || opts.activity.degraded) return null;
  const spec = opts.activity.spec;
  const prompt = String(spec.prompt || "").trim();
  if (!prompt) return null;

  try {
    if (mode === "choice") {
      const ex = registerExercise({
        lessonId: opts.lessonId,
        learningSessionId: opts.learningSessionId,
        mode: "choice",
        prompt,
        source: "tutor_candidate",
        shuffleChoices: true,
        spec: {
          lessonTitle: opts.lessonTitle,
          choices: spec.choices as string[],
          correctChoiceIndex: Number(spec.correctChoiceIndex),
          explanation: spec.explanation ? String(spec.explanation) : undefined,
        },
      }).exercise;
      opts.activity.spec = {
        ...spec,
        choices: ex.spec.choices,
        correctChoiceIndex: ex.spec.correctChoiceIndex,
        explanation: ex.spec.explanation ?? spec.explanation,
      };
      return ex;
    }
    if (mode === "multi_choice") {
      const ex = registerExercise({
        lessonId: opts.lessonId,
        learningSessionId: opts.learningSessionId,
        mode: "multi_choice",
        prompt,
        source: "tutor_candidate",
        shuffleChoices: true,
        spec: {
          lessonTitle: opts.lessonTitle,
          choices: spec.choices as string[],
          correctChoiceIndices: spec.correctChoiceIndices as number[],
          explanation: spec.explanation ? String(spec.explanation) : undefined,
        },
      }).exercise;
      opts.activity.spec = {
        ...spec,
        choices: ex.spec.choices,
        correctChoiceIndices: ex.spec.correctChoiceIndices,
      };
      return ex;
    }
    if (mode === "order_steps") {
      const ex = registerExercise({
        lessonId: opts.lessonId,
        learningSessionId: opts.learningSessionId,
        mode: "order_steps",
        prompt,
        source: "tutor_candidate",
        shuffleChoices: true,
        spec: {
          lessonTitle: opts.lessonTitle,
          steps: spec.steps as string[],
          correctStepsOrder: spec.correctStepsOrder as string[],
          explanation: spec.explanation ? String(spec.explanation) : undefined,
        },
      }).exercise;
      opts.activity.spec = {
        ...spec,
        steps: ex.spec.steps,
      };
      return ex;
    }
    if (mode === "fill_blank") {
      const blanks = Array.isArray(spec.blanks)
        ? (spec.blanks as Array<{ id: string; label: string; answer: string; placeholder?: string }>)
        : spec.expectedExpression
          ? [
              {
                id: "math-ans",
                label: "结果表达式",
                answer: String(spec.expectedExpression),
              },
            ]
          : [];
      if (!blanks.length) return null;
      return registerExercise({
        lessonId: opts.lessonId,
        learningSessionId: opts.learningSessionId,
        mode: "fill_blank",
        prompt,
        source: "tutor_candidate",
        spec: {
          lessonTitle: opts.lessonTitle,
          blanks,
          explanation: spec.explanation ? String(spec.explanation) : undefined,
        },
      }).exercise;
    }
    if (mode === "code") {
      return registerExercise({
        lessonId: opts.lessonId,
        learningSessionId: opts.learningSessionId,
        mode: "code",
        prompt,
        source: "tutor_candidate",
        spec: {
          lessonTitle: opts.lessonTitle,
          language: String(spec.language || "python"),
          starterCode: spec.starterCode ? String(spec.starterCode) : undefined,
          expectedOutput: spec.expectedOutput
            ? String(spec.expectedOutput)
            : undefined,
          rubricPoints: (spec.rubricPoints as string[]) || ["逻辑正确"],
        },
      }).exercise;
    }
    if (mode === "short_answer") {
      return registerExercise({
        lessonId: opts.lessonId,
        learningSessionId: opts.learningSessionId,
        mode: "short_answer",
        prompt,
        source: "tutor_candidate",
        spec: {
          lessonTitle: opts.lessonTitle,
          rubricPoints:
            Array.isArray(spec.rubricPoints) && spec.rubricPoints.length > 0
              ? (spec.rubricPoints as string[])
              : ["核心要点准确", "结合实例说明"],
        },
      }).exercise;
    }
  } catch {
    // Non-assessable or missing authoritative answer key -> stay as non-graded teaching activity
  }
  return null;
}

/**
 * Hybrid Teaching Planner (Section 9):
 * - Fast Structured Decision by default
 * - On-demand Bounded ReAct ONLY when external retrieval or complex diagnosis is needed
 * - Strictly enforces prerequisite gates (TP-11), verified-mastery separation (TP-12),
 *   activity validation/degradation (TP-09), and canonical Exercise registration (TP-07).
 */
export async function runTeachingPlanner(opts: {
  context: TeachingContext;
  lesson?: Lesson;
  identity?: Partial<AgentTaskIdentity>;
  model?: LanguageModel | string | null;
  modelLabel?: string;
  providerName?: string;
  webProvider?: WebResearchProvider;
  abortSignal?: AbortSignal;
  customExecutor?: RuntimeModelExecutor;
  persistToDb?: boolean;
}): Promise<TeachingDecision> {
  const ctx = opts.context;
  const decisionId = `td-${crypto.randomUUID().slice(0, 10)}`;
  const capabilities =
    ctx.availableCapabilities.length > 0
      ? ctx.availableCapabilities
      : DEFAULT_LEARNOS_CAPABILITIES;
  const supportedActivities = listSupportedActivityTypesForCapabilities(capabilities);
  const escalateToReAct = shouldEscalateTeachingToReAct(ctx);

  let rawDecision: {
    action: TeachingAction;
    conceptId: string;
    objective: string;
    rationale: string;
    requestedActivityType?: string;
    activitySpec?: Record<string, unknown>;
  };
  let executionPath: TeachingDecision["executionPath"] = "deterministic_policy";
  let supplementalResearchPackageId: string | undefined;

  // Hard guardrails run first for unmet prerequisites or self-reported mastery
  if (
    !ctx.prerequisitesMet ||
    ctx.userSelfReportedMastery ||
    /我已经会了|我早就掌握了|直接跳过|标记已掌握/i.test(ctx.userRequest || "")
  ) {
    rawDecision = buildPolicyTeachingDecision(ctx);
  } else if (opts.model || opts.customExecutor) {
    const registry = new AgentToolRegistry();
    registry.register({
      name: "request_supplemental_research",
      category: "research",
      description: "当当前教材缺少关键解释或用户问到未覆盖细节时，按需触发小预算补充研究。",
      inputSchema: z.object({
        topic: z.string().min(2),
        question: z.string().min(2),
      }),
      execute: async (args, toolCtx) => {
        const res = await runResearchPlanner({
          request: {
            goal: args.question,
            topic: args.topic,
            researchPurpose: "clarification",
            budget: { maxSteps: 3, maxSearches: 2, maxFetches: 1, maxTokens: 6000 },
          },
          webProvider: opts.webProvider,
          abortSignal: toolCtx.abortSignal,
        });
        supplementalResearchPackageId = res.package.id;
        return {
          packageId: res.package.id,
          status: res.package.status,
          concepts: res.package.concepts.slice(0, 3),
          unresolvedQuestions: res.package.unresolvedQuestions,
        };
      },
    });

    const recentHistory = (() => {
      try {
        return listTeachingDecisionsForLessonFromDb(ctx.lessonId, 4).map((d) => ({
          action: d.action,
          objective: d.objective,
        }));
      } catch {
        return [];
      }
    })();

    const skillRegistry = getTeachingSkillRegistry();
    const onDemandSkills = skillRegistry.resolveOnDemandSkills({
      userRequest: ctx.userRequest,
      consecutiveFailures: ctx.learnerEvidence.consecutiveFailures,
    });
    const onDemandSkillsPrompt =
      skillRegistry.formatLoadedSkillsPrompt(onDemandSkills);
    const compactSkillCatalog = skillRegistry.getCompactCatalogForSystemPrompt();

    const taskDef: AgentTaskDefinition<
      TeachingContext,
      z.infer<typeof teachingDecisionSchema>
    > = {
      name: "teaching_planner",
      kind: "teaching",
      mode: escalateToReAct ? "hybrid" : "structured",
      maxSteps: escalateToReAct ? 4 : 1,
      timeoutMs: 25000,
      tokenBudget: 8000,
      allowedTools: escalateToReAct ? ["request_supplemental_research"] : [],
      allowedCategories: escalateToReAct ? ["read", "research"] : [],
      buildContext: async (input) => ({
        system: [
          "你是「学径」的 Teaching Planner（混合自适应教学决策器）。",
          "必须严格基于真实学习证据决定下一步教学动作，绝不凭空臆测掌握度，也绝不直接修改正式掌握度。",
          "【遵循知识图谱边界契约（教学消费图谱）】：必须围绕 knowledgeContext.contract.inScope 与 progressionStep 推进当前教学活动；严禁越界抢讲 contract.deferredTo 中属于后续课程的核心内容；当学习者已达标准备 advance 时，可自然预告 nextLessonTitle 的衔接。",
          `当前运行环境支持的活动类型：${supportedActivities.join(", ")}。`,
          compactSkillCatalog,
          onDemandSkillsPrompt,
          "只输出合法 JSON：",
          `{
  "action": "explain | retrieve_knowledge | show_example | visualize | guided_practice | independent_practice | assess | remediate | review | advance",
  "conceptId": "${input.lessonId}",
  "objective": "本步教学明确目标",
  "rationale": "基于真实学习证据的决策依据",
  "requestedActivityType": "从支持类型中择一",
  "activitySpec": { "prompt": "活动指引与具体内容..." }
}`,
        ]
          .filter(Boolean)
          .join("\n"),
        prompt: JSON.stringify({
          lessonId: input.lessonId,
          lessonTitle: input.lessonTitle,
          currentOutcome: input.currentOutcome,
          knowledgeContext: input.knowledgeContext,
          learnerEvidence: input.learnerEvidence,
          userRequest: input.userRequest,
          availableMinutes: input.availableMinutes,
          recentTeachingDecisions: recentHistory,
        }),
      }),
      validateOutput: (raw) => teachingDecisionSchema.parse(raw),
    };

    try {
      const execRes = await executeAgentTask({
        definition: taskDef,
        input: ctx,
        identity: {
          ...opts.identity,
          kind: "teaching",
          goalId: ctx.goalId,
          trackId: ctx.trackId,
          lessonId: ctx.lessonId,
          learningSessionId: ctx.learningSessionId,
        },
        model: opts.model,
        modelLabel: opts.modelLabel,
        providerName: opts.providerName,
        registry,
        abortSignal: opts.abortSignal,
        customExecutor: opts.customExecutor,
        maxRepairAttempts: 1,
      });
      rawDecision = execRes.output;
      executionPath = escalateToReAct ? "on_demand_react" : "fast_structured";
    } catch {
      rawDecision = buildPolicyTeachingDecision(ctx);
      executionPath = "deterministic_policy";
    }
  } else {
    rawDecision = buildPolicyTeachingDecision(ctx);
  }

  // Enforce TP-11 post-LLM guardrail too: never allow advance when prerequisites are unmet
  if (!ctx.prerequisitesMet && rawDecision.action === "advance") {
    rawDecision = buildPolicyTeachingDecision(ctx);
  }

  // If action is retrieve_knowledge and supplemental research hasn't run yet, run bounded clarification research
  if (rawDecision.action === "retrieve_knowledge" && !supplementalResearchPackageId) {
    try {
      const supp: { package: ResearchPackage } = await runResearchPlanner({
        request: {
          goal: ctx.userRequest || ctx.currentOutcome,
          topic: ctx.lessonTitle,
          researchPurpose: "clarification",
          budget: { maxSteps: 2, maxSearches: 1, maxFetches: 1, maxTokens: 5000 },
        },
        webProvider: opts.webProvider,
        abortSignal: opts.abortSignal,
      });
      supplementalResearchPackageId = supp.package.id;
    } catch {}
  }

  // Validate & resolve activity via extensible Activity Registry (safe degradation on unsupported types/capabilities!)
  const resolvedActivity = rawDecision.requestedActivityType
    ? resolveAndValidateTeachingActivity({
        requestedType: rawDecision.requestedActivityType,
        rawSpec: rawDecision.activitySpec ?? { prompt: rawDecision.objective },
        availableCapabilities: capabilities,
      })
    : undefined;

  // Enrich & cache visual activities through Visual Explainer engine (strict SVG sanitization + contractVersion cache)
  if (
    resolvedActivity &&
    !resolvedActivity.degraded &&
    (resolvedActivity.effectiveType === "diagram" ||
      resolvedActivity.effectiveType === "visual_explanation")
  ) {
    try {
      const sp = resolvedActivity.spec;
      const veRes = await runVisualExplainer({
        lessonId: ctx.lessonId,
        lessonTitle: ctx.lessonTitle,
        conceptId: rawDecision.conceptId || ctx.lessonId,
        conceptSummary: ctx.knowledgeContext.concept,
        title: sp.title ? String(sp.title) : undefined,
        summary: sp.summary ? String(sp.summary) : sp.prompt ? String(sp.prompt) : undefined,
        caption: sp.caption ? String(sp.caption) : undefined,
        visualType: sp.visualType as "mermaid" | "svg" | "interactive_widget" | undefined,
        mermaid: sp.mermaid ? String(sp.mermaid) : undefined,
        svg: sp.svg ? String(sp.svg) : undefined,
        widget: sp.widget as
          | { widgetType: "timeline" | "parameter_explorer"; config: Record<string, unknown> }
          | undefined,
        steps: Array.isArray(sp.steps)
          ? (sp.steps as Array<{
              stepNumber: number;
              title: string;
              explanation: string;
              highlightIds?: string[];
              mermaid?: string;
            }>)
          : undefined,
        contract: ctx.knowledgeContext.contract ?? null,
        contractVersion: ctx.knowledgeContext.contract?.blueprintVersion ?? 1,
        learningSessionId: ctx.learningSessionId,
        decisionId,
        persistActivity: false,
        availableCapabilities: capabilities,
      });
      resolvedActivity.spec = {
        ...resolvedActivity.spec,
        ...veRes.card,
      };
    } catch {}
  }

  // Register canonical Exercise in Exercise Engine when activity is assessable (TP-07)
  let registeredExercise: ExerciseRecord | null = null;
  if (opts.persistToDb !== false && resolvedActivity) {
    registeredExercise = registerCanonicalExerciseFromActivity({
      lessonId: ctx.lessonId,
      lessonTitle: ctx.lessonTitle,
      learningSessionId: ctx.learningSessionId,
      activity: resolvedActivity,
    });
  }

  const finalDecision: TeachingDecision = {
    decisionId,
    action: rawDecision.action,
    conceptId: rawDecision.conceptId || ctx.lessonId,
    objective: rawDecision.objective,
    rationale: rawDecision.rationale,
    executionPath,
    requestedActivityType: rawDecision.requestedActivityType,
    activitySpec: rawDecision.activitySpec,
    resolvedActivity,
    registeredExercise,
    supplementalResearchPackageId,
    verifiedMasteryMutated: false,
  };

  if (opts.persistToDb !== false) {
    try {
      saveTeachingDecisionToDb({
        decisionId,
        workflowId: opts.identity?.workflowId,
        taskId: opts.identity?.taskId,
        runId: opts.identity?.runId,
        goalId: ctx.goalId,
        trackId: ctx.trackId,
        lessonId: ctx.lessonId,
        learningSessionId: ctx.learningSessionId,
        action: finalDecision.action,
        conceptId: finalDecision.conceptId,
        objective: finalDecision.objective,
        rationale: finalDecision.rationale,
        decision: finalDecision,
      });
      if (resolvedActivity) {
        saveTeachingActivityToDb({
          activityId: `act-${crypto.randomUUID().slice(0, 10)}`,
          lessonId: ctx.lessonId,
          learningSessionId: ctx.learningSessionId,
          decisionId,
          activityType: resolvedActivity.effectiveType,
          schemaVersion: resolvedActivity.schemaVersion,
          gradingMode: resolvedActivity.gradingMode,
          status: "active",
          spec: resolvedActivity.spec,
          linkedExerciseId: registeredExercise?.exercise_id ?? null,
        });
      }
    } catch {}
  }

  return finalDecision;
}
