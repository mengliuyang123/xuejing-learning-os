/**
 * Pure-TypeScript Cognitive Modeling Engine:
 * - Bayesian Knowledge Tracing (BKT) for mastery posterior estimation
 * - Official `ts-fsrs` (Open Spaced Repetition) for interval scheduling & forgetting curve
 */
import {
  type Card,
  type Grade,
  Rating,
  State,
  createEmptyCard,
  forgetting_curve,
  fsrs,
  generatorParameters,
} from "ts-fsrs";

const scheduler = fsrs(
  generatorParameters({
    enable_short_term: false,
    enable_fuzz: false,
    request_retention: 0.9,
    maximum_interval: 90,
  }),
);

export type BKTParams = {
  pLearn: number; // P(T) transition probability
  pGuess: number; // P(G) guessing probability
  pSlip: number; // P(S) slipping probability
};

export const DEFAULT_BKT: BKTParams = {
  pLearn: 0.22,
  pGuess: 0.2,
  pSlip: 0.1,
};

/**
 * Exact Bayes' rule BKT posterior + learning transition update.
 */
export function updateBKT(
  pKnownPrior: number,
  correct: boolean,
  params: BKTParams = DEFAULT_BKT,
): { pPosterior: number; pNext: number; score: number } {
  const prior = Math.min(0.99, Math.max(0.05, pKnownPrior));
  const { pLearn, pGuess, pSlip } = params;

  let pPosterior: number;
  if (correct) {
    const num = prior * (1 - pSlip);
    const den = num + (1 - prior) * pGuess;
    pPosterior = den > 0 ? num / den : prior;
  } else {
    const num = prior * pSlip;
    const den = num + (1 - prior) * (1 - pGuess);
    pPosterior = den > 0 ? num / den : prior;
  }

  const effectiveLearn = correct ? pLearn : pLearn * 0.35;
  const pNext = Math.min(
    0.99,
    Math.max(0.05, pPosterior + (1 - pPosterior) * effectiveLearn),
  );

  return {
    pPosterior,
    pNext,
    score: Math.round(pNext * 100),
  };
}

export type FSRSRating = 1 | 2 | 3 | 4; // 1=Again(忘记), 2=Hard(困难), 3=Good(良好), 4=Easy(容易)

export type FSRSState = {
  stabilityDays: number;
  difficulty: number;
  lapses: number;
  reps?: number;
  fsrsState?: number;
};

function toFSRSCard(
  prev: Partial<FSRSState> | undefined,
  nowDate: Date,
  elapsedDays: number,
): Card {
  if (!prev || !prev.stabilityDays || prev.stabilityDays <= 0) {
    return createEmptyCard(nowDate);
  }
  const lastReview = new Date(nowDate.getTime() - elapsedDays * 86400000);
  const due = new Date(
    lastReview.getTime() + Math.max(1, prev.stabilityDays) * 86400000,
  );
  return {
    due,
    stability: Math.max(0.2, prev.stabilityDays),
    difficulty: Math.min(10, Math.max(1, prev.difficulty ?? 5.0)),
    elapsed_days: Math.max(0, elapsedDays),
    scheduled_days: Math.max(1, Math.round(prev.stabilityDays)),
    learning_steps: 0,
    reps: prev.reps ?? 1,
    lapses: prev.lapses ?? 0,
    state: (prev.fsrsState as State) ?? State.Review,
    last_review: lastReview,
  };
}

function ratingToGrade(rating: FSRSRating): Grade {
  return (
    {
      1: Rating.Again,
      2: Rating.Hard,
      3: Rating.Good,
      4: Rating.Easy,
    } as Record<FSRSRating, Grade>
  )[rating];
}

/**
 * Official `ts-fsrs` power-law forgetting curve R(t, S).
 */
export function computeRetrievability(
  elapsedDays: number,
  stabilityDays: number,
): number {
  const t = Math.max(0, elapsedDays);
  const s = Math.max(0.2, stabilityDays);
  return forgetting_curve(scheduler.parameters.w[20], t, s);
}

/**
 * Runs official `ts-fsrs` scheduling update for a 4-grade rating.
 */
export function reviewFSRS(
  prev: Partial<FSRSState> | undefined,
  rating: FSRSRating,
  elapsedDays = 1,
  nowDate = new Date(),
): FSRSState & { nextIntervalDays: number; masteryDelta: number } {
  const card = toFSRSCard(prev, nowDate, elapsedDays);
  const grade = ratingToGrade(rating);
  const record = scheduler.next(card, nowDate, grade);
  const nextCard = record.card;

  const stabilityDays = Number(Math.max(0.2, nextCard.stability).toFixed(2));
  const difficulty = Number(
    Math.min(10, Math.max(1, nextCard.difficulty)).toFixed(2),
  );
  const nextIntervalDays = Math.max(1, nextCard.scheduled_days);
  const masteryDelta =
    rating === 1 ? -10 : rating === 2 ? 4 : rating === 3 ? 12 : 18;

  return {
    stabilityDays,
    difficulty,
    lapses: nextCard.lapses,
    reps: nextCard.reps,
    fsrsState: nextCard.state,
    nextIntervalDays,
    masteryDelta,
  };
}

/**
 * Pre-computes interval labels for all 4 FSRS rating buttons via `ts-fsrs`.
 */
export function previewFSRSRatings(
  prev: Partial<FSRSState> | undefined,
  elapsedDays = 1,
): Array<{ rating: FSRSRating; label: string; intervalDays: number }> {
  const labels: Record<FSRSRating, string> = {
    1: "忘记",
    2: "困难",
    3: "良好",
    4: "容易",
  };
  const nowDate = new Date();
  return ([1, 2, 3, 4] as FSRSRating[]).map((rating) => ({
    rating,
    label: labels[rating],
    intervalDays: reviewFSRS(prev, rating, elapsedDays, nowDate).nextIntervalDays,
  }));
}

/**
 * Generates retention curve points over `horizonDays` using `ts-fsrs` forgetting_curve.
 */
export function buildRetentionCurve(
  stabilityDays: number,
  elapsedAlready = 0,
  horizonDays = 10,
): Array<{ dayOffset: number; retention: number }> {
  return Array.from({ length: horizonDays + 1 }, (_, d) => ({
    dayOffset: d,
    retention: Math.round(
      computeRetrievability(elapsedAlready + d, stabilityDays) * 100,
    ),
  }));
}
