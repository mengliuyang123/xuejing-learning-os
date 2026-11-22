import crypto from "node:crypto";
import { generateText, type LanguageModel } from "ai";
import { z } from "zod";
import {
  buildDeepSeekCallConfig,
  extractModelIdFromInstance,
  isDeepSeekModelInstance,
} from "./deepseek-config";
import {
  type LessonGraphNeighborhood,
  resolveGraphNeighborsForLesson,
  resolveNextRollingLesson,
} from "./curriculum-planner";
import type {
  GoalPlan,
  Lesson,
  LessonContract,
  PriorKnowledgeLevel,
} from "./learning";
import {
  type FourLayerQualityReport,
  type LessonContent,
  type TeachingBlock,
  detectScopeOverreachInBlocks,
  evaluateLessonContentFourLayers,
  pruneScopeOverreachInBlocks,
} from "./lesson-content";
import type { ClientModelConfig } from "./model-config";
import type { ResearchPackage } from "./research-planner";
import {
  getLessonPreparationFromDb,
  getResearchCacheFromDb,
  getTrackResearchPackageFromDb,
  saveLessonContentVersionToDb,
  saveResearchCacheToDb,
  upsertLessonPreparationInDb,
} from "./db";
import {
  type FetchLike,
  type KnowledgeAcquisitionMode,
  type LearningDomain,
  type ResearchSourceRef,
  WebResearchError,
  classifyLearningDomain,
  deepseekWebFetch,
  deepseekWebSearch,
  inferLearningCapabilityProfile,
  searchResultToSourceRef,
} from "./web-research";

export type TopicResearchResult = {
  topic: string;
  domain: LearningDomain;
  mode: KnowledgeAcquisitionMode;
  effectiveMode: KnowledgeAcquisitionMode;
  learnerLevel: PriorKnowledgeLevel;
  cacheHit: boolean;
  retrievedAt: string;
  queriesUsed: string[];
  domainStrategyNote: string;
  summary: string;
  keyConcepts: string[];
  recommendedPrerequisites: string[];
  commonPitfalls: string[];
  multiPerspectiveNotes?: string[];
  sources: ResearchSourceRef[];
  unverifiedPoints: string[];
  fallbackNotice?: string;
};

/**
 * 9-Point Lesson Research Brief — mandatory prerequisite before generating a detailed lesson,
 * preventing shallow "one-code-snippet" tutorials.
 */
export type LessonResearchBrief = {
  /** 1. 本节课要解决什么真实问题？ */
  realProblem: string;
  /** 2. 学习者需要哪些先修知识？ */
  prerequisites: string[];
  /** 3. 哪些术语是初学者可能不理解的？ */
  jargonGlossary: Array<{ term: string; plainExplanation: string }>;
  /** 4. 应该使用怎样的生活类比？ */
  everydayAnalogy: string;
  /** 5. 有哪些可以循序渐进讲解的示例？ */
  progressiveExamples: Array<{
    stage: string;
    title: string;
    explanation: string;
    codeOrContent: string;
  }>;
  /** 6. 学生需要亲手完成什么？ */
  handsOnTask: string;
  /** 7. 常见错误和误解有哪些？ */
  commonMisconceptions: Array<{ misconception: string; correction: string }>;
  /** 8. 怎样判断学生真正掌握了这个知识点？（与确定性评分引擎分离） */
  masteryVerification: string;
  /** 9. 哪些内容目前仍缺乏足够信息（待核验）？ */
  knowledgeGaps: string[];
  /** 10. 知识图谱节点边界契约（防止单课越界抢讲后继章节） */
  contract?: LessonContract;
  blueprintVersion?: number;
  reusedTrackResearch?: boolean;
};

export type DeepLessonTutorial = {
  headline: string;
  whyItMatters: string;
  environmentOrContextSetup?: string;
  coreWalkthroughMarkdown: string;
  checkYourUnderstandingPrompt: string;
  /** 模块化渐进教学块（适合分步展开与状态恢复，替代孤立超长文章） */
  modularBlocks?: TeachingBlock[];
  /** 下一节衔接预告（不抢讲具体实现） */
  nextLessonTeaser?: string;
};

export type LessonQualityReport = {
  score: number;
  passed: boolean;
  checks: Array<{ id: string; label: string; ok: boolean; detail?: string }>;
  warnings: string[];
};

export type PreparedLessonPackage = {
  lessonId: string;
  trackId: string | null;
  status: "ready" | "fallback";
  mode: KnowledgeAcquisitionMode;
  effectiveMode: KnowledgeAcquisitionMode;
  domain: LearningDomain;
  learnerLevel: PriorKnowledgeLevel;
  cacheHit: boolean;
  reusedTrackResearch?: boolean;
  blueprintVersion?: number;
  contract?: LessonContract;
  lessonContent?: LessonContent;
  preparedAt: string;
  brief: LessonResearchBrief;
  tutorial: DeepLessonTutorial;
  sources: ResearchSourceRef[];
  qualityReport: LessonQualityReport;
  fallbackNotice?: string;
};

function makeCacheKey(parts: string[]): string {
  const hash = crypto
    .createHash("sha256")
    .update(parts.map((p) => p.trim().toLowerCase()).join("|"))
    .digest("hex")
    .slice(0, 24);
  return `rc-${hash}`;
}

function getDomainResearchConfig(domain: LearningDomain): {
  ttlDays: number;
  searchCount: number;
  maxFetches: number;
  strategyNote: string;
} {
  switch (domain) {
    case "programming":
      return {
        ttlDays: 7,
        searchCount: 6,
        maxFetches: 2,
        strategyNote:
          "编程领域优先检索官方最新文档、API 规范与工程常见坑点（缓存 7 天）。",
      };
    case "math":
      return {
        ttlDays: 30,
        searchCount: 4,
        maxFetches: 1,
        strategyNote:
          "数学基础理论注重严格定义、几何/直觉类比与逐步推导，避免机械堆砌搜索页数（缓存 30 天）。",
      };
    case "humanities":
      return {
        ttlDays: 30,
        searchCount: 6,
        maxFetches: 2,
        strategyNote:
          "人文历史领域注重史料背景与多元学术解释，明确标注不同观点而非强行单一结论（缓存 30 天）。",
      };
    default:
      return {
        ttlDays: 14,
        searchCount: 5,
        maxFetches: 1,
        strategyNote: "通用主题优先参考高权威概述与实践指南（缓存 14 天）。",
      };
  }
}

function buildDomainQueries(
  topic: string,
  domain: LearningDomain,
  learnerLevel: PriorKnowledgeLevel,
): string[] {
  const clean = topic.trim();
  if (domain === "programming") {
    const levelHint =
      learnerLevel === "beginner"
        ? "入门 教程 环境配置 常见错误"
        : learnerLevel === "advanced"
          ? "best practices error handling production architecture"
          : "官方文档 教程 实践 示例";
    return [
      `${clean} ${levelHint} after:2024`,
      `${clean} common mistakes pitfalls debugging`,
    ];
  }
  if (domain === "math") {
    const levelHint =
      learnerLevel === "beginner"
        ? "直观理解 定义 例子 常见误区"
        : "严格定义 证明 推导 应用";
    return [`${clean} ${levelHint}`];
  }
  if (domain === "humanities") {
    const langTag = /[\u4e00-\u9fff]/.test(clean) ? " lang:zh" : "";
    return [
      `${clean} 核心脉络 史料 背景${langTag}`,
      `${clean} 不同观点 争议 学术解释${langTag}`,
    ];
  }
  return [`${clean} 核心概念 入门 实践 常见误区`];
}

