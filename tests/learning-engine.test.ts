import test from "node:test";
import assert from "node:assert/strict";
import {
  closeDbForTesting,
  listDomainEventsFromDb,
  loadStoreFromDb,
  saveStoreToDb,
} from "../lib/db";
import {
  applyPlanDraft,
  listAttemptsForExercise,
  listPendingPlanDrafts,
  registerExercise,
  shuffleChoiceExerciseSpec,
  startLearningSession,
  submitExerciseAttempt,
} from "../lib/learning-engine";
import { type Store, initial } from "../lib/learning";

const TEST_DAY = "2026-11-21";

function seedTwoLessonTrack(): Store {
  const base = initial(TEST_DAY);
  return {
    ...base,
    activeTrackId: "track-agent-e2e",
    goalPlans: [
      {
        id: "track-agent-e2e",
        version: "track-agent-e2e-v1",
        goal: "系统掌握 AI Agent 核心循环",
        title: "AI Agent 核心原理",
        days: 6,
        daily: 30,
        start: 1200,
        units: [
          {
            id: "u-react-loop",
            title: "ReAct 核心循环",
            subtitle: "Thought → Action → Observation",
            minutes: 30,
            requires: [],
            concept: "Agent 根据用户目标决定调用工具、回填 Observation 并判断完成。",
            example: "",
            question: "",
            choices: [],
            answer: 0,
            feedback: "",
          },
          {
            id: "u-agent-memory",
            title: "Agent 对话记忆与状态",
            subtitle: "上下文裁剪与状态隔离",
            minutes: 30,
            requires: ["u-react-loop"],
            concept: "将领域状态与对话上下文分离。",
            example: "",
            question: "",
            choices: [],
            answer: 0,
            feedback: "",
          },
        ],
        slots: [
          {
            id: "blk-u1",
            day: "2026-11-21",
            start: 1200,
            minutes: 30,
            title: "ReAct 核心循环",
            kind: "学习",
            lesson: "u-react-loop",
          },
          {
            id: "blk-u2",
            day: "2026-11-22",
            start: 1200,
            minutes: 30,
            title: "Agent 对话记忆与状态",
            kind: "学习",
            lesson: "u-agent-memory",
          },
        ],
      },
    ],
    blocks: [
      {
        id: "blk-u1",
        day: "2026-11-21",
        start: 1200,
        minutes: 30,
        title: "ReAct 核心循环",
        kind: "学习",
        lesson: "u-react-loop",
      },
      {
        id: "blk-u2",
        day: "2026-11-22",
        start: 1200,
        minutes: 30,
        title: "Agent 对话记忆与状态",
        kind: "学习",
        lesson: "u-agent-memory",
      },
    ],
    mastery: { "u-react-loop": 0, "u-agent-memory": 0 },
  };
}

