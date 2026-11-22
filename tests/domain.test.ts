import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTodaySnapshot,
  generateCandidateActivities,
  selectActivitiesForTimeBudget,
} from "../lib/domain-activities";
import type { Lesson } from "../lib/learning";
import { classifyTaskType } from "../lib/context-manager";
import { resolveLessonPracticeSpec } from "../lib/lesson-practice";
import { AgentTraceRecorder } from "../lib/agent-trace";
import {
  closeDbForTesting,
  listDomainEventsFromDb,
  saveStoreToDb,
} from "../lib/db";
import { initial, type Store } from "../lib/learning";

const DAY = "2026-11-21";

function buildSampleStore(): Store {
  const s = initial(DAY);
  s.activeTrackId = "track-agent";
  s.goalPlans = [
    {
      id: "track-agent",
      version: "v1",
      goal: "8 周掌握 Agent 开发",
      title: "AI Agent 开发实战",
      days: 14,
      daily: 60,
      start: 1200,
      units: [
        {
          id: "ag-1",
          title: "Prompt 与结构化输出",
          subtitle: "结构化约束基础",
          concept: "Schema 约束输出",
          example: "{}",
          minutes: 30,
          requires: [],
          question: "如何约束 JSON 输出？",
          choices: ["Schema", "纯文本"],
          answer: 0,
          feedback: "答对后进入下一步",
        },
        {
          id: "ag-2",
          title: "Tool Calling 函数参数与错误处理",
          subtitle: "工具参数校验与异常恢复",
          concept: "工具定义与异常恢复",
          example: "{}",
          minutes: 30,
          requires: ["ag-1"],
          question: "工具调用出错如何处理？",
          choices: ["返回结构化错误", "静默忽略"],
          answer: 0,
          feedback: "答对后进入下一步",
        },
        {
          id: "ag-3",
          title: "ReAct 多步循环与状态规划",
          subtitle: "多步决策执行闭环",
          concept: "Observation -> Action",
          example: "{}",
          minutes: 55,
          requires: ["ag-2"],
          question: "ReAct 为什么需要 Observation？",
          choices: ["依据真实工具结果决策", "增加字数"],
          answer: 0,
          feedback: "答对后进入下一步",
        },
      ],
      slots: [],
    },
  ];
  // ag-1 mastered but due for review; ag-2 unlocked in progress; ag-3 locked behind ag-2
  s.mastery = { "ag-1": 85, "ag-2": 50, "ag-3": 0 };
  s.masteryMeta = {
    "ag-1": {
      stabilityDays: 2,
      lastReviewDay: "2026-11-17",
      nextReviewDay: "2026-11-19", // overdue!
      attempts: 2,
      lastResult: true,
    },
  };
  s.blocks = [
    {
      id: "blk-today-1",
      day: DAY,
      start: 1200,
      minutes: 30,
      title: "Tool Calling 函数参数与错误处理",
      kind: "学习",
      lesson: "ag-2",
    },
  ];
  return s;
}

test("Domain Activities: generateCandidateActivities & selectActivitiesForTimeBudget adapt to 15m/30m/60m windows", () => {
  const s = buildSampleStore();
  const candidates = generateCandidateActivities(s, DAY);

  // ag-3 is locked behind ag-2 (50% < 80%), so only ag-1 (review) and ag-2 (practice) should be candidates
  assert.equal(candidates.length, 2);
  assert.ok(candidates.some((c) => c.conceptId === "ag-1" && c.type === "review"));
  assert.ok(candidates.some((c) => c.conceptId === "ag-2" && c.type === "practice"));

  // 15-minute window should pick the 15-minute FSRS active recall review first
  const for15m = selectActivitiesForTimeBudget(candidates, 15, "medium");
  assert.equal(for15m[0].conceptId, "ag-1");
  assert.equal(for15m[0].type, "review");

  // 30-minute window with high energy can pick practice or review cleanly within budget
  const for30m = selectActivitiesForTimeBudget(candidates, 30, "high");
  assert.ok(for30m.length >= 1);
  assert.ok(for30m[0].estimatedMinutes <= 30);

  // Today snapshot computes accurate KPIs directly from domain state (no chat history needed)
  const snap = buildTodaySnapshot(s, DAY);
  assert.equal(snap.todayMinutes, 30);
  assert.equal(snap.dueReviewCount, 1);
  assert.equal(snap.goalProgressPct, 33);
  assert.ok(snap.nextBestAction);
});

