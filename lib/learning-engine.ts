import crypto from "node:crypto";
import {
  type Block,
  type InteractiveBlankSlot,
  type InteractiveCheckCard,
  type InteractiveCheckMode,
  type Lesson,
  type Store,
  computeMasteryUpdate,
  findSlot,
  getLessonById,
  getMissingPrerequisites,
  getTrackForLesson,
  time,
  today,
} from "./learning";
import {
  extractMemoryPreferences,
  getWakingBounds,
  postponeDependentBlocks,
} from "./scheduler";
import { adaptTrackContractsFromAssessment } from "./curriculum-planner";
import {
  getDb,
  loadStoreFromDb,
  recordDomainEventInDb,
  saveStoreToDb,
} from "./db";

export type LearningEngineErrorCode =
  | "INVALID_EXERCISE_SPEC"
  | "INVALID_ANSWER_PAYLOAD"
  | "EXERCISE_NOT_FOUND"
  | "LESSON_SESSION_MISMATCH"
  | "DRAFT_NOT_FOUND"
  | "DRAFT_NOT_PENDING"
  | "DRAFT_EXPIRED"
  | "DRAFT_CONFLICT";

export class LearningEngineError extends Error {
  readonly code: LearningEngineErrorCode;
  readonly status: number;

  constructor(code: LearningEngineErrorCode, status: number, message: string) {
    super(message);
    this.name = "LearningEngineError";
    this.code = code;
    this.status = status;
  }
}

export type LearningSessionMode = "learn" | "practice" | "assess" | "review";

export type LearningSessionRecord = {
  learning_session_id: string;
  lesson_id: string;
  track_id: string | null;
  content_version: string;
  current_mode: LearningSessionMode;
  active_exercise_id: string | null;
  progress: number;
  completion_status: "active" | "completed" | "needs_review";
  started_at: string;
  updated_at: string;
};

export type ExerciseSpec = {
  lessonTitle?: string;
  choices?: string[];
  correctChoiceIndex?: number;
  correctChoiceIndices?: number[];
  blanks?: InteractiveBlankSlot[];
  steps?: string[];
  correctStepsOrder?: string[];
  starterCode?: string;
  expectedOutput?: string;
  rubricPoints?: string[];
  language?: string;
  hint?: string;
  explanation?: string;
};

export type ExerciseRecord = {
  exercise_id: string;
  lesson_id: string;
  learning_session_id: string | null;
  mode: InteractiveCheckMode;
  prompt: string;
  spec: ExerciseSpec;
  source: "curriculum" | "tutor_candidate";
  dedupe_key: string;
  created_at: string;
};

export type StructuredExerciseAnswer = {
  selectedOrder?: string[];
  choiceIndex?: number;
  choiceIndices?: number[];
  blanks?: Record<string, string>;
  text?: string;
};

export type PositionMatchDetail = {
  index: number;
  submitted: string;
  expected: string;
  matched: boolean;
};

export type ExerciseAttemptRecord = {
  attempt_id: string;
  idempotency_key: string;
  exercise_id: string;
  learning_session_id: string;
  lesson_id: string;
  submitted_answer: StructuredExerciseAnswer;
  status: "draft" | "submitted" | "graded";
  score: number;
  correct: boolean;
  error_type: string;
  correct_answer: unknown;
  feedback: string;
  position_matches: PositionMatchDetail[] | null;
  grader_version: string;
  created_at: string;
  graded_at: string | null;
};

export type PlanDraftDiff = {
  addedBlocks: Block[];
  movedBlocks: Array<{
    blockId: string;
    title: string;
    oldDay: string;
    oldStart: number;
    newDay: string;
    newStart: number;
  }>;
};

export type PlanDraftRecord = {
  draft_id: string;
  source_attempt_id: string;
  lesson_id: string;
  trigger_reason: string;
  summary: string;
  status: "pending" | "applied" | "dismissed" | "expired";
  candidate_activity: {
    lessonId: string;
    title: string;
    minutes: number;
    kind: "复习";
    reason: string;
  };
  diff: PlanDraftDiff;
  impact_count: number;
  created_at: string;
  resolved_at: string | null;
};

export type LearnerModelUpdateResult = {
  before: number;
  after: number;
  delta: number;
  nextReviewDay: string;
  stabilityDays: number;
  unlockedTitles: string[];
  estimatorVersion: string;
};

export type SubmitAttemptResult = {
  deduplicated: boolean;
  attempt: ExerciseAttemptRecord;
  learnerUpdate: LearnerModelUpdateResult | null;
  planDraft: PlanDraftRecord | null;
  session: LearningSessionRecord | null;
  store: Store;
};

function parseSessionRow(row: Record<string, unknown>): LearningSessionRecord {
  return {
    learning_session_id: String(row.learning_session_id),
    lesson_id: String(row.lesson_id),
    track_id: row.track_id ? String(row.track_id) : null,
    content_version: String(row.content_version || "v1"),
    current_mode: (String(row.current_mode || "learn") as LearningSessionMode),
    active_exercise_id: row.active_exercise_id
      ? String(row.active_exercise_id)
      : null,
    progress: Number(row.progress ?? 0),
    completion_status: (String(row.completion_status || "active") as
      | "active"
      | "completed"
      | "needs_review"),
    started_at: String(row.started_at),
    updated_at: String(row.updated_at),
  };
}

function parseExerciseRow(row: Record<string, unknown>): ExerciseRecord {
  let spec: ExerciseSpec = {};
  try {
    spec = JSON.parse(String(row.spec_json || "{}")) as ExerciseSpec;
  } catch {}
  return {
    exercise_id: String(row.exercise_id),
    lesson_id: String(row.lesson_id),
    learning_session_id: row.learning_session_id
      ? String(row.learning_session_id)
      : null,
    mode: String(row.mode) as InteractiveCheckMode,
    prompt: String(row.prompt),
    spec,
    source: (String(row.source || "curriculum") as
      | "curriculum"
      | "tutor_candidate"),
    dedupe_key: String(row.dedupe_key),
    created_at: String(row.created_at),
  };
}

function parseAttemptRow(row: Record<string, unknown>): ExerciseAttemptRecord {
  let submitted: StructuredExerciseAnswer = {};
  let correctAnswer: unknown = null;
  let positionMatches: PositionMatchDetail[] | null = null;
  try {
    submitted = JSON.parse(
      String(row.submitted_answer_json || "{}"),
    ) as StructuredExerciseAnswer;
  } catch {}
  try {
    correctAnswer = row.correct_answer_json
      ? JSON.parse(String(row.correct_answer_json))
      : null;
  } catch {}
  try {
    positionMatches = row.position_matches_json
      ? (JSON.parse(
          String(row.position_matches_json),
        ) as PositionMatchDetail[])
      : null;
  } catch {}
  return {
    attempt_id: String(row.attempt_id),
    idempotency_key: String(row.idempotency_key),
    exercise_id: String(row.exercise_id),
    learning_session_id: String(row.learning_session_id),
    lesson_id: String(row.lesson_id),
    submitted_answer: submitted,
    status: (String(row.status || "graded") as
      | "draft"
      | "submitted"
      | "graded"),
    score: Number(row.score ?? 0),
    correct: Boolean(row.correct),
    error_type: String(row.error_type || "none"),
    correct_answer: correctAnswer,
    feedback: String(row.feedback || ""),
    position_matches: positionMatches,
    grader_version: String(row.grader_version || "deterministic-v1"),
    created_at: String(row.created_at),
    graded_at: row.graded_at ? String(row.graded_at) : null,
  };
}

