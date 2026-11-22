import {
  type Block,
  type DeferredTopicEntry,
  type GoalPlan,
  type Lesson,
  type LessonContract,
  type PriorKnowledgeLevel,
  type Store,
  type TrackDepth,
  free,
  hasPrerequisiteCycle,
  offset,
} from "./learning";
import {
  extractMemoryPreferences,
  getWakingBounds,
  isWithinSleep,
} from "./scheduler";

function shortUuid(len = 8): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID().slice(0, len);
  }
  return Math.random().toString(36).slice(2, 2 + len);
}

export const MIN_DYNAMIC_LESSONS = 1;
export const MAX_DYNAMIC_LESSONS = 64;

export const TRACK_DEPTH_LABELS: Record<TrackDepth, string> = {
  crash: "速通聚焦",
  standard: "实战标准",
  deep: "系统深入",
};

export type LessonCountRecommendation = {
  min: number;
  max: number;
  recommended: number;
  depth: TrackDepth;
  priorKnowledge: PriorKnowledgeLevel;
  rationale: string;
};

/**
 * E2E-001: Dynamically determine target lesson count based on goal complexity,
 * prior knowledge, deadline/time budget, depth preference, and prerequisite depth.
 * Never forces 6 lessons across all goals.
 */
export function recommendLessonCount(input: {
  goal: string;
  priorKnowledge?: PriorKnowledgeLevel;
  days?: number;
  dailyMinutes?: number;
  depth?: TrackDepth;
  scopeNote?: string;
  dependencyCount?: number;
  avgLessonMinutes?: number;
}): LessonCountRecommendation {
  const goalText = `${input.goal || ""} ${input.scopeNote || ""}`.trim();
  const depth: TrackDepth =
    input.depth ||
    (/速通|快速|入门体验|1天|周末|冲刺|最小可用|MVP/i.test(goalText)
      ? "crash"
      : /系统|深入|架构|原理|精通|全面|完整|从零到精通|生产级/i.test(goalText)
        ? "deep"
        : "standard");

  const priorKnowledge: PriorKnowledgeLevel =
    input.priorKnowledge ||
    (/零基础|没学过|小白|初学者|新手/i.test(goalText)
      ? "beginner"
      : /有经验|进阶|熟悉|已有基础|高级|资深/i.test(goalText)
        ? "advanced"
        : "intermediate");

  // 1. Base count from depth
  let base = depth === "crash" ? 2 : depth === "deep" ? 9 : 5;

  // 2. Complexity adjustment from goal breadth (multi-topic clauses / keywords)
  const clauseMarkers = (goalText.match(/[、,，+＋&/]|以及|和|到/g) || []).length;
  if (clauseMarkers >= 3) base += 2;
  else if (clauseMarkers >= 1 && depth !== "crash") base += 1;
  if (/单点|仅|只学|排查|修复|一个概念/i.test(goalText)) base -= 1;

  // 3. Prior knowledge adjustment (beginners need prereqs; advanced skips basics)
  if (priorKnowledge === "beginner") base += 1;
  if (priorKnowledge === "advanced") base -= 1;

  // 4. Prerequisite dependency floor
  if (
    typeof input.dependencyCount === "number" &&
    input.dependencyCount > 0
  ) {
    base = Math.max(base, input.dependencyCount + 1);
  }

  // 5. Deadline & time budget constraint
  const avgLessonMin = Math.max(15, Math.min(90, input.avgLessonMinutes ?? 35));
  const days =
    typeof input.days === "number" && input.days > 0 ? input.days : undefined;
  const dailyMin =
    typeof input.dailyMinutes === "number" && input.dailyMinutes > 0
      ? input.dailyMinutes
      : undefined;

  let budgetCap = MAX_DYNAMIC_LESSONS;
  let budgetNote = "";
  if (days !== undefined) {
    const effectiveDaily = dailyMin ?? 45;
    const totalMinutes = days * effectiveDaily;
    budgetCap = Math.max(1, Math.min(MAX_DYNAMIC_LESSONS, Math.floor(totalMinutes / avgLessonMin) || 1));
    if (base > budgetCap) {
      budgetNote = `受 ${days} 天 × ${effectiveDaily} 分钟时间预算约束，收敛至 ${budgetCap} 节可执行微课`;
      base = budgetCap;
    } else if (days >= 21 && depth === "deep" && base < 8) {
      base = Math.min(budgetCap, 8);
    }
  }

  const recommended = Math.max(
    MIN_DYNAMIC_LESSONS,
    Math.min(MAX_DYNAMIC_LESSONS, Math.round(base)),
  );
  const min = Math.max(
    MIN_DYNAMIC_LESSONS,
    depth === "crash" ? 1 : recommended - 1,
  );
  const max = Math.min(
    MAX_DYNAMIC_LESSONS,
    Math.max(recommended, Math.min(budgetCap, recommended + 2)),
  );

  const rationaleParts = [
    `深度定位：${TRACK_DEPTH_LABELS[depth]}`,
    `基础水平：${priorKnowledge === "beginner" ? "零基础/入门（含先修铺垫）" : priorKnowledge === "advanced" ? "进阶（精简基础）" : "中等"}`,
    budgetNote || `建议范围 ${min}–${max} 节（推荐 ${recommended} 节）`,
  ];

  return {
    min,
    max,
    recommended,
    depth,
    priorKnowledge,
    rationale: rationaleParts.join("；"),
  };
}

/**
 * Ensures every lesson carries explicit learning objective and completion criteria.
 */
export function normalizeLessonGoalFields(lesson: Lesson): Lesson {
  const objective =
    lesson.objective?.trim() ||
    `理解并掌握「${lesson.title}」：${(lesson.concept || lesson.subtitle || lesson.title).slice(0, 72)}`;
  const completionCriteria =
    lesson.completionCriteria?.trim() ||
    (lesson.practiceType === "code"
      ? `完成「${lesson.title}」动手代码实现并通过本课检测（掌握度 ≥ 80%）`
      : `用自己的话讲清「${lesson.title}」核心机制并通过本课检测（掌握度 ≥ 80%）`);
  return {
    ...lesson,
    objective,
    completionCriteria,
  };
}

