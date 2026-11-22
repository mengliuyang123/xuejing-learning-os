import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  syncGoalPlanToCurriculumBlueprint,
} from "../lib/curriculum-blueprint";
import {
  adaptTrackContractsFromAssessment,
  deriveGraphLessonContracts,
  groupLessonsIntoStages,
  normalizeKnowledgeGraphTopology,
  reconcileTrackUnitsAndSchedule,
  resolveGraphNeighborsForLesson,
  resolveNextRollingLesson,
} from "../lib/curriculum-planner";
import {
  computeCrossChapterConceptLinks,
  layoutKnowledgeGraph,
} from "../lib/graph";
import {
  closeDbForTesting,
  getLatestCurriculumBlueprintFromDb,
  getLessonPreparationFromDb,
  saveResearchPackageToDb,
} from "../lib/db";
import type { GoalPlan, Lesson, Store } from "../lib/learning";
import {
  detectScopeOverreachInBlocks,
  evaluateLessonContentFourLayers,
  generateStructuredLessonContent,
  pruneScopeOverreachInBlocks,
} from "../lib/lesson-content";
import type { ResearchPackage } from "../lib/research-planner";
import {
  prepareLessonInDepth,
  triggerRollingPrewarmForNextLesson,
} from "../lib/topic-researcher";
import {
  type FetchLike,
  inferLearningCapabilityProfile,
} from "../lib/web-research";