test("E2E Control Boundary: Session Controller, Single Exercise Deduplication, Deterministic Order Grading, Idempotency, Zero Premature Calendar Mutation, and Plan Draft Application", () => {
  const prev = process.env.LEARNOS_DB_PATH;
  process.env.LEARNOS_DB_PATH = ":memory:";
  closeDbForTesting();

  try {
    // 1. Seed track + 2 scheduled lessons in SQLite (works 100% offline with zero LLM key)
    saveStoreToDb(seedTwoLessonTrack(), {
      trigger: "初始化测试轨道",
      summary: "创建 2 节测试课程",
    });

    // 2. startLearningSession opens lesson deterministically (no chat prompt sent!)
    const started = startLearningSession({
      lessonId: "u-react-loop",
      trackId: "track-agent-e2e",
      mode: "practice",
      day: TEST_DAY,
    });
    assert.ok(started.session.learning_session_id.startsWith("ls-"));
    assert.equal(started.session.lesson_id, "u-react-loop");
    assert.equal(started.session.current_mode, "practice");

    // 3. Register a canonical order_steps exercise and verify strict deduplication
    const correctOrder = [
      "用户目标",
      "LLM Action",
      "工具执行",
      "Observation 回填",
      "Final Answer",
    ];
    const shuffled = [
      "工具执行",
      "Final Answer",
      "Observation 回填",
      "用户目标",
      "LLM Action",
    ];
    const reg1 = registerExercise({
      lessonId: "u-react-loop",
      learningSessionId: started.session.learning_session_id,
      mode: "order_steps",
      prompt: "请还原 Agent 处理用户请求时的正确执行顺序。",
      spec: {
        lessonTitle: "ReAct 核心循环",
        steps: shuffled,
        correctStepsOrder: correctOrder,
      },
      source: "tutor_candidate",
    });
    assert.equal(reg1.deduplicated, false);

    // Calling registerExercise again with the same prompt & mode MUST deduplicate!
    const reg2 = registerExercise({
      lessonId: "u-react-loop",
      learningSessionId: started.session.learning_session_id,
      mode: "order_steps",
      prompt: "请还原 Agent 处理用户请求时的正确执行顺序。",
      spec: {
        lessonTitle: "ReAct 核心循环",
        steps: shuffled,
        correctStepsOrder: correctOrder,
      },
      source: "tutor_candidate",
    });
    assert.equal(reg2.deduplicated, true);
    assert.equal(reg2.exercise.exercise_id, reg1.exercise.exercise_id);

    // 4. Submit user's exact misordered sequence via Assessment Service (NO LLM call!)
    const beforeBlocks = loadStoreFromDb(TEST_DAY).blocks;
    const failRes = submitExerciseAttempt({
      exerciseId: reg1.exercise.exercise_id,
      learningSessionId: started.session.learning_session_id,
      idempotencyKey: "idem-attempt-1",
      answer: { selectedOrder: shuffled },
      day: TEST_DAY,
    });

    assert.equal(failRes.deduplicated, false);
    assert.equal(failRes.attempt.correct, false);
    assert.equal(failRes.attempt.score, 0);
    assert.equal(failRes.attempt.grader_version, "deterministic-v1");
    assert.equal(failRes.attempt.error_type, "start_and_exit_position_error");
    assert.ok(failRes.attempt.position_matches);
    // Position 2 factually had "Final Answer" while expected was "LLM Action"
    assert.equal(failRes.attempt.position_matches![1].submitted, "Final Answer");
    assert.equal(failRes.attempt.position_matches![1].expected, "LLM Action");
    assert.equal(failRes.attempt.position_matches![1].matched, false);

    // Cold-start BKT honesty: failed attempt from 0% MUST stay 0% (never bump 0% -> 8%!)
    assert.equal(failRes.learnerUpdate?.before, 0);
    assert.equal(failRes.learnerUpdate?.after, 0);

    // ZERO premature calendar mutation! Real SQLite blocks must be untouched until user confirms draft
    const afterFailBlocks = loadStoreFromDb(TEST_DAY).blocks;
    assert.equal(afterFailBlocks.length, beforeBlocks.length);
    assert.equal(
      afterFailBlocks.find((b) => b.id === "blk-u2")?.day,
      "2026-11-22",
    );

    // A pending Plan Draft must be created for user preview & approval
    assert.ok(failRes.planDraft);
    assert.equal(failRes.planDraft!.status, "pending");
    assert.equal(failRes.planDraft!.diff.addedBlocks.length, 1);

    // 5. Duplicate submission with same idempotencyKey MUST be idempotent!
    const dupRes = submitExerciseAttempt({
      exerciseId: reg1.exercise.exercise_id,
      learningSessionId: started.session.learning_session_id,
      idempotencyKey: "idem-attempt-1",
      answer: { selectedOrder: shuffled },
      day: TEST_DAY,
    });
    assert.equal(dupRes.deduplicated, true);
    assert.equal(dupRes.attempt.attempt_id, failRes.attempt.attempt_id);
    assert.equal(
      listAttemptsForExercise(reg1.exercise.exercise_id).length,
      1,
    );
    assert.equal(listPendingPlanDrafts("u-react-loop").length, 1);
    const assessEventsAfterDup = listDomainEventsFromDb(20).filter(
      (e) => e.eventType === "AssessmentCompleted",
    );
    assert.equal(assessEventsAfterDup.length, 1);

    // 6. Explicit user confirmation applies the Plan Draft atomically & idempotently
    const applied1 = applyPlanDraft(failRes.planDraft!.draft_id, TEST_DAY);
    assert.equal(applied1.applied, true);
    assert.equal(applied1.draft.status, "applied");
    assert.equal(
      loadStoreFromDb(TEST_DAY).blocks.length,
      beforeBlocks.length + 1,
    );

    const applied2 = applyPlanDraft(failRes.planDraft!.draft_id, TEST_DAY);
    assert.equal(applied2.applied, false);
    assert.equal(
      loadStoreFromDb(TEST_DAY).blocks.length,
      beforeBlocks.length + 1,
    );

    // 7. Correct submission grades 100% deterministically and advances BKT honestly
    const passRes = submitExerciseAttempt({
      exerciseId: reg1.exercise.exercise_id,
      learningSessionId: started.session.learning_session_id,
      idempotencyKey: "idem-attempt-2",
      answer: { selectedOrder: correctOrder },
      day: TEST_DAY,
    });
    assert.equal(passRes.attempt.correct, true);
    assert.equal(passRes.attempt.score, 100);
    assert.ok((passRes.learnerUpdate?.after ?? 0) > 0);
  } finally {
    closeDbForTesting();
    if (prev === undefined) delete process.env.LEARNOS_DB_PATH;
    else process.env.LEARNOS_DB_PATH = prev;
  }
});