export type CurriculumSectionGroup = {
  sectionIndex: number;
  globalSectionCode: string;
  sectionTitle: string;
  sectionSubtitle?: string;
  units: Lesson[];
};

export type CurriculumStageGroup = {
  stageIndex: number;
  stageTitle: string;
  stageSubtitle: string;
  sections: CurriculumSectionGroup[];
  units: Lesson[];
};

const CHINESE_CHAPTER_NUMS = [
  "一",
  "二",
  "三",
  "四",
  "五",
  "六",
  "七",
  "八",
  "九",
  "十",
  "十一",
  "十二",
];

function formatChineseChapterPrefix(chapterIdx1Based: number): string {
  const cn =
    CHINESE_CHAPTER_NUMS[chapterIdx1Based - 1] || String(chapterIdx1Based);
  return `第${cn}章`;
}

function extractCoreTopicPhrase(title: string): string {
  const cleaned = (title || "")
    .replace(
      /^(?:第\s*[\d一二三四五六七八九十百]+\s*[章节课步篇讲单元]|Lesson\s*\d+|Step\s*\d+|\d+(?:\.\d+)?)\s*[:：·\.\-—\s]*/i,
      "",
    )
    .trim();
  if (!cleaned) return "核心专题";
  const head = cleaned.split(/[:：—\-（(]/)[0]?.trim() || cleaned;
  return head.length > 16 ? head.slice(0, 16) : head;
}

function synthesizeClusterTopicTitle(clusterUnits: Lesson[]): string {
  const phrases: string[] = [];
  for (const u of clusterUnits) {
    const p = extractCoreTopicPhrase(u.title);
    if (p && !phrases.includes(p)) {
      phrases.push(p);
    }
  }
  if (phrases.length === 0) return "核心知识专题";
  if (phrases.length === 1) return phrases[0];
  if (phrases.length === 2) return `${phrases[0]}与${phrases[1]}`;
  return `${phrases[0]}、${phrases[1]}与${phrases[phrases.length - 1]}`;
}

function computeMaxTopologicalDepth(units: Lesson[]): number {
  const byId = new Map(units.map((u) => [u.id, u]));
  const memo = new Map<string, number>();
  function depthOf(id: string, visiting = new Set<string>()): number {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const u = byId.get(id);
    if (!u) return 0;
    const reqs = (u.requires || []).filter((r) => byId.has(r));
    const d = reqs.length
      ? Math.max(...reqs.map((r) => depthOf(r, visiting) + 1))
      : 0;
    visiting.delete(id);
    memo.set(id, d);
    return d;
  }
  let maxD = 0;
  for (const u of units) {
    maxD = Math.max(maxD, depthOf(u.id));
  }
  return maxD;
}

/**
 * Restructures over-serialized linear "single-stick" chains (where an LLM lazily chained
 * `u0 -> u1 -> u2 -> ... -> uN` for N >= 5) into an authentic multi-stage Knowledge Graph DAG,
 * while 100% preserving any LLM-authored custom 大章节 (`stageTitle`) & 小章节 (`moduleTitle`).
 * When a track lacks explicit `stageTitle` or `moduleTitle`, dynamically derives domain-specific
 * 大章节 and 小章节 titles from the actual lesson concepts (never hardcoded generic boilerplate).
 */
export function normalizeKnowledgeGraphTopology(units: Lesson[]): Lesson[] {
  if (!Array.isArray(units) || units.length === 0) return [];
  const n = units.length;
  const maxDepth = computeMaxTopologicalDepth(units);

  // Detect over-serialized single chain: N >= 5 and depth is >= N - 2
  const isOverSerializedChain = n >= 5 && maxDepth >= n - 2;

  const cloned = units.map((u) => ({
    ...u,
    requires: [...(u.requires || [])],
  }));

  if (isOverSerializedChain) {
    if (n >= 9) {
      const coreHubIdx = 4;
      const capStart = 5;
      const engStart = Math.max(capStart + 2, n - 3);

      cloned[0].requires = [];
      cloned[1].requires = [];
      cloned[2].requires = [cloned[0].id, cloned[1].id];
      cloned[3].requires = [cloned[0].id, cloned[1].id];
      cloned[coreHubIdx].requires = [cloned[2].id, cloned[3].id];

      // Parallel capability branches off Core Hub (chunked into balanced layers if n > 12)
      const capIds: string[] = [];
      for (let i = capStart; i < engStart; i++) {
        const offsetInCap = i - capStart;
        if (offsetInCap < 4) {
          cloned[i].requires = [cloned[coreHubIdx].id];
        } else {
          // For larger curricula (e.g. 15–64 lessons), chain subsequent capability waves every 4 parallel nodes
          const parentCapIdx = capStart + (offsetInCap - 4);
          cloned[i].requires = [cloned[parentCapIdx].id];
        }
        capIds.push(cloned[i].id);
      }

      // Engineering / Verification nodes before capstone
      const engIds: string[] = [];
      for (let i = engStart; i < n - 1; i++) {
        const pairedCap =
          capIds[(i - engStart) % Math.max(1, capIds.length)] ||
          cloned[coreHubIdx].id;
        cloned[i].requires = [cloned[coreHubIdx].id, pairedCap].filter(
          (v, idx, arr) => arr.indexOf(v) === idx,
        );
        engIds.push(cloned[i].id);
      }

      // Final Capstone convergence
      const capstoneReqs =
        engIds.length > 0
          ? [...capIds.slice(-1), ...engIds]
          : capIds.length > 0
            ? capIds
            : [cloned[n - 2].id];
      cloned[n - 1].requires = capstoneReqs.filter(
        (v, idx, arr) => arr.indexOf(v) === idx,
      );
    } else {
      // 5–8 lessons:
      const anchorIdx = n >= 7 ? 2 : 1;
      cloned[0].requires = [];
      for (let i = 1; i <= anchorIdx; i++) {
        cloned[i].requires = [cloned[i - 1].id];
      }
      const branchIds: string[] = [];
      for (let i = anchorIdx + 1; i < n - 1; i++) {
        cloned[i].requires = [cloned[anchorIdx].id];
        branchIds.push(cloned[i].id);
      }
      cloned[n - 1].requires =
        branchIds.length > 0 ? branchIds : [cloned[anchorIdx].id];
    }
  }

  // Partition lessons without explicit stageTitle into topic-derived chapters & sub-chapters
  const bucketIndexForUnit = (idx: number): number => {
    if (n <= 1) return 0;
    if (n <= 3) return idx === 0 ? 0 : idx === n - 1 ? 1 : 0;
    if (n <= 6) return idx <= 1 ? 0 : idx < n - 1 ? 1 : 2;
    if (n <= 12) {
      const ratio = idx / (n - 1);
      if (ratio <= 0.22) return 0;
      if (ratio <= 0.45) return 1;
      if (ratio <= 0.75) return 2;
      return 3;
    }
    return Math.floor(idx / 4);
  };

  // Pre-group units by their explicit stageTitle OR dynamic bucket index to synthesize domain-specific chapter titles
  const bucketUnits = new Map<number, Lesson[]>();
  cloned.forEach((u, idx) => {
    const b = bucketIndexForUnit(idx);
    const list = bucketUnits.get(b) || [];
    list.push(u);
    bucketUnits.set(b, list);
  });

  const synthesizedStageTitleByBucket = new Map<number, string>();
  let chapterCounter = 1;
  for (const [b, list] of bucketUnits.entries()) {
    const prefix = formatChineseChapterPrefix(chapterCounter++);
    const topicSummary = synthesizeClusterTopicTitle(list);
    synthesizedStageTitleByBucket.set(b, `${prefix} · ${topicSummary}`);
  }

  const withStages = cloned.map((u, idx) => {
    const existingStage = u.stageTitle?.trim();
    if (existingStage) {
      return {
        ...u,
        stageTitle: existingStage,
        moduleTitle: u.moduleTitle?.trim() || undefined,
      };
    }
    const b = bucketIndexForUnit(idx);
    return {
      ...u,
      stageTitle:
        synthesizedStageTitleByBucket.get(b) ||
        `${formatChineseChapterPrefix(b + 1)} · ${extractCoreTopicPhrase(u.title)}`,
      moduleTitle: u.moduleTitle?.trim() || undefined,
    };
  });

  // For any chapter whose units lack `moduleTitle` (小章节), synthesize meaningful sub-chapters (every 1–2 related units)
  const unitsByStage = new Map<string, Lesson[]>();
  for (const u of withStages) {
    const st = u.stageTitle!;
    const arr = unitsByStage.get(st) || [];
    arr.push(u);
    unitsByStage.set(st, arr);
  }

  const inferredModuleByLessonId = new Map<string, string>();
  let stageOrd = 0;
  for (const [, stageUnits] of unitsByStage.entries()) {
    stageOrd += 1;
    const allHaveExplicitModule = stageUnits.every((u) =>
      Boolean(u.moduleTitle?.trim()),
    );
    if (allHaveExplicitModule) continue;

    // Group lessons inside this chapter into sub-chapters of size 2 (or 1 for singletons)
    const chunkSize = stageUnits.length <= 2 ? 1 : 2;
    let secOrd = 0;
    for (let i = 0; i < stageUnits.length; i += chunkSize) {
      secOrd += 1;
      const chunk = stageUnits.slice(i, i + chunkSize);
      const explicitInChunk = chunk.find((c) => c.moduleTitle?.trim())?.moduleTitle?.trim();
      const secTitle =
        explicitInChunk ||
        `${stageOrd}.${secOrd} ${synthesizeClusterTopicTitle(chunk)}`;
      for (const cu of chunk) {
        if (!cu.moduleTitle?.trim()) {
          inferredModuleByLessonId.set(cu.id, secTitle);
        }
      }
    }
  }

  return withStages.map((u) => ({
    ...u,
    moduleTitle: u.moduleTitle?.trim() || inferredModuleByLessonId.get(u.id) || extractCoreTopicPhrase(u.title),
  }));
}

/**
 * Groups a track's units into a 2-level hierarchy:
 * - 大章节 (`CurriculumStageGroup`: `stageTitle`, `stageSubtitle`, `sections`, `units`)
 * - 小章节 (`CurriculumSectionGroup`: `sectionTitle`, `globalSectionCode`, `units`)
 * Preserves 100% of LLM-authored custom chapter and sub-chapter names and counts.
 */
export function groupLessonsIntoStages(
  units: Lesson[],
): CurriculumStageGroup[] {
  const normalized = normalizeKnowledgeGraphTopology(units);
  const groups: CurriculumStageGroup[] = [];
  const byTitle = new Map<string, CurriculumStageGroup>();

  for (const u of normalized) {
    const title =
      u.stageTitle?.trim() ||
      `第一章 · ${extractCoreTopicPhrase(u.title)}`;
    let g = byTitle.get(title);
    if (!g) {
      g = {
        stageIndex: groups.length + 1,
        stageTitle: title,
        stageSubtitle: u.stageSubtitle?.trim() || "",
        sections: [],
        units: [],
      };
      byTitle.set(title, g);
      groups.push(g);
    }
    if (!g.stageSubtitle && u.stageSubtitle?.trim()) {
      g.stageSubtitle = u.stageSubtitle.trim();
    }
    g.units.push(u);
  }

  // Populate nested sub-chapters (`sections`) and dynamic stage subtitles inside each chapter
  for (const g of groups) {
    const secMap = new Map<string, CurriculumSectionGroup>();
    for (const u of g.units) {
      const rawSecTitle =
        u.moduleTitle?.trim() || extractCoreTopicPhrase(u.title);
      let sec = secMap.get(rawSecTitle);
      if (!sec) {
        const secIdx = g.sections.length + 1;
        const codePrefix = `${g.stageIndex}.${secIdx}`;
        const cleanedTitle = rawSecTitle
          .replace(/^\d+\.\d+\s*[·\.\s:-]*/g, "")
          .trim() || rawSecTitle;
        sec = {
          sectionIndex: secIdx,
          globalSectionCode: codePrefix,
          sectionTitle: cleanedTitle,
          sectionSubtitle: u.moduleSubtitle?.trim(),
          units: [],
        };
        secMap.set(rawSecTitle, sec);
        g.sections.push(sec);
      }
      if (!sec.sectionSubtitle && u.moduleSubtitle?.trim()) {
        sec.sectionSubtitle = u.moduleSubtitle.trim();
      }
      sec.units.push(u);
    }

    if (!g.stageSubtitle) {
      const secNames = g.sections.map((s) => s.sectionTitle).slice(0, 3);
      g.stageSubtitle =
        secNames.length > 0
          ? `涵盖小节：${secNames.join(" · ")}${g.sections.length > 3 ? ` 等 ${g.sections.length} 个子专题` : ""}`
          : synthesizeClusterTopicTitle(g.units);
    }
  }

  return groups;
}

export type LessonGraphNeighborhood = {
  lesson: Lesson;
  contract: LessonContract;
  positionIndex: number; // 1-based topological/track index
  totalUnits: number;
  blueprintVersion: number;
  predecessors: Array<{
    id: string;
    title: string;
    concept: string;
    objective?: string;
    mastery: number;
    mastered: boolean;
  }>;
  directSuccessors: Array<{
    id: string;
    title: string;
    concept: string;
    objective?: string;
  }>;
  laterUnits: Array<{
    id: string;
    title: string;
    concept: string;
    objective?: string;
  }>;
};

/**
 * Derives versioned `LessonContract`s across all lessons in a Knowledge Graph (DAG).
 * Explicitly defines:
 * - `assumedPrior`: inherited from prerequisite nodes (do not re-explain at length)
 * - `inScope`: core concepts & minimum verifiable deliverables of this node
 * - `outOfScope` & `deferredTo`: topics & full implementations reserved for downstream nodes (no spoilers!)
 * - `progressionStep`: exact step in the track's progressive arc
 *
 * When `preserveMasteredContracts` is true, already mastered lessons (`mastery >= 80`) keep
 * their existing contract snapshot untouched so completed learning history stays immutable.
 */
export function deriveGraphLessonContracts(
  units: Lesson[],
  opts: {
    blueprintVersion?: number;
    mastery?: Record<string, number>;
    preserveMasteredContracts?: boolean;
    normalizeTopology?: boolean;
  } = {},
): Lesson[] {
  const version = Math.max(1, opts.blueprintVersion ?? 1);
  const topologyUnits = opts.normalizeTopology
    ? normalizeKnowledgeGraphTopology(units)
    : units;
  const normalized = topologyUnits.map((u) => normalizeLessonGoalFields({ ...u }));
  const unitById = new Map(normalized.map((u) => [u.id, u]));
  const total = normalized.length;

  // Build downstream adjacency (direct + transitive)
  const directDownstream = new Map<string, Lesson[]>();
  for (const u of normalized) directDownstream.set(u.id, []);
  for (const u of normalized) {
    for (const reqId of u.requires || []) {
      if (directDownstream.has(reqId)) {
        directDownstream.get(reqId)!.push(u);
      }
    }
  }

  return normalized.map((u, idx) => {
    const isMastered = (opts.mastery?.[u.id] ?? 0) >= 80;
    if (opts.preserveMasteredContracts && isMastered && u.contract) {
      return u;
    }

    const existing = u.contract;
    const preds = (u.requires || [])
      .map((id) => unitById.get(id))
      .filter((p): p is Lesson => Boolean(p));

    // Direct dependents + any subsequent lessons in track sequence
    const directSuccs = directDownstream.get(u.id) || [];
    const seenDownstream = new Set<string>();
    const downstreamOrdered: Lesson[] = [];
    for (const s of [...directSuccs, ...normalized.slice(idx + 1)]) {
      if (s.id !== u.id && !seenDownstream.has(s.id)) {
        seenDownstream.add(s.id);
        downstreamOrdered.push(s);
      }
    }

    const derivedAssumedPrior = preds.map(
      (p) => `已学前置《${p.title}》：${(p.objective || p.concept).slice(0, 72)}`,
    );
    const assumedPrior =
      existing?.assumedPrior?.length && existing.blueprintVersion === version
        ? existing.assumedPrior
        : derivedAssumedPrior.length > 0
          ? derivedAssumedPrior
          : ["本节为知识图谱起点节点，无需前置课程基础，从核心直觉与最小闭环切入"];

    const derivedInScope = [
      u.objective || `掌握「${u.title}」核心原理`,
      `核心机制：${u.concept}`,
      `最小可验证成果：${u.completionCriteria || `完成「${u.title}」基础验证`}`,
    ];
    const inScope =
      existing?.inScope?.length && existing.blueprintVersion === version
        ? existing.inScope
        : derivedInScope;

    const deferredTo: DeferredTopicEntry[] =
      existing?.deferredTo?.length && existing.blueprintVersion === version
        ? existing.deferredTo
        : downstreamOrdered.slice(0, 5).map((dn) => ({
            topic: `${dn.title}（${(dn.concept || dn.objective || "").slice(0, 56)}）`,
            targetLessonId: dn.id,
            targetLessonTitle: dn.title,
            reason: directSuccs.some((d) => d.id === dn.id)
              ? "直接后继节点核心内容，本节仅做铺垫不提前展开完整实现"
              : "后续章节进阶主题，严禁在本节提前剧透或堆砌代码",
          }));

    const outOfScope =
      existing?.outOfScope?.length && existing.blueprintVersion === version
        ? existing.outOfScope
        : deferredTo.map(
            (d) =>
              `《${d.targetLessonTitle}》的核心机制与完整实现（留到对应后续节点深入，本节最多一句话预告）`,
          );

    const nextUnit = directSuccs[0] || normalized[idx + 1] || null;
    const progressionStep =
      existing?.progressionStep && existing.blueprintVersion === version
        ? existing.progressionStep
        : nextUnit
          ? `第 ${idx + 1}/${total} 步：本节只完成「${u.title}」的最小闭环验证；完成后将在下一节《${nextUnit.title}》自然衔接到「${(nextUnit.concept || nextUnit.title).slice(0, 44)}」。`
          : `第 ${idx + 1}/${total} 步（终章收官）：综合前序节点能力完成「${u.title}」的完整闭环验证。`;

    return {
      ...u,
      contract: {
        assumedPrior,
        inScope,
        outOfScope,
        deferredTo,
        progressionStep,
        blueprintVersion: version,
      },
    };
  });
}

/**
 * Resolves the complete Knowledge Graph neighborhood and versioned `LessonContract`
 * for any lesson in a track, powering:
 * 1. Lesson Preparation (graph-aware scope boundaries)
 * 2. 4-Layer Quality Gate (scope-overreach verification)
 * 3. Teaching Planner / AI Tutor (depth & bridge teaser awareness)
 */
export function resolveGraphNeighborsForLesson(
  units: Lesson[],
  lessonId: string,
  opts: {
    blueprintVersion?: number;
    mastery?: Record<string, number>;
  } = {},
): LessonGraphNeighborhood | null {
  if (!Array.isArray(units) || units.length === 0) return null;
  const version = Math.max(1, opts.blueprintVersion ?? 1);
  const withContracts = deriveGraphLessonContracts(units, {
    blueprintVersion: version,
    mastery: opts.mastery,
    preserveMasteredContracts: true,
  });
  const idx = withContracts.findIndex((u) => u.id === lessonId);
  if (idx < 0) return null;

  const target = withContracts[idx];
  const byId = new Map(withContracts.map((u) => [u.id, u]));
  const predecessors = (target.requires || [])
    .map((reqId) => byId.get(reqId))
    .filter((p): p is Lesson => Boolean(p))
    .map((p) => {
      const m = opts.mastery?.[p.id] ?? 0;
      return {
        id: p.id,
        title: p.title,
        concept: p.concept,
        objective: p.objective,
        mastery: m,
        mastered: m >= 80,
      };
    });

  const directSuccessors = withContracts
    .filter((u) => (u.requires || []).includes(target.id))
    .map((u) => ({
      id: u.id,
      title: u.title,
      concept: u.concept,
      objective: u.objective,
    }));

  const directIds = new Set(directSuccessors.map((d) => d.id));
  const laterUnits = [
    ...directSuccessors,
    ...withContracts
      .slice(idx + 1)
      .filter((u) => !directIds.has(u.id))
      .map((u) => ({
        id: u.id,
        title: u.title,
        concept: u.concept,
        objective: u.objective,
      })),
  ];

  return {
    lesson: target,
    contract: target.contract!,
    positionIndex: idx + 1,
    totalUnits: withContracts.length,
    blueprintVersion: target.contract?.blueprintVersion ?? version,
    predecessors,
    directSuccessors,
    laterUnits,
  };
}

/**
 * Resolves the immediate next candidate lesson (N+1) for silent rolling background preparation.
 * Only selects a single downstream/subsequent unmastered lesson — never pre-generates the entire track!
 */
export function resolveNextRollingLesson(
  units: Lesson[],
  currentLessonId: string,
  mastery: Record<string, number> = {},
): Lesson | null {
  if (!Array.isArray(units) || units.length <= 1) return null;
  const idx = units.findIndex((u) => u.id === currentLessonId);
  if (idx < 0) return null;

  // 1. Prefer direct dependent lesson whose other prerequisites are already met
  const current = units[idx];
  const directDep = units.find(
    (u) =>
      u.id !== current.id &&
      (mastery[u.id] ?? 0) < 80 &&
      (u.requires || []).includes(current.id) &&
      (u.requires || []).every(
        (r) => r === current.id || (mastery[r] ?? 0) >= 80,
      ),
  );
  if (directDep) return directDep;

  // 2. Otherwise pick the immediate next unmastered lesson in sequence
  for (let i = idx + 1; i < units.length; i++) {
    if ((mastery[units[i].id] ?? 0) < 80) {
      return units[i];
    }
  }
  return null;
}

/**
 * Feedback loop #4 (测验反哺图谱):
 * Dynamically adapts unmastered downstream nodes' `LessonContract` based on real assessment
 * evidence (e.g., reinforcing weak prerequisite concepts in downstream `assumedPrior` or
 * recording verified mastery handoff), while 100% preserving mastered nodes and history.
 */
export function adaptTrackContractsFromAssessment(
  plan: GoalPlan,
  opts: {
    assessedLessonId: string;
    correct: boolean;
    masteryAfter: number;
    misconceptionNote?: string;
    masteryMap: Record<string, number>;
  },
): { plan: GoalPlan; updatedLessonIds: string[]; nextBlueprintVersion: number } {
  const currentVersion = plan.blueprintVersion ?? 1;
  const assessed = plan.units.find((u) => u.id === opts.assessedLessonId);
  if (!assessed) {
    return {
      plan,
      updatedLessonIds: [],
      nextBlueprintVersion: currentVersion,
    };
  }

  const nextVersion = currentVersion + 1;
  const updatedLessonIds: string[] = [];

  const updatedUnits = deriveGraphLessonContracts(plan.units, {
    blueprintVersion: currentVersion,
    mastery: opts.masteryMap,
    preserveMasteredContracts: true,
  }).map((u) => {
    const isMastered = (opts.masteryMap[u.id] ?? 0) >= 80;
    const dependsOnAssessed = (u.requires || []).includes(assessed.id);
    if (isMastered || !dependsOnAssessed || !u.contract) {
      return u;
    }

    updatedLessonIds.push(u.id);
    const bridgeNote = opts.correct
      ? `前置《${assessed.title}》已验证掌握（${opts.masteryAfter}%），可直接承接其核心成果进入本节`
      : `前置《${assessed.title}》近期存在薄弱点（${opts.misconceptionNote || "需注意概念边界"}），本节开篇需做 1 分钟针对性衔接强化`;

    const filteredPrior = u.contract.assumedPrior.filter(
      (p) => !p.includes(`《${assessed.title}》`),
    );

    return {
      ...u,
      contract: {
        ...u.contract,
        assumedPrior: [bridgeNote, ...filteredPrior],
        blueprintVersion: nextVersion,
      },
    };
  });

  if (updatedLessonIds.length === 0) {
    return {
      plan,
      updatedLessonIds: [],
      nextBlueprintVersion: currentVersion,
    };
  }

  return {
    plan: {
      ...plan,
      version: `${plan.id}-v${nextVersion}`,
      blueprintVersion: nextVersion,
      units: updatedUnits,
    },
    updatedLessonIds,
    nextBlueprintVersion: nextVersion,
  };
}

export type TrackValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  topologicalOrder: string[];
};

