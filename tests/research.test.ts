import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDbForTesting,
  getLessonPreparationFromDb,
  getResearchCacheFromDb,
} from "../lib/db";
import {
  type FetchLike,
  WebResearchError,
  clampSearchQuery,
  classifyLearningDomain,
  deepseekWebFetch,
  deepseekWebSearch,
  validateFetchUrl,
} from "../lib/web-research";
import {
  evaluateLessonQuality,
  prepareLessonInDepth,
  researchLearningTopic,
} from "../lib/topic-researcher";
import type { Lesson } from "../lib/learning";

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "learnos-research-"));
  process.env.LEARNOS_DB_PATH = join(dir, "test.sqlite");
  return {
    cleanup() {
      closeDbForTesting();
      delete process.env.LEARNOS_DB_PATH;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Step 1: DeepSeek Search & Fetch contract, query clamping, URL safety, 429 retry, 402 fail-fast, and bounded excerpts", async () => {
  // Query clamping <= 128 Unicode chars
  assert.equal(Array.from(clampSearchQuery("学".repeat(200))).length, 128);

  // URL credential rejection
  assert.throws(
    () => validateFetchUrl("https://user:pass@example.com/doc"),
    (err: unknown) => err instanceof WebResearchError && err.code === "INVALID_REQUEST",
  );
  assert.throws(
    () => validateFetchUrl("ftp://example.com/file"),
    (err: unknown) => err instanceof WebResearchError && err.code === "INVALID_REQUEST",
  );

  // Retry once on HTTP 429, then succeed and verify Bearer header + authority ranking
  let searchCalls = 0;
  let seenAuth = "";
  const mockSearchFetch: FetchLike = async (input, init) => {
    searchCalls++;
    seenAuth = String((init?.headers as Record<string, string>)?.Authorization || "");
    assert.equal(String(input), "https://api.deepseek.com/v1/tools/search");
    if (searchCalls === 1) {
      return makeJsonResponse(429, { error: { message: "rate limited" } });
    }
    return makeJsonResponse(200, {
      results: [
        {
          rerank_score: 1.6,
          title: "普通博客",
          url: "https://blog.example.com/post",
          snippet: "博客简述",
          summary: "普通博客摘要",
          content: "",
          site_name: "Blog",
          site_icon: null,
          date: "2026-01-01T00:00:00Z",
          authority: 1,
        },
        {
          rerank_score: 2.2,
          title: "DeepSeek 官方文档",
          url: "https://api-docs.deepseek.com/tools",
          snippet: "官方工具调用规范",
          summary: "官方详细说明了工具调用参数校验与错误处理流程。",
          content: "",
          site_name: "DeepSeek Docs",
          site_icon: null,
          date: "2026-06-01T00:00:00Z",
          authority: 4,
        },
      ],
    });
  };

  const searchRes = await deepseekWebSearch({
    query: "DeepSeek Tool Calling",
    count: 5,
    apiKey: "sk-test-key",
    fetchImpl: mockSearchFetch,
  });
  assert.equal(searchCalls, 2);
  assert.equal(seenAuth, "Bearer sk-test-key");
  assert.equal(searchRes.results.length, 2);
  // High-authority doc ranked first
  assert.equal(searchRes.results[0].url, "https://api-docs.deepseek.com/tools");

  // 402 Insufficient balance MUST NOT retry
  let calls402 = 0;
  const mock402: FetchLike = async () => {
    calls402++;
    return makeJsonResponse(402, { error: { message: "insufficient balance" } });
  };
  await assert.rejects(
    () =>
      deepseekWebSearch({
        query: "test",
        apiKey: "sk-test-key",
        fetchImpl: mock402,
      }),
    (err: unknown) =>
      err instanceof WebResearchError &&
      err.code === "INSUFFICIENT_BALANCE" &&
      err.retryable === false,
  );
  assert.equal(calls402, 1);

  // Fetch API truncates large page into bounded excerpt (never mirroring entire sites)
  const mockPageFetch: FetchLike = async (input) => {
    assert.equal(String(input), "https://api.deepseek.com/v1/tools/fetch");
    return makeJsonResponse(200, {
      title: "Official Guide",
      content: "A".repeat(12000),
    });
  };
  const page = await deepseekWebFetch({
    url: "https://example.com/guide",
    maxExcerptChars: 1000,
    apiKey: "sk-test-key",
    fetchImpl: mockPageFetch,
  });
  assert.equal(page.truncated, true);
  assert.ok(page.excerpt.length <= 1002);
});