function parsePlanDraftRow(row: Record<string, unknown>): PlanDraftRecord {
  let candidate = {
    lessonId: String(row.lesson_id),
    title: "",
    minutes: 20,
    kind: "复习" as const,
    reason: "",
  };
  let diff: PlanDraftDiff = { addedBlocks: [], movedBlocks: [] };
  try {
    candidate = JSON.parse(String(row.candidate_activity_json || "{}"));
  } catch {}
  try {
    diff = JSON.parse(String(row.diff_json || "{}"));
  } catch {}
  return {
    draft_id: String(row.draft_id),
    source_attempt_id: String(row.source_attempt_id),
    lesson_id: String(row.lesson_id),
    trigger_reason: String(row.trigger_reason),
    summary: String(row.summary),
    status: (String(row.status || "pending") as
      | "pending"
      | "applied"
      | "dismissed"
      | "expired"),
    candidate_activity: candidate,
    diff,
    impact_count: Number(row.impact_count ?? 0),
    created_at: String(row.created_at),
    resolved_at: row.resolved_at ? String(row.resolved_at) : null,
  };
}

function buildDedupeKey(
  lessonId: string,
  mode: InteractiveCheckMode,
  prompt: string,
): string {
  const normPrompt = prompt
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 120);
  const hash = crypto
    .createHash("sha256")
    .update(`${lessonId}::${mode}::${normPrompt}`)
    .digest("hex")
    .slice(0, 16);
  return `${lessonId}:${mode}:${hash}`;
}

export function exerciseToCheckCard(
  ex: ExerciseRecord,
  latestAttempt?: ExerciseAttemptRecord | null,
): InteractiveCheckCard {
  return {
    kind: "interactive_check",
    checkId: ex.exercise_id,
    exerciseId: ex.exercise_id,
    mode: ex.mode,
    lessonId: ex.lesson_id,
    lessonTitle: ex.spec.lessonTitle,
    prompt: ex.prompt,
    choices: ex.spec.choices,
    correctChoiceIndex: ex.spec.correctChoiceIndex,
    correctChoiceIndices: ex.spec.correctChoiceIndices,
    blanks: ex.spec.blanks,
    steps: ex.spec.steps,
    correctStepsOrder: ex.spec.correctStepsOrder,
    starterCode: ex.spec.starterCode,
    expectedOutput: ex.spec.expectedOutput,
    rubricPoints: ex.spec.rubricPoints,
    language: ex.spec.language,
    hint: ex.spec.hint,
    explanation: ex.spec.explanation,
    savedChoiceIndex: latestAttempt?.submitted_answer.choiceIndex,
    savedChoiceIndices: latestAttempt?.submitted_answer.choiceIndices,
    savedBlanks: latestAttempt?.submitted_answer.blanks,
    savedOrder: latestAttempt?.submitted_answer.selectedOrder,
    savedUserAnswer: latestAttempt?.submitted_answer.text,
  };
}

/**
 * 1. Lesson Session Controller:
 * Authoritative single entry point for starting or resuming a lesson session.
 * Works deterministically via SQLite with ZERO LLM calls required.
 */
