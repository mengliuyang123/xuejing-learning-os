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
  getLatestLessonContentVersionFromDb,
  saveLessonContentVersionToDb,
} from "./db";
import type { LessonGraphNeighborhood } from "./curriculum-planner";
import type { Lesson, LessonContract } from "./learning";
import type { ResearchPackage } from "./research-planner";
import type { LearningCapabilityProfile } from "./web-research";

export type LessonDepthMode = "beginner" | "standard" | "concise";

export type TeachingBlockType =
  | "motivation"
  | "prerequisite_bridge"
  | "concept_explanation"
  | "analogy"
  | "diagram"
  | "worked_example"
  | "derivation"
  | "timeline"
  | "perspective_comparison"
  | "parameter_relation"
  | "misconceptions"
  | "guided_task"
  | "check_in";

export interface TeachingBlock {
  id: string;
  type: TeachingBlockType;
  title: string;
  content: unknown;
  objectiveId?: string;
}

export interface FourLayerQualityCheck {
  layer: "structure" | "knowledge" | "pedagogy" | "technical";
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
  failingBlockIds?: string[];
}

export interface FourLayerQualityReport {
  passed: boolean;
  status: "ready" | "limited" | "failed";
  layerScores: {
    structure: number;
    knowledge: number;
    pedagogy: number;
    technical: number;
  };
  overallScore: number;
  checks: FourLayerQualityCheck[];
  warnings: string[];
  failingBlockIds: string[];
}

export interface LessonContent {
  contentId: string;
  lessonId: string;
  trackId: string | null;
  version: number;
  depth: LessonDepthMode;
  learningOutcomes: string[];
  blocks: TeachingBlock[];
  estimatedMinutes: number;
  researchPackageId?: string | null;
  blueprintId?: string | null;
  blueprintVersion?: number;
  contract?: LessonContract;
  knowledgeGaps: string[];
  qualityReport: FourLayerQualityReport;
  status: "ready" | "limited" | "failed";
}

export interface ScopeOverreachCheckResult {
  ok: boolean;
  overreachingBlockIds: string[];
  violations: Array<{
    blockId: string;
    blockTitle: string;
    deferredTopic: string;
    targetLessonTitle: string;
  }>;
  summary: string;
}

function extractDistinctiveDeferredAnchors(
  contract: LessonContract | null | undefined,
  currentLessonTitle?: string,
): Array<{ anchor: string; targetLessonTitle: string }> {
  if (!contract) return [];
  const inScopeText = [
    currentLessonTitle || "",
    ...(contract.inScope || []),
    ...(contract.assumedPrior || []),
  ]
    .join(" ")
    .toLowerCase();

  const anchors: Array<{ anchor: string; targetLessonTitle: string }> = [];
  const seen = new Set<string>();

  for (const d of contract.deferredTo || []) {
    const rawTitle = (d.targetLessonTitle || "").trim();
    if (!rawTitle) continue;
    // Split on punctuation/colon to get distinctive sub-phrases (length >= 3)
    const parts = [
      rawTitle,
      ...rawTitle
        .split(/[：:·—\-/、，,（）()\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 3),
    ];
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (seen.has(lower)) continue;
      // Ignore generic pedagogical words or terms already in current lesson's inScope
      if (
        /^(基础|入门|实战|进阶|核心|原理|深入|概述|实践|练习|综合|从零|构建|理解)$/.test(
          part,
        )
      ) {
        continue;
      }
      if (inScopeText.includes(lower)) continue;
      seen.add(lower);
      anchors.push({ anchor: part, targetLessonTitle: rawTitle });
    }
  }
  return anchors;
}

/**
 * Deterministic + Semantic Scope Boundary Inspector (Downstream Loop #2: 质检消费图谱).
 * Checks whether any TeachingBlock in the current lesson jumps ahead and teaches
 * the core mechanism or full implementation reserved for a downstream node in `contract.deferredTo`.
 * Note: Brief 1-sentence forward teasers ("下一课/后续课程将介绍...") are explicitly permitted.
 */