function makeTempDb(): { cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learnos-graph-contract-"));
  process.env.LEARNOS_DB_PATH = path.join(dir, "test.sqlite");
  return {
    cleanup: () => {
      closeDbForTesting();
      delete process.env.LEARNOS_DB_PATH;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function makeSampleUnits(): Lesson[] {
  return [
    {
      id: "ag-u1",
      title: "LLM 单次 API 调用基础",
      subtitle: "理解 messages 与基础请求响应",
      minutes: 25,
      requires: [],
      concept: "通过 HTTP/SDK 发送 messages 并读取模型单次回复文本。",
      objective: "独立跑通一次带 system prompt 的单次 LLM API 调用",
      completionCriteria: "能解释 messages 角色分工并打印响应结果",
      example: "client.chat.completions.create(model='deepseek-flash', messages=[...])",
      question: "system 角色的作用是什么？",
      choices: ["设定全局指令边界", "代替用户输入", "执行本地函数"],
      answer: 0,
      feedback: "system 用于设定助手行为边界。",
      practiceType: "code",
      practiceLanguage: "python",
    },
    {
      id: "ag-u2",
      title: "Function Calling 工具模式",
      subtitle: "结构化 JSON Schema 工具声明",
      minutes: 35,
      requires: ["ag-u1"],
      concept: "通过 tools JSON Schema 让模型输出结构化 tool_calls 参数。",
      objective: "掌握 tools Schema 声明与宿主函数分发执行",
      completionCriteria: "能定义 get_weather 工具 Schema 并解析 tool_calls",
      example: "tools = [{'type': 'function', 'function': {'name': 'get_weather'}}]",
      question: "谁负责真正执行工具函数？",
      choices: ["宿主程序", "大模型直接联网", "浏览器"],
      answer: 0,
      feedback: "宿主程序负责执行工具函数。",
      practiceType: "code",
      practiceLanguage: "python",
    },
    {
      id: "ag-u3",
      title: "ReAct 状态循环与终止控制",
      subtitle: "思考-行动-观察多步闭环",
      minutes: 40,
      requires: ["ag-u2"],
      concept: "在 while 循环中将 tool 执行结果追加回 messages，直到无 tool_calls 或达到 maxSteps。",
      objective: "实现带 maxSteps 保护的 ReAct 多步工具调用循环",
      completionCriteria: "能写出完整的 while 循环并处理工具异常",
      example: "while step < max_steps: ...",
      question: "如何避免 ReAct 死循环？",
      choices: ["设置 maxSteps 与终止条件", "无限重试", "删除 system prompt"],
      answer: 0,
      feedback: "必须设置步数上限与终止判断。",
      practiceType: "code",
      practiceLanguage: "python",
    },
  ];
}

test("Pillar 1 & 3: Knowledge Graph unifies with CurriculumBlueprint, derives LessonContracts, and reuses global Track ResearchPackage without duplicate searches", async () => {
  const env = makeTempDb();
  try {
    const rawPlan: GoalPlan = {
      id: "track-agent",
      version: "track-agent-v1",
      goal: "从零掌握 AI Agent 开发（API 调用、Function Calling 与 ReAct 循环）",
      title: "AI Agent 核心开发",
      days: 7,
      daily: 45,
      start: 1140,
      depth: "standard",
      priorKnowledge: "beginner",
      units: makeSampleUnits(),
      slots: [],
    };

    // Save 1 track-level global ResearchPackage
    const globalPkg: ResearchPackage = {
      id: "rpkg-global-agent",
      goal: rawPlan.goal,
      topic: rawPlan.title,
      capabilityProfile: inferLearningCapabilityProfile(rawPlan.goal),
      concepts: [
        {
          id: "c1",
          name: "Messages 协议",
          definition: "system/user/assistant 消息列表结构",
          explanation: "LLM 无状态对话的基础上下文载体。",
          prerequisites: [],
          examples: ["messages=[{'role':'user','content':'hi'}]"],
          misconceptions: ["误以为服务端默认记住上一轮历史"],
          learningOutcomes: ["掌握单次 API 调用"],
          evidenceRefs: ["https://api-docs.deepseek.com/zh-cn/guides/tool_calls"],
        },
        {
          id: "c2",
          name: "Function Calling",
          definition: "基于 JSON Schema 的结构化工具调用协议",
          explanation: "模型产出参数，宿主程序执行。",
          prerequisites: ["Messages 协议"],
          examples: ["tools=[{'type':'function'}]"],
          misconceptions: ["误以为模型直接执行函数"],
          learningOutcomes: ["掌握工具调用"],
          evidenceRefs: ["https://api-docs.deepseek.com/zh-cn/guides/tool_calls"],
        },
      ],
      prerequisites: ["Python 基础语法", "环境变量配置"],
      learningOutcomes: ["掌握单次 API 调用", "掌握工具调用", "掌握 ReAct 循环"],
      commonMisconceptions: [
        "误以为模型自己直接执行本地 Python 函数",
        "忘记在循环中设置 maxSteps 导致死循环",
      ],
      workedExamples: ["最小 Chat Completion 调用示例"],
      sourceRefs: [
        {
          url: "https://api-docs.deepseek.com/zh-cn/guides/tool_calls",
          title: "DeepSeek Tool Calls 官方指南",
          siteName: "DeepSeek Docs",
          authority: 4,
          rerankScore: 2.8,
          date: "2026-11-01",
          retrievedAt: "2026-11-21T10:00:00Z",
          excerpt: "Tool Calls 让模型能够输出结构化函数调用参数。",
          origin: "deepseek_search",
        },
      ],
      unresolvedQuestions: [],
      coverageReport: {
        requiredOutcomes: ["掌握单次 API 调用", "掌握工具调用"],
        coveredOutcomes: ["掌握单次 API 调用", "掌握工具调用"],
        partiallyCoveredOutcomes: [],
        missingOutcomes: [],
        unresolvedQuestions: [],
        recommendation: "sufficient",
      },
      effectiveMode: "auto_web",
      status: "sufficient",
      cacheHit: false,
      queriesUsed: ["DeepSeek Tool Calls"],
      fetchedUrls: ["https://api-docs.deepseek.com/zh-cn/guides/tool_calls"],
    };

    saveResearchPackageToDb({
      packageId: globalPkg.id,
      cacheKey: "ck-global-agent",
      goal: globalPkg.goal,
      topic: globalPkg.topic,
      learnerLevel: "beginner",
      purpose: "curriculum",
      strategyVersion: "rp-v1",
      effectiveMode: "auto_web",
      status: "sufficient",
      contentHash: "hash-1",
      pkg: globalPkg,
      coverage: globalPkg.coverageReport,
      sourceRefs: globalPkg.sourceRefs,
    });

    // Unify GoalPlan with CurriculumBlueprint
    const { plan, blueprint } = syncGoalPlanToCurriculumBlueprint({
      plan: rawPlan,
      researchPackageId: globalPkg.id,
    });

    assert.equal(plan.blueprintVersion, 1);
    assert.equal(plan.researchPackageId, globalPkg.id);
    assert.ok(plan.blueprintId);

    const savedBp = getLatestCurriculumBlueprintFromDb(plan.id);
    assert.ok(savedBp);
    assert.equal(savedBp.blueprintId, blueprint.id);
    assert.equal(savedBp.version, 1);

    // Every node in the Knowledge Graph must carry a versioned LessonContract
    const u1Contract = plan.units[0].contract!;
    assert.ok(u1Contract);
    assert.equal(u1Contract.blueprintVersion, 1);
    assert.ok(
      u1Contract.deferredTo.some((d) =>
        d.targetLessonTitle.includes("Function Calling"),
      ),
      "Lesson 1 contract must defer Function Calling to Lesson 2",
    );
    assert.ok(
      u1Contract.deferredTo.some((d) =>
        d.targetLessonTitle.includes("ReAct"),
      ),
      "Lesson 1 contract must defer ReAct loop to Lesson 3",
    );

    // Prepare Lesson 1: must reuse global track ResearchPackage with ZERO network calls!
    let searchNetworkCalls = 0;
    const failIfCalledFetch: FetchLike = async () => {
      searchNetworkCalls++;
      throw new Error("Should not call external search when track ResearchPackage exists!");
    };

    const prep1 = await prepareLessonInDepth({
      lesson: plan.units[0],
      trackId: plan.id,
      trackTitle: plan.title,
      trackGoal: plan.goal,
      trackUnits: plan.units,
      blueprintId: plan.blueprintId,
      blueprintVersion: plan.blueprintVersion,
      researchPackageId: plan.researchPackageId,
      reuseTrackResearch: true,
      learnerLevel: "beginner",
      mode: "auto_web",
      fetchImpl: failIfCalledFetch,
    });

    assert.equal(searchNetworkCalls, 0);
    assert.equal(prep1.reusedTrackResearch, true);
    assert.equal(prep1.blueprintVersion, 1);
    assert.ok(prep1.contract);
    assert.ok(prep1.tutorial.modularBlocks && prep1.tutorial.modularBlocks.length >= 4);
    assert.equal(
      prep1.qualityReport.checks.find((c) => c.id === "scope_boundary_compliance")?.ok,
      true,
    );
  } finally {
    env.cleanup();
  }
});

test("Pillar 2: 4-Layer Quality Gate detects scope overreach (spoilers of downstream nodes) and deterministically prunes/repairs offending blocks", async () => {
  const env = makeTempDb();
  try {
    const units = deriveGraphLessonContracts(makeSampleUnits(), {
      blueprintVersion: 1,
    });
    const lesson1 = units[0];
    const contract1 = lesson1.contract!;
    const profile = inferLearningCapabilityProfile("Python AI Agent 开发");

    // 1. A brief 1-sentence forward teaser is ALLOWED and passes scope_boundary_compliance
    const cleanBlocks = [
      {
        id: "b1",
        type: "motivation" as const,
        title: "为什么先学单次 API 调用",
        content: "先跑通一次最小 messages 请求，下一课我们将在《Function Calling 工具模式》中引入工具调用。",
      },
      {
        id: "b2",
        type: "concept_explanation" as const,
        title: "Messages 角色与请求参数",
        content: "system 设定助手边界，user 传递当前问题，assistant 返回模型生成的文本响应。",
      },
      {
        id: "b3",
        type: "worked_example" as const,
        title: "最小单次调用代码",
        content: "```python\nresp = client.chat.completions.create(model='deepseek-flash', messages=[{'role':'user','content':'hi'}])\n```",
      },
      {
        id: "b4",
        type: "guided_task" as const,
        title: "动手跑通第一次调用",
        content: "修改 system prompt 并打印返回文本。",
      },
    ];
    const cleanCheck = detectScopeOverreachInBlocks({
      blocks: cleanBlocks,
      contract: contract1,
      currentLessonTitle: lesson1.title,
    });
    assert.equal(cleanCheck.ok, true);

    // 2. A block that jumps ahead and teaches Lesson 3's "ReAct 状态循环与终止控制" in Lesson 1 is FLAGGED!
    const spoilerBlocks = [
      ...cleanBlocks,
      {
        id: "b-spoiler",
        type: "worked_example" as const,
        title: "ReAct 状态循环与终止控制完整实现",
        content:
          "下面我们在第 1 课直接写出完整的 ReAct 状态循环与终止控制代码，并在循环中解析 Function Calling 工具模式：\n```python\nwhile step < max_steps:\n    # ReAct 状态循环与终止控制\n```",
      },
    ];
    const overreachCheck = detectScopeOverreachInBlocks({
      blocks: spoilerBlocks,
      contract: contract1,
      currentLessonTitle: lesson1.title,
    });
    assert.equal(overreachCheck.ok, false);
    assert.deepEqual(overreachCheck.overreachingBlockIds, ["b-spoiler"]);

    const qualityReport = evaluateLessonContentFourLayers({
      content: {
        contentId: "lc-test-1",
        lessonId: lesson1.id,
        trackId: "track-agent",
        version: 1,
        depth: "standard",
        learningOutcomes: [lesson1.objective!],
        blocks: spoilerBlocks,
        estimatedMinutes: 25,
        contract: contract1,
        knowledgeGaps: [],
      },
      profile,
      contract: contract1,
      currentLessonTitle: lesson1.title,
    });
    const scopeCheck = qualityReport.checks.find(
      (c) => c.id === "scope_boundary_compliance",
    );
    assert.ok(scopeCheck);
    assert.equal(scopeCheck.ok, false);
    assert.ok(qualityReport.failingBlockIds.includes("b-spoiler"));

    // 3. Targeted Scope Pruner deterministically converts the spoiler block into a clean boundary bridge
    const pruned = pruneScopeOverreachInBlocks({
      blocks: spoilerBlocks,
      contract: contract1,
      currentLessonTitle: lesson1.title,
    });
    assert.deepEqual(pruned.prunedBlockIds, ["b-spoiler"]);
    const afterPruneCheck = detectScopeOverreachInBlocks({
      blocks: pruned.blocks,
      contract: contract1,
      currentLessonTitle: lesson1.title,
    });
    assert.equal(afterPruneCheck.ok, true);

    // 4. End-to-end generator auto-prunes if LLM still outputs a spoiler on final attempt
    const generated = await generateStructuredLessonContent({
      lesson: lesson1,
      trackId: "track-agent",
      blueprintVersion: 1,
      contract: contract1,
      profile,
      maxRepairAttempts: 0,
      customExecutor: async () => ({
        text: JSON.stringify({
          learningOutcomes: [lesson1.objective!],
          blocks: spoilerBlocks,
          knowledgeGaps: [],
        }),
      }),
    });
    assert.equal(generated.status, "ready");
    assert.equal(
      generated.qualityReport.checks.find((c) => c.id === "scope_boundary_compliance")
        ?.ok,
      true,
    );
  } finally {
    env.cleanup();
  }
});

test("Pillar 4 & 5: N+1 Rolling Prewarm prepares ONLY Lesson N+1 (never all chapters), deduplicates in-flight calls, and invalidates cache when blueprintVersion advances while preserving mastered history", async () => {
  const env = makeTempDb();
  try {
    const baseUnits = deriveGraphLessonContracts(makeSampleUnits(), {
      blueprintVersion: 1,
    });
    const track: GoalPlan = {
      id: "track-rolling",
      version: "track-rolling-v1",
      goal: "AI Agent 渐进式开发",
      title: "AI Agent 实战",
      days: 6,
      daily: 45,
      start: 1140,
      depth: "standard",
      priorKnowledge: "intermediate",
      blueprintId: "bp-rolling-1",
      blueprintVersion: 1,
      units: baseUnits,
      slots: [],
    };

    // 1. resolveNextRollingLesson picks Lesson 2 when on Lesson 1
    const nextAfter1 = resolveNextRollingLesson(track.units, "ag-u1", {});
    assert.equal(nextAfter1?.id, "ag-u2");

    // 2. triggerRollingPrewarmForNextLesson warms ONLY Lesson 2 (ag-u2), leaving Lesson 3 (ag-u3) unprepared!
    const prewarmRes = await triggerRollingPrewarmForNextLesson({
      track,
      currentLessonId: "ag-u1",
      masteryMap: {},
    });
    assert.equal(prewarmRes.prewarmedLessonId, "ag-u2");
    assert.ok(getLessonPreparationFromDb("ag-u2"), "Lesson 2 must be prewarmed in SQLite");
    assert.equal(
      getLessonPreparationFromDb("ag-u3"),
      null,
      "Lesson 3 must NOT be pre-generated upfront!",
    );

    // 3. Downstream Loop #4: Learner masters Lesson 1 (mastery = 90%); assessment feedback updates unmastered Lesson 2 contract to v2
    const masteryMap: Record<string, number> = {
      "ag-u1": 90,
      "ag-u2": 0,
      "ag-u3": 0,
    };
    const adapted = adaptTrackContractsFromAssessment(track, {
      assessedLessonId: "ag-u1",
      correct: true,
      masteryAfter: 90,
      masteryMap,
    });
    assert.equal(adapted.nextBlueprintVersion, 2);
    assert.deepEqual(adapted.updatedLessonIds, ["ag-u2"]);
    // Mastered Lesson 1 keeps its original v1 contract snapshot
    assert.equal(adapted.plan.units[0].contract?.blueprintVersion, 1);
    // Unmastered Lesson 2 advances to v2 with updated assumedPrior
    assert.equal(adapted.plan.units[1].contract?.blueprintVersion, 2);
    assert.ok(
      adapted.plan.units[1].contract?.assumedPrior[0].includes("已验证掌握"),
    );

    // 4. Scope adjustment via reconcileTrackUnitsAndSchedule increments blueprintVersion, updates unmastered contracts, and 100% protects mastered Lesson 1
    const initialStore: Store = {
      activeTrackId: adapted.plan.id,
      goalPlans: [adapted.plan],
      mastery: masteryMap,
      blocks: [],
      memories: [],
      decision: "init",
    };
    const reconciled = reconcileTrackUnitsAndSchedule(initialStore, {
      trackId: adapted.plan.id,
      day: "2026-11-21",
      removeLessonIds: ["ag-u1", "ag-u3"], // Try to remove mastered ag-u1 and unmastered ag-u3
      appendUnits: [
        {
          id: "ag-u4",
          title: "Agent 可观测性与评测闭环",
          concept: "通过结构化 Trace 记录每一步工具调用与延迟。",
          objective: "为 Agent 加上完整的 Trace 追踪与评测指标",
          completionCriteria: "能输出并检查一次完整 Run 的 Trace 记录",
          requires: ["ag-u2"],
        },
      ],
    });

    // Mastered ag-u1 is protected from removal and keeps its v1 contract & 90% mastery!
    assert.ok(reconciled.preservedMasteredIds.includes("ag-u1"));
    assert.equal(reconciled.store.mastery["ag-u1"], 90);
    const u1After = reconciled.plan.units.find((u) => u.id === "ag-u1")!;
    assert.equal(u1After.contract?.blueprintVersion, 1);

    // Unmastered ag-u3 was removed, ag-u4 was added, and unmastered ag-u2 & ag-u4 contracts updated to v3!
    assert.equal(reconciled.plan.blueprintVersion, 3);
    const u2After = reconciled.plan.units.find((u) => u.id === "ag-u2")!;
    const u4After = reconciled.plan.units.find((u) => u.id === "ag-u4")!;
    assert.equal(u2After.contract?.blueprintVersion, 3);
    assert.equal(u4After.contract?.blueprintVersion, 3);
    assert.ok(
      u2After.contract?.deferredTo.some((d) =>
        d.targetLessonTitle.includes("可观测性"),
      ),
      "Lesson 2's v3 contract must now defer to the newly added Lesson 4!",
    );

    // 5. Because ag-u2's cached preparation was built at v1, calling prepareLessonInDepth at v3 automatically invalidates stale v1 cache and refreshes to v3!
    const refreshedPrep2 = await prepareLessonInDepth({
      lesson: u2After,
      trackId: reconciled.plan.id,
      trackTitle: reconciled.plan.title,
      trackGoal: reconciled.plan.goal,
      trackUnits: reconciled.plan.units,
      blueprintVersion: reconciled.plan.blueprintVersion,
      masteryMap: reconciled.store.mastery,
      learnerLevel: "intermediate",
      mode: "quick_draft",
    });
    assert.equal(refreshedPrep2.cacheHit, false, "Stale v1 cache must be invalidated when blueprintVersion is v3");
    assert.equal(refreshedPrep2.blueprintVersion, 3);

    // Calling again at v3 hits the fresh v3 cache immediately
    const hitPrep2 = await prepareLessonInDepth({
      lesson: u2After,
      trackId: reconciled.plan.id,
      trackTitle: reconciled.plan.title,
      trackGoal: reconciled.plan.goal,
      trackUnits: reconciled.plan.units,
      blueprintVersion: reconciled.plan.blueprintVersion,
      masteryMap: reconciled.store.mastery,
      learnerLevel: "intermediate",
      mode: "quick_draft",
    });
    assert.equal(hitPrep2.cacheHit, true);
    assert.equal(hitPrep2.blueprintVersion, 3);

    // Verify resolveGraphNeighborsForLesson exposes full neighborhood
    const neighborhood = resolveGraphNeighborsForLesson(
      reconciled.plan.units,
      "ag-u2",
      {
        blueprintVersion: reconciled.plan.blueprintVersion,
        mastery: reconciled.store.mastery,
      },
    );
    assert.ok(neighborhood);
    assert.equal(neighborhood.predecessors[0].id, "ag-u1");
    assert.equal(neighborhood.predecessors[0].mastered, true);
    assert.equal(neighborhood.directSuccessors[0].id, "ag-u4");
  } finally {
    env.cleanup();
  }
});

test("Knowledge Graph Topology Normalizer & 2D Landscape Layout: restructures 11-node linear chains into 4-stage branching DAG with cross-chapter concept links", () => {
  const linearEleven: Lesson[] = [
    "Agent 全景图：LLM + Tools + Loop + Memory",
    "Python 工程基本功：函数、字典、异常与模块",
    "LLM API 调用与提示词结构",
    "Function Calling：让模型真正「动手」",
    "Agent Loop：思考—行动—观察与终止条件",
    "记忆系统：上下文裁剪、摘要与长期记忆",
    "RAG 知识库：切分、检索与引用溯源",
    "多智能体编排：Supervisor / Worker 与图编排",
    "Agent 评测：评测集、LLM-as-judge 与回归",
    "可观测性与上线：Tracing、成本护栏与灰度",
    "端到端业务落地：把组件拼成可用 Agent",
  ].map((title, idx) => ({
    id: `u${idx + 1}`,
    title,
    subtitle: title,
    minutes: 30,
    requires: idx === 0 ? [] : [`u${idx}`],
    concept: title,
    example: "",
    question: "",
    choices: [],
    answer: 0,
    feedback: "",
  }));

  const normalized = normalizeKnowledgeGraphTopology(linearEleven);
  const stages = groupLessonsIntoStages(normalized);
  assert.equal(stages.length, 4, "11-lesson track must group into 4 distinct pedagogical stages");

  // Stage 3 capability modules (u6 Memory, u7 RAG, u8 Multi-Agent) must branch in parallel off u5 (Agent Loop)
  assert.deepEqual(normalized[5].requires, ["u5"]);
  assert.deepEqual(normalized[6].requires, ["u5"]);
  assert.deepEqual(normalized[7].requires, ["u5"]);
  // Final capstone u11 must converge multiple branches
  assert.ok(normalized[10].requires.length >= 2);

  const mockStore: Store = {
    mastery: { u1: 90, u2: 85 },
    blocks: [],
    memories: [],
    decision: "",
  };
  const layout = layoutKnowledgeGraph(normalized, mockStore);
  assert.ok(
    layout.layerCount <= 6,
    `Branching 11-node DAG should compress into <= 6 horizontal layers (got ${layout.layerCount})`,
  );
  assert.ok(
    layout.crossEdges.length >= 2,
    "Should infer cross-chapter concept synergy links (e.g. Memory<->RAG, Loop<->Tracing)",
  );
  assert.ok(layout.boardWidth > layout.boardHeight, "2D layout should be landscape-proportioned");

  // Also verify that dynamically synthesized stage/section titles are domain-specific (not generic hardcoded boilerplate)
  assert.ok(
    stages[0].stageTitle.includes("Agent 全景图"),
    `Expected domain-derived chapter title, got ${stages[0].stageTitle}`,
  );
  assert.ok(stages[0].sections.length >= 1, "Each chapter must contain sub-chapters (sections)");
});

test("Free-form LLM Chapter & Sub-chapter Hierarchy: supports arbitrary lesson count (e.g. 18 lessons > old 16 cap) and preserves custom 大章节 -> 小章节 -> 课时 structure", () => {
  const env = makeTempDb();
  try {
    const customStructure = [
      {
        chapter: "第一篇 · 分布式存储引擎内核",
        sections: [
          {
            section: "1.1 LSM-Tree 写入链路与 MemTable",
            titles: ["WAL 预写日志与崩溃恢复", "跳表 MemTable 并发写入", "Immutable 刷盘与 SSTable 布局"],
          },
          {
            section: "1.2 Compaction 策略与读放大优化",
            titles: ["Leveled vs Tiered 合并策略", "Bloom Filter 与块缓存加速"],
          },
        ],
      },
      {
        chapter: "第二篇 · 共识协议与复制状态机",
        sections: [
          {
            section: "2.1 Raft 选主与日志复制",
            titles: ["Term 任期与 Leader 选举安全性", "Log Replication 与 Commit Index 推进", "Snapshot 快照安装与日志压缩"],
          },
          {
            section: "2.2 成员变更与脑裂防护",
            titles: ["Joint Consensus 联合共识", "PreVote 与 ReadIndex 线性一致读"],
          },
        ],
      },
      {
        chapter: "第三篇 · 分布式事务与 MVCC",
        sections: [
          {
            section: "3.1 多版本并发控制",
            titles: ["MVCC 版本链与快照隔离", "Write Skew 写偏序检测"],
          },
          {
            section: "3.2 Percolator 与两阶段提交",
            titles: ["2PC 主从锁协调机制", "混合逻辑时钟 HLC 与 TrueTime"],
          },
        ],
      },
      {
        chapter: "第四篇 · 分片调度与弹性扩缩容",
        sections: [
          {
            section: "4.1 Range 分裂与负载均衡",
            titles: ["动态 Range Split 与 Merge", "基于热度的副本迁移调度"],
          },
        ],
      },
      {
        chapter: "第五篇 · 混沌工程与生产级压测",
        sections: [
          {
            section: "5.1 故障注入与一致性验证",
            titles: ["Jepsen 网络分区故障注入", "端到端分布式 KV 引擎验收"],
          },
        ],
      },
    ];

    const units: Lesson[] = [];
    for (const ch of customStructure) {
      for (const sec of ch.sections) {
        for (const t of sec.titles) {
          const idx = units.length;
          units.push({
            id: `dist-u${idx + 1}`,
            title: t,
            subtitle: t,
            minutes: 35,
            requires: idx === 0 ? [] : [`dist-u${idx}`],
            concept: `${t} 的核心机制与工程实现`,
            objective: `掌握 ${t}`,
            completionCriteria: `完成 ${t} 实验验证`,
            example: "",
            question: "",
            choices: [],
            answer: 0,
            feedback: "",
            stageTitle: ch.chapter,
            moduleTitle: sec.section,
          });
        }
      }
    }

    assert.equal(units.length, 18, "Should support 18 lessons (> old 16 cap)");

    const rawPlan: GoalPlan = {
      id: "track-dist-kv",
      version: "track-dist-kv-v1",
      goal: "深入掌握分布式 KV 存储引擎架构",
      title: "分布式存储系统内核",
      days: 30,
      daily: 60,
      start: 1140,
      depth: "deep",
      units,
      slots: [],
    };

    const { plan, blueprint } = syncGoalPlanToCurriculumBlueprint({
      plan: rawPlan,
    });

    const stageGroups = groupLessonsIntoStages(plan.units);
    assert.equal(stageGroups.length, 5, "Must preserve all 5 custom LLM chapters (大章节)");
    assert.equal(stageGroups[0].stageTitle, "第一篇 · 分布式存储引擎内核");
    assert.equal(stageGroups[0].sections.length, 2, "Chapter 1 must preserve its 2 custom sub-chapters (小章节)");
    assert.equal(stageGroups[0].sections[0].sectionTitle, "LSM-Tree 写入链路与 MemTable");
    assert.equal(stageGroups[0].sections[0].units.length, 3);

    // Blueprint persisted in SQLite must also reflect the 5 custom chapters and their sub-chapters
    assert.equal(blueprint.stages.length, 5);
    assert.equal(blueprint.stages[1].title, "第二篇 · 共识协议与复制状态机");
    assert.equal(blueprint.stages[1].modules.length, 2);
  } finally {
    env.cleanup();
  }
});

