import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UIMessage } from "ai";
import {
  CURRENT_DB_SCHEMA_VERSION,
  PrerequisiteCycleError,
  SchemaVersionError,
  StateVersionConflictError,
  archiveTrackInDb,
  clearAllDataInDb,
  closeDbForTesting,
  createPreResetSnapshotInDb,
  exportFullBackupFromDb,
  getChatThreadFromDb,
  getChatThreadPageFromDb,
  getDb,
  getTrackImpactFromDb,
  listAuditFromDb,
  loadStoreFromDb,
  permanentlyDeleteTrackInDb,
  restoreTrackInDb,
  saveChatThreadToDb,
  saveStoreToDb,
} from "../lib/db";
import {
  type GoalPlan,
  type Lesson,
  type Store,
  emptyStore,
  getTracks,
} from "../lib/learning";
import {
  registerExercise,
  startLearningSession,
  submitExerciseAttempt,
} from "../lib/learning-engine";

function makeTempDbDir() {
  const dir = mkdtempSync(join(tmpdir(), "learnos-wave0-"));
  const dbPath = join(dir, "test.sqlite");
  return {
    dir,
    dbPath,
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
    concept: `${title} 核心概念`,
    example: "print('hello')",
    question: `${title} 检查题`,
    choices: ["正确选项", "错误选项 A", "错误选项 B"],
    answer: 0,
    feedback: "标准解释",
  };
}

function makePlan(id: string, title: string, units: Lesson[]): GoalPlan {
  return {
    id,
    version: `${id}-v1`,
    goal: title,
    title,
    days: 7,
    daily: 30,
    start: 1140,
    units,
    slots: [],
  };
}

test("Wave 0 (DB-21): SQLite sets user_version=1 and rejects future unsupported schema version (v999)", () => {
  const env = makeTempDbDir();
  try {
    process.env.LEARNOS_DB_PATH = env.dbPath;
    const db = getDb();
    const vRow = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.equal(vRow.user_version, CURRENT_DB_SCHEMA_VERSION);
    closeDbForTesting();

    // Simulate future DB schema v999
    const raw = new DatabaseSync(env.dbPath);
    raw.exec("PRAGMA user_version = 999;");
    raw.close();

    assert.throws(
      () => loadStoreFromDb("2026-11-21"),
      (err: unknown) =>
        err instanceof SchemaVersionError &&
        err.code === "SCHEMA_VERSION_UNSUPPORTED" &&
        err.foundVersion === 999,
    );

    // Ensure user_version was not silently mutated
    const check = new DatabaseSync(env.dbPath);
    const after = check.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    check.close();
    assert.equal(after.user_version, 999);
  } finally {
    env.cleanup();
  }
});

test("Wave 0 (PERF-02): Chat thread stores all 1,000 messages without -120 truncation and supports cursor pagination", () => {
  const env = makeTempDbDir();
  try {
    process.env.LEARNOS_DB_PATH = env.dbPath;
    const msgs: UIMessage[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `m-${i + 1}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `消息编号 #${i + 1}` }],
    }));

    saveChatThreadToDb("thread-1000", "agent", msgs, { title: "千条历史测试" });

    const all = getChatThreadFromDb("thread-1000");
    assert.equal(all.length, 1000);
    assert.equal(all[0].id, "m-1");
    assert.equal(all[999].id, "m-1000");

    const latestPage = getChatThreadPageFromDb("thread-1000", { limit: 50 });
    assert.equal(latestPage.totalCount, 1000);
    assert.equal(latestPage.messages.length, 50);
    assert.equal(latestPage.messages[0].id, "m-951");
    assert.equal(latestPage.messages[49].id, "m-1000");
    assert.equal(latestPage.hasMore, true);
    assert.equal(latestPage.nextBeforeIndex, 950);

    const olderPage = getChatThreadPageFromDb("thread-1000", {
      limit: 50,
      beforeIndex: latestPage.nextBeforeIndex,
    });
    assert.equal(olderPage.messages[0].id, "m-901");
    assert.equal(olderPage.messages[49].id, "m-950");
  } finally {
    env.cleanup();
  }
});