export function detectScopeOverreachInBlocks(opts: {
  blocks: TeachingBlock[];
  contract?: LessonContract | null;
  currentLessonTitle?: string;
}): ScopeOverreachCheckResult {
  const anchors = extractDistinctiveDeferredAnchors(
    opts.contract,
    opts.currentLessonTitle,
  );
  if (anchors.length === 0) {
    return {
      ok: true,
      overreachingBlockIds: [],
      violations: [],
      summary: "符合本节知识图谱边界契约",
    };
  }

  const stringifyContent = (c: unknown): string => {
    if (typeof c === "string") return c;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      return Object.values(c as Record<string, unknown>)
        .map((v) => (typeof v === "string" ? v : JSON.stringify(v ?? "")))
        .join("\n");
    }
    return JSON.stringify(c ?? "");
  };

  const violations: ScopeOverreachCheckResult["violations"] = [];
  const overreachingIds = new Set<string>();

  for (const blk of opts.blocks || []) {
    const titleLower = (blk.title || "").toLowerCase();
    const bodyStr = stringifyContent(blk.content);
    // Strip explicit 1-sentence forward teaser lines before checking for substantive overreach
    const nonTeaserBody = bodyStr
      .split(/\r?\n|。/)
      .filter(
        (line) =>
          !/(下一课|下一节|后续课程|后续章节|后继课程|后继节点|留到|留待|留至|将在《|预告|本节暂不展开)/.test(
            line,
          ),
      )
      .join("。")
      .toLowerCase();

    for (const { anchor, targetLessonTitle } of anchors) {
      const anchorLower = anchor.toLowerCase();
      const titleHit =
        titleLower.includes(anchorLower) &&
        !/(预告|衔接|边界|留待)/.test(titleLower);

      // Count occurrences in non-teaser body; >= 2 occurrences or presence inside code/steps indicates substantive teaching
      let bodyHits = 0;
      let pos = 0;
      while ((pos = nonTeaserBody.indexOf(anchorLower, pos)) !== -1) {
        bodyHits++;
        pos += anchorLower.length;
      }
      const substantiveBodyOverreach =
        bodyHits >= 2 ||
        (bodyHits >= 1 &&
          nonTeaserBody.length >= 160 &&
          (blk.type === "worked_example" ||
            blk.type === "concept_explanation" ||
            blk.type === "derivation"));

      if (titleHit || substantiveBodyOverreach) {
        overreachingIds.add(blk.id);
        violations.push({
          blockId: blk.id,
          blockTitle: blk.title,
          deferredTopic: anchor,
          targetLessonTitle,
        });
        break;
      }
    }
  }

  if (violations.length === 0) {
    return {
      ok: true,
      overreachingBlockIds: [],
      violations: [],
      summary: "符合本节知识图谱边界契约（未抢讲后继节点内容）",
    };
  }

  const summary = violations
    .map(
      (v) =>
        `教学块「${v.blockTitle}」(${v.blockId}) 越界抢讲了后继节点《${v.targetLessonTitle}》的核心内容「${v.deferredTopic}」`,
    )
    .join("；");

  return {
    ok: false,
    overreachingBlockIds: [...overreachingIds],
    violations,
    summary,
  };
}

/**
 * Targeted Scope Pruning / Localized Repair:
 * Rewrites or trims overreaching blocks into clean forward-bridge teasers while keeping all
 * in-scope blocks intact, ensuring persisted LessonContent never spoils downstream chapters.
 */
export function pruneScopeOverreachInBlocks(opts: {
  blocks: TeachingBlock[];
  contract?: LessonContract | null;
  currentLessonTitle?: string;
}): { blocks: TeachingBlock[]; prunedBlockIds: string[] } {
  const check = detectScopeOverreachInBlocks(opts);
  if (check.ok) {
    return { blocks: opts.blocks, prunedBlockIds: [] };
  }

  const violationByBlock = new Map(
    check.violations.map((v) => [v.blockId, v]),
  );
  const prunedBlockIds: string[] = [];

  const nextBlocks = opts.blocks.map((blk) => {
    const v = violationByBlock.get(blk.id);
    if (!v) return blk;
    prunedBlockIds.push(blk.id);

    const progression =
      opts.contract?.progressionStep ||
      `本节仅聚焦「${opts.currentLessonTitle || "当前节点"}」的核心范围`;
    const inScopeFocus =
      opts.contract?.inScope?.[0] ||
      opts.currentLessonTitle ||
      "本节核心概念";

    if (blk.type === "worked_example") {
      return {
        ...blk,
        title: `${opts.currentLessonTitle || "本节"} · 最小闭环示例`,
        content: {
          explanation: `聚焦本节核心范围（${inScopeFocus}）完成最小闭环验证。注：关于「${v.deferredTopic}」的完整实现已按图谱契约留至后继课程《${v.targetLessonTitle}》。`,
          code: `# 本节最小闭环验证：${opts.currentLessonTitle || "当前概念"}\n# （后继节点《${v.targetLessonTitle}》将在此基础上继续演进）`,
        },
      };
    }

    return {
      ...blk,
      title: `本节边界与《${v.targetLessonTitle}》衔接预告`,
      content: `${progression}。为了循序渐进，本节专注掌握「${inScopeFocus}」；关于「${v.deferredTopic}」的深入机制与完整实践将在后继节点《${v.targetLessonTitle}》中专门展开。`,
    };
  });

  return { blocks: nextBlocks, prunedBlockIds };
}