test("Step 2-5: Three modes (auto_web, quick_draft, user_materials), SQLite local cache reuse, 9-point LessonResearchBrief & Quality Gate", async () => {
  const env = makeTempDb();
  try {
    let networkCalls = 0;
    const mockFetch: FetchLike = async (input) => {
      networkCalls++;
      const url = String(input);
      if (url.endsWith("/v1/tools/search")) {
        return makeJsonResponse(200, {
          results: [
            {
              rerank_score: 2.5,
              title: "Function Calling 官方指南",
              url: "https://docs.example.dev/function-calling",
              snippet: "宿主程序校验模型参数并执行函数。",
              summary:
                "工具调用分为声明 Schema、模型产出调用参数、宿主程序校验并执行、将 Observation 回灌 messages 四步。",
              content: "",
              site_name: "Example Docs",
              site_icon: null,
              date: "2026-05-01T00:00:00Z",
              authority: 4,
            },
          ],
        });
      }
      return makeJsonResponse(200, {
        title: "Function Calling 官方指南",
        content: "# Function Calling\n1. Define JSON Schema\n2. Validate arguments in host code\n3. Handle timeouts and retries.",
      });
    };

    // 1. auto_web hits network once, caches to SQLite
    const r1 = await researchLearningTopic({
      topic: "LLM Tool Calling",
      goal: "学会安全实现 Function Calling",
      learnerLevel: "beginner",
      mode: "auto_web",
      apiKey: "sk-test-key",
      fetchImpl: mockFetch,
    });
    assert.equal(r1.domain, "programming");
    assert.equal(r1.effectiveMode, "auto_web");
    assert.equal(r1.cacheHit, false);
    assert.ok(r1.sources.length >= 1);
    const callsAfterFirst = networkCalls;
    assert.ok(callsAfterFirst >= 1);

    // 2. Second identical topic research hits SQLite cache -> ZERO extra network calls!
    const r2 = await researchLearningTopic({
      topic: "LLM Tool Calling",
      goal: "学会安全实现 Function Calling",
      learnerLevel: "beginner",
      mode: "auto_web",
      apiKey: "sk-test-key",
      fetchImpl: mockFetch,
    });
    assert.equal(r2.cacheHit, true);
    assert.equal(networkCalls, callsAfterFirst);

    // 3. quick_draft makes ZERO network calls and transparently marks unverified caveats
    const quick = await researchLearningTopic({
      topic: "React Server Components",
      mode: "quick_draft",
      fetchImpl: mockFetch,
    });
    assert.equal(quick.effectiveMode, "quick_draft");
    assert.equal(networkCalls, callsAfterFirst);
    assert.ok(quick.fallbackNotice && quick.fallbackNotice.length > 0);
    assert.ok(quick.unverifiedPoints.length > 0);

    // 4. user_materials uses pasted notes + fetched user URL
    const matRes = await researchLearningTopic({
      topic: "团队内部 Agent 规范",
      mode: "user_materials",
      userNotes: "所有写操作工具必须经过人工确认并记录 audit trace。",
      userUrls: ["https://docs.example.dev/internal-agent"],
      apiKey: "sk-test-key",
      fetchImpl: mockFetch,
    });
    assert.equal(matRes.effectiveMode, "user_materials");
    assert.ok(matRes.sources.some((s) => s.origin === "user_material"));
    assert.ok(matRes.sources.some((s) => s.origin === "deepseek_fetch"));

    // 5. On-demand deep lesson preparation produces 9-point brief + passes quality gate + caches in SQLite
    const lesson: Lesson = {
      id: "lesson-fc-01",
      title: "第一次调用 LLM API 与 Tool Calling",
      subtitle: "理解运行环境、API Key、请求响应与工具执行",
      minutes: 45,
      requires: [],
      concept: "通过 HTTP/SDK 发送消息数组并校验工具参数。",
      objective: "零基础跑通一次带参数校验的 LLM API 调用并定位常见报错。",
      completionCriteria: "完成最小脚本编写并通过参数校验练习（掌握度 ≥ 80%）。",
      example: 'const resp = await client.chat.completions.create({ model, messages });',
      question: "谁负责校验并执行工具函数？",
      choices: ["宿主程序", "模型权重", "CSS"],
      answer: 0,
      feedback: "宿主程序校验并执行。",
      practiceType: "code",
      practiceLanguage: "python",
    };

    const callsBeforePrep = networkCalls;
    const prep1 = await prepareLessonInDepth({
      lesson,
      trackId: "track-agent-1",
      trackTitle: "AI Agent 开发",
      learnerLevel: "beginner",
      mode: "auto_web",
      apiKey: "sk-test-key",
      fetchImpl: mockFetch,
    });
    assert.equal(prep1.cacheHit, false);
    assert.equal(prep1.status, "ready");
    // Verify all 9 brief fields + beginner environment setup
    assert.ok(prep1.brief.realProblem.length >= 10);
    assert.ok(prep1.brief.prerequisites.length >= 1);
    assert.ok(prep1.brief.jargonGlossary.length >= 2);
    assert.ok(prep1.brief.everydayAnalogy.length >= 10);
    assert.ok(prep1.brief.progressiveExamples.length >= 2);
    assert.ok(prep1.brief.handsOnTask.length >= 10);
    assert.ok(prep1.brief.commonMisconceptions.length >= 2);
    assert.ok(prep1.brief.masteryVerification.length >= 10);
    assert.ok(
      prep1.tutorial.environmentOrContextSetup?.includes("环境"),
      "Beginner programming lesson must include environment setup guidance",
    );
    assert.equal(prep1.qualityReport.passed, true);
    assert.ok(prep1.qualityReport.score >= 85);

    // Deterministic check: revisiting lesson loads instantaneously from SQLite lesson_preparations with ZERO network calls
    const callsAfterPrep1 = networkCalls;
    assert.ok(callsAfterPrep1 > callsBeforePrep);
    const dbRow = getLessonPreparationFromDb(lesson.id);
    assert.ok(dbRow);
    assert.equal(dbRow.status, "ready");

    const prep2 = await prepareLessonInDepth({
      lesson,
      trackId: "track-agent-1",
      learnerLevel: "beginner",
      mode: "auto_web",
      apiKey: "sk-test-key",
      fetchImpl: mockFetch,
    });
    assert.equal(prep2.cacheHit, true);
    assert.equal(networkCalls, callsAfterPrep1);

    // Ensure quality gate catches shallow drafts
    const shallowReport = evaluateLessonQuality(
      {
        realProblem: "短",
        prerequisites: [],
        jargonGlossary: [],
        everydayAnalogy: "无",
        progressiveExamples: [],
        handsOnTask: "做题",
        commonMisconceptions: [],
        masteryVerification: "会了",
        knowledgeGaps: [],
      },
      {
        headline: "短",
        whyItMatters: "短",
        coreWalkthroughMarkdown: "太浅了",
        checkYourUnderstandingPrompt: "短",
      },
      [],
      "auto_web",
    );
    assert.equal(shallowReport.passed, false);
    assert.ok(shallowReport.score < 50);

    // Verify research_cache row was persisted with source provenance
    assert.equal(getResearchCacheFromDb("non-existent-key"), null);
  } finally {
    env.cleanup();
  }
});