export function startLearningSession(opts: {
  lessonId: string;
  trackId?: string;
  mode?: LearningSessionMode;
  contentVersion?: string;
  exerciseId?: string;
  day?: string;
}): {
  session: LearningSessionRecord;
  exercise: ExerciseRecord | null;
  exercises: ExerciseRecord[];
  latestAttempt: ExerciseAttemptRecord | null;
  attempts: ExerciseAttemptRecord[];
  pendingPlanDrafts: PlanDraftRecord[];
} {
  const db = getDb();
  const day = opts.day || today();
  const nowIso = new Date().toISOString();
  const store = loadStoreFromDb(day);
  const lesson = getLessonById(store, opts.lessonId);
  const track = getTrackForLesson(store, opts.lessonId);
  const trackId = opts.trackId || track?.id || null;
  const mastery = store.mastery[opts.lessonId] ?? 0;

  // Resume existing session for this lesson if present
  const existingRow = db
    .prepare(
      "SELECT * FROM learning_sessions WHERE lesson_id = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(opts.lessonId) as Record<string, unknown> | undefined;

  let session: LearningSessionRecord;
  if (existingRow) {
    session = parseSessionRow(existingRow);
    const nextMode = opts.mode || session.current_mode;
    const nextStatus =
      mastery >= 80
        ? "completed"
        : session.completion_status === "completed"
          ? "completed"
          : session.completion_status;
    db.prepare(
      `UPDATE learning_sessions
       SET current_mode = ?, progress = ?, completion_status = ?, updated_at = ?
       WHERE learning_session_id = ?`,
    ).run(
      nextMode,
      Math.max(session.progress, mastery),
      nextStatus,
      nowIso,
      session.learning_session_id,
    );
    session = {
      ...session,
      current_mode: nextMode,
      progress: Math.max(session.progress, mastery),
      completion_status: nextStatus,
      updated_at: nowIso,
    };
  } else {
    const sid = `ls-${crypto.randomUUID().slice(0, 10)}`;
    const initialMode: LearningSessionMode = opts.mode || "learn";
    const status = mastery >= 80 ? "completed" : "active";
    db.prepare(
      `INSERT INTO learning_sessions
        (learning_session_id, lesson_id, track_id, content_version, current_mode, active_exercise_id, progress, completion_status, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(
      sid,
      opts.lessonId,
      trackId,
      opts.contentVersion || "v1",
      initialMode,
      mastery,
      status,
      nowIso,
      nowIso,
    );
    session = {
      learning_session_id: sid,
      lesson_id: opts.lessonId,
      track_id: trackId,
      content_version: opts.contentVersion || "v1",
      current_mode: initialMode,
      active_exercise_id: null,
      progress: mastery,
      completion_status: status,
      started_at: nowIso,
      updated_at: nowIso,
    };
  }

  // If lesson has built-in structured MCQ and no exercises exist yet, register canonical curriculum exercise
  let exercises = listExercisesForLesson(opts.lessonId);
  if (
    exercises.length === 0 &&
    lesson &&
    lesson.question &&
    lesson.choices &&
    lesson.choices.length >= 2
  ) {
    const reg = registerExercise({
      lessonId: lesson.id,
      learningSessionId: session.learning_session_id,
      mode: "choice",
      prompt: lesson.question,
      spec: {
        lessonTitle: lesson.title,
        choices: lesson.choices,
        correctChoiceIndex: lesson.answer,
        explanation: lesson.feedback,
      },
      source: "curriculum",
    });
    exercises = [reg.exercise];
    session = { ...session, active_exercise_id: reg.exercise.exercise_id };
  }

  const requestedExercise = opts.exerciseId
    ? exercises.find((e) => e.exercise_id === opts.exerciseId) || null
    : null;
  const activeExercise =
    requestedExercise ||
    (session.active_exercise_id
      ? exercises.find((e) => e.exercise_id === session.active_exercise_id)
      : null) ||
    exercises[0] ||
    null;

  if (activeExercise && session.active_exercise_id !== activeExercise.exercise_id) {
    db.prepare(
      "UPDATE learning_sessions SET active_exercise_id = ?, updated_at = ? WHERE learning_session_id = ?",
    ).run(activeExercise.exercise_id, nowIso, session.learning_session_id);
    session = {
      ...session,
      active_exercise_id: activeExercise.exercise_id,
      updated_at: nowIso,
    };
  }

  const attempts = activeExercise
    ? listAttemptsForExercise(activeExercise.exercise_id)
    : listAttemptsForLesson(opts.lessonId);
  const latestAttempt = attempts[0] || null;
  const pendingPlanDrafts = listPendingPlanDrafts(opts.lessonId);

  return {
    session,
    exercise: activeExercise,
    exercises,
    latestAttempt,
    attempts,
    pendingPlanDrafts,
  };
}

function validateExerciseSpec(
  mode: InteractiveCheckMode,
  spec: ExerciseSpec,
): ExerciseSpec {
  const normalizedSpec: ExerciseSpec = { ...spec };

  if (mode === "choice") {
    const choices = normalizedSpec.choices;
    const idx = normalizedSpec.correctChoiceIndex;
    if (!Array.isArray(choices) || choices.length < 2) {
      throw new LearningEngineError(
        "INVALID_EXERCISE_SPEC",
        400,
        "单选题必须提供至少 2 个选项（choices）。",
      );
    }
    if (
      typeof idx !== "number" ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= choices.length
    ) {
      throw new LearningEngineError(
        "INVALID_EXERCISE_SPEC",
        400,
        "单选题缺少有效的标准答案索引（correctChoiceIndex），禁止进入正式客观评分。",
      );
    }
  } else if (mode === "multi_choice") {
    const choices = normalizedSpec.choices;
    const idxs = normalizedSpec.correctChoiceIndices;
    if (!Array.isArray(choices) || choices.length < 2) {
      throw new LearningEngineError(
        "INVALID_EXERCISE_SPEC",
        400,
        "多选题必须提供至少 2 个选项（choices）。",
      );
    }
    if (
      !Array.isArray(idxs) ||
      idxs.length === 0 ||
      idxs.some(
        (i) => typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= choices.length,
      )
    ) {
      throw new LearningEngineError(
        "INVALID_EXERCISE_SPEC",
        400,
        "多选题缺少有效的标准答案列表（correctChoiceIndices），禁止进入正式客观评分。",
      );
    }
  } else if (mode === "order_steps") {
    if (
      (!normalizedSpec.correctStepsOrder ||
        normalizedSpec.correctStepsOrder.length === 0) &&
      normalizedSpec.steps &&
      normalizedSpec.steps.length > 0
    ) {
      normalizedSpec.correctStepsOrder = [...normalizedSpec.steps];
    }
    const expected = normalizedSpec.correctStepsOrder || [];
    if (expected.length < 2) {
      throw new LearningEngineError(
        "INVALID_EXERCISE_SPEC",
        400,
        "排序题必须至少包含 2 个步骤及标准顺序（correctStepsOrder）。",
      );
    }
    const normSet = new Set(expected.map(normalizeToken).filter(Boolean));
    if (normSet.size !== expected.length) {
      throw new LearningEngineError(
        "INVALID_EXERCISE_SPEC",
        400,
        "排序题标准步骤存在空项或重复项，无法进行确定性评分。",
      );
    }
  } else if (mode === "fill_blank") {
    const blanks = normalizedSpec.blanks;
    if (!Array.isArray(blanks) || blanks.length === 0) {
      throw new LearningEngineError(
        "INVALID_EXERCISE_SPEC",
        400,
        "填空题必须至少包含 1 个空位（blanks）。",
      );
    }
    if (blanks.some((b) => !b.answer || !b.answer.trim())) {
      throw new LearningEngineError(
        "INVALID_EXERCISE_SPEC",
        400,
        "填空题存在缺少标准答案（answer）的空位，禁止进入正式客观评分。",
      );
    }
  }

  return normalizedSpec;
}

function validateSubmittedAnswer(
  exercise: ExerciseRecord,
  answer: StructuredExerciseAnswer,
): void {
  const spec = exercise.spec;

  if (exercise.mode === "order_steps") {
    const expected = spec.correctStepsOrder || spec.steps || [];
    const submitted = answer.selectedOrder;
    if (!Array.isArray(submitted) || submitted.length === 0) {
      throw new LearningEngineError(
        "INVALID_ANSWER_PAYLOAD",
        400,
        "排序答案不能为空，请排列全部步骤后再提交。",
      );
    }
    if (submitted.length !== expected.length) {
      throw new LearningEngineError(
        "INVALID_ANSWER_PAYLOAD",
        400,
        `排序步骤数量不完整：共需 ${expected.length} 步，实际提交 ${submitted.length} 步。`,
      );
    }
    const expectedSet = new Set(expected.map(normalizeToken));
    const seen = new Set<string>();
    for (const rawItem of submitted) {
      const norm = normalizeToken(String(rawItem ?? ""));
      if (!norm) {
        throw new LearningEngineError(
          "INVALID_ANSWER_PAYLOAD",
          400,
          "排序答案包含空白步骤，请检查后重新提交。",
        );
      }
      if (seen.has(norm)) {
        throw new LearningEngineError(
          "INVALID_ANSWER_PAYLOAD",
          400,
          `排序答案包含重复步骤「${rawItem}」，每一步只能出现一次。`,
        );
      }
      if (!expectedSet.has(norm)) {
        throw new LearningEngineError(
          "INVALID_ANSWER_PAYLOAD",
          400,
          `排序答案包含不属于本题的步骤「${rawItem}」。`,
        );
      }
      seen.add(norm);
    }
    return;
  }

  if (exercise.mode === "choice") {
    const choices = spec.choices || [];
    const idx = answer.choiceIndex;
    if (
      typeof idx !== "number" ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= choices.length
    ) {
      throw new LearningEngineError(
        "INVALID_ANSWER_PAYLOAD",
        400,
        "请先选择一个有效的选项再提交。",
      );
    }
    return;
  }

  if (exercise.mode === "multi_choice") {
    const choices = spec.choices || [];
    const idxs = answer.choiceIndices;
    if (
      !Array.isArray(idxs) ||
      idxs.length === 0 ||
      idxs.some(
        (i) => typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= choices.length,
      )
    ) {
      throw new LearningEngineError(
        "INVALID_ANSWER_PAYLOAD",
        400,
        "请至少选择一个有效选项后再提交多选题。",
      );
    }
    return;
  }

  if (exercise.mode === "fill_blank") {
    const blanks = answer.blanks || {};
    const nonEmpty = Object.values(blanks).filter(
      (v) => typeof v === "string" && v.trim().length > 0,
    );
    if (nonEmpty.length === 0) {
      throw new LearningEngineError(
        "INVALID_ANSWER_PAYLOAD",
        400,
        "填空答案不能为空，请填写后再提交。",
      );
    }
    return;
  }

  const text = (answer.text || "").trim();
  if (!text) {
    throw new LearningEngineError(
      "INVALID_ANSWER_PAYLOAD",
      400,
      "作答内容不能为空，请填写后再提交。",
    );
  }
}

function resolveOrCreateSessionId(
  lessonId: string,
  explicitSessionId?: string | null,
): string {
  const db = getDb();
  if (explicitSessionId) {
    const row = db
      .prepare(
        "SELECT learning_session_id, lesson_id FROM learning_sessions WHERE learning_session_id = ?",
      )
      .get(explicitSessionId) as
      | { learning_session_id?: string; lesson_id?: string }
      | undefined;
    if (row?.learning_session_id && row.lesson_id === lessonId) {
      return row.learning_session_id;
    }
  }
  const latest = db
    .prepare(
      "SELECT learning_session_id FROM learning_sessions WHERE lesson_id = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(lessonId) as { learning_session_id?: string } | undefined;
  if (latest?.learning_session_id) {
    return latest.learning_session_id;
  }
  const nowIso = new Date().toISOString();
  const sid = `ls-${crypto.randomUUID().slice(0, 10)}`;
  const store = loadStoreFromDb(today());
  const track = getTrackForLesson(store, lessonId);
  const mastery = store.mastery[lessonId] ?? 0;
  db.prepare(
    `INSERT INTO learning_sessions
      (learning_session_id, lesson_id, track_id, content_version, current_mode, active_exercise_id, progress, completion_status, started_at, updated_at)
     VALUES (?, ?, ?, 'v1', 'practice', NULL, ?, ?, ?, ?)`,
  ).run(
    sid,
    lessonId,
    track?.id ?? null,
    mastery,
    mastery >= 80 ? "completed" : "active",
    nowIso,
    nowIso,
  );
  return sid;
}

const LEADING_CHOICE_LETTER_RE = /^[A-Fa-f][.、:：)\）\s]+/;
const PINNED_TAIL_CHOICE_RE =
  /^(?:以上都|以上皆|上述都|上述皆|以上全|以上说法都|all of the above|none of the above)/i;

function remapExplanationOptionLetters(
  explanation: string | undefined,
  oldIdx: number,
  newIdx: number,
): string | undefined {
  if (!explanation || oldIdx === newIdx) return explanation;
  const oldLetter = String.fromCharCode(65 + oldIdx);
  const newLetter = String.fromCharCode(65 + newIdx);
  return explanation
    .replace(
      new RegExp(
        `(选|选项|答案是|答案为|正确答案是|正确答案：|正确选项是|应选)\\s*${oldLetter}(?![A-Za-z])`,
        "g",
      ),
      `$1 ${newLetter}`,
    )
    .replace(
      new RegExp(`(?<![A-Za-z])${oldLetter}\\s*(项|选项|正确|是正确的)`, "g"),
      `${newLetter} $1`,
    );
}

/**
 * Eliminates LLM positional bias (where LLMs almost always place the correct choice at index 1 / Option B)
 * by performing a uniform Fisher-Yates shuffle on `choices` and remapping `correctChoiceIndex` /
 * `correctChoiceIndices` accordingly (while keeping meta-options like "以上都对" pinned at the end).
 */
export function shuffleChoiceExerciseSpec(
  mode: InteractiveCheckMode,
  spec: ExerciseSpec,
  opts?: { randomInt?: (maxExclusive: number) => number },
): ExerciseSpec {
  const randInt =
    opts?.randomInt ||
    ((maxExclusive: number) => crypto.randomInt(0, maxExclusive));

  if (
    mode === "choice" &&
    Array.isArray(spec.choices) &&
    spec.choices.length >= 2 &&
    typeof spec.correctChoiceIndex === "number" &&
    Number.isInteger(spec.correctChoiceIndex) &&
    spec.correctChoiceIndex >= 0 &&
    spec.correctChoiceIndex < spec.choices.length
  ) {
    const cleaned = spec.choices.map((c) =>
      String(c || "").replace(LEADING_CHOICE_LETTER_RE, "").trim(),
    );
    const n = cleaned.length;
    const pinLast = PINNED_TAIL_CHOICE_RE.test(cleaned[n - 1] || "");
    const shuffleLen = pinLast ? n - 1 : n;
    const perm = Array.from({ length: n }, (_, i) => i);
    for (let i = shuffleLen - 1; i > 0; i--) {
      const j = Math.max(0, Math.min(i, randInt(i + 1)));
      const tmp = perm[i];
      perm[i] = perm[j];
      perm[j] = tmp;
    }
    const newChoices = perm.map((oldIdx) => cleaned[oldIdx]);
    const newCorrectIdx = perm.indexOf(spec.correctChoiceIndex);
    return {
      ...spec,
      choices: newChoices,
      correctChoiceIndex:
        newCorrectIdx >= 0 ? newCorrectIdx : spec.correctChoiceIndex,
      explanation: remapExplanationOptionLetters(
        spec.explanation,
        spec.correctChoiceIndex,
        newCorrectIdx,
      ),
    };
  }

  if (
    mode === "multi_choice" &&
    Array.isArray(spec.choices) &&
    spec.choices.length >= 2 &&
    Array.isArray(spec.correctChoiceIndices) &&
    spec.correctChoiceIndices.length > 0
  ) {
    const cleaned = spec.choices.map((c) =>
      String(c || "").replace(LEADING_CHOICE_LETTER_RE, "").trim(),
    );
    const n = cleaned.length;
    const pinLast = PINNED_TAIL_CHOICE_RE.test(cleaned[n - 1] || "");
    const shuffleLen = pinLast ? n - 1 : n;
    const perm = Array.from({ length: n }, (_, i) => i);
    for (let i = shuffleLen - 1; i > 0; i--) {
      const j = Math.max(0, Math.min(i, randInt(i + 1)));
      const tmp = perm[i];
      perm[i] = perm[j];
      perm[j] = tmp;
    }
    const newChoices = perm.map((oldIdx) => cleaned[oldIdx]);
    const newCorrectIndices = spec.correctChoiceIndices
      .map((oldIdx) => perm.indexOf(oldIdx))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    return {
      ...spec,
      choices: newChoices,
      correctChoiceIndices:
        newCorrectIndices.length > 0
          ? newCorrectIndices
          : spec.correctChoiceIndices,
    };
  }

  if (
    mode === "order_steps" &&
    Array.isArray(spec.steps) &&
    Array.isArray(spec.correctStepsOrder) &&
    spec.steps.length >= 2 &&
    spec.steps.length === spec.correctStepsOrder.length &&
    spec.steps.every((s, idx) => s === spec.correctStepsOrder![idx])
  ) {
    const shuffled = [...spec.steps];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.max(0, Math.min(i, randInt(i + 1)));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    if (shuffled.every((s, idx) => s === spec.correctStepsOrder![idx])) {
      const tmp = shuffled[0];
      shuffled[0] = shuffled[1];
      shuffled[1] = tmp;
    }
    return {
      ...spec,
      steps: shuffled,
    };
  }

  return spec;
}

/**
 * 2. Single Canonical Exercise Registry (with strict deduplication & spec validation):
 * Prevents AI Tutor from creating duplicate copies or ungradable exercises,
 * and always binds every registered exercise to an authoritative learning_session_id.
 */
export function registerExercise(opts: {
  lessonId: string;
  learningSessionId?: string | null;
  mode: InteractiveCheckMode;
  prompt: string;
  spec: ExerciseSpec;
  source?: "curriculum" | "tutor_candidate";
  shuffleChoices?: boolean;
}): { exercise: ExerciseRecord; deduplicated: boolean } {
  const validatedSpec = validateExerciseSpec(opts.mode, opts.spec);
  const normalizedSpec = opts.shuffleChoices
    ? shuffleChoiceExerciseSpec(opts.mode, validatedSpec)
    : validatedSpec;
  const db = getDb();
  const targetSessionId = resolveOrCreateSessionId(
    opts.lessonId,
    opts.learningSessionId,
  );
  const dedupeKey = buildDedupeKey(opts.lessonId, opts.mode, opts.prompt);
  const existing = db
    .prepare("SELECT * FROM exercises WHERE dedupe_key = ? LIMIT 1")
    .get(dedupeKey) as Record<string, unknown> | undefined;

  if (existing) {
    const exercise = parseExerciseRow(existing);
    const nowIso = new Date().toISOString();
    if (!exercise.learning_session_id) {
      db.prepare(
        "UPDATE exercises SET learning_session_id = ? WHERE exercise_id = ?",
      ).run(targetSessionId, exercise.exercise_id);
      exercise.learning_session_id = targetSessionId;
    }
    db.prepare(
      "UPDATE learning_sessions SET active_exercise_id = ?, updated_at = ? WHERE learning_session_id = ?",
    ).run(exercise.exercise_id, nowIso, targetSessionId);
    return { exercise, deduplicated: true };
  }

  const nowIso = new Date().toISOString();
  const exerciseId = `ex-${crypto.randomUUID().slice(0, 8)}`;

  db.prepare(
    `INSERT INTO exercises
      (exercise_id, lesson_id, learning_session_id, mode, prompt, spec_json, source, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    exerciseId,
    opts.lessonId,
    targetSessionId,
    opts.mode,
    opts.prompt.trim(),
    JSON.stringify(normalizedSpec),
    opts.source || "tutor_candidate",
    dedupeKey,
    nowIso,
  );

  db.prepare(
    "UPDATE learning_sessions SET active_exercise_id = ?, updated_at = ? WHERE learning_session_id = ?",
  ).run(exerciseId, nowIso, targetSessionId);

  return {
    exercise: {
      exercise_id: exerciseId,
      lesson_id: opts.lessonId,
      learning_session_id: targetSessionId,
      mode: opts.mode,
      prompt: opts.prompt.trim(),
      spec: normalizedSpec,
      source: opts.source || "tutor_candidate",
      dedupe_key: dedupeKey,
      created_at: nowIso,
    },
    deduplicated: false,
  };
}

export function getExerciseById(exerciseId: string): ExerciseRecord | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM exercises WHERE exercise_id = ?")
    .get(exerciseId) as Record<string, unknown> | undefined;
  return row ? parseExerciseRow(row) : null;
}

export function listExercisesForLesson(lessonId: string): ExerciseRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM exercises WHERE lesson_id = ? ORDER BY created_at DESC",
    )
    .all(lessonId) as Array<Record<string, unknown>>;
  return rows.map(parseExerciseRow);
}