const lessonContentLlmSchema = z.object({
  learningOutcomes: z.array(z.string().min(3)).min(1),
  blocks: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.enum([
          "motivation",
          "prerequisite_bridge",
          "concept_explanation",
          "analogy",
          "diagram",
          "worked_example",
          "derivation",
          "timeline",
          "perspective_comparison",
          "parameter_relation",
          "misconceptions",
          "guided_task",
          "check_in",
        ]),
        title: z.string().min(2),
        content: z.unknown(),
        objectiveId: z.string().optional(),
      }),
    )
    .min(3),
  knowledgeGaps: z.array(z.string()),
});

/**
 * 4-Layer Lesson Quality Gate (Section 11.4):
 * Separates structural completeness from knowledge accuracy, pedagogical progression,
 * and domain-appropriate technical checks — NEVER equating raw character count with teaching quality!
 */
export function evaluateLessonContentFourLayers(opts: {
  content: Omit<LessonContent, "qualityReport" | "status">;
  profile: LearningCapabilityProfile;
  researchPackage?: ResearchPackage | null;
  contract?: LessonContract | null;
  currentLessonTitle?: string;
  isFallbackTemplate?: boolean;
}): FourLayerQualityReport {
  const { content, profile, researchPackage } = opts;
  const blocks = content.blocks || [];
  const blockTypes = new Set(blocks.map((b) => b.type));
  const checks: FourLayerQualityCheck[] = [];
  const failingBlockIds = new Set<string>();

  const stringifyContent = (c: unknown): string =>
    typeof c === "string" ? c : JSON.stringify(c ?? "");

  // ---- LAYER 1: Structure ----
  const uniqueIds = new Set(blocks.map((b) => b.id)).size === blocks.length;
  checks.push({
    layer: "structure",
    id: "unique_block_ids",
    label: "教学块 ID 唯一且非空",
    ok: uniqueIds && blocks.length >= 3,
  });
  const nonEmptyBlocks = blocks.filter(
    (b) => stringifyContent(b.content).trim().length >= 12,
  );
  const emptyBlocks = blocks.filter(
    (b) => stringifyContent(b.content).trim().length < 12,
  );
  for (const eb of emptyBlocks) failingBlockIds.add(eb.id);
  checks.push({
    layer: "structure",
    id: "non_empty_blocks",
    label: "所有教学块包含实质内容",
    ok: emptyBlocks.length === 0 && nonEmptyBlocks.length >= 3,
    failingBlockIds: emptyBlocks.map((b) => b.id),
  });

  // ---- LAYER 2: Knowledge ----
  const coversMotivationAndConcept =
    blockTypes.has("motivation") || blockTypes.has("concept_explanation");
  const researchUnresolved =
    researchPackage?.unresolvedQuestions?.length ?? 0;
  const gapsMarkedHonest =
    researchPackage?.status === "fallback"
      ? content.knowledgeGaps.length > 0
      : researchUnresolved === 0 || content.knowledgeGaps.length > 0;
  checks.push({
    layer: "knowledge",
    id: "outcomes_covered",
    label: "覆盖本课学习成果与核心概念",
    ok: content.learningOutcomes.length >= 1 && coversMotivationAndConcept,
  });
  checks.push({
    layer: "knowledge",
    id: "honest_knowledge_gaps",
    label: "研究缺口与未验证假设诚实标注",
    ok: gapsMarkedHonest,
    detail:
      gapsMarkedHonest
        ? `标注 ${content.knowledgeGaps.length} 项待核验`
        : "研究包存在缺口或处于降级模式，但课程未标注待核验信息",
  });

  // ---- LAYER 3: Pedagogy ----
  const hasExampleOrActiveModel =
    blockTypes.has("worked_example") ||
    blockTypes.has("derivation") ||
    blockTypes.has("parameter_relation") ||
    blockTypes.has("timeline") ||
    blockTypes.has("diagram");
  const hasPracticeOrCheck =
    blockTypes.has("guided_task") || blockTypes.has("check_in");
  const beginnerNeedsBridge =
    content.depth !== "beginner" ||
    blockTypes.has("prerequisite_bridge") ||
    blockTypes.has("analogy");
  checks.push({
    layer: "pedagogy",
    id: "causal_progression",
    label: "具备直观示例/推导/图解与实践闭环",
    ok: hasExampleOrActiveModel && hasPracticeOrCheck,
  });
  checks.push({
    layer: "pedagogy",
    id: "depth_adapted",
    label: "符合学习者深度（初学者含前置衔接）",
    ok: beginnerNeedsBridge,
  });

  // Downstream Loop #2: Knowledge Graph Scope Boundary Verification
  const effectiveContract = opts.contract ?? content.contract ?? null;
  const scopeOverreach = detectScopeOverreachInBlocks({
    blocks,
    contract: effectiveContract,
    currentLessonTitle: opts.currentLessonTitle,
  });
  for (const id of scopeOverreach.overreachingBlockIds) {
    failingBlockIds.add(id);
  }
  checks.push({
    layer: "pedagogy",
    id: "scope_boundary_compliance",
    label: "遵循知识图谱边界契约（不抢讲后继节点内容）",
    ok: scopeOverreach.ok,
    detail: scopeOverreach.summary,
    failingBlockIds: scopeOverreach.overreachingBlockIds,
  });

  // ---- LAYER 4: Technical / Domain Consistency ----
  const allText = blocks.map((b) => stringifyContent(b.content)).join("\n");
  let domainCheckOk = true;
  let domainDetail = "符合学科表达规范";
  if (profile.dimensions.includes("programming")) {
    const hasCodeOrApi = /```|def |function |const |import |SELECT |curl |http/i.test(
      allText,
    );
    domainCheckOk = hasCodeOrApi;
    domainDetail = hasCodeOrApi
      ? "包含可执行/可验证代码或接口示例"
      : "编程课缺少具体可运行代码或 API 片段";
  } else if (
    profile.dimensions.includes("mathematics") ||
    profile.dimensions.includes("statistics_probability")
  ) {
    const hasFormalStep =
      blockTypes.has("derivation") ||
      /[=≈≤≥∑∫]|P\(|条件概率|贝叶斯|反例|前提/i.test(allText);
    domainCheckOk = hasFormalStep;
    domainDetail = hasFormalStep
      ? "包含数学表达式/推导或前提反例"
      : "数学课缺少清晰推导或前提说明";
  } else if (profile.dimensions.includes("history_humanities")) {
    const hasHistoryStructure =
      blockTypes.has("timeline") ||
      blockTypes.has("perspective_comparison") ||
      /(史料|观点|解释|因果|背景|时期)/i.test(allText);
    domainCheckOk = hasHistoryStructure;
    domainDetail = hasHistoryStructure
      ? "区分史实脉络与多元观点解释"
      : "历史人文课缺少时间脉络或多元解释视角";
  } else if (profile.dimensions.includes("photography_visual_arts")) {
    const hasPhotoMechanics =
      blockTypes.has("parameter_relation") ||
      blockTypes.has("diagram") ||
      /(光圈|快门|ISO|曝光|景深|构图|人像)/i.test(allText);
    domainCheckOk = hasPhotoMechanics;
    domainDetail = hasPhotoMechanics
      ? "包含拍摄参数关系或视觉实践指导"
      : "摄影课缺少参数关系或实际拍摄指导";
  }
  checks.push({
    layer: "technical",
    id: "domain_technical_alignment",
    label: "领域专业性与技术一致性检查",
    ok: domainCheckOk,
    detail: domainDetail,
  });

  const scoreOf = (layer: FourLayerQualityCheck["layer"]) => {
    const items = checks.filter((c) => c.layer === layer);
    if (!items.length) return 100;
    return Math.round(
      (items.filter((c) => c.ok).length / items.length) * 100,
    );
  };

  const layerScores = {
    structure: scoreOf("structure"),
    knowledge: scoreOf("knowledge"),
    pedagogy: scoreOf("pedagogy"),
    technical: scoreOf("technical"),
  };
  const overallScore = Math.round(
    (layerScores.structure +
      layerScores.knowledge +
      layerScores.pedagogy +
      layerScores.technical) /
      4,
  );

  const warnings: string[] = [];
  for (const c of checks) {
    if (!c.ok) warnings.push(`[${c.layer}] ${c.label}${c.detail ? `：${c.detail}` : ""}`);
  }
  if (opts.isFallbackTemplate) {
    warnings.push("当前内容为离线结构化占位，非真实模型深度合成，标记为 limited。");
  }

  const passed =
    layerScores.structure === 100 &&
    layerScores.knowledge >= 50 &&
    layerScores.pedagogy >= 50 &&
    overallScore >= 75 &&
    !opts.isFallbackTemplate;

  const status: FourLayerQualityReport["status"] = passed
    ? "ready"
    : overallScore >= 50
      ? "limited"
      : "failed";

  return {
    passed,
    status,
    layerScores,
    overallScore,
    checks,
    warnings,
    failingBlockIds: [...failingBlockIds],
  };
}

/**
 * Builds an honest offline/limited TeachingBlock structure when no LLM model is supplied.
 * Explicitly marked as `limited` (NEVER disguised as high-quality `ready`!).
 */
function buildDomainAwareFallbackBlocks(opts: {
  lesson: Lesson;
  depth: LessonDepthMode;
  profile: LearningCapabilityProfile;
  researchPackage?: ResearchPackage | null;
}): { blocks: TeachingBlock[]; knowledgeGaps: string[] } {
  const { lesson, depth, profile, researchPackage } = opts;
  const blocks: TeachingBlock[] = [];
  const gaps = [...(researchPackage?.unresolvedQuestions || [])];
  if (gaps.length === 0) {
    gaps.push("当前为离线结构化占位内容（未调用 LLM 深度合成），关键示例与细节待联网完善。");
  }

  blocks.push({
    id: "blk-motivation",
    type: "motivation",
    title: "为什么要学这一课",
    content:
      lesson.objective ||
      `掌握「${lesson.title}」以解决真实学习目标中的核心问题。`,
  });

  if (depth === "beginner") {
    blocks.push({
      id: "blk-prereq",
      type: "prerequisite_bridge",
      title: "初学者前置衔接",
      content:
        researchPackage?.prerequisites.join("；") ||
        "先确认基础环境、核心术语与前置概念，避免跳步造成理解断层。",
    });
  }

  blocks.push({
    id: "blk-concept",
    type: "concept_explanation",
    title: "核心概念拆解",
    content:
      researchPackage?.concepts[0]?.explanation ||
      lesson.concept ||
      `理解「${lesson.title}」的构成与运行规律。`,
  });

  if (profile.dimensions.includes("programming")) {
    blocks.push({
      id: "blk-code-example",
      type: "worked_example",
      title: "最小可运行代码示例",
      content: {
        explanation: "先观察最小输入与输出，再加入错误处理保护边界。",
        code:
          lesson.example ||
          "```python\n# 最小验证示例\ndef run_demo(x):\n    if not x:\n        raise ValueError('输入不能为空')\n    return f'ok: {x}'\n```",
      },
    });
  } else if (
    profile.dimensions.includes("mathematics") ||
    profile.dimensions.includes("statistics_probability")
  ) {
    blocks.push({
      id: "blk-derivation",
      type: "derivation",
      title: "直观理解与分步推导",
      content: {
        formula: "P(A|B) = P(B|A) * P(A) / P(B)",
        steps: [
          "明确先验假设与事件条件（前提：P(B) > 0）",
          "结合具体数值例子验证条件更新过程",
          "检查常见反例（如忽略基础率导致的基率谬误）",
        ],
      },
    });
  } else if (profile.dimensions.includes("history_humanities")) {
    blocks.push({
      id: "blk-timeline",
      type: "timeline",
      title: "关键时间脉络与背景",
      content: [
        "背景阶段：社会经济与制度前提积累",
        "转折阶段：核心技术/事件触发结构变化",
        "影响阶段：长期社会结构与观念演变",
      ],
    });
    blocks.push({
      id: "blk-perspectives",
      type: "perspective_comparison",
      title: "史实与多元学术解释对照",
      content: [
        { view: "制度与经济视角", detail: "强调产权、市场规模与资本积累因素" },
        { view: "资源与全球贸易视角", detail: "强调能源禀赋、贸易网络与技术传播" },
      ],
    });
  } else if (profile.dimensions.includes("photography_visual_arts")) {
    blocks.push({
      id: "blk-photo-params",
      type: "parameter_relation",
      title: "曝光三要素与人像参数关系",
      content: {
        relation: "光圈（控制进光量与景深虚化）× 快门速度（控制动态凝固/防抖）× ISO（控制感光度与噪点）",
        portraitGuide: "拍摄自然光人像时优先定好大光圈虚化背景，确保快门不低于安全快门，最后用 ISO 补足曝光。",
      },
    });
  } else {
    blocks.push({
      id: "blk-example",
      type: "worked_example",
      title: "循序渐进示例",
      content:
        researchPackage?.workedExamples[0] ||
        `围绕「${lesson.title}」的真实场景分步演示从输入到结果的完整过程。`,
    });
  }

  blocks.push({
    id: "blk-misconceptions",
    type: "misconceptions",
    title: "常见误区与纠偏",
    content: researchPackage?.commonMisconceptions || [
      "避免只记表面术语而忽略适用边界与实际验证。",
    ],
  });

  blocks.push({
    id: "blk-task",
    type: "guided_task",
    title: "动手实践与检验",
    content:
      lesson.completionCriteria ||
      `请围绕「${lesson.title}」完成一次具体实操，并对照完成条件验证掌握结果。`,
  });

  return { blocks, knowledgeGaps: gaps };
}