/**
 * Validates lesson count bounds, explicit objectives & completion criteria,
 * prerequisite existence, non-self dependencies, and DAG acyclicity (Kahn's algorithm).
 */
export function validateTrackUnits(
  units: Lesson[],
  opts: { strictGoalFields?: boolean } = {},
): TrackValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Array.isArray(units) || units.length < MIN_DYNAMIC_LESSONS) {
    return {
      ok: false,
      errors: [`学习轨道至少需要 ${MIN_DYNAMIC_LESSONS} 节课程。`],
      warnings,
      topologicalOrder: [],
    };
  }
  if (units.length > MAX_DYNAMIC_LESSONS) {
    errors.push(
      `单条学习轨道最多支持 ${MAX_DYNAMIC_LESSONS} 节课程（当前 ${units.length} 节），建议拆分阶段。`,
    );
  }

  const seenIds = new Set<string>();
  for (const u of units) {
    if (!u.id?.trim()) {
      errors.push("存在缺少 id 的课程节点。");
    } else if (seenIds.has(u.id)) {
      errors.push(`存在重复的课程 id：${u.id}`);
    } else {
      seenIds.add(u.id);
    }

    if (!u.title?.trim()) {
      errors.push(`课程 ${u.id || "(未知)"} 缺少标题。`);
    }
    if (!u.objective?.trim()) {
      if (opts.strictGoalFields) {
        errors.push(`课程「${u.title || u.id}」缺少明确的学习目标（objective）。`);
      } else {
        warnings.push(`课程「${u.title || u.id}」未提供 objective，将自动补齐。`);
      }
    }
    if (!u.completionCriteria?.trim()) {
      if (opts.strictGoalFields) {
        errors.push(
          `课程「${u.title || u.id}」缺少明确的完成条件（completionCriteria）。`,
        );
      } else {
        warnings.push(
          `课程「${u.title || u.id}」未提供 completionCriteria，将自动补齐。`,
        );
      }
    }
  }

  // Check self-dependencies & dangling prerequisites
  for (const u of units) {
    const reqSet = new Set<string>();
    for (const req of u.requires || []) {
      if (req === u.id) {
        errors.push(`课程「${u.title}」不能依赖自身（${req}）。`);
      } else if (!seenIds.has(req)) {
        errors.push(`课程「${u.title}」引用了不存在的先修课程：${req}`);
      } else if (reqSet.has(req)) {
        warnings.push(`课程「${u.title}」包含重复先修依赖：${req}`);
      }
      reqSet.add(req);
    }
  }

  // Explicit DAG cycle check via Kahn's algorithm
  if (errors.length === 0 && hasPrerequisiteCycle(units)) {
    errors.push("知识依赖图中存在循环依赖（Cycle），请调整先修关系。");
  }

  // Compute topological order if acyclic
  const topologicalOrder: string[] = [];
  if (errors.length === 0) {
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const u of units) {
      inDegree.set(u.id, 0);
      adj.set(u.id, []);
    }
    for (const u of units) {
      for (const req of u.requires || []) {
        if (!adj.has(req)) continue;
        adj.get(req)!.push(u.id);
        inDegree.set(u.id, (inDegree.get(u.id) ?? 0) + 1);
      }
    }
    const queue = units
      .filter((u) => (inDegree.get(u.id) ?? 0) === 0)
      .map((u) => u.id);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      topologicalOrder.push(curr);
      for (const nxt of adj.get(curr) || []) {
        const deg = (inDegree.get(nxt) ?? 1) - 1;
        inDegree.set(nxt, deg);
        if (deg === 0) queue.push(nxt);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    topologicalOrder,
  };
}

