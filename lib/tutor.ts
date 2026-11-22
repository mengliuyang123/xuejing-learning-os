import type {
  ActiveRecallCardData,
  GoalPlan,
  MemoryProposal,
  MemorySavedCard,
} from "./learning";
import type { HandsOnLab } from "./labs";

export type TutorCard =
  | { kind: "program"; plan: GoalPlan }
  | {
      kind: "reading";
      unitId: string;
      title: string;
      concept: string;
      example: string;
    }
  | { kind: "example"; title: string; content: string }
  | {
      kind: "quiz";
      question: string;
      choices: string[];
      unitId?: string;
      answer?: number;
      feedback?: string;
      isVariant?: boolean;
    }
  | {
      kind: "feedback";
      attempt: string;
      choice: number;
      correct: boolean;
      explanation: string;
      unitId?: string;
      masteryBefore?: number;
      masteryAfter?: number;
      unlockedTitles?: string[];
      nextReviewDay?: string;
    }
  | { kind: "lab"; lab: HandsOnLab }
  | ActiveRecallCardData
  | MemorySavedCard
  | MemoryProposal;