export function listAttemptsForExercise(
  exerciseId: string,
): ExerciseAttemptRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM exercise_attempts WHERE exercise_id = ? ORDER BY created_at DESC",
    )
    .all(exerciseId) as Array<Record<string, unknown>>;
  return rows.map(parseAttemptRow);
}

export function listAttemptsForLesson(
  lessonId: string,
): ExerciseAttemptRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM exercise_attempts WHERE lesson_id = ? ORDER BY created_at DESC LIMIT 20",
    )
    .all(lessonId) as Array<Record<string, unknown>>;
  return rows.map(parseAttemptRow);
}

export function listPendingPlanDrafts(lessonId?: string): PlanDraftRecord[] {
  const db = getDb();
  const rows = (
    lessonId
      ? db
          .prepare(
            "SELECT * FROM plan_drafts WHERE status = 'pending' AND lesson_id = ? ORDER BY created_at DESC",
          )
          .all(lessonId)
      : db
          .prepare(
            "SELECT * FROM plan_drafts WHERE status = 'pending' ORDER BY created_at DESC",
          )
          .all()
  ) as Array<Record<string, unknown>>;
  return rows.map(parsePlanDraftRow);
}

function normalizeToken(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[0-9]+[.)、:\s]+/, "");
}

/**
 * 3. Deterministic Assessment Engine:
 * Grades objective exercises with 100% factual accuracy and zero LLM hallucination.
 */