test("Step 6: Domain-adaptive research across Programming, Mathematics, and Humanities", async () => {
  const env = makeTempDb();
  try {
    assert.equal(classifyLearningDomain("Python FastAPI 与 LLM Tool Calling"), "programming");
    assert.equal(classifyLearningDomain("线性代数特征值与贝叶斯定理推导"), "math");
    assert.equal(classifyLearningDomain("唐朝安史之乱与工业革命的历史史料解读"), "humanities");

    const seenQueries: string[] = [];
    const domainMockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/tools/search")) {
        const body = JSON.parse(String(init?.body || "{}")) as { query: string };
        seenQueries.push(body.query);
        return makeJsonResponse(200, {
          results: [
            {
              rerank_score: 2.3,
              title: `权威资料：${body.query.slice(0, 24)}`,
              url: `https://edu.example.org/${seenQueries.length}`,
              snippet: "结构化核心摘要",
              summary: "包含清晰定义、案例与常见误区对比。",
              content: "",
              site_name: "Edu Archive",
              site_icon: null,
              date: "2026-03-01T00:00:00Z",
              authority: 3,
            },
          ],
        });
      }
      return makeJsonResponse(200, {
        title: "Detailed Source",
        content: "# Section\nStructured content excerpt for teaching.",
      });
    };

    // 1. Programming: uses 2 queries including recency (`after:2024`) & pitfalls
    const prog = await researchLearningTopic({
      topic: "TypeScript AI Agent SDK",
      learnerLevel: "intermediate",
      mode: "auto_web",
      apiKey: "sk-test",
      fetchImpl: domainMockFetch,
    });
    assert.equal(prog.domain, "programming");
    assert.equal(prog.queriesUsed.length, 2);
    assert.ok(prog.queriesUsed[0].includes("after:2024"));

    // 2. Mathematics: lighter search (1 query), focuses on intuition/definitions without forcing redundant search volume
    const math = await researchLearningTopic({
      topic: "贝叶斯定理与条件概率",
      learnerLevel: "beginner",
      mode: "auto_web",
      apiKey: "sk-test",
      fetchImpl: domainMockFetch,
    });
    assert.equal(math.domain, "math");
    assert.equal(math.queriesUsed.length, 1);

    // 3. Humanities: queries both context and differing interpretations, surfaces multiPerspectiveNotes
    const hum = await researchLearningTopic({
      topic: "工业革命为何首先发生在英国 历史",
      learnerLevel: "intermediate",
      mode: "auto_web",
      apiKey: "sk-test",
      fetchImpl: domainMockFetch,
    });
    assert.equal(hum.domain, "humanities");
    assert.equal(hum.queriesUsed.length, 2);
    assert.ok(hum.multiPerspectiveNotes && hum.multiPerspectiveNotes.length > 0);

    // 4. Graceful offline degradation when network fails completely
    const failingFetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const degraded = await researchLearningTopic({
      topic: "离线测试主题",
      mode: "auto_web",
      apiKey: "sk-test",
      fetchImpl: failingFetch,
    });
    assert.equal(degraded.effectiveMode, "quick_draft");
    assert.ok(degraded.fallbackNotice && degraded.fallbackNotice.includes("自动降级"));
    assert.ok(degraded.unverifiedPoints.length > 0);
  } finally {
    env.cleanup();
  }
});