test("Task-Aware Context Classifier distinguishes learn, plan, and chat accurately", () => {
  assert.equal(classifyTaskType("下周三加班，帮我把课程重排到周五"), "plan");
  assert.equal(classifyTaskType("开始学习 Tool Calling 并出一道填空题"), "learn");
  assert.equal(classifyTaskType("你好，总结一下现状"), "chat");
  assert.equal(
    classifyTaskType("看看这个", { type: "block" }),
    "plan",
  );
  assert.equal(
    classifyTaskType("看看这个", { type: "lesson" }),
    "learn",
  );
});

test("Event-Driven SQLite domain_events links Agent Trace runs & Plan Revisions", async () => {
  const prev = process.env.LEARNOS_DB_PATH;
  process.env.LEARNOS_DB_PATH = ":memory:";
  closeDbForTesting();

  try {
    const s = buildSampleStore();
    saveStoreToDb(s, { trigger: "初始排程", summary: "排入 Tool Calling 课程" });

    const trace = new AgentTraceRecorder({
      runId: "run-evt-link-1",
      conversationId: "track-agent",
      provider: "deepseek",
      model: "deepseek-chat",
      modelLabel: "DeepSeek",
      userPrompt: "提交测验答案",
    });
    trace.recordRunStarted();
    await trace.wrapToolExecution({
      toolCallId: "tc-assess-e1",
      toolName: "record_learning_assessment",
      args: { lessonId: "ag-2", correct: true },
      execute: () => ({ kind: "mastery_update", attemptId: "att-1" }),
      captureStateChanges: () => [
        {
          entityType: "assessment_record",
          entityId: "att-1",
          action: "create",
          afterState: { correct: true, after: 82 },
        },
      ],
    });
    trace.recordRunCompleted({ finalResponse: "已更新掌握度。" });

    const events = listDomainEventsFromDb(20);
    assert.ok(events.some((e) => e.eventType === "PlanVersionCreated"));
    const assessEvt = events.find((e) => e.eventType === "AssessmentCompleted");
    assert.ok(assessEvt);
    assert.equal(assessEvt!.runId, "run-evt-link-1");
  } finally {
    closeDbForTesting();
    if (prev === undefined) delete process.env.LEARNOS_DB_PATH;
    else process.env.LEARNOS_DB_PATH = prev;
  }
});

test("Dynamic Practice Spec distinguishes CodeMirror code lessons vs prose text lessons", () => {
  const theoryLesson: Lesson = {
    id: "u-theory",
    title: "LLM 是怎样被调用的一次：Token、上下文与 API",
    subtitle: "理解 Token 与上下文原理",
    minutes: 30,
    requires: [],
    concept: "理解大模型只做一件事：给定上下文，预测下一个 token。",
    example: "",
    question: "",
    choices: [],
    answer: 0,
    feedback: "",
  };
  const theorySpec = resolveLessonPracticeSpec(
    theoryLesson,
    "AI Agent 开发 · 原理入门",
  );
  assert.equal(theorySpec.kind, "text");

  const pyLesson: Lesson = {
    ...theoryLesson,
    id: "u-py",
    title: "Python 最小语法：变量、函数与字典",
    example: "def greet(name):\n    return f'hi {name}'",
  };
  const pySpec = resolveLessonPracticeSpec(pyLesson, "AI Agent 开发 · 零基础起步");
  assert.equal(pySpec.kind, "code");
  assert.equal(pySpec.language, "python");

  const jsonLesson: Lesson = {
    ...theoryLesson,
    id: "u-json",
    title: "Tool Calling：用 JSON Schema 描述工具",
    example: '{"type": "object", "properties": {"city": {"type": "string"}}}',
  };
  const jsonSpec = resolveLessonPracticeSpec(jsonLesson, "AI Agent");
  assert.equal(jsonSpec.kind, "code");
  assert.equal(jsonSpec.language, "json");

  const explicitOverride: Lesson = {
    ...theoryLesson,
    practiceType: "code",
    practiceLanguage: "typescript",
    starterCode: "const x: number = 1;",
  };
  const overrideSpec = resolveLessonPracticeSpec(explicitOverride, "原理入门");
  assert.equal(overrideSpec.kind, "code");
  assert.equal(overrideSpec.language, "typescript");
  assert.equal(overrideSpec.starterCode, "const x: number = 1;");
});