test("MCQ Positional Bias Elimination: shuffleChoiceExerciseSpec & registerExercise(shuffleChoices:true) randomize option positions, remap correctChoiceIndex/explanation, and grade accurately", () => {
  const prev = process.env.LEARNOS_DB_PATH;
  process.env.LEARNOS_DB_PATH = ":memory:";
  closeDbForTesting();

  try {
    saveStoreToDb(seedTwoLessonTrack(), {
      trigger: "初始化测试轨道",
      summary: "创建 2 节测试课程",
    });
    const started = startLearningSession({
      lessonId: "u-react-loop",
      trackId: "track-agent-e2e",
      mode: "practice",
      day: TEST_DAY,
    });

    // 1. Deterministic rotation test: move option B (index 1) to option D (index 3)
    const rotated = shuffleChoiceExerciseSpec(
      "choice",
      {
        choices: [
          "A. 干扰项 1",
          "B. 真正的正确答案（PATH 未配置）",
          "C. 干扰项 2",
          "D. 干扰项 3",
        ],
        correctChoiceIndex: 1,
        explanation: "因此选 B，B 项准确指出了 PATH 环境变量缺失。",
      },
      { randomInt: () => 0 }, // deterministic swap sequence
    );
    assert.equal(
      rotated.choices![rotated.correctChoiceIndex!],
      "真正的正确答案（PATH 未配置）",
      "Leading letter prefixes stripped and correctChoiceIndex points to the exact right answer",
    );
    assert.notEqual(rotated.correctChoiceIndex, 1);
    const expectedLetter = String.fromCharCode(65 + rotated.correctChoiceIndex!);
    assert.ok(
      rotated.explanation?.includes(`选 ${expectedLetter}`),
      `Explanation letter reference must remap from B to ${expectedLetter}: got ${rotated.explanation}`,
    );

    // 2. Meta-option "以上都对" stays pinned at the last position
    const withPinnedTail = shuffleChoiceExerciseSpec(
      "choice",
      {
        choices: ["特点一", "特点二", "特点三", "以上都对"],
        correctChoiceIndex: 3,
      },
      { randomInt: () => 0 },
    );
    assert.equal(withPinnedTail.choices![3], "以上都对");
    assert.equal(withPinnedTail.correctChoiceIndex, 3);

    // 3. Statistical distribution across 36 tutor-generated MCQs that ALL start with correctChoiceIndex=1 (Option B)
    const seenIndices = new Set<number>();
    let lastExerciseId = "";
    let lastCorrectIdx = 0;

    for (let i = 0; i < 36; i++) {
      const reg = registerExercise({
        lessonId: "u-react-loop",
        learningSessionId: started.session.learning_session_id,
        mode: "choice",
        prompt: `第 ${i + 1} 道单选题：为什么会出现该报错？`,
        spec: {
          choices: [
            "错误解释 1",
            "正确解释：缺少 PATH 环境变量",
            "错误解释 2",
            "错误解释 3",
          ],
          correctChoiceIndex: 1, // LLM bias: always index 1 (B)
        },
        source: "tutor_candidate",
        shuffleChoices: true,
      });
      const idx = reg.exercise.spec.correctChoiceIndex!;
      seenIndices.add(idx);
      assert.equal(
        reg.exercise.spec.choices![idx],
        "正确解释：缺少 PATH 环境变量",
      );
      lastExerciseId = reg.exercise.exercise_id;
      lastCorrectIdx = idx;
    }

    assert.equal(
      seenIndices.size,
      4,
      `Correct answer must appear across all 4 options A/B/C/D (0,1,2,3), saw: ${[...seenIndices].join(",")}`,
    );

    // 4. Submitting the shuffled correctChoiceIndex grades as 100% correct
    const attemptRes = submitExerciseAttempt({
      exerciseId: lastExerciseId,
      learningSessionId: started.session.learning_session_id,
      idempotencyKey: "idem-shuffled-choice",
      answer: { choiceIndex: lastCorrectIdx },
      day: TEST_DAY,
    });
    assert.equal(attemptRes.attempt.correct, true);
    assert.equal(attemptRes.attempt.score, 100);
  } finally {
    closeDbForTesting();
    if (prev === undefined) delete process.env.LEARNOS_DB_PATH;
    else process.env.LEARNOS_DB_PATH = prev;
  }
});