/**
 * Upgraded Lesson Preparation Engine (Section 11):
 * Consumes ResearchPackage + Curriculum outcomes + Learner depth (`beginner` | `standard` | `concise`),
 * dynamically selects TeachingBlocks per discipline, runs the 4-Layer Quality Gate with
 * bounded localized repair, and persists versioned `LessonContent` in SQLite.
 */
export async function generateStructuredLessonContent(opts: {
  lesson: Lesson;
  trackId?: string | null;
  blueprintId?: string | null;
  blueprintVersion?: number;
  contract?: LessonContract | null;
  graphNeighborhood?: LessonGraphNeighborhood | null;
  depth?: LessonDepthMode;
  researchPackage?: ResearchPackage | null;
  profile: LearningCapabilityProfile;
  identity?: Partial<AgentTaskIdentity>;
  model?: LanguageModel | string | null;
  modelLabel?: string;
  providerName?: string;
  abortSignal?: AbortSignal;
  customExecutor?: RuntimeModelExecutor;
  forceRefresh?: boolean;
  maxRepairAttempts?: number;
}): Promise<LessonContent> {
  const depth: LessonDepthMode = opts.depth || "standard";
  const effectiveContract =
    opts.contract ??
    opts.graphNeighborhood?.contract ??
    opts.lesson.contract ??
    undefined;
  const effectiveBpVersion =
    opts.blueprintVersion ??
    effectiveContract?.blueprintVersion ??
    opts.graphNeighborhood?.blueprintVersion ??
    1;

  if (!opts.forceRefresh) {
    try {
      const existing = getLatestLessonContentVersionFromDb(opts.lesson.id, depth);
      if (existing && existing.status === "ready" && existing.content) {
        const cached = existing.content as LessonContent;
        const cachedBpVer =
          cached.blueprintVersion ?? cached.contract?.blueprintVersion ?? 1;
        // Cache invalidation on blueprint version upgrade
        if (cachedBpVer >= effectiveBpVersion) {
          return cached;
        }
      }
    } catch {}
  }

  const priorLatest = (() => {
    try {
      return getLatestLessonContentVersionFromDb(opts.lesson.id);
    } catch {
      return null;
    }
  })();
  const nextVersion = (priorLatest?.version ?? 0) + 1;

  // Offline / no-LLM path: explicitly marked `limited` (Section 11.5: never pretend templates are ready!)
  if (!opts.model && !opts.customExecutor) {
    const fb = buildDomainAwareFallbackBlocks({
      lesson: opts.lesson,
      depth,
      profile: opts.profile,
      researchPackage: opts.researchPackage,
    });
    const baseContent = {
      contentId: `lc-${crypto.randomUUID().slice(0, 10)}`,
      lessonId: opts.lesson.id,
      trackId: opts.trackId ?? null,
      version: nextVersion,
      depth,
      learningOutcomes: [
        opts.lesson.objective || `掌握「${opts.lesson.title}」`,
      ],
      blocks: fb.blocks,
      estimatedMinutes: opts.lesson.minutes,
      researchPackageId: opts.researchPackage?.id ?? null,
      blueprintId: opts.blueprintId ?? null,
      blueprintVersion: effectiveBpVersion,
      contract: effectiveContract,
      knowledgeGaps: fb.knowledgeGaps,
    };
    const qualityReport = evaluateLessonContentFourLayers({
      content: baseContent,
      profile: opts.profile,
      researchPackage: opts.researchPackage,
      contract: effectiveContract,
      currentLessonTitle: opts.lesson.title,
      isFallbackTemplate: true,
    });
    const finalContent: LessonContent = {
      ...baseContent,
      qualityReport,
      status: qualityReport.status,
    };
    try {
      saveLessonContentVersionToDb({
        contentId: finalContent.contentId,
        lessonId: finalContent.lessonId,
        trackId: finalContent.trackId,
        version: finalContent.version,
        depth: finalContent.depth,
        status: finalContent.status,
        researchPackageId: finalContent.researchPackageId,
        blueprintId: finalContent.blueprintId,
        content: finalContent,
        qualityReport,
      });
    } catch {}
    return finalContent;
  }

  const maxRepairs = Math.max(0, Math.min(2, opts.maxRepairAttempts ?? 1));
  let repairFeedback = "";
  let bestContent: LessonContent | null = null;

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const taskDef: AgentTaskDefinition<
      { repairFeedback: string },
      z.infer<typeof lessonContentLlmSchema>
    > = {
      name: "lesson_content_generator",
      kind: "lesson_preparation",
      mode: "structured",
      maxSteps: 1,
      timeoutMs: 40000,
      tokenBudget: 12000,
      allowedTools: [],
      buildContext: async ({ repairFeedback: fb }) => ({
        system: [
          "你是「学径」的结构化渐进式教材设计师（遵循知识图谱边界契约 Lesson Contract）。",
          `当前学科能力画像：${opts.profile.dimensions.join(", ")}；教学深度：${depth}（beginner=零基础补齐前置衔接与直觉；standard=完整原理与实践；concise=高密度精炼复盘）。`,
          "不要生成孤立的长篇大论或千篇一律的模板！请根据本课领域与图谱契约，生成适合逐步呈现与互动的模块化教学块（blocks，建议 4–6 个块，每块聚焦单一核心意图）：",
          "可选块类型：motivation, prerequisite_bridge, concept_explanation, analogy, diagram, worked_example, derivation, timeline, perspective_comparison, parameter_relation, misconceptions, guided_task, check_in。",
          "【严格遵守知识图谱边界契约（防剧透与防重复）】：",
          "- 对 assumedPrior（已学前置能力）只做简短衔接（prerequisite_bridge），严禁重新从零长篇讲一遍；",
          "- 教学内容与示例必须 100% 聚焦 inScope 与 progressionStep（只推进本节这一小步的最小闭环）；",
          "- 严禁抢讲 outOfScope / deferredTo 中属于后续课程的核心机制或提前写出后续章节的完整多阶段代码（最多只能用 1 句话做后续预告）！",
          "只输出合法 JSON：",
          `{
  "learningOutcomes": ["本课学习成果"],
  "blocks": [
    { "id": "b1", "type": "motivation", "title": "标题", "content": "结构化文本或对象" }
  ],
  "knowledgeGaps": ["缺乏权威证据或需核验的条目"]
}`,
        ].join("\n"),
        prompt: [
          `课程标题：${opts.lesson.title}`,
          `学习目标：${opts.lesson.objective || opts.lesson.concept}`,
          `完成条件：${opts.lesson.completionCriteria || "完成本课实践检验"}`,
          effectiveContract
            ? [
                `【知识图谱节点边界契约（v${effectiveBpVersion}）】`,
                `- 承接前置（不重复展开）：${effectiveContract.assumedPrior.join("；")}`,
                `- 本节核心范围（inScope）：${effectiveContract.inScope.join("；")}`,
                `- 本节推进步（progressionStep）：${effectiveContract.progressionStep}`,
                effectiveContract.deferredTo.length > 0
                  ? `- 留给后续节点（严禁在本节提前讲完或写出完整代码）：${effectiveContract.deferredTo
                      .map((d) => `《${d.targetLessonTitle}》(${d.topic})`)
                      .join("；")}`
                  : "- 本节为图谱收官节点",
              ].join("\n")
            : "",
          opts.researchPackage
            ? `研究知识包（${opts.researchPackage.status}）：${JSON.stringify({
                concepts: opts.researchPackage.concepts.slice(0, 5),
                examples: opts.researchPackage.workedExamples.slice(0, 4),
                misconceptions: opts.researchPackage.commonMisconceptions.slice(0, 4),
                unresolvedQuestions: opts.researchPackage.unresolvedQuestions,
              }).slice(0, 3200)}`
            : "（无外部研究包，请诚实将时效性内容写入 knowledgeGaps）",
          fb ? `\n【四层质量门禁发现以下缺陷，请定点修复受影响教学块】\n${fb}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      }),
      validateOutput: (raw) => lessonContentLlmSchema.parse(raw),
    };

    try {
      const execRes = await executeAgentTask({
        definition: taskDef,
        input: { repairFeedback },
        identity: {
          ...opts.identity,
          kind: "lesson_preparation",
          trackId: opts.trackId ?? undefined,
          lessonId: opts.lesson.id,
        },
        model: opts.model,
        modelLabel: opts.modelLabel,
        providerName: opts.providerName,
        abortSignal: opts.abortSignal,
        customExecutor: opts.customExecutor,
        maxRepairAttempts: 0,
      });

      let blocksToEvaluate = execRes.output.blocks;
      // On the final repair attempt, if scope overreach persists, deterministically prune offending blocks
      if (attempt === maxRepairs && effectiveContract) {
        const preCheck = detectScopeOverreachInBlocks({
          blocks: blocksToEvaluate,
          contract: effectiveContract,
          currentLessonTitle: opts.lesson.title,
        });
        if (!preCheck.ok) {
          blocksToEvaluate = pruneScopeOverreachInBlocks({
            blocks: blocksToEvaluate,
            contract: effectiveContract,
            currentLessonTitle: opts.lesson.title,
          }).blocks;
        }
      }

      const base = {
        contentId: `lc-${crypto.randomUUID().slice(0, 10)}`,
        lessonId: opts.lesson.id,
        trackId: opts.trackId ?? null,
        version: nextVersion,
        depth,
        learningOutcomes: execRes.output.learningOutcomes,
        blocks: blocksToEvaluate,
        estimatedMinutes: opts.lesson.minutes,
        researchPackageId: opts.researchPackage?.id ?? null,
        blueprintId: opts.blueprintId ?? null,
        blueprintVersion: effectiveBpVersion,
        contract: effectiveContract,
        knowledgeGaps: execRes.output.knowledgeGaps,
      };

      const qualityReport = evaluateLessonContentFourLayers({
        content: base,
        profile: opts.profile,
        researchPackage: opts.researchPackage,
        contract: effectiveContract,
        currentLessonTitle: opts.lesson.title,
        isFallbackTemplate: false,
      });

      const candidate: LessonContent = {
        ...base,
        qualityReport,
        status: qualityReport.status,
      };
      bestContent = candidate;

      if (qualityReport.passed) {
        try {
          saveLessonContentVersionToDb({
            contentId: candidate.contentId,
            lessonId: candidate.lessonId,
            trackId: candidate.trackId,
            version: candidate.version,
            depth: candidate.depth,
            status: candidate.status,
            researchPackageId: candidate.researchPackageId,
            blueprintId: candidate.blueprintId,
            content: candidate,
            qualityReport,
          });
        } catch {}
        return candidate;
      }

      repairFeedback = qualityReport.warnings.join("\n");
    } catch (err) {
      if (
        opts.abortSignal?.aborted ||
        (err instanceof Error && err.message === "TASK_ABORTED")
      ) {
        throw err;
      }
      repairFeedback = err instanceof Error ? err.message : String(err);
    }
  }

  // Reached repair cap: return honest `failed` / `limited` status (NEVER mark low-quality as `ready`!)
  const finalResult: LessonContent = bestContent || {
    contentId: `lc-${crypto.randomUUID().slice(0, 10)}`,
    lessonId: opts.lesson.id,
    trackId: opts.trackId ?? null,
    version: nextVersion,
    depth,
    learningOutcomes: [opts.lesson.objective || opts.lesson.title],
    blocks: [],
    estimatedMinutes: opts.lesson.minutes,
    researchPackageId: opts.researchPackage?.id ?? null,
    blueprintId: opts.blueprintId ?? null,
    knowledgeGaps: [repairFeedback || "课程生成未通过四层质量校验"],
    qualityReport: {
      passed: false,
      status: "failed",
      layerScores: { structure: 0, knowledge: 0, pedagogy: 0, technical: 0 },
      overallScore: 0,
      checks: [],
      warnings: [repairFeedback || "课程生成未通过四层质量校验"],
      failingBlockIds: [],
    },
    status: "failed",
  };

  try {
    saveLessonContentVersionToDb({
      contentId: finalResult.contentId,
      lessonId: finalResult.lessonId,
      trackId: finalResult.trackId,
      version: finalResult.version,
      depth: finalResult.depth,
      status: finalResult.status,
      researchPackageId: finalResult.researchPackageId,
      blueprintId: finalResult.blueprintId,
      content: finalResult,
      qualityReport: finalResult.qualityReport,
    });
  } catch {}

  return finalResult;
}