test("Wave 0 (DB-14, FAIL-15, DB-09, KNOW-12): Optimistic locking prevents silent overwrite, plan_revisions increment version_seq, and cyclic prereqs are rejected", () => {
  const env = makeTempDbDir();
  try {
    process.env.LEARNOS_DB_PATH = env.dbPath;
    const u1 = makeLesson("u1", "第一课");
    const u2 = makeLesson("u2", "第二课", ["u1"]);
    const baseStore: Store = {
      ...emptyStore("2026-11-21"),
      activeTrackId: "tr-1",
      goalPlans: [makePlan("tr-1", "AI 基础", [u1, u2])],
      blocks: [
        {
          id: "blk-1",
          day: "2026-11-21",
          start: 1140,
          minutes: 30,
          title: "第一课",
          kind: "学习",
          lesson: "u1",
        },
      ],
    };

    const r1 = saveStoreToDb(baseStore, { trigger: "初始建轨" });
    assert.equal(r1.stateVersion, 1);
    assert.equal(r1.revisionSeq, 1);

    // Two concurrent clients read the exact same snapshot (stateVersion=1)
    const snapA = loadStoreFromDb("2026-11-21");
    const snapB = loadStoreFromDb("2026-11-21");
    assert.equal(snapA.stateVersion, 1);
    assert.equal(snapB.stateVersion, 1);

    // Client A moves blk-1 to 1200 -> succeeds, bumps stateVersion=2, version_seq=2
    snapA.blocks[0] = { ...snapA.blocks[0], start: 1200 };
    const rA = saveStoreToDb(snapA, { trigger: "编辑 A" });
    assert.equal(rA.stateVersion, 2);
    assert.equal(rA.revisionSeq, 2);

    // Client B tries to save stale snapshot (stateVersion=1) -> rejected with 409 conflict!
    snapB.blocks[0] = { ...snapB.blocks[0], start: 1260 };
    assert.throws(
      () => saveStoreToDb(snapB, { trigger: "编辑 B" }),
      (err: unknown) =>
        err instanceof StateVersionConflictError &&
        err.expectedVersion === 1 &&
        err.currentVersion === 2,
    );

    // Verify revision chain and goal_plan version bump
    const audit = listAuditFromDb(10);
    assert.equal(audit.revisions.length, 2);
    assert.equal(audit.revisions[0].versionSeq, 2);
    assert.equal(audit.revisions[0].parentRevisionId, audit.revisions[1].id);
    const reloaded = loadStoreFromDb("2026-11-21");
    assert.equal(reloaded.blocks[0].start, 1200);
    assert.equal(reloaded.goalPlans?.[0].version, "tr-1-v2");

    // KNOW-12: Cyclic prerequisite graph rejected
    const cyclicStore: Store = {
      ...reloaded,
      goalPlans: [
        makePlan("tr-1", "AI 基础", [
          makeLesson("u1", "第一课", ["u2"]),
          makeLesson("u2", "第二课", ["u1"]),
        ]),
      ],
    };
    assert.throws(
      () => saveStoreToDb(cyclicStore, { trigger: "注入循环" }),
      (err: unknown) =>
        err instanceof PrerequisiteCycleError &&
        err.code === "CYCLIC_PREREQUISITE_DETECTED",
    );
  } finally {
    env.cleanup();
  }
});