/**
 * Schedules lessons into conflict-free slots while respecting waking hours,
 * daily budgets, and prerequisite topological completion order.
 */
export function scheduleTrackUnitsInOrder(
  units: Lesson[],
  existingBlocks: Block[],
  day: string,
  opts: {
    startMin: number;
    endMin: number;
    dailyMinutes: number;
    scheduleSettings?: Store["scheduleSettings"];
    existingLessonEndTimes?: Map<string, { day: string; endMin: number }>;
  },
): Block[] {
  const placed: Block[] = [];
  const allBlocks = [...existingBlocks];
  const waking = getWakingBounds(opts.scheduleSettings);
  const startFloor = Math.max(waking.wakeStart, opts.startMin);
  const endCap = Math.min(waking.wakeEnd, opts.endMin);

  const lessonEndMap = new Map<string, { day: string; endMin: number }>(
    opts.existingLessonEndTimes || [],
  );
  // Seed end times from already-existing blocks for any lesson
  for (const b of existingBlocks) {
    if (!b.lesson) continue;
    const prev = lessonEndMap.get(b.lesson);
    const end = b.start + b.minutes;
    if (
      !prev ||
      b.day > prev.day ||
      (b.day === prev.day && end > prev.endMin)
    ) {
      lessonEndMap.set(b.lesson, { day: b.day, endMin: end });
    }
  }

  const dailyUsed = new Map<string, number>();

  for (const unit of units) {
    // Respect prerequisite completion day/time
    let minDay = day;
    let minStartOnMinDay = startFloor;
    for (const reqId of unit.requires || []) {
      const reqEnd = lessonEndMap.get(reqId);
      if (!reqEnd) continue;
      if (reqEnd.day > minDay) {
        minDay = reqEnd.day;
        minStartOnMinDay = Math.max(startFloor, reqEnd.endMin + 15);
      } else if (reqEnd.day === minDay) {
        minStartOnMinDay = Math.max(minStartOnMinDay, reqEnd.endMin + 15);
      }
    }

    let placedSlot: { day: string; start: number } | null = null;
    for (let d = 0; d < 42; d++) {
      const candidateDay = offset(minDay, d);
      const used = dailyUsed.get(candidateDay) ?? 0;
      if (used > 0 && used + unit.minutes > opts.dailyMinutes) {
        continue;
      }
      const daySearchStart = d === 0 ? minStartOnMinDay : startFloor;
      for (let m = daySearchStart; m + unit.minutes <= endCap; m += 15) {
        if (
          !isWithinSleep(m, unit.minutes, opts.scheduleSettings) &&
          free(allBlocks, candidateDay, m, unit.minutes)
        ) {
          placedSlot = { day: candidateDay, start: m };
          dailyUsed.set(candidateDay, used + unit.minutes);
          break;
        }
      }
      if (placedSlot) break;
    }

    if (placedSlot) {
      const block: Block = {
        id: `blk-${shortUuid(8)}`,
        day: placedSlot.day,
        start: placedSlot.start,
        minutes: unit.minutes,
        title: unit.title,
        kind: "学习",
        lesson: unit.id,
      };
      placed.push(block);
      allBlocks.push(block);
      lessonEndMap.set(unit.id, {
        day: placedSlot.day,
        endMin: placedSlot.start + unit.minutes,
      });
    }
  }

  return placed;
}

