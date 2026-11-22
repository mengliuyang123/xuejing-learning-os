import type {
  Block,
  InteractiveBlankSlot,
  InteractiveCheckCard,
  InteractiveCheckMode,
  Store,
} from "./learning";

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