export function gradeExerciseDeterministically(
  exercise: ExerciseRecord,
  answer: StructuredExerciseAnswer,
): {
  score: number;
  correct: boolean;
  errorType: string;
  correctAnswer: unknown;
  feedback: string;
  positionMatches: PositionMatchDetail[] | null;
  graderVersion: string;
} {
  const spec = exercise.spec;

  // --- Mode 1: Deterministic Sequence Order Verification ---
  if (exercise.mode === "order_steps") {
    const expected = spec.correctStepsOrder || spec.steps || [];
    const submitted = answer.selectedOrder || [];
    const total = expected.length;

    if (total === 0) {
      return {
        score: 0,
        correct: false,
        errorType: "missing_rubric",
        correctAnswer: [],
        feedback: "该排序题缺少标准顺序定义，无法自动判分。",
        positionMatches: null,
        graderVersion: "deterministic-v1",
      };
    }

    const positionMatches: PositionMatchDetail[] = expected.map((exp, idx) => {
      const sub = submitted[idx] ?? "（未填）";
      const matched = normalizeToken(sub) === normalizeToken(exp);
      return { index: idx + 1, submitted: sub, expected: exp, matched };
    });

    const matchedCount = positionMatches.filter((p) => p.matched).length;
    const score = Math.round((matchedCount / total) * 100);
    const correct = matchedCount === total && submitted.length === total;

    if (correct) {
      return {
        score: 100,
        correct: true,
        errorType: "none",
        correctAnswer: expected,
        feedback: `顺序完全正确（${total}/${total} 步全部匹配）。${spec.explanation ? ` ${spec.explanation}` : ""}`,
        positionMatches,
        graderVersion: "deterministic-v1",
      };
    }

    const wrongPositions = positionMatches.filter((p) => !p.matched);
    const startWrong = !positionMatches[0]?.matched;
    const endWrong = !positionMatches[total - 1]?.matched;
    const errorType =
      startWrong && endWrong
        ? "start_and_exit_position_error"
        : startWrong
          ? "start_position_error"
          : endWrong
            ? "exit_position_error"
            : "sequence_mismatch";

    const wrongSummary = wrongPositions
      .map(
        (p) =>
          `第 ${p.index} 步你排了「${p.submitted}」，应为「${p.expected}」`,
      )
      .join("；");

    const correctChain = expected.join(" → ");
    return {
      score,
      correct: false,
      errorType,
      correctAnswer: expected,
      feedback: `位置匹配 ${matchedCount}/${total}（得分 ${score} 分）。具体差异：${wrongSummary}。正确顺序应为：${correctChain}。`,
      positionMatches,
      graderVersion: "deterministic-v1",
    };
  }

  // --- Mode 2: Single Choice ---
  if (exercise.mode === "choice") {
    const expectedIdx = spec.correctChoiceIndex;
    const choices = spec.choices || [];
    const chosenIdx = answer.choiceIndex;
    if (expectedIdx === undefined || chosenIdx === undefined) {
      return {
        score: 0,
        correct: false,
        errorType: "incomplete_answer",
        correctAnswer:
          expectedIdx !== undefined ? choices[expectedIdx] : undefined,
        feedback: "未选择有效选项。",
        positionMatches: null,
        graderVersion: "deterministic-v1",
      };
    }
    const correct = chosenIdx === expectedIdx;
    const expectedText = choices[expectedIdx] || `选项 ${expectedIdx + 1}`;
    const chosenText = choices[chosenIdx] || `选项 ${chosenIdx + 1}`;
    return {
      score: correct ? 100 : 0,
      correct,
      errorType: correct ? "none" : "wrong_option",
      correctAnswer: { index: expectedIdx, text: expectedText },
      feedback: correct
        ? `回答正确（选中「${chosenText}」）。${spec.explanation || ""}`
        : `回答有误：你选择了「${chosenText}」，正确选项是「${expectedText}」。${spec.explanation || ""}`,
      positionMatches: null,
      graderVersion: "deterministic-v1",
    };
  }

  // --- Mode 3: Multi Choice ---
  if (exercise.mode === "multi_choice") {
    const expected = [...new Set(spec.correctChoiceIndices || [])].sort(
      (a, b) => a - b,
    );
    const chosen = [...new Set(answer.choiceIndices || [])].sort(
      (a, b) => a - b,
    );
    const choices = spec.choices || [];
    const missing = expected.filter((i) => !chosen.includes(i));
    const extra = chosen.filter((i) => !expected.includes(i));
    const correct =
      expected.length > 0 && missing.length === 0 && extra.length === 0;
    const hitCount = expected.filter((i) => chosen.includes(i)).length;
    const score =
      expected.length > 0
        ? Math.max(
            0,
            Math.round(((hitCount - extra.length * 0.5) / expected.length) * 100),
          )
        : 0;
    const errorType = correct
      ? "none"
      : missing.length > 0 && extra.length > 0
        ? "missing_and_extra_options"
        : missing.length > 0
          ? "missing_options"
          : "extra_options";
    const expectedLabels = expected.map((i) => choices[i] || `#${i + 1}`);
    return {
      score: correct ? 100 : score,
      correct,
      errorType,
      correctAnswer: expectedLabels,
      feedback: correct
        ? `多选完全正确（${expected.length}/${expected.length} 项匹配）。${spec.explanation || ""}`
        : `多选未完全匹配：${missing.length ? `漏选 ${missing.length} 项` : ""}${missing.length && extra.length ? "，" : ""}${extra.length ? `多选 ${extra.length} 项` : ""}。正确答案包含：${expectedLabels.join("、")}。`,
      positionMatches: null,
      graderVersion: "deterministic-v1",
    };
  }

  // --- Mode 4: Fill in the Blank ---
  if (exercise.mode === "fill_blank") {
    const slots = spec.blanks || [];
    const submitted = answer.blanks || {};
    const gradableSlots = slots.filter((s) => Boolean(s.answer?.trim()));
    if (gradableSlots.length === 0) {
      const filled = Object.values(submitted).filter((v) => v.trim().length > 0);
      const correct = filled.length >= Math.max(1, slots.length);
      return {
        score: correct ? 100 : 0,
        correct,
        errorType: correct ? "none" : "incomplete_blanks",
        correctAnswer: null,
        feedback: correct
          ? "已提交全部填空作答。如需深入点评，可点击下方请 AI Tutor 讲解。"
          : "尚有空白处未填写。",
        positionMatches: null,
        graderVersion: "rubric-v1",
      };
    }

    const details: PositionMatchDetail[] = gradableSlots.map((slot, idx) => {
      const sub = (submitted[slot.id] || "").trim();
      const exp = (slot.answer || "").trim();
      const matched = normalizeToken(sub) === normalizeToken(exp);
      return {
        index: idx + 1,
        submitted: sub || "（空）",
        expected: exp,
        matched,
      };
    });
    const matchedCount = details.filter((d) => d.matched).length;
    const score = Math.round((matchedCount / gradableSlots.length) * 100);
    const correct = matchedCount === gradableSlots.length;
    const diffText = details
      .filter((d) => !d.matched)
      .map((d) => `空(${d.index}) 填了「${d.submitted}」，应为「${d.expected}」`)
      .join("；");

    return {
      score,
      correct,
      errorType: correct ? "none" : "blank_mismatch",
      correctAnswer: gradableSlots.map((s) => ({
        id: s.id,
        answer: s.answer,
      })),
      feedback: correct
        ? `全部 ${gradableSlots.length} 处填空均正确。${spec.explanation || ""}`
        : `填空匹配 ${matchedCount}/${gradableSlots.length}：${diffText}。`,
      positionMatches: details,
      graderVersion: "deterministic-v1",
    };
  }

  // --- Mode 5 & 6: Code / Short Answer (Deterministic Rubric Evidence Check) ---
  const rawText = (answer.text || "").trim();
  const rubric = spec.rubricPoints || [];
  if (!rawText || rawText.length < 4) {
    return {
      score: 0,
      correct: false,
      errorType: "empty_submission",
      correctAnswer: spec.expectedOutput || rubric,
      feedback: "作答内容过短，请写出关键实现或原理解释后再提交。",
      positionMatches: null,
      graderVersion: "rubric-v1",
    };
  }

  if (rubric.length > 0) {
    const lower = rawText.toLowerCase();
    const matchedPoints = rubric.filter((pt) => {
      const keywords = pt
        .toLowerCase()
        .split(/[\s,，。、；;:/()（）]+/)
        .filter((w) => w.length >= 2);
      return keywords.some((kw) => lower.includes(kw));
    });
    const ratio = matchedPoints.length / rubric.length;
    const score = Math.max(20, Math.round(ratio * 100));
    const correct = ratio >= 0.5 && rawText.length >= 15;
    return {
      score,
      correct,
      errorType: correct ? "none" : "rubric_gap",
      correctAnswer: rubric,
      feedback: correct
        ? `已命中 ${matchedPoints.length}/${rubric.length} 项评分要点（${score} 分）。可点击「请 AI Tutor 点评」获取更细致的优化建议。`
        : `当前命中 ${matchedPoints.length}/${rubric.length} 项关键要点，建议补充：${rubric.filter((p) => !matchedPoints.includes(p)).join("；")}。`,
      positionMatches: null,
      graderVersion: "rubric-v1",
    };
  }

  const meetsMinimum = rawText.length >= 20;
  return {
    score: meetsMinimum ? 80 : 40,
    correct: meetsMinimum,
    errorType: meetsMinimum ? "none" : "too_brief",
    correctAnswer: spec.expectedOutput || null,
    feedback: meetsMinimum
      ? "已按结构化提交记录本次作答。如需针对性代码评审或深度讲解，可点击请 AI Tutor 结合本次作答进行解读。"
      : "回答偏简略（少于 20 字），建议补充核心步骤或边界条件后再次提交。",
    positionMatches: null,
    graderVersion: "rubric-v1",
  };
}