export type TrackScopeAdjustmentInput = {
  trackId: string;
  day: string;
  depth?: TrackDepth;
  scopeNote?: string;
  priorKnowledge?: PriorKnowledgeLevel;
  days?: number;
  dailyMinutes?: number;
  /** Optional explicit next unit list (supports adding, removing, or refining lessons). */
  nextUnits?: Lesson[];
  /** Optional quick append of new units without rewriting existing ones. */
  appendUnits?: Array<{
    id?: string;
    title: string;
    concept: string;
    objective?: string;
    completionCriteria?: string;
    example?: string;
    minutes?: number;
    requires?: string[];
    practiceType?: "code" | "text";
    practiceLanguage?: string;
    practicePrompt?: string;
    starterCode?: string;
    chapterTitle?: string;
    chapterSummary?: string;
    sectionTitle?: string;
    stageTitle?: string;
    stageSubtitle?: string;
    moduleTitle?: string;
  }>;
  /** Optional IDs of uncompleted lessons to trim when narrowing scope. */
  removeLessonIds?: string[];
};

export type TrackScopeAdjustmentResult = {
  store: Store;
  plan: GoalPlan;
  addedLessonIds: string[];
  removedLessonIds: string[];
  preservedMasteredIds: string[];
  newlyScheduledBlocks: Block[];
  removedFutureBlockIds: string[];
  validation: TrackValidationResult;
};