function extractSentences(sources: ResearchSourceRef[], maxItems = 6): string[] {
  const out: string[] = [];
  for (const s of sources) {
    const raw = (s.excerpt || s.title).trim();
    if (!raw) continue;
    const cleaned = raw.replace(/\s+/g, " ").slice(0, 140);
    if (!out.includes(cleaned)) out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * High-level tool: research_learning_topic
 * Supports auto_web (default), quick_draft (offline/fast fallback), and user_materials (optional URLs/notes).
 * Uses SQLite research_cache to avoid redundant internet queries.
 */
export async function researchLearningTopic(opts: {
  topic: string;
  goal?: string;
  learnerLevel?: PriorKnowledgeLevel;
  mode?: KnowledgeAcquisitionMode;
  userUrls?: string[];
  userNotes?: string;
  forceRefresh?: boolean;
  clientConfig?: ClientModelConfig | null;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  abortSignal?: AbortSignal;
}): Promise<TopicResearchResult> {
  const topic = opts.topic.trim();
  const learnerLevel: PriorKnowledgeLevel = opts.learnerLevel || "intermediate";
  const requestedMode: KnowledgeAcquisitionMode = opts.mode || "auto_web";
  const domain = classifyLearningDomain(`${topic} ${opts.goal || ""}`);
  const domainCfg = getDomainResearchConfig(domain);

  const materialsFingerprint = [
    ...(opts.userUrls || []).map((u) => u.trim()).sort(),
    (opts.userNotes || "").trim().slice(0, 200),
  ].join(";");

  const cacheKey = makeCacheKey([
    "topic",
    topic,
    learnerLevel,
    requestedMode,
    materialsFingerprint,
  ]);

  if (!opts.forceRefresh) {
    try {
      const cached = getResearchCacheFromDb(cacheKey);
      if (cached && cached.payload && typeof cached.payload === "object") {
        const payload = cached.payload as TopicResearchResult;
        return {
          ...payload,
          cacheHit: true,
        };
      }
    } catch {
      // Cache read is best-effort
    }
  }

  const retrievedAt = new Date().toISOString();
  const sources: ResearchSourceRef[] = [];
  const queriesUsed: string[] = [];
  const unverifiedPoints: string[] = [];
  let effectiveMode: KnowledgeAcquisitionMode = requestedMode;
  let fallbackNotice: string | undefined;

  // Mode 3: Optional user-supplied materials (URLs and/or pasted notes)
  if (requestedMode === "user_materials" || opts.userNotes?.trim() || opts.userUrls?.length) {
    if (opts.userNotes?.trim()) {
      sources.push({
        url: "local://user-notes",
        title: "用户提供的参考笔记",
        siteName: "用户资料",
        authority: 4,
        rerankScore: 3,
        date: retrievedAt,
        retrievedAt,
        excerpt: opts.userNotes.trim().slice(0, 2400),
        origin: "user_material",
      });
    }
    for (const rawUrl of (opts.userUrls || []).slice(0, 3)) {
      if (!rawUrl.trim()) continue;
      try {
        const fetched = await deepseekWebFetch({
          url: rawUrl,
          clientConfig: opts.clientConfig,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
          fetchImpl: opts.fetchImpl,
          abortSignal: opts.abortSignal,
        });
        sources.push({
          url: fetched.url,
          title: fetched.title,
          siteName: new URL(fetched.url).hostname,
          authority: 3,
          rerankScore: 2.5,
          date: null,
          retrievedAt: fetched.retrievedAt,
          excerpt: fetched.excerpt,
          origin: "deepseek_fetch",
        });
      } catch (err) {
        unverifiedPoints.push(
          `用户指定链接 ${rawUrl} 读取失败（${err instanceof Error ? err.message : "未知错误"}），未纳入正文依据。`,
        );
      }
    }
  }

  // Mode 1: Auto web search (default)
  if (requestedMode === "auto_web") {
    const queries = buildDomainQueries(topic, domain, learnerLevel);
    let searchSucceeded = false;

    for (const q of queries) {
      queriesUsed.push(q);
      try {
        const res = await deepseekWebSearch({
          query: q,
          count: domainCfg.searchCount,
          oriQuestion: opts.goal || topic,
          needContent: false,
          clientConfig: opts.clientConfig,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
          fetchImpl: opts.fetchImpl,
          abortSignal: opts.abortSignal,
        });
        searchSucceeded = true;
        for (const item of res.results) {
          if (sources.some((s) => s.url === item.url)) continue;
          sources.push(searchResultToSourceRef(item, res.retrievedAt));
        }
      } catch (err) {
        const msg =
          err instanceof WebResearchError
            ? err.message
            : err instanceof Error
              ? err.message
              : "联网检索异常";
        if (!searchSucceeded) {
          fallbackNotice = `联网检索不可用（${msg}），已自动降级为快速生成模式；时效性或 API 细节请以官方文档为准。`;
        } else {
          unverifiedPoints.push(`子检索「${q}」未能完成：${msg}`);
        }
        break;
      }
    }

    // Selective Fetch on top high-authority result(s) for concrete substance (bounded, never mirroring sites)
    if (searchSucceeded && sources.length > 0 && domainCfg.maxFetches > 0) {
      const topCandidates = sources
        .filter((s) => s.origin === "deepseek_search" && (s.authority >= 2 || s.rerankScore >= 1.5))
        .slice(0, domainCfg.maxFetches);
      for (const cand of topCandidates) {
        try {
          const fetched = await deepseekWebFetch({
            url: cand.url,
            maxExcerptChars: 1800,
            clientConfig: opts.clientConfig,
            apiKey: opts.apiKey,
            baseUrl: opts.baseUrl,
            fetchImpl: opts.fetchImpl,
            abortSignal: opts.abortSignal,
          });
          if (fetched.excerpt) {
            cand.excerpt = fetched.excerpt;
            cand.origin = "deepseek_fetch";
          }
        } catch {
          // Fetch failure on a single site is normal (site robots/paywall); keep Search summary
        }
      }
    }

    if (!searchSucceeded || sources.length === 0) {
      effectiveMode = "quick_draft";
      if (!fallbackNotice) {
        fallbackNotice =
          "未检索到足够的高质量网页资料，已降级为快速生成草案，涉及最新版本或具体数字的内容标记为待核验。";
      }
      unverifiedPoints.push("本次主题研究未获得外部权威网页证实，关键细节待核验。");
    }
  } else if (requestedMode === "quick_draft") {
    effectiveMode = "quick_draft";
    fallbackNotice =
      "当前为「AI 快速生成」模式（未联网检索），对于时效性较强的库版本、API 参数或前沿结论请注意核验。";
    unverifiedPoints.push("快速生成模式基于模型内生知识，未做实时网络核对。");
  }

  // Quality boundary #1: search results are NOT proof — surface low-authority warnings
  const authoritativeCount = sources.filter(
    (s) => s.authority >= 3 || s.origin === "user_material",
  ).length;
  if (effectiveMode === "auto_web" && authoritativeCount === 0 && sources.length > 0) {
    unverifiedPoints.push(
      "检索结果中缺少高权威来源（authority ≥ 3），关键API/事实结论需以官方文档或原始教材进一步核验。",
    );
  }

  const keyConcepts =
    sources.length > 0
      ? sources.slice(0, 5).map((s) => s.title)
      : [
          `${topic} 的核心问题与应用场景`,
          `${topic} 的基础概念与最小闭环`,
          `${topic} 的常见错误与验证方法`,
        ];

  const recommendedPrerequisites =
    learnerLevel === "beginner"
      ? domain === "programming"
        ? ["基础运行环境与依赖管理", "基本语法与数据读取", "理解错误日志与最小验证方式"]
        : domain === "math"
          ? ["基本符号与概念直觉", "前置核心定义复习"]
          : ["核心时代背景与基本术语"]
      : learnerLevel === "advanced"
        ? ["跳过入门语法，直入核心机制、边界条件与复杂案例"]
        : ["掌握基础概念后聚焦核心原理、动手实现与异常处理"];

  const commonPitfalls =
    domain === "programming"
      ? [
          "直接复制示例代码却忽略环境、密钥或依赖版本差异",
          "只测试正常路径，未处理超时、格式错误或空结果",
        ]
      : domain === "math"
        ? [
            "死记公式结论而忽略适用前提与边界条件",
            "混淆相关性与因果性或跳步导致推导漏洞",
          ]
        : domain === "humanities"
          ? [
              "把单一二手观点当成唯一史实，忽略一手史料与不同学派分歧",
              "脱离当时历史语境用现代标准简单评判",
            ]
          : ["只看概念定义不做具体案例迁移与检验"];

  const multiPerspectiveNotes =
    domain === "humanities"
      ? [
          "人文/历史主题需区分「基本事实脉络」与「不同学者/史料解释」，学习中应对比至少两种解释视角。",
        ]
      : undefined;

  const snippetDigest = extractSentences(sources, 4).join(" | ");
  const summary =
    sources.length > 0
      ? `已完成「${topic}」主题研究（${domain} 领域 · ${effectiveMode} 模式，收集 ${sources.length} 条来源，其中高权威 ${authoritativeCount} 条）。关键摘录：${snippetDigest}`
      : `已完成「${topic}」快速主题梳理（${domain} 领域 · ${effectiveMode} 模式）。${fallbackNotice || ""}`;

  const result: TopicResearchResult = {
    topic,
    domain,
    mode: requestedMode,
    effectiveMode,
    learnerLevel,
    cacheHit: false,
    retrievedAt,
    queriesUsed,
    domainStrategyNote: domainCfg.strategyNote,
    summary,
    keyConcepts,
    recommendedPrerequisites,
    commonPitfalls,
    multiPerspectiveNotes,
    sources: sources.slice(0, 8),
    unverifiedPoints,
    fallbackNotice,
  };

  try {
    saveResearchCacheToDb({
      cacheKey,
      kind: "topic",
      domain,
      mode: effectiveMode,
      queryOrTopic: topic,
      learnerLevel,
      payload: result,
      sources: result.sources,
      unverifiedClaims: result.unverifiedPoints,
      ttlDays: domainCfg.ttlDays,
    });
  } catch {
    // Cache write is best-effort
  }

  return result;
}

const lessonBriefAndTutorialSchema = z.object({
  brief: z.object({
    realProblem: z.string().min(6),
    prerequisites: z.array(z.string().min(1)).min(1),
    jargonGlossary: z
      .array(
        z.object({
          term: z.string().min(1),
          plainExplanation: z.string().min(2),
        }),
      )
      .min(2),
    everydayAnalogy: z.string().min(6),
    progressiveExamples: z
      .array(
        z.object({
          stage: z.string().min(1),
          title: z.string().min(1),
          explanation: z.string().min(4),
          codeOrContent: z.string().min(4),
        }),
      )
      .min(2),
    handsOnTask: z.string().min(6),
    commonMisconceptions: z
      .array(
        z.object({
          misconception: z.string().min(2),
          correction: z.string().min(4),
        }),
      )
      .min(2),
    masteryVerification: z.string().min(6),
    knowledgeGaps: z.array(z.string().min(1)),
  }),
  tutorial: z.object({
    headline: z.string().min(2),
    whyItMatters: z.string().min(6),
    environmentOrContextSetup: z.string().optional(),
    coreWalkthroughMarkdown: z.string().min(40),
    checkYourUnderstandingPrompt: z.string().min(4),
  }),
});

/**
 * Step 5: Quality gate ensuring generated lessons are deep, non-shallow,
 * learner-adapted, and honest about unverified claims.
 */
export function evaluateLessonQuality(
  brief: LessonResearchBrief,
  tutorial: DeepLessonTutorial,
  sources: ResearchSourceRef[],
  effectiveMode: KnowledgeAcquisitionMode,
  opts?: {
    contract?: LessonContract | null;
    currentLessonTitle?: string;
    blocks?: TeachingBlock[];
  },
): LessonQualityReport {
  const checks: LessonQualityReport["checks"] = [
    {
      id: "real_problem",
      label: "明确真实问题",
      ok: brief.realProblem.trim().length >= 12,
    },
    {
      id: "jargon_glossary",
      label: "初学者术语解释（≥2）",
      ok: brief.jargonGlossary.length >= 2,
      detail: `当前 ${brief.jargonGlossary.length} 条`,
    },
    {
      id: "everyday_analogy",
      label: "生活类比",
      ok: brief.everydayAnalogy.trim().length >= 10,
    },
    {
      id: "progressive_examples",
      label: "循序渐进示例（≥2 阶段）",
      ok: brief.progressiveExamples.length >= 2,
      detail: `当前 ${brief.progressiveExamples.length} 阶段`,
    },
    {
      id: "hands_on_task",
      label: "亲手实践任务",
      ok: brief.handsOnTask.trim().length >= 10,
    },
    {
      id: "misconceptions",
      label: "常见误区与纠偏（≥2）",
      ok: brief.commonMisconceptions.length >= 2,
      detail: `当前 ${brief.commonMisconceptions.length} 条`,
    },
    {
      id: "mastery_verification",
      label: "独立掌握验证标准",
      ok: brief.masteryVerification.trim().length >= 10,
    },
    {
      id: "tutorial_depth",
      label: "教程正文深度",
      ok: tutorial.coreWalkthroughMarkdown.trim().length >= 80,
    },
    {
      id: "evidence_transparency",
      label: "来源依据或待核验标注",
      ok:
        (effectiveMode !== "quick_draft" && sources.length > 0) ||
        brief.knowledgeGaps.length > 0,
      detail:
        sources.length > 0
          ? `${sources.length} 条参考来源`
          : `已标注 ${brief.knowledgeGaps.length} 条待核验提示`,
    },
  ];

  const effectiveContract = opts?.contract ?? brief.contract ?? null;
  if (effectiveContract) {
    const blocksToInspect =
      opts?.blocks ||
      tutorial.modularBlocks ||
      buildModularTeachingBlocksFromBrief({
        lessonTitle: opts?.currentLessonTitle || tutorial.headline,
        brief,
        tutorial,
        contract: effectiveContract,
      });
    const overreach = detectScopeOverreachInBlocks({
      blocks: blocksToInspect,
      contract: effectiveContract,
      currentLessonTitle: opts?.currentLessonTitle || tutorial.headline,
    });
    checks.push({
      id: "scope_boundary_compliance",
      label: "遵循知识图谱边界契约（不抢讲后继节点）",
      ok: overreach.ok,
      detail: overreach.summary,
    });
  }

  const passedCount = checks.filter((c) => c.ok).length;
  const score = Math.round((passedCount / checks.length) * 100);
  const warnings: string[] = [];
  if (effectiveMode === "quick_draft") {
    warnings.push("本课由快速生成模式产出，建议结合官方文档或参考资料核验时效性细节。");
  }
  if (brief.knowledgeGaps.length > 0) {
    warnings.push(`存在 ${brief.knowledgeGaps.length} 项待核验内容，已单独标出。`);
  }

  return {
    score,
    passed: score >= 80,
    checks,
    warnings,
  };
}

function buildModularTeachingBlocksFromBrief(opts: {
  lessonTitle: string;
  brief: LessonResearchBrief;
  tutorial: DeepLessonTutorial;
  contract?: LessonContract | null;
}): TeachingBlock[] {
  const { brief, tutorial, contract } = opts;
  const blocks: TeachingBlock[] = [];

  blocks.push({
    id: "mod-motivation",
    type: "motivation",
    title: "本节定位与要解决的真实问题",
    content: contract?.progressionStep
      ? `${brief.realProblem}\n\n【图谱推进定位】${contract.progressionStep}`
      : brief.realProblem,
  });

  if (
    tutorial.environmentOrContextSetup ||
    (contract?.assumedPrior && contract.assumedPrior.length > 0)
  ) {
    blocks.push({
      id: "mod-prereq-bridge",
      type: "prerequisite_bridge",
      title: "前置能力承接与准备",
      content: [
        tutorial.environmentOrContextSetup || "",
        contract?.assumedPrior?.length
          ? `承接前置：${contract.assumedPrior.join("；")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  blocks.push({
    id: "mod-analogy",
    type: "analogy",
    title: "直觉类比",
    content: brief.everydayAnalogy,
  });

  blocks.push({
    id: "mod-concept",
    type: "concept_explanation",
    title: "本节核心机制精讲（In-Scope）",
    content: tutorial.coreWalkthroughMarkdown,
  });

  brief.progressiveExamples.forEach((ex, i) => {
    blocks.push({
      id: `mod-example-${i + 1}`,
      type: "worked_example",
      title: `${ex.stage} · ${ex.title}`,
      content: {
        explanation: ex.explanation,
        code: ex.codeOrContent,
      },
    });
  });

  if (brief.commonMisconceptions.length > 0) {
    blocks.push({
      id: "mod-misconceptions",
      type: "misconceptions",
      title: "常见误区与边界纠偏",
      content: brief.commonMisconceptions.map(
        (m) => `误区：${m.misconception} → 纠偏：${m.correction}`,
      ),
    });
  }

  blocks.push({
    id: "mod-guided-task",
    type: "guided_task",
    title: "本节最小闭环动手检验",
    content: tutorial.nextLessonTeaser
      ? `${brief.handsOnTask}\n\n（后续衔接预告：${tutorial.nextLessonTeaser}）`
      : brief.handsOnTask,
  });

  return blocks;
}

/**
 * Converts a track-level global `ResearchPackage` into a lesson-scoped `TopicResearchResult`
 * so lessons reuse global track research by default without redundant web searches.
 */
function researchPackageToTopicResearchResult(opts: {
  pkg: ResearchPackage;
  lesson: Lesson;
  domain: LearningDomain;
  learnerLevel: PriorKnowledgeLevel;
  requestedMode: KnowledgeAcquisitionMode;
}): TopicResearchResult {
  const { pkg, lesson, domain, learnerLevel, requestedMode } = opts;
  return {
    topic: `${pkg.topic} · ${lesson.title}`,
    domain,
    mode: requestedMode,
    effectiveMode: pkg.effectiveMode || requestedMode,
    learnerLevel,
    cacheHit: true,
    retrievedAt: new Date().toISOString(),
    queriesUsed: ["[复用轨道全局 ResearchPackage]"],
    domainStrategyNote: "已复用本轨道建轨阶段的全局研究包，避免单课重复检索。",
    summary: `围绕「${lesson.title}」复用轨道全局研究成果（共 ${pkg.concepts.length} 个核心概念、${pkg.sourceRefs.length} 条权威来源）。`,
    keyConcepts:
      pkg.concepts.length > 0
        ? pkg.concepts.map((c) => `${c.name}：${c.definition}`)
        : [lesson.title, lesson.concept],
    recommendedPrerequisites:
      pkg.prerequisites.length > 0
        ? pkg.prerequisites
        : ["确认基础概念与前置节点要求"],
    commonPitfalls:
      pkg.commonMisconceptions.length >= 2
        ? pkg.commonMisconceptions
        : [
            ...pkg.commonMisconceptions,
            `只背诵「${lesson.title}」名词定义，未动手验证最小闭环输入与输出`,
            `混淆本节核心范围与后续进阶章节的边界条件`,
          ].slice(0, 4),
    sources: pkg.sourceRefs || [],
    unverifiedPoints: pkg.unresolvedQuestions || [],
    fallbackNotice:
      pkg.status === "fallback"
        ? "当前复用轨道快速研究包，如需补充最新网页资料可点击「刷新研究」。"
        : undefined,
  };
}

const inFlightLessonPreps = new Map<string, Promise<PreparedLessonPackage>>();

function extractJsonFromModelText(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("模型未返回可解析的 JSON 对象");
  }
}

function buildDeterministicLessonBriefAndTutorial(opts: {
  lesson: Lesson;
  trackGoal: string;
  domain: LearningDomain;
  learnerLevel: PriorKnowledgeLevel;
  research: TopicResearchResult;
  contract?: LessonContract;
  blueprintVersion?: number;
  reusedTrackResearch?: boolean;
}): { brief: LessonResearchBrief; tutorial: DeepLessonTutorial } {
  const {
    lesson,
    domain,
    learnerLevel,
    research,
    contract,
    blueprintVersion,
    reusedTrackResearch,
  } = opts;
  const setupNote =
    domain === "programming" && learnerLevel === "beginner"
      ? "先确认本地运行环境、依赖安装与凭证/配置文件（如 API Key 放进环境变量而非硬编码），并先跑通一次最小验证命令确认环境正常。"
      : domain === "programming" && learnerLevel === "intermediate"
        ? "确认依赖版本与客户端初始化方式，先观察一次真实请求与完整响应结构。"
        : domain === "programming"
          ? "直接聚焦关键参数调优、边界异常（超时/限流/Schema 漂移）与可观测验证。"
          : domain === "math"
            ? "先明确定义域、符号含义与直观几何/概率意义，再进入严谨推导。"
            : domain === "humanities"
              ? "先定位时间线、核心史料背景，再对照不同学派或史料的主要分歧。"
              : "先明确本课要解决的具体场景与输入输出边界。";

  const nextDeferred = contract?.deferredTo?.[0];
  const nextLessonTeaser = nextDeferred
    ? `本节完成最小闭环后，下一阶段将在《${nextDeferred.targetLessonTitle}》继续深入「${nextDeferred.topic}」（本节不提前展开其完整实现）。`
    : undefined;

  const brief: LessonResearchBrief = {
    realProblem:
      lesson.objective?.trim() ||
      `帮助学习者真正解决「${lesson.title}」在实际场景中的核心落地问题，而不是停留在名词概念。`,
    prerequisites:
      contract?.assumedPrior?.length
        ? contract.assumedPrior
        : lesson.requires.length > 0
          ? [
              ...lesson.requires.map((id) => `前置课程节点：${id}`),
              ...research.recommendedPrerequisites.slice(0, 2),
            ]
          : research.recommendedPrerequisites,
    jargonGlossary: [
      {
        term: lesson.title.split(/[：:]/)[0].trim() || lesson.title,
        plainExplanation: lesson.concept.slice(0, 120) || "本课最核心的操作对象与运行机制。",
      },
      {
        term:
          domain === "programming"
            ? "边界条件与异常处理"
            : domain === "math"
              ? "适用前提与约束条件"
              : "一手依据与多视角解读",
        plainExplanation:
          domain === "programming"
            ? "当输入缺失、网络超时或返回非预期结构时，程序如何安全降级而不崩溃。"
            : domain === "math"
              ? "定理或公式成立所依赖的前提条件，超出前提直接套用会得出错误结论。"
              : "区分原始史料事实与后世学者的推论解释，避免把单一观点当成唯一真相。",
      },
    ],
    everydayAnalogy:
      domain === "programming"
        ? `把「${lesson.title}」想象成餐厅点单与后厨协同：菜单（协议/Schema）先约定好格式，服务员（宿主程序）核对点单无误再交给后厨执行，并把真实菜品状态带回给顾客。`
        : domain === "math"
          ? `把「${lesson.title}」当成地图比例尺与坐标系：先看清它如何把复杂现象映射到可计算的量，再看每个参数变化如何改变结果。`
          : `把「${lesson.title}」想象成还原一场历史现场的庭审：既要看时间线与原始证物（史料），也要听不同立场证人的叙述差异。`,
    progressiveExamples: [
      {
        stage: "阶段 1 · 本节核心最小闭环",
        title: `认识「${lesson.title}」的输入与输出`,
        explanation: `${setupNote} ${lesson.concept}`,
        codeOrContent:
          lesson.example?.trim() ||
          `核心要点：${lesson.concept}\n目标：${lesson.objective || lesson.title}`,
      },
      {
        stage: "阶段 2 · 本节边界自检与下节衔接",
        title: `为「${lesson.title}」加入本节边界检查`,
        explanation:
          "在最小示例跑通后，主动构造一次缺失参数或边界输入，确认本节最小闭环稳健，并为下一节点做好接口预留（不提前实现后续章节内容）。",
        codeOrContent: [
          "本节闭环验证清单：",
          "1. 先跑通本节最小正常输入并核对输出",
          "2. 构造 1 个本节范围内的边界输入验证兜底分支",
          nextLessonTeaser
            ? `3. 后续衔接：${nextLessonTeaser}`
            : "3. 对照本课完成条件逐项核验",
        ].join("\n"),
      },
    ],
    handsOnTask:
      lesson.practicePrompt?.trim() ||
      lesson.completionCriteria?.trim() ||
      `请围绕「${lesson.title}」亲手完成一次最小实践，并补充至少 1 条边界情况的处理思路。`,
    commonMisconceptions: research.commonPitfalls.map((pitfall) => ({
      misconception: pitfall,
      correction: `在「${lesson.title}」中应显式检查前置条件与结果反馈，再推进下一步。`,
    })),
    masteryVerification:
      lesson.completionCriteria?.trim() ||
      `在 Learn 练习与测验区通过确定性评分校验（掌握度 ≥ 80%），并能独立解释核心机制与常见错因。`,
    knowledgeGaps:
      research.unverifiedPoints.length > 0
        ? research.unverifiedPoints
        : research.effectiveMode === "quick_draft"
          ? ["当前为快速生成草案，最新版本细节待结合权威来源核验。"]
          : [],
    contract,
    blueprintVersion,
    reusedTrackResearch,
  };

  const tutorial: DeepLessonTutorial = {
    headline: lesson.title,
    whyItMatters: brief.realProblem,
    environmentOrContextSetup: setupNote,
    coreWalkthroughMarkdown: [
      `### 核心机制拆解`,
      lesson.concept,
      contract?.progressionStep
        ? `\n### 图谱推进与本节边界\n- **本节推进步**：${contract.progressionStep}\n- **本节聚焦范围**：${contract.inScope.join("；")}`
        : "",
      ``,
      `### 执行链路与关键边界`,
      `- **明确输入与状态**：确认每一步依赖什么前置数据，避免把隐式状态混在一起。`,
      `- **分离决策与执行**：看清哪一步负责判断/推导，哪一步负责真实执行或校验。`,
      `- **提前设计终止与兜底**：任何流程都要定义正常结束、异常回退与验证标准。`,
      research.multiPerspectiveNotes?.length
        ? `\n### 多元视角提示\n${research.multiPerspectiveNotes.map((n) => `- ${n}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    checkYourUnderstandingPrompt: brief.handsOnTask,
    nextLessonTeaser,
  };

  tutorial.modularBlocks = buildModularTeachingBlocksFromBrief({
    lessonTitle: lesson.title,
    brief,
    tutorial,
    contract,
  });

  return { brief, tutorial };
}

/**
 * Prunes any scope-overreaching progressive examples or markdown paragraphs in `brief` & `tutorial`
 * when a synthesized lesson accidentally spoils a deferred downstream node's core topic.
 */
function enforceContractScopeOnBriefAndTutorial(opts: {
  lesson: Lesson;
  brief: LessonResearchBrief;
  tutorial: DeepLessonTutorial;
  contract?: LessonContract;
  blueprintVersion?: number;
  reusedTrackResearch?: boolean;
}): {
  brief: LessonResearchBrief;
  tutorial: DeepLessonTutorial;
  prunedBlockIds: string[];
} {
  const { lesson, contract, blueprintVersion, reusedTrackResearch } = opts;
  const brief: LessonResearchBrief = {
    ...opts.brief,
    contract,
    blueprintVersion,
    reusedTrackResearch,
  };
  const nextDeferred = contract?.deferredTo?.[0];
  const nextLessonTeaser =
    opts.tutorial.nextLessonTeaser ||
    (nextDeferred
      ? `本节完成「${lesson.title}」最小闭环后，下一阶段将在《${nextDeferred.targetLessonTitle}》深入「${nextDeferred.topic}」（本节不提前展开其完整实现）。`
      : undefined);

  const tutorial: DeepLessonTutorial = {
    ...opts.tutorial,
    nextLessonTeaser,
  };

  let blocks = buildModularTeachingBlocksFromBrief({
    lessonTitle: lesson.title,
    brief,
    tutorial,
    contract,
  });

  let prunedBlockIds: string[] = [];
  if (contract && contract.deferredTo.length > 0) {
    const pruned = pruneScopeOverreachInBlocks({
      blocks,
      contract,
      currentLessonTitle: lesson.title,
    });
    blocks = pruned.blocks;
    prunedBlockIds = pruned.prunedBlockIds;

    if (prunedBlockIds.length > 0) {
      // Sync pruned example/concept blocks back to brief.progressiveExamples & tutorial.coreWalkthroughMarkdown
      const conceptBlk = blocks.find((b) => b.id === "mod-concept");
      if (conceptBlk && typeof conceptBlk.content === "string") {
        tutorial.coreWalkthroughMarkdown = conceptBlk.content;
      }
      brief.progressiveExamples = brief.progressiveExamples.map((ex, idx) => {
        const blkId = `mod-example-${idx + 1}`;
        if (!prunedBlockIds.includes(blkId)) return ex;
        const targetTitle =
          contract.deferredTo[0]?.targetLessonTitle || "后续章节";
        return {
          stage: `阶段 ${idx + 1} · 本节边界自检与下节衔接`,
          title: `${lesson.title} · 本节最小闭环边界验证`,
          explanation: `聚焦本节核心范围（${contract.inScope[0] || lesson.title}）验证边界输入。注：进阶内容已按知识图谱契约留至后继课程《${targetTitle}》。`,
          codeOrContent: `# 本节最小闭环验证：${lesson.title}\n# 后继节点《${targetTitle}》将在此基础上继续演进`,
        };
      });
    }
  }

  tutorial.modularBlocks = blocks;
  return { brief, tutorial, prunedBlockIds };
}

/**
 * Step 4: On-demand & rolling deep lesson preparation with:
 * 1. Knowledge Graph `LessonContract` consumption & blueprintVersion cache invalidation.
 * 2. Track-level global `ResearchPackage` reuse (eliminating duplicate per-lesson web searches).
 * 3. In-flight promise deduplication (`inFlightLessonPreps`).
 * 4. 4-Layer Scope-Overreach Quality Gate & targeted spoiler pruning.
 * 5. Dual persistence into `lesson_preparations` and `lesson_content_versions`.
 */
export async function prepareLessonInDepth(opts: {
  lesson: Lesson;
  trackId?: string | null;
  trackTitle?: string;
  trackGoal?: string;
  trackUnits?: Lesson[];
  blueprintId?: string | null;
  blueprintVersion?: number;
  contract?: LessonContract | null;
  graphNeighborhood?: LessonGraphNeighborhood | null;
  masteryMap?: Record<string, number>;
  researchPackageId?: string | null;
  trackResearchPackage?: ResearchPackage | null;
  reuseTrackResearch?: boolean;
  learnerLevel?: PriorKnowledgeLevel;
  mode?: KnowledgeAcquisitionMode;
  userUrls?: string[];
  userNotes?: string;
  forceRefresh?: boolean;
  model?: LanguageModel | string | null;
  clientConfig?: ClientModelConfig | null;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  abortSignal?: AbortSignal;
}): Promise<PreparedLessonPackage> {
  const { lesson } = opts;
  const learnerLevel: PriorKnowledgeLevel = opts.learnerLevel || "intermediate";
  const requestedMode: KnowledgeAcquisitionMode = opts.mode || "auto_web";

  // 1. Resolve Knowledge Graph neighborhood & versioned LessonContract
  const neighborhood =
    opts.graphNeighborhood ??
    resolveGraphNeighborsForLesson(
      opts.trackUnits && opts.trackUnits.length > 0
        ? opts.trackUnits
        : [lesson],
      lesson.id,
      {
        blueprintVersion:
          opts.blueprintVersion ?? lesson.contract?.blueprintVersion ?? 1,
        mastery: opts.masteryMap,
      },
    );
  const effectiveContract =
    opts.contract ?? neighborhood?.contract ?? lesson.contract ?? undefined;
  const effectiveBlueprintVersion =
    opts.blueprintVersion ??
    effectiveContract?.blueprintVersion ??
    neighborhood?.blueprintVersion ??
    1;

  const dedupeKey = `${lesson.id}:${learnerLevel}:${requestedMode}:v${effectiveBlueprintVersion}`;
  if (!opts.forceRefresh && inFlightLessonPreps.has(dedupeKey)) {
    return inFlightLessonPreps.get(dedupeKey)!;
  }

  const runPrep = async (): Promise<PreparedLessonPackage> => {
    const domain = classifyLearningDomain(
      `${lesson.title} ${lesson.concept} ${opts.trackGoal || ""}`,
    );

    // 2. Instant SQLite cache hit when revisiting/reviewing a prepared lesson at current blueprintVersion
    if (!opts.forceRefresh) {
      try {
        const existing = getLessonPreparationFromDb(lesson.id);
        if (
          existing &&
          (existing.status === "ready" || existing.status === "fallback") &&
          existing.brief &&
          existing.tutorial &&
          existing.learnerLevel === learnerLevel &&
          existing.mode === requestedMode
        ) {
          const cachedBrief = existing.brief as LessonResearchBrief;
          const cachedBpVer =
            cachedBrief.blueprintVersion ??
            cachedBrief.contract?.blueprintVersion ??
            1;
          // Invalidate cache if track's blueprintVersion advanced
          if (cachedBpVer >= effectiveBlueprintVersion) {
            const cachedTutorial = existing.tutorial as DeepLessonTutorial;
            if (!cachedTutorial.modularBlocks) {
              cachedTutorial.modularBlocks =
                buildModularTeachingBlocksFromBrief({
                  lessonTitle: lesson.title,
                  brief: cachedBrief,
                  tutorial: cachedTutorial,
                  contract: cachedBrief.contract || effectiveContract,
                });
            }
            return {
              lessonId: lesson.id,
              trackId: existing.trackId,
              status: existing.status,
              mode: requestedMode,
              effectiveMode: existing.mode,
              domain,
              learnerLevel,
              cacheHit: true,
              reusedTrackResearch: Boolean(cachedBrief.reusedTrackResearch),
              blueprintVersion: cachedBpVer,
              contract: cachedBrief.contract || effectiveContract,
              preparedAt: existing.updatedAt,
              brief: cachedBrief,
              tutorial: cachedTutorial,
              sources: (existing.sources || []) as ResearchSourceRef[],
              qualityReport:
                (existing.qualityReport as LessonQualityReport) ||
                evaluateLessonQuality(
                  cachedBrief,
                  cachedTutorial,
                  (existing.sources || []) as ResearchSourceRef[],
                  existing.mode,
                  {
                    contract: cachedBrief.contract || effectiveContract,
                    currentLessonTitle: lesson.title,
                  },
                ),
              fallbackNotice:
                existing.status === "fallback"
                  ? "本课缓存来自快速生成模式，点击「刷新研究」可联网补充最新权威资料。"
                  : undefined,
            };
          }
        }
      } catch {
        // Proceed to fresh preparation
      }
    }

    // Stage 1: Real status -> researching
    try {
      upsertLessonPreparationInDb({
        lessonId: lesson.id,
        trackId: opts.trackId ?? null,
        status: "researching",
        mode: requestedMode,
        learnerLevel,
        errorMessage: null,
      });
    } catch {}

    // 3. Global Track-Level Research Reuse (avoid per-lesson duplicate web searches!)
    let reusedTrackResearch = false;
    let resolvedTrackPkg: ResearchPackage | null =
      opts.trackResearchPackage ?? null;
    const allowTrackReuse =
      opts.reuseTrackResearch !== false &&
      !opts.forceRefresh &&
      requestedMode !== "user_materials" &&
      Boolean(
        opts.trackResearchPackage ||
          opts.researchPackageId ||
          (opts.trackUnits && opts.trackUnits.length > 1),
      );

    if (allowTrackReuse && !resolvedTrackPkg) {
      try {
        const dbRow = getTrackResearchPackageFromDb({
          packageId: opts.researchPackageId,
          goal: opts.trackGoal,
          topic: opts.trackTitle,
        });
        if (dbRow?.pkg && typeof dbRow.pkg === "object") {
          resolvedTrackPkg = dbRow.pkg as ResearchPackage;
        }
      } catch {}
    }

    let research: TopicResearchResult;
    if (allowTrackReuse && resolvedTrackPkg) {
      reusedTrackResearch = true;
      research = researchPackageToTopicResearchResult({
        pkg: resolvedTrackPkg,
        lesson,
        domain,
        learnerLevel,
        requestedMode,
      });
    } else {
      research = await researchLearningTopic({
        topic: `${opts.trackTitle ? `${opts.trackTitle} ` : ""}${lesson.title}`,
        goal: lesson.objective || opts.trackGoal || lesson.concept,
        learnerLevel,
        mode: requestedMode,
        userUrls: opts.userUrls,
        userNotes: opts.userNotes,
        forceRefresh: opts.forceRefresh,
        clientConfig: opts.clientConfig,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        fetchImpl: opts.fetchImpl,
        abortSignal: opts.abortSignal,
      });
    }

    // Stage 2: Real status -> drafting
    try {
      upsertLessonPreparationInDb({
        lessonId: lesson.id,
        trackId: opts.trackId ?? null,
        status: "drafting",
        mode: research.effectiveMode,
        learnerLevel,
        sources: research.sources,
      });
    } catch {}

    let synthesized: {
      brief: LessonResearchBrief;
      tutorial: DeepLessonTutorial;
    } | null = null;

    if (opts.model) {
      const sourceContext = research.sources
        .slice(0, 5)
        .map(
          (s, idx) =>
            `[来源 ${idx + 1}] ${s.title} (${s.siteName || s.url}, authority=${s.authority}, retrieved=${s.retrievedAt.slice(0, 10)})\n${s.excerpt}`,
        )
        .join("\n\n");

      const learnerDepthDirective =
        learnerLevel === "beginner"
          ? "学习者零基础：必须补足前置环境、依赖/前提准备、初学者易困惑术语解释和一步步可验证的最小示例，严禁一上来直接甩出黑盒代码或跳步结论。"
          : learnerLevel === "intermediate"
            ? "学习者有基础但未系统掌握本主题：重点讲清核心机制、请求/推导链路、典型工程或解题示例，以及最常踩的坑。"
            : "学习者已有进阶经验：精简入门铺垫，直接深入底层权衡、关键参数/边界条件、异常恢复与生产级实践。";

      const domainDirective =
        domain === "programming"
          ? "编程领域：示例应包含真实可运行片段、输入输出与错误处理；如涉及最新 SDK/API 且缺少来源依据，必须在 knowledgeGaps 中标注待核验。"
          : domain === "math"
            ? "数学领域：兼顾直观类比与严格定义/推导步骤，强调定理前提与常见反例。"
            : domain === "humanities"
              ? "人文历史领域：明确区分史实脉络与不同学术解释，在教程与误区中体现多元视角。"
              : "通用领域：结合真实场景、循序渐进案例与可验证行动步骤。";

      const contractDirective = effectiveContract
        ? [
            `【知识图谱边界契约（Lesson Contract v${effectiveBlueprintVersion} — 必须严格遵守！）】`,
            `- 承接前置（assumedPrior，只做简短衔接不重复长篇讲）：${effectiveContract.assumedPrior.join("；")}`,
            `- 本节核心范围（inScope，100% 聚焦于此）：${effectiveContract.inScope.join("；")}`,
            `- 本节推进步（progressionStep）：${effectiveContract.progressionStep}`,
            effectiveContract.deferredTo.length > 0
              ? `- 严禁越界抢讲（deferredTo / outOfScope）：${effectiveContract.deferredTo
                  .map((d) => `《${d.targetLessonTitle}》(${d.topic})`)
                  .join("；")} —— 这些属于后续课程节点，严禁在本节的正文或示例中提前讲完或写出后续课程的完整代码（仅允许在末尾一句话预告）！`
              : "- 本节为图谱终章节点，可完成综合收官验证。",
          ].join("\n")
        : "";

      try {
        const jsonContract = `{
  "brief": {
    "realProblem": "本课要解决的真实问题（2-3 句清晰连贯的话）",
    "prerequisites": ["承接先修要点 1", "承接先修要点 2"],
    "jargonGlossary": [
      { "term": "术语名", "plainExplanation": "初学者能秒懂的大白话解释" }
    ],
    "everydayAnalogy": "贴近日常生活的精准类比（2-3 句）",
    "progressiveExamples": [
      {
        "stage": "阶段 1 · 本节核心最小闭环",
        "title": "示例标题",
        "explanation": "为什么这样写、每一步发生了什么（严格限于本节 inScope）",
        "codeOrContent": "本节最小闭环代码或推导过程（严禁提前写出后续章节的内容）"
      },
      {
        "stage": "阶段 2 · 本节边界检验与下节衔接",
        "title": "示例标题",
        "explanation": "在本节范围内增加边界检验，并自然留出下一课的接口",
        "codeOrContent": "本节边界检验代码或验证清单（严禁剧透后继节点实现）"
      }
    ],
    "handsOnTask": "学习者在本节需要亲手完成的最小闭环任务描述",
    "commonMisconceptions": [
      { "misconception": "初学者最常犯的错误或误解", "correction": "清晰的纠偏与原因" }
    ],
    "masteryVerification": "可检查的掌握判定标准（不篡改客观题标准答案）",
    "knowledgeGaps": ["缺乏权威依据或版本时效待核验的条目，没有可传空数组"]
  },
  "tutorial": {
    "headline": "精炼教程标题",
    "whyItMatters": "1-2 句点明价值",
    "environmentOrContextSetup": "按学习者水平给出的课前环境/前置衔接（1-2 句）",
    "coreWalkthroughMarkdown": "模块化、聚焦本节 inScope 的精炼中文 Markdown 核心机制拆解（不写冗长水文，不重复 realProblem/everydayAnalogy，严禁越界抢讲后继节点内容）",
    "checkYourUnderstandingPrompt": "引导学习者进入练习区验证的一句话任务"
  }
}`;

        const isDeepSeek = isDeepSeekModelInstance(opts.model);
        const callCfg = buildDeepSeekCallConfig("structured_deep", {
          isDeepSeek,
          modelId: extractModelIdFromInstance(opts.model),
        });

        const sysText = [
          "你是「学径」的渐进式模块化课程设计师。请基于轨道研究资料与知识图谱边界契约（Lesson Contract），生成边界清晰、循序渐进、不剧透后续章节的本课基础教学底座。",
          learnerDepthDirective,
          domainDirective,
          contractDirective,
          "严格质量约束：",
          "1. 只输出一个合法 JSON 对象，不要附加任何开场白、解释文字或多余内容；字段名必须与下方模板 100% 一致：",
          jsonContract,
          "2. 严禁把检索到的网页原文、阅读量、发布日期或截断的半句话直接拼进教程，必须消化吸收后用干净、专业、循序渐进的中文教学语言重述。",
          "3. coreWalkthroughMarkdown 专注本节 inScope 核心原理与机制拆解，篇幅精炼清晰，留出 AI Tutor 动态互动与渐进引导的空间，严禁提前把后续课程的代码和机制一次性写完。",
          "4. 搜索结果不是事实证明：缺乏权威依据或版本时效待确认之处必须写入 brief.knowledgeGaps。",
          "5. 研究与评估分离：masteryVerification 只描述掌握判据，不修改客观题标准答案。",
          "6. jargonGlossary 至少 2 条，progressiveExamples 至少 2 个本节内递进小步，commonMisconceptions 至少 2 条。",
        ]
          .filter(Boolean)
          .join("\n");

        const promptText = [
          `课程标题：${lesson.title}`,
          neighborhood
            ? `图谱位置：第 ${neighborhood.positionIndex} / ${neighborhood.totalUnits} 课（蓝图版本 v${effectiveBlueprintVersion}）`
            : "",
          `学习目标：${lesson.objective || lesson.concept}`,
          `完成条件：${lesson.completionCriteria || "掌握核心机制并通过实践检测"}`,
          `既有教材概要：${lesson.concept}`,
          lesson.example ? `既有示例：\n${lesson.example}` : "",
          contractDirective ? `\n${contractDirective}` : "",
          `当前知识获取模式：${research.effectiveMode}${reusedTrackResearch ? "（复用轨道全局研究包）" : ""}${research.fallbackNotice ? `（${research.fallbackNotice}）` : ""}`,
          sourceContext
            ? `\n检索到的参考资料（请消化提炼，切勿原文复制或截断）：\n${sourceContext}`
            : "\n（无外部网页来源，请基于稳定知识生成，并将时效性内容写入 knowledgeGaps）",
        ]
          .filter(Boolean)
          .join("\n");

        let res = await generateText({
          model: opts.model,
          abortSignal: opts.abortSignal,
          maxOutputTokens: callCfg.maxOutputTokens,
          temperature: callCfg.temperature,
          providerOptions: callCfg.providerOptions as Parameters<
            typeof generateText
          >[0]["providerOptions"],
          system: sysText,
          prompt: promptText,
        });

        // DeepSeek JSON Mode guard (json_mode.md #4): retry once if whitespace-only content returned
        if (isDeepSeek && !res.text.trim()) {
          res = await generateText({
            model: opts.model,
            abortSignal: opts.abortSignal,
            maxOutputTokens: callCfg.maxOutputTokens,
            temperature: 0.2,
            providerOptions: callCfg.providerOptions as Parameters<
              typeof generateText
            >[0]["providerOptions"],
            system: sysText,
            prompt: `${promptText}\n\n请严格只输出一个合法 JSON 对象，不要附加任何非 JSON 文字。`,
          });
        }

        const parsedJson = extractJsonFromModelText(res.text);
        const validated = lessonBriefAndTutorialSchema.safeParse(parsedJson);
        if (validated.success) {
          const d = validated.data;
          synthesized = {
            brief: {
              ...d.brief,
              prerequisites: d.brief.prerequisites.slice(0, 6),
              jargonGlossary: d.brief.jargonGlossary.slice(0, 6),
              progressiveExamples: d.brief.progressiveExamples.slice(0, 4),
              commonMisconceptions: d.brief.commonMisconceptions.slice(0, 5),
              knowledgeGaps: d.brief.knowledgeGaps.slice(0, 6),
            },
            tutorial: d.tutorial,
          };
          for (const gap of research.unverifiedPoints) {
            if (!synthesized.brief.knowledgeGaps.includes(gap)) {
              synthesized.brief.knowledgeGaps.push(gap);
            }
          }
        } else {
          console.error(
            "[topic-researcher] LLM JSON schema validation mismatch:",
            validated.error.issues.slice(0, 4),
          );
        }
      } catch (err) {
        console.error(
          "[topic-researcher] LLM lesson brief synthesis failed, using structured fallback:",
          err,
        );
      }
    }

    if (!synthesized) {
      synthesized = buildDeterministicLessonBriefAndTutorial({
        lesson,
        trackGoal: opts.trackGoal || lesson.title,
        domain,
        learnerLevel,
        research,
        contract: effectiveContract,
        blueprintVersion: effectiveBlueprintVersion,
        reusedTrackResearch,
      });
    }

    // 4. Enforce Knowledge Graph Scope Contract & prune any downstream spoilers
    const enforced = enforceContractScopeOnBriefAndTutorial({
      lesson,
      brief: synthesized.brief,
      tutorial: synthesized.tutorial,
      contract: effectiveContract,
      blueprintVersion: effectiveBlueprintVersion,
      reusedTrackResearch,
    });
    synthesized = {
      brief: enforced.brief,
      tutorial: enforced.tutorial,
    };

    const qualityReport = evaluateLessonQuality(
      synthesized.brief,
      synthesized.tutorial,
      research.sources,
      research.effectiveMode,
      {
        contract: effectiveContract,
        currentLessonTitle: lesson.title,
        blocks: synthesized.tutorial.modularBlocks,
      },
    );
    const finalStatus: "ready" | "fallback" =
      research.effectiveMode === "quick_draft" && requestedMode === "auto_web"
        ? "fallback"
        : "ready";

    // 5. Persist modular LessonContent version into `lesson_content_versions` as well
    const capProfile = inferLearningCapabilityProfile(
      `${opts.trackTitle || ""} ${lesson.title} ${lesson.concept}`,
    );
    const depthMode =
      learnerLevel === "beginner"
        ? "beginner"
        : learnerLevel === "advanced"
          ? "concise"
          : "standard";
    const modularBlocks =
      synthesized.tutorial.modularBlocks ||
      buildModularTeachingBlocksFromBrief({
        lessonTitle: lesson.title,
        brief: synthesized.brief,
        tutorial: synthesized.tutorial,
        contract: effectiveContract,
      });
    const baseLessonContent = {
      contentId: `lc-${lesson.id}-v${effectiveBlueprintVersion}`,
      lessonId: lesson.id,
      trackId: opts.trackId ?? null,
      version: effectiveBlueprintVersion,
      depth: depthMode as "beginner" | "standard" | "concise",
      learningOutcomes: effectiveContract?.inScope?.length
        ? effectiveContract.inScope
        : [lesson.objective || lesson.title],
      blocks: modularBlocks,
      estimatedMinutes: lesson.minutes,
      researchPackageId:
        resolvedTrackPkg?.id ?? opts.researchPackageId ?? null,
      blueprintId: opts.blueprintId ?? null,
      blueprintVersion: effectiveBlueprintVersion,
      contract: effectiveContract,
      knowledgeGaps: synthesized.brief.knowledgeGaps,
    };
    const fourLayerReport: FourLayerQualityReport =
      evaluateLessonContentFourLayers({
        content: baseLessonContent,
        profile: capProfile,
        researchPackage: resolvedTrackPkg,
        contract: effectiveContract,
        currentLessonTitle: lesson.title,
        isFallbackTemplate: !opts.model && finalStatus === "fallback",
      });
    const lessonContentRecord: LessonContent = {
      ...baseLessonContent,
      qualityReport: fourLayerReport,
      status: finalStatus === "ready" ? "ready" : "limited",
    };

    try {
      saveLessonContentVersionToDb({
        contentId: lessonContentRecord.contentId,
        lessonId: lesson.id,
        trackId: opts.trackId ?? null,
        version: effectiveBlueprintVersion,
        depth: depthMode,
        status: lessonContentRecord.status,
        researchPackageId: lessonContentRecord.researchPackageId,
        blueprintId: lessonContentRecord.blueprintId,
        content: lessonContentRecord,
        qualityReport: fourLayerReport,
      });
    } catch {}

    const savedRow = upsertLessonPreparationInDb({
      lessonId: lesson.id,
      trackId: opts.trackId ?? null,
      status: finalStatus,
      mode: research.effectiveMode,
      learnerLevel,
      brief: synthesized.brief,
      tutorial: synthesized.tutorial,
      sources: research.sources,
      qualityReport,
      errorMessage: null,
    });

    return {
      lessonId: lesson.id,
      trackId: opts.trackId ?? null,
      status: finalStatus,
      mode: requestedMode,
      effectiveMode: research.effectiveMode,
      domain,
      learnerLevel,
      cacheHit: false,
      reusedTrackResearch,
      blueprintVersion: effectiveBlueprintVersion,
      contract: effectiveContract,
      lessonContent: lessonContentRecord,
      preparedAt: savedRow.updatedAt,
      brief: synthesized.brief,
      tutorial: synthesized.tutorial,
      sources: research.sources,
      qualityReport,
      fallbackNotice: research.fallbackNotice,
    };
  };

  const promise = runPrep().finally(() => {
    inFlightLessonPreps.delete(dedupeKey);
  });
  if (!opts.forceRefresh) {
    inFlightLessonPreps.set(dedupeKey, promise);
  }
  return promise;
}

/**
 * Rolling N+1 Preparation (Section 5: 自动准备与 N+1 滚动预热):
 * Silently prewarms ONLY the immediate next lesson (N+1) in the active track's Knowledge Graph,
 * reusing the track's global ResearchPackage and respecting in-flight deduplication and blueprintVersion.
 * Never pre-generates all chapters at once!
 */
export async function triggerRollingPrewarmForNextLesson(opts: {
  track: GoalPlan;
  currentLessonId: string;
  masteryMap?: Record<string, number>;
  model?: LanguageModel | string | null;
  clientConfig?: ClientModelConfig | null;
}): Promise<{ prewarmedLessonId: string | null; cacheHit?: boolean }> {
  const nextLesson = resolveNextRollingLesson(
    opts.track.units,
    opts.currentLessonId,
    opts.masteryMap || {},
  );
  if (!nextLesson) {
    return { prewarmedLessonId: null };
  }

  const res = await prepareLessonInDepth({
    lesson: nextLesson,
    trackId: opts.track.id,
    trackTitle: opts.track.title,
    trackGoal: opts.track.goal,
    trackUnits: opts.track.units,
    blueprintId: opts.track.blueprintId,
    blueprintVersion: opts.track.blueprintVersion ?? 1,
    researchPackageId: opts.track.researchPackageId,
    masteryMap: opts.masteryMap,
    reuseTrackResearch: true,
    learnerLevel: opts.track.priorKnowledge || "intermediate",
    mode: "auto_web",
    model: opts.model ?? null,
    clientConfig: opts.clientConfig,
  });

  return {
    prewarmedLessonId: nextLesson.id,
    cacheHit: res.cacheHit,
  };
}