/**
 * 4. Unified Authoritative Submission Pipeline:
 * Stage 1 (Assessment Engine) -> Stage 2 (Learner Model BKT/FSRS) -> Stage 3 (Planner Draft, NO premature calendar mutation!)
 */
export function submitExerciseAttempt(opts: {
  exerciseId: string;
  learningSessionId: string;
  attemptId?: string;
  idempotencyKey: string;
  answer: StructuredExerciseAnswer;
  day?: string;
}): SubmitAttemptResult {
  const db = getDb();
  const day = opts.day || today();
  const nowIso = new Date().toISOString();

  // --- Idempotency & Duplicate Submission Protection ---
  const existingRow = db
    .prepare(
      "SELECT * FROM exercise_attempts WHERE idempotency_key = ? OR attempt_id = ? LIMIT 1",
    )
    .get(opts.idempotencyKey, opts.attemptId || "__none__") as
    | Record<string, unknown>
    | undefined;

  if (existingRow) {
    const existingAttempt = parseAttemptRow(existingRow);
    const draftRow = db
      .prepare("SELECT * FROM plan_drafts WHERE source_attempt_id = ? LIMIT 1")
      .get(existingAttempt.attempt_id) as Record<string, unknown> | undefined;
    const sessRow = db
      .prepare("SELECT * FROM learning_sessions WHERE learning_session_id = ?")
      .get(existingAttempt.learning_session_id) as
      | Record<string, unknown>
      | undefined;
    return {
      deduplicated: true,
      attempt: existingAttempt,
      learnerUpdate: null,
      planDraft: draftRow ? parsePlanDraftRow(draftRow) : null,
      session: sessRow ? parseSessionRow(sessRow) : null,
      store: loadStoreFromDb(day),
    };
  }

  const exercise = getExerciseById(opts.exerciseId);
  if (!exercise) {
    throw new LearningEngineError(
      "EXERCISE_NOT_FOUND",
      404,
      `未找到练习 exercise_id=${opts.exerciseId}`,
    );
  }

  // Cross-lesson session integrity guard (ASSESS-07)
  const existingSessRow = db
    .prepare(
      "SELECT learning_session_id, lesson_id FROM learning_sessions WHERE learning_session_id = ?",
    )
    .get(opts.learningSessionId) as
    | { learning_session_id?: string; lesson_id?: string }
    | undefined;
  if (
    existingSessRow?.lesson_id &&
    existingSessRow.lesson_id !== exercise.lesson_id
  ) {
    throw new LearningEngineError(
      "LESSON_SESSION_MISMATCH",
      400,
      `练习所属课程（${exercise.lesson_id}）与会话所属课程（${existingSessRow.lesson_id}）不匹配，已拒绝跨课程提交。`,
    );
  }

  // Objective spec & answer payload validation (E2E-004, SORT-06/07/08, GEN-09, ASSESS-03)
  validateExerciseSpec(exercise.mode, exercise.spec);
  validateSubmittedAnswer(exercise, opts.answer);

  // --- STAGE 1: Deterministic Assessment Engine ---
  const graded = gradeExerciseDeterministically(exercise, opts.answer);
  const attemptId = opts.attemptId || `att-${crypto.randomUUID().slice(0, 10)}`;

  db.prepare(
    `INSERT INTO exercise_attempts
      (attempt_id, idempotency_key, exercise_id, learning_session_id, lesson_id, submitted_answer_json, status, score, correct, error_type, correct_answer_json, feedback, position_matches_json, grader_version, created_at, graded_at)
     VALUES (?, ?, ?, ?, ?, ?, 'graded', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attemptId,
    opts.idempotencyKey,
    exercise.exercise_id,
    opts.learningSessionId,
    exercise.lesson_id,
    JSON.stringify(opts.answer),
    graded.score,
    graded.correct ? 1 : 0,
    graded.errorType,
    graded.correctAnswer !== undefined
      ? JSON.stringify(graded.correctAnswer)
      : null,
    graded.feedback,
    graded.positionMatches ? JSON.stringify(graded.positionMatches) : null,
    graded.graderVersion,
    nowIso,
    nowIso,
  );

  const attempt: ExerciseAttemptRecord = {
    attempt_id: attemptId,
    idempotency_key: opts.idempotencyKey,
    exercise_id: exercise.exercise_id,
    learning_session_id: opts.learningSessionId,
    lesson_id: exercise.lesson_id,
    submitted_answer: opts.answer,
    status: "graded",
    score: graded.score,
    correct: graded.correct,
    error_type: graded.errorType,
    correct_answer: graded.correctAnswer,
    feedback: graded.feedback,
    position_matches: graded.positionMatches,
    grader_version: graded.graderVersion,
    created_at: nowIso,
    graded_at: nowIso,
  };

  // --- STAGE 2: Learner Model (AssessmentCompleted -> BKT + FSRS, ZERO direct calendar edits!) ---
  const store = loadStoreFromDb(day);
  const lesson: Lesson =
    getLessonById(store, exercise.lesson_id) || {
      id: exercise.lesson_id,
      title: exercise.spec.lessonTitle || exercise.lesson_id,
      subtitle: "",
      minutes: 25,
      requires: [],
      concept: "",
      example: "",
      question: exercise.prompt,
      choices: exercise.spec.choices || [],
      answer: exercise.spec.correctChoiceIndex ?? 0,
      feedback: exercise.spec.explanation || "",
    };

  const calc = computeMasteryUpdate(store, lesson, graded.correct, day);
  const nextMasteryMap = { ...store.mastery, [lesson.id]: calc.after };

  // Downstream Loop #4 (测验反哺图谱): Version-update unmastered downstream contracts
  // based on real assessment evidence while 100% preserving mastered lessons & history.
  const adaptedGoalPlans = (store.goalPlans || []).map((plan) => {
    if (!plan.units.some((u) => u.id === lesson.id)) return plan;
    const adapted = adaptTrackContractsFromAssessment(plan, {
      assessedLessonId: lesson.id,
      correct: graded.correct,
      masteryAfter: calc.after,
      misconceptionNote: !graded.correct ? graded.feedback : undefined,
      masteryMap: nextMasteryMap,
    });
    return adapted.plan;
  });

  const nextStore: Store = {
    ...store,
    goalPlans: adaptedGoalPlans,
    mastery: nextMasteryMap,
    masteryMeta: { ...(store.masteryMeta || {}), [lesson.id]: calc.meta },
    attempts: [
      {
        id: attemptId,
        lessonId: lesson.id,
        kind: exercise.mode === "code" ? ("lab" as const) : ("quiz" as const),
        correct: graded.correct,
        attemptedAt: nowIso,
      },
      ...(store.attempts || []),
    ].slice(0, 100),
    // Calendar blocks remain untouched here!
  };

  saveStoreToDb(nextStore, {
    trigger: graded.correct ? "练习评分达标" : "练习评分需巩固",
    summary: `${lesson.title}（${graded.score} 分 · BKT ${calc.before}% → ${calc.after}%）`,
  });

  recordDomainEventInDb({
    eventType: "AssessmentCompleted",
    entityType: "exercise_attempt",
    entityId: attemptId,
    summary: `完成「${lesson.title}」${exercise.mode} 评分（${graded.score} 分，${graded.correct ? "通过" : graded.errorType}，BKT ${calc.before}% → ${calc.after}%）`,
    payload: {
      attemptId,
      exerciseId: exercise.exercise_id,
      learningSessionId: opts.learningSessionId,
      lessonId: lesson.id,
      score: graded.score,
      correct: graded.correct,
      errorType: graded.errorType,
      beforeMastery: calc.before,
      afterMastery: calc.after,
      nextReviewDay: calc.nextReviewDay,
      graderVersion: graded.graderVersion,
      estimatorVersion: "bkt-fsrs-v1",
    },
  });

  // Update Learning Session progress & completion status
  const nextCompletion =
    calc.after >= 80
      ? "completed"
      : graded.correct
        ? "active"
        : "needs_review";
  db.prepare(
    `UPDATE learning_sessions
     SET progress = ?, completion_status = ?, updated_at = ?
     WHERE learning_session_id = ?`,
  ).run(calc.after, nextCompletion, nowIso, opts.learningSessionId);

  const sessRow = db
    .prepare("SELECT * FROM learning_sessions WHERE learning_session_id = ?")
    .get(opts.learningSessionId) as Record<string, unknown> | undefined;

  // --- STAGE 3: Pedagogy / Planner Draft (Generates Preview Diff ONLY — NEVER auto-mutates calendar!) ---
  let planDraft: PlanDraftRecord | null = null;
  if (!graded.correct) {
    // SCHED-07 / SCHED-09: If prerequisites are not met, direct remediation to the earliest unmet prerequisite
    const missingPrereqs = getMissingPrerequisites(nextStore, lesson);
    const remediationLesson =
      missingPrereqs.length > 0 ? missingPrereqs[0] : lesson;
    const redirectedForPrereq = remediationLesson.id !== lesson.id;

    const waking = getWakingBounds(nextStore.scheduleSettings);
    const prefs = extractMemoryPreferences(nextStore.memories, day);
    const endLimit = Math.min(
      waking.wakeEnd,
      prefs.preferredEnd ?? waking.wakeEnd,
    );
    const slot =
      findSlot(
        nextStore.blocks,
        day,
        Math.max(waking.wakeStart, prefs.preferredStart ?? 1140),
        20,
        undefined,
        endLimit,
      ) ||
      findSlot(
        nextStore.blocks,
        day,
        waking.wakeStart,
        20,
        undefined,
        waking.wakeEnd,
      );

    if (slot) {
      // E2E-006: Deduplicate pending remedial plan drafts for the same target lesson
      const existingPendingRow = db
        .prepare(
          "SELECT * FROM plan_drafts WHERE lesson_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        )
        .get(remediationLesson.id) as Record<string, unknown> | undefined;
      const draftId = existingPendingRow?.draft_id
        ? String(existingPendingRow.draft_id)
        : `draft-${crypto.randomUUID().slice(0, 8)}`;

      const remedialBlock: Block = {
        id: `rem-${draftId}`,
        day: slot.day,
        start: slot.start,
        minutes: 20,
        title: `${remediationLesson.title} · 针对性巩固练习`,
        kind: "复习",
        lesson: remediationLesson.id,
      };
      // Simulate downstream dependency impact on a COPY without mutating real blocks
      const simulated = postponeDependentBlocks(
        { ...nextStore, blocks: [...nextStore.blocks, remedialBlock] },
        remediationLesson.id,
        slot.day,
      );
      const movedBlocks: PlanDraftDiff["movedBlocks"] = [];
      for (const afterBlk of simulated.blocks) {
        const beforeBlk = nextStore.blocks.find((b) => b.id === afterBlk.id);
        if (
          beforeBlk &&
          (beforeBlk.day !== afterBlk.day || beforeBlk.start !== afterBlk.start)
        ) {
          movedBlocks.push({
            blockId: beforeBlk.id,
            title: beforeBlk.title,
            oldDay: beforeBlk.day,
            oldStart: beforeBlk.start,
            newDay: afterBlk.day,
            newStart: afterBlk.start,
          });
        }
      }

      const candidateActivity = {
        lessonId: remediationLesson.id,
        title: remedialBlock.title,
        minutes: 20,
        kind: "复习" as const,
        reason: redirectedForPrereq
          ? `「${lesson.title}」的先修课「${remediationLesson.title}」尚未达标，建议优先安排 20 分钟先修巩固`
          : `本次评分 ${graded.score} 分（${graded.errorType}），建议插入 20 分钟巩固练习`,
      };
      const diff: PlanDraftDiff = {
        addedBlocks: [remedialBlock],
        movedBlocks,
      };
      const impactCount = 1 + movedBlocks.length;
      const summary =
        (redirectedForPrereq
          ? `先修「${remediationLesson.title}」未达标，建议先在 ${slot.day.slice(5)} ${time(slot.start)} 巩固 20 分钟`
          : `建议在 ${slot.day.slice(5)} ${time(slot.start)} 增加 20 分钟「${remediationLesson.title}」巩固练习`) +
        (movedBlocks.length > 0
          ? `（将顺延 ${movedBlocks.length} 节后续依赖课，确认后才生效）`
          : "（无冲突，不影响其他日程，确认后才生效）");

      if (existingPendingRow) {
        db.prepare(
          `UPDATE plan_drafts
           SET source_attempt_id = ?, trigger_reason = ?, summary = ?, candidate_activity_json = ?, diff_json = ?, impact_count = ?, created_at = ?
           WHERE draft_id = ?`,
        ).run(
          attemptId,
          graded.errorType,
          summary,
          JSON.stringify(candidateActivity),
          JSON.stringify(diff),
          impactCount,
          nowIso,
          draftId,
        );
      } else {
        db.prepare(
          `INSERT OR IGNORE INTO plan_drafts
            (draft_id, source_attempt_id, lesson_id, trigger_reason, summary, status, candidate_activity_json, diff_json, impact_count, created_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL)`,
        ).run(
          draftId,
          attemptId,
          remediationLesson.id,
          graded.errorType,
          summary,
          JSON.stringify(candidateActivity),
          JSON.stringify(diff),
          impactCount,
          nowIso,
        );
      }

      planDraft = {
        draft_id: draftId,
        source_attempt_id: attemptId,
        lesson_id: remediationLesson.id,
        trigger_reason: graded.errorType,
        summary,
        status: "pending",
        candidate_activity: candidateActivity,
        diff,
        impact_count: impactCount,
        created_at: nowIso,
        resolved_at: null,
      };

      recordDomainEventInDb({
        eventType: "RemediationTriggered",
        entityType: "plan_draft",
        entityId: draftId,
        summary: existingPendingRow
          ? `已更新待确认补救排期草案：${summary}`
          : `已生成补救排期草案：${summary}`,
        payload: {
          draftId,
          sourceAttemptId: attemptId,
          lessonId: remediationLesson.id,
          originalLessonId: lesson.id,
          impactCount,
          deduplicated: Boolean(existingPendingRow),
        },
      });
    }
  }

  return {
    deduplicated: false,
    attempt,
    learnerUpdate: {
      before: calc.before,
      after: calc.after,
      delta: calc.delta,
      nextReviewDay: calc.nextReviewDay,
      stabilityDays: calc.stabilityDays,
      unlockedTitles: calc.unlocked.map((u) => u.title),
      estimatorVersion: "bkt-fsrs-v1",
    },
    planDraft,
    session: sessRow ? parseSessionRow(sessRow) : null,
    store: nextStore,
  };
}

function blocksOverlap(
  a: { day: string; start: number; minutes: number },
  b: { day: string; start: number; minutes: number },
): boolean {
  if (a.day !== b.day) return false;
  return a.start < b.start + b.minutes && b.start < a.start + a.minutes;
}

const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 5. Planner Draft Application (Explicit user authorization -> atomic SQLite Plan Revision)
 * Enforces strict state machine (DIFF-06), expiry check (DIFF-11), and live conflict re-validation (DIFF-12 / DATA-14).
 */
export function applyPlanDraft(
  draftId: string,
  day?: string,
): { applied: boolean; draft: PlanDraftRecord; store: Store } {
  const db = getDb();
  const targetDay = day || today();
  const row = db
    .prepare("SELECT * FROM plan_drafts WHERE draft_id = ?")
    .get(draftId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new LearningEngineError(
      "DRAFT_NOT_FOUND",
      404,
      `未找到排期草案 draft_id=${draftId}`,
    );
  }
  const draft = parsePlanDraftRow(row);
  if (draft.status === "applied") {
    return { applied: false, draft, store: loadStoreFromDb(targetDay) };
  }
  if (draft.status !== "pending") {
    throw new LearningEngineError(
      "DRAFT_NOT_PENDING",
      409,
      `排期草案当前状态为「${draft.status}」（已拒绝或已失效），不可再次应用，请重新生成方案。`,
    );
  }

  // DIFF-11: Expiry check (older than 24h or targets a past calendar date)
  const createdMs = Date.parse(draft.created_at);
  const nowMs = Date.now();
  const isOlderThanTtl =
    Number.isFinite(createdMs) && nowMs - createdMs > DRAFT_MAX_AGE_MS;
  const targetsPastDay = draft.diff.addedBlocks.some(
    (b) => b.day < targetDay,
  );
  if (isOlderThanTtl || targetsPastDay) {
    const expiredAt = new Date().toISOString();
    db.prepare(
      "UPDATE plan_drafts SET status = 'expired', resolved_at = ? WHERE draft_id = ?",
    ).run(expiredAt, draftId);
    throw new LearningEngineError(
      "DRAFT_EXPIRED",
      409,
      "该排期草案已过期，请基于当前最新日程重新计算方案。",
    );
  }

  // DIFF-12 / DATA-14: Re-validate live calendar conflicts & waking bounds before applying
  const store = loadStoreFromDb(targetDay);
  const waking = getWakingBounds(store.scheduleSettings);
  const movedMap = new Map(draft.diff.movedBlocks.map((m) => [m.blockId, m]));
  const simulatedBlocks = store.blocks.map((b) => {
    const mv = movedMap.get(b.id);
    return mv ? { ...b, day: mv.newDay, start: mv.newStart } : b;
  });

  for (const addBlk of draft.diff.addedBlocks) {
    if (
      addBlk.start < waking.wakeStart ||
      addBlk.start + addBlk.minutes > waking.wakeEnd
    ) {
      throw new LearningEngineError(
        "DRAFT_CONFLICT",
        409,
        `草案建议时段（${addBlk.day} ${time(addBlk.start)}）超出当前清醒学习红线，请重新计算排期。`,
      );
    }
    const conflict = simulatedBlocks.find(
      (b) => b.id !== addBlk.id && blocksOverlap(b, addBlk),
    );
    if (conflict) {
      throw new LearningEngineError(
        "DRAFT_CONFLICT",
        409,
        `草案建议时段（${addBlk.day} ${time(addBlk.start)}）已被「${conflict.title}」占用，已阻止重叠写入，请重新计算排期。`,
      );
    }
  }

  for (const mv of draft.diff.movedBlocks) {
    const movedBlk = simulatedBlocks.find((b) => b.id === mv.blockId);
    if (!movedBlk) continue;
    const conflict = simulatedBlocks.find(
      (b) => b.id !== movedBlk.id && blocksOverlap(b, movedBlk),
    );
    if (conflict) {
      throw new LearningEngineError(
        "DRAFT_CONFLICT",
        409,
        `草案调整后的时段（${mv.newDay} ${time(mv.newStart)}）与「${conflict.title}」冲突，已阻止重叠写入。`,
      );
    }
  }

  let nextBlocks = simulatedBlocks;
  for (const addBlk of draft.diff.addedBlocks) {
    if (!nextBlocks.some((b) => b.id === addBlk.id)) {
      nextBlocks = [...nextBlocks, addBlk];
    }
  }

  const nextStore: Store = { ...store, blocks: nextBlocks };
  saveStoreToDb(nextStore, {
    trigger: "确认应用补救排期草案",
    summary: draft.summary,
  });

  const nowIso = new Date().toISOString();
  db.prepare(
    "UPDATE plan_drafts SET status = 'applied', resolved_at = ? WHERE draft_id = ?",
  ).run(nowIso, draftId);

  return {
    applied: true,
    draft: { ...draft, status: "applied", resolved_at: nowIso },
    store: loadStoreFromDb(targetDay),
  };
}

export function dismissPlanDraft(
  draftId: string,
): { draft: PlanDraftRecord } {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM plan_drafts WHERE draft_id = ?")
    .get(draftId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new LearningEngineError(
      "DRAFT_NOT_FOUND",
      404,
      `未找到排期草案 draft_id=${draftId}`,
    );
  }
  const draft = parsePlanDraftRow(row);
  const nowIso = new Date().toISOString();
  db.prepare(
    "UPDATE plan_drafts SET status = 'dismissed', resolved_at = ? WHERE draft_id = ?",
  ).run(nowIso, draftId);
  return {
    draft: { ...draft, status: "dismissed", resolved_at: nowIso },
  };
}
