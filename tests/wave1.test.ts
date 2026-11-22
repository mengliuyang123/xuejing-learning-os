import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDbForTesting,
  getDb,
  loadStoreFromDb,
  saveStoreToDb,
} from "../lib/db";
import {
  type GoalPlan,
  type Lesson,
  type Store,
  emptyStore,
} from "../lib/learning";
import {
  LearningEngineError,
  applyPlanDraft,
  dismissPlanDraft,
  listPendingPlanDrafts,
  registerExercise,
  startLearningSession,
  submitExerciseAttempt,
} from "../lib/learning-engine";

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "learnos-wave1-"));
  const dbPath = join(dir, "test.sqlite");
  process.env.LEARNOS_DB_PATH = dbPath;
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

function makeLesson(id: string, title: string, requires: string[] = []): Lesson {
  return {
    id,
    title,
    subtitle: title,
    minutes: 30,
    requires,
    concept: `${title} 概念`,
    example: "code()",
    question: `${title} 测验`,
    choices: ["正确", "错误 A", "错误 B"],
    answer: 0,
    feedback: "解析",
  };
}

function seedTwoLessonStore() {
  const u1 = makeLesson("l1", "第一课：JSON 基础");
  const u2 = makeLesson("l2", "第二课：Tool Calling", ["l1"]);
  const plan: GoalPlan = {
    id: "tr-w1",
    version: "tr-w1-v1",
    goal: "AI Agent",
    title: "AI Agent",
    days: 7,
    daily: 30,
    start: 1140,
    units: [u1, u2],
    slots: [],
  };
  const store: Store = {
    ...emptyStore("2026-11-21"),
    activeTrackId: "tr-w1",
    goalPlans: [plan],
    mastery: { l1: 90, l2: 0 },
  };
  saveStoreToDb(store, { trigger: "seed" });
}

test("Wave 1 (GEN-09, E2E-004, SORT-06/07/08, ASSESS-03): Rejects invalid exercise specs and invalid order_steps submissions with 400 and zero side effects", () => {
  const env = makeTempDb();
  try {
    seedTwoLessonStore();
    const { session } = startLearningSession({
      lessonId: "l1",
      trackId: "tr-w1",
      day: "2026-11-21",
    });

    // GEN-09: choice without correctChoiceIndex rejected
    assert.throws(
      () =>
        registerExercise({
          lessonId: "l1",
          learningSessionId: session.learning_session_id,
          mode: "choice",
          prompt: "缺答案单选题",
          spec: { choices: ["A", "B"] },
        }),
      (err: unknown) =>
        err instanceof LearningEngineError &&
        err.code === "INVALID_EXERCISE_SPEC" &&
        err.status === 400,
    );

    // Register valid order_steps exercise WITHOUT passing learningSessionId -> E2E-003 auto-binds session!
    const { exercise } = registerExercise({
      lessonId: "l1",
      mode: "order_steps",
      prompt: "排列 Agent 执行流程",
      spec: {
        steps: ["A", "B", "C", "D", "E"],
        correctStepsOrder: ["A", "B", "C", "D", "E"],
      },
      source: "tutor_candidate",
    });
    assert.equal(exercise.learning_session_id, session.learning_session_id);

    const db = getDb();
    const exRow = db
      .prepare("SELECT learning_session_id FROM exercises WHERE exercise_id = ?")
      .get(exercise.exercise_id) as { learning_session_id: string | null };
    assert.equal(exRow.learning_session_id, session.learning_session_id);

    // SORT-06 (empty), SORT-07 (missing steps), SORT-08 (duplicate steps) all rejected with 400
    for (const [key, badOrder] of [
      ["sort-06", []],
      ["sort-07", ["A", "B"]],
      ["sort-08", ["A", "B", "C", "D", "D"]],
      ["sort-unknown", ["A", "B", "C", "D", "Z"]],
    ] as const) {
      assert.throws(
        () =>
          submitExerciseAttempt({
            exerciseId: exercise.exercise_id,
            learningSessionId: session.learning_session_id,
            idempotencyKey: key,
            answer: { selectedOrder: [...badOrder] },
            day: "2026-11-21",
          }),
        (err: unknown) =>
          err instanceof LearningEngineError &&
          err.code === "INVALID_ANSWER_PAYLOAD" &&
          err.status === 400,
      );
    }

    // Verify ZERO attempts, ZERO drafts, unchanged mastery
    const attCount = (
      db.prepare("SELECT COUNT(*) AS c FROM exercise_attempts").get() as {
        c: number;
      }
    ).c;
    assert.equal(attCount, 0);
    assert.equal(listPendingPlanDrafts().length, 0);
    assert.equal(loadStoreFromDb("2026-11-21").mastery.l1, 90);
  } finally {
    env.cleanup();
  }
});