test("Wave 0 (DB-24, DB-19, DESK-20): Track archive/restore preserves history, permanent delete protects shared data, full backup covers all tables, and pre-reset snapshot succeeds", () => {
  const env = makeTempDbDir();
  try {
    process.env.LEARNOS_DB_PATH = env.dbPath;
    const sharedU = makeLesson("u-shared", "共享基础课");
    const tr1Only = makeLesson("u-tr1", "轨道一独占课", ["u-shared"]);
    const tr2Only = makeLesson("u-tr2", "轨道二独占课", ["u-shared"]);

    const initial: Store = {
      ...emptyStore("2026-11-21"),
      activeTrackId: "tr-1",
      goalPlans: [
        makePlan("tr-1", "AI Agent 轨道", [sharedU, tr1Only]),
        makePlan("tr-2", "Python 轨道", [sharedU, tr2Only]),
      ],
      blocks: [
        {
          id: "blk-tr1-future",
          day: "2026-11-22",
          start: 1140,
          minutes: 30,
          title: "轨道一未来课",
          kind: "学习",
          lesson: "u-tr1",
          done: false,
        },
        {
          id: "blk-tr1-done",
          day: "2026-11-20",
          start: 1140,
          minutes: 30,
          title: "轨道一已完成课",
          kind: "学习",
          lesson: "u-tr1",
          done: true,
        },
        {
          id: "blk-tr2-future",
          day: "2026-11-23",
          start: 1140,
          minutes: 30,
          title: "轨道二未来课",
          kind: "学习",
          lesson: "u-tr2",
          done: false,
        },
      ],
      memories: [
        {
          id: "mem-keep",
          label: "学习偏好",
          category: "preference",
          text: "晚上 19:00 学习",
        },
      ],
    };
    saveStoreToDb(initial, { trigger: "初始化双轨道" });

    // Create real session, exercise, attempt, and chat thread
    const { session } = startLearningSession({
      lessonId: "u-tr1",
      trackId: "tr-1",
      mode: "practice",
    });
    const { exercise } = registerExercise({
      lessonId: "u-tr1",
      learningSessionId: session.learning_session_id,
      mode: "choice",
      prompt: "测试单选",
      spec: {
        choices: ["A", "B"],
        correctChoiceIndex: 0,
      },
      source: "tutor_candidate",
    });
    submitExerciseAttempt({
      exerciseId: exercise.exercise_id,
      learningSessionId: session.learning_session_id,
      idempotencyKey: "wave0-att-1",
      answer: { choiceIndex: 0 },
      day: "2026-11-21",
    });
    saveChatThreadToDb("chat-backup-1", "agent", [
      { id: "cm1", role: "user", parts: [{ type: "text", text: "你好" }] },
    ]);

    // DB-19: Full-stack backup includes exercises (curriculum + tutor), formal attempts, sessions, threads
    const backup = exportFullBackupFromDb("2026-11-21");
    assert.equal(backup.schema, "xushi-learnos-backup-v2");
    assert.equal(backup.exercises.length, 2);
    assert.equal(backup.exerciseAttempts.length, 1);
    assert.equal(backup.learningSessions.length, 1);
    assert.equal(backup.chatThreads.length, 1);
    assert.equal(JSON.stringify(backup).includes("sk-"), false);

    // DB-24: Impact preview accurately distinguishes exclusive vs shared lessons
    const impact = getTrackImpactFromDb("tr-1");
    assert.ok(impact);
    assert.equal(impact.exclusiveLessonCount, 1);
    assert.deepEqual(impact.sharedLessonIds, ["u-shared"]);
    assert.equal(impact.futureBlockCount, 1);
    assert.equal(impact.completedBlockCount, 1);
    assert.equal(impact.exerciseCount, 2);
    assert.equal(impact.attemptCount, 1);
    assert.equal(impact.otherTrackCount, 1);

    // DB-24 Default: Archive tr-1 preserves history, pauses future uncompleted blocks, hides from active tracks
    const archivedRes = archiveTrackInDb("tr-1", "2026-11-21");
    assert.equal(archivedRes.pausedBlocks, 1);
    assert.equal(getTracks(archivedRes.store).length, 1);
    assert.equal(getTracks(archivedRes.store)[0].id, "tr-2");
    assert.equal(
      archivedRes.store.blocks.some((b) => b.id === "blk-tr1-future"),
      false,
    );
    assert.equal(
      archivedRes.store.blocks.some((b) => b.id === "blk-tr1-done"),
      true,
    );
    assert.equal(exportFullBackupFromDb("2026-11-21").exerciseAttempts.length, 1);

    // Restore archived track
    const restored = restoreTrackInDb("tr-1", "2026-11-21");
    assert.equal(getTracks(restored.store).length, 2);

    // Independent Permanent Delete removes exclusive data only, preserving tr-2, shared lesson, and unrelated memories
    const delRes = permanentlyDeleteTrackInDb("tr-1", "2026-11-21");
    assert.equal(delRes.deletedCounts.exercises, 2);
    assert.equal(delRes.deletedCounts.attempts, 1);
    assert.equal(delRes.store.goalPlans?.length, 1);
    assert.equal(delRes.store.goalPlans?.[0].id, "tr-2");
    assert.equal(
      delRes.store.goalPlans?.[0].units.some((u) => u.id === "u-shared"),
      true,
    );
    assert.equal(
      delRes.store.blocks.some((b) => b.id === "blk-tr2-future"),
      true,
    );
    assert.equal(delRes.store.memories.length, 1);
    assert.equal(delRes.store.memories[0].id, "mem-keep");

    // DESK-20: Pre-reset snapshot creates valid restorable backup before clearing
    const snapPath = createPreResetSnapshotInDb();
    assert.ok(snapPath && existsSync(snapPath));
    clearAllDataInDb();
    assert.equal(loadStoreFromDb("2026-11-21").goalPlans?.length, 0);
    const snapDb = new DatabaseSync(snapPath);
    const integrity = snapDb.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    const countPlans = snapDb
      .prepare("SELECT COUNT(*) AS c FROM goal_plans")
      .get() as { c: number };
    snapDb.close();
    assert.equal(integrity.integrity_check, "ok");
    assert.equal(countPlans.c, 1);
  } finally {
    env.cleanup();
  }
});