/**
 * E2E-001 (AC #3, #4, #5, #7):
 * Adjusts a track's scope, depth, or lesson count cleanly without corrupting
 * mastered history, completed blocks, locked blocks, or other tracks' schedules.
 */
export function reconcileTrackUnitsAndSchedule(
  store: Store,
  input: TrackScopeAdjustmentInput,
): TrackScopeAdjustmentResult {
  const plans = store.goalPlans || [];
  const target = plans.find((p) => p.id === input.trackId);
  if (!target) {
    throw new Error(`未找到轨道 ${input.trackId}`);
  }

  const prevIds = new Set(target.units.map((u) => u.id));
  const otherTrackLessonIds = new Set<string>();
  for (const p of plans) {
    if (p.id === target.id) continue;
    for (const u of p.units) otherTrackLessonIds.add(u.id);
  }

  // Start from either explicit nextUnits or current units
  let candidateUnits: Lesson[] = input.nextUnits
    ? input.nextUnits.map((u) => normalizeLessonGoalFields({ ...u }))
    : target.units.map((u) => normalizeLessonGoalFields({ ...u }));

  // Remove requested uncompleted lessons if removeLessonIds provided
  if (input.removeLessonIds?.length) {
    const toRemove = new Set(input.removeLessonIds);
    candidateUnits = candidateUnits.filter((u) => {
      if (!toRemove.has(u.id)) return true;
      // Protect mastered lessons (mastery >= 80) from accidental silent drop unless explicitly replaced via nextUnits
      const isMastered = (store.mastery[u.id] ?? 0) >= 80;
      return isMastered;
    });
  }

  // Append any new units
  if (input.appendUnits?.length) {
    const baseLen = candidateUnits.length;
    input.appendUnits.forEach((raw, idx) => {
      const id =
        raw.id?.trim() ||
        `${target.id}-u${baseLen + idx + 1}-${shortUuid(4)}`;
      const fallbackReq =
        candidateUnits.length > 0
          ? [candidateUnits[candidateUnits.length - 1].id]
          : [];
      const unit = normalizeLessonGoalFields({
        id,
        title: raw.title.trim(),
        subtitle: raw.concept.trim().slice(0, 40),
        minutes: Math.max(15, Math.min(90, raw.minutes ?? 30)),
        requires: raw.requires ? [...raw.requires] : fallbackReq,
        concept: raw.concept.trim(),
        objective: raw.objective?.trim(),
        completionCriteria: raw.completionCriteria?.trim(),
        example: raw.example?.trim() || "",
        question: "",
        choices: [],
        answer: 0,
        feedback: "",
        practiceType: raw.practiceType,
        practiceLanguage: raw.practiceLanguage,
        practicePrompt: raw.practicePrompt,
        starterCode: raw.starterCode,
        stageTitle:
          raw.chapterTitle?.trim() || raw.stageTitle?.trim() || undefined,
        stageSubtitle:
          raw.chapterSummary?.trim() || raw.stageSubtitle?.trim() || undefined,
        moduleTitle:
          raw.sectionTitle?.trim() || raw.moduleTitle?.trim() || undefined,
      });
      candidateUnits.push(unit);
    });
  }

  // Clean dangling prerequisites caused by trimmed lessons so DAG remains valid
  const survivingIds = new Set(candidateUnits.map((u) => u.id));
  candidateUnits = candidateUnits.map((u) => ({
    ...u,
    requires: (u.requires || []).filter(
      (req) => req !== u.id && survivingIds.has(req),
    ),
  }));

  const nextBlueprintVersion = (target.blueprintVersion ?? 1) + 1;
  candidateUnits = deriveGraphLessonContracts(candidateUnits, {
    blueprintVersion: nextBlueprintVersion,
    mastery: store.mastery,
    preserveMasteredContracts: true,
  });

  const validation = validateTrackUnits(candidateUnits, {
    strictGoalFields: true,
  });
  if (!validation.ok) {
    throw new Error(`课程依赖或目标校验失败：${validation.errors.join("；")}`);
  }

  // Sort units in valid topological order if needed (keep original relative order when already valid)
  const addedLessonIds = candidateUnits
    .filter((u) => !prevIds.has(u.id))
    .map((u) => u.id);
  const removedLessonIds = [...prevIds].filter((id) => !survivingIds.has(id));
  const preservedMasteredIds = [...prevIds].filter(
    (id) => (store.mastery[id] ?? 0) >= 80,
  );

  // Clean up ONLY uncompleted, unlocked future study blocks exclusive to removed lessons
  const removedExclusive = new Set(
    removedLessonIds.filter((id) => !otherTrackLessonIds.has(id)),
  );
  const removedFutureBlockIds: string[] = [];
  const survivingBlocks = store.blocks.filter((b) => {
    if (
      b.lesson &&
      removedExclusive.has(b.lesson) &&
      !b.done &&
      !b.locked &&
      b.kind === "学习"
    ) {
      removedFutureBlockIds.push(b.id);
      return false;
    }
    return true;
  });

  // Update block titles for surviving lessons if titles were refined
  const unitById = new Map(candidateUnits.map((u) => [u.id, u]));
  const updatedBlocks = survivingBlocks.map((b) => {
    if (b.lesson && !b.done && b.kind === "学习" && unitById.has(b.lesson)) {
      const u = unitById.get(b.lesson)!;
      if (b.title !== u.title) {
        return { ...b, title: u.title };
      }
    }
    return b;
  });

  // Schedule newly added (or currently unscheduled unmastered) lessons without touching existing blocks
  const scheduledLessonIds = new Set(
    updatedBlocks
      .filter((b) => b.lesson && (b.kind === "学习" || b.done))
      .map((b) => b.lesson!),
  );
  const unitsNeedingSlots = candidateUnits.filter(
    (u) =>
      addedLessonIds.includes(u.id) ||
      (!scheduledLessonIds.has(u.id) && (store.mastery[u.id] ?? 0) < 80),
  );

  const prefs = extractMemoryPreferences(store.memories, input.day);
  const waking = getWakingBounds(store.scheduleSettings);
  const dailyMinutes = input.dailyMinutes ?? target.daily ?? prefs.maxSessionMinutes ?? 60;
  const startMin = Math.max(waking.wakeStart, target.start ?? prefs.preferredStart ?? 1140);
  const endMin = Math.min(waking.wakeEnd, prefs.preferredEnd ?? 1350);

  const newlyScheduledBlocks =
    unitsNeedingSlots.length > 0 && !target.archived
      ? scheduleTrackUnitsInOrder(unitsNeedingSlots, updatedBlocks, input.day, {
          startMin,
          endMin,
          dailyMinutes,
          scheduleSettings: store.scheduleSettings,
        })
      : [];

  const finalBlocks = [...updatedBlocks, ...newlyScheduledBlocks];

  // Preserve ALL existing mastery records (never erase history even for trimmed lessons!)
  const nextMastery: Record<string, number> = { ...store.mastery };
  for (const u of candidateUnits) {
    nextMastery[u.id] ??= 0;
  }

  const nextDays =
    input.days ??
    Math.max(
      1,
      target.days,
      Math.ceil(candidateUnits.length * 1.5),
    );

  const nextPlan: GoalPlan = {
    ...target,
    version: `${target.id}-v${nextBlueprintVersion}`,
    blueprintVersion: nextBlueprintVersion,
    days: nextDays,
    daily: dailyMinutes,
    depth: input.depth ?? target.depth ?? "standard",
    scopeNote:
      input.scopeNote !== undefined ? input.scopeNote.trim() : target.scopeNote,
    priorKnowledge: input.priorKnowledge ?? target.priorKnowledge,
    units: candidateUnits,
    slots: finalBlocks.filter(
      (b) => b.lesson && survivingIds.has(b.lesson),
    ),
  };

  const nextStore: Store = {
    ...store,
    goalPlans: plans.map((p) => (p.id === target.id ? nextPlan : p)),
    blocks: finalBlocks,
    mastery: nextMastery,
    decision: `已调整「${nextPlan.title}」范围与深度（${TRACK_DEPTH_LABELS[nextPlan.depth || "standard"]} · ${candidateUnits.length} 节课，新增 ${addedLessonIds.length} 节、精简 ${removedLessonIds.length} 节）`,
  };

  return {
    store: nextStore,
    plan: nextPlan,
    addedLessonIds,
    removedLessonIds,
    preservedMasteredIds,
    newlyScheduledBlocks,
    removedFutureBlockIds,
    validation,
  };
}