test("Wave 1 (ASSESS-07 & old exercise switching): Rejects cross-lesson session submission and allows reopening older exercises", () => {
  const env = makeTempDb();
  try {
    seedTwoLessonStore();
    const s1 = startLearningSession({
      lessonId: "l1",
      trackId: "tr-w1",
      day: "2026-11-21",
    });
    assert.equal(s1.session.completion_status, "completed");

    const exOld = registerExercise({
      lessonId: "l2",
      mode: "choice",
      prompt: "第二课旧单选",
      spec: { choices: ["X", "Y"], correctChoiceIndex: 0 },
    });
    const exNew = registerExercise({
      lessonId: "l2",
      mode: "fill_blank",
      prompt: "第二课新填空",
      spec: { blanks: [{ id: "b1", answer: "json.loads" }] },
    });

    // Reopening old exercise by explicit exerciseId works
    const restoredOld = startLearningSession({
      lessonId: "l2",
      exerciseId: exOld.exercise.exercise_id,
      day: "2026-11-21",
    });
    assert.equal(restoredOld.exercise?.exercise_id, exOld.exercise.exercise_id);
    assert.equal(restoredOld.exercises.length >= 2, true);
    assert.notEqual(exNew.exercise.exercise_id, exOld.exercise.exercise_id);

    // ASSESS-07: submitting l2's exercise with l1's completed session is rejected with 400
    assert.throws(
      () =>
        submitExerciseAttempt({
          exerciseId: exOld.exercise.exercise_id,
          learningSessionId: s1.session.learning_session_id,
          idempotencyKey: "cross-lesson-1",
          answer: { choiceIndex: 1 },
          day: "2026-11-21",
        }),
      (err: unknown) =>
        err instanceof LearningEngineError &&
        err.code === "LESSON_SESSION_MISMATCH" &&
        err.status === 400,
    );

    // Verify l1's completed session was NOT corrupted
    const db = getDb();
    const s1Row = db
      .prepare(
        "SELECT progress, completion_status FROM learning_sessions WHERE learning_session_id = ?",
      )
      .get(s1.session.learning_session_id) as {
      progress: number;
      completion_status: string;
    };
    assert.equal(s1Row.completion_status, "completed");
    assert.equal(s1Row.progress, 90);
  } finally {
    env.cleanup();
  }
});

test("Wave 1 & 2.1 (E2E-006, SCHED-07/09, DIFF-06/11/12, DATA-14): Deduplicates remedial drafts, redirects locked prereq remediation, and blocks dismissed/expired/conflicting draft applications", () => {
  const env = makeTempDb();
  try {
    seedTwoLessonStore();
    const s2 = startLearningSession({
      lessonId: "l2",
      trackId: "tr-w1",
      day: "2026-11-21",
    });
    const { exercise } = registerExercise({
      lessonId: "l2",
      learningSessionId: s2.session.learning_session_id,
      mode: "choice",
      prompt: "Tool Calling 校验题",
      spec: { choices: ["正确", "错1", "错2"], correctChoiceIndex: 0 },
    });

    // E2E-006: 7 consecutive failures produce ONLY 1 deduplicated pending draft
    let lastDraftId = "";
    for (let i = 1; i <= 7; i++) {
      const res = submitExerciseAttempt({
        exerciseId: exercise.exercise_id,
        learningSessionId: s2.session.learning_session_id,
        idempotencyKey: `wrong-${i}`,
        answer: { choiceIndex: 1 },
        day: "2026-11-21",
      });
      assert.ok(res.planDraft);
      lastDraftId = res.planDraft.draft_id;
    }
    const pending = listPendingPlanDrafts("l2");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].draft_id, lastDraftId);

    // DIFF-12 / DATA-14: Occupy the draft's target slot -> applyPlanDraft rejects with 409 DRAFT_CONFLICT
    const proposed = pending[0].diff.addedBlocks[0];
    const liveStore = loadStoreFromDb("2026-11-21");
    liveStore.blocks.push({
      id: "blk-occupied",
      day: proposed.day,
      start: proposed.start,
      minutes: 15,
      title: "新插入复习块",
      kind: "复习",
    });
    saveStoreToDb(liveStore, { trigger: "插入冲突块" });

    assert.throws(
      () => applyPlanDraft(lastDraftId, "2026-11-21"),
      (err: unknown) =>
        err instanceof LearningEngineError &&
        err.code === "DRAFT_CONFLICT" &&
        err.status === 409,
    );

    // DIFF-06: Dismissed draft cannot be applied via API
    dismissPlanDraft(lastDraftId);
    assert.throws(
      () => applyPlanDraft(lastDraftId, "2026-11-21"),
      (err: unknown) =>
        err instanceof LearningEngineError &&
        err.code === "DRAFT_NOT_PENDING" &&
        err.status === 409,
    );

    // DIFF-11: Stale draft (created_at = 2020-01-01) is marked expired and rejected with 409
    const freshFail = submitExerciseAttempt({
      exerciseId: exercise.exercise_id,
      learningSessionId: s2.session.learning_session_id,
      idempotencyKey: "wrong-for-expiry",
      answer: { choiceIndex: 2 },
      day: "2026-11-21",
    });
    assert.ok(freshFail.planDraft);
    const expDraftId = freshFail.planDraft.draft_id;
    const db = getDb();
    db.prepare("UPDATE plan_drafts SET created_at = '2020-01-01T00:00:00.000Z' WHERE draft_id = ?").run(
      expDraftId,
    );
    assert.throws(
      () => applyPlanDraft(expDraftId, "2026-11-21"),
      (err: unknown) =>
        err instanceof LearningEngineError &&
        err.code === "DRAFT_EXPIRED" &&
        err.status === 409,
    );

    // SCHED-07 / SCHED-09: When l1 (prerequisite) drops below 80%, failing l2 directs remediation to l1
    const curStore = loadStoreFromDb("2026-11-21");
    curStore.mastery.l1 = 30;
    saveStoreToDb(curStore, { trigger: "降低先修掌握度" });
    const prereqFail = submitExerciseAttempt({
      exerciseId: exercise.exercise_id,
      learningSessionId: s2.session.learning_session_id,
      idempotencyKey: "wrong-with-unmet-prereq",
      answer: { choiceIndex: 1 },
      day: "2026-11-21",
    });
    assert.equal(prereqFail.planDraft?.lesson_id, "l1");
  } finally {
    env.cleanup();
  }
});
