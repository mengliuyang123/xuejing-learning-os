import { resolveLanguageModel } from "../../../../lib/ai-config";
import { getDbInfo } from "../../../../lib/db";
import {
  LearningEngineError,
  type StructuredExerciseAnswer,
  submitExerciseAttempt,
} from "../../../../lib/learning-engine";
import { triggerRollingPrewarmForNextLesson } from "../../../../lib/topic-researcher";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      exerciseId: string;
      learningSessionId: string;
      attemptId?: string;
      idempotencyKey: string;
      answer: StructuredExerciseAnswer;
      day?: string;
    };

    if (!body?.exerciseId || !body?.learningSessionId || !body?.idempotencyKey) {
      return Response.json(
        { error: "缺少 exerciseId、learningSessionId 或 idempotencyKey" },
        { status: 400 },
      );
    }

    const result = submitExerciseAttempt({
      exerciseId: body.exerciseId,
      learningSessionId: body.learningSessionId,
      attemptId: body.attemptId,
      idempotencyKey: body.idempotencyKey,
      answer: body.answer || {},
      day: body.day,
    });

    // N+1 Rolling Prewarm on assessment completion: silently warm the next topological lesson
    if (!result.deduplicated && result.attempt.correct) {
      const lessonId = result.attempt.lesson_id;
      const owningTrack = (result.store.goalPlans || []).find((p) =>
        p.units.some((u) => u.id === lessonId),
      );
      if (owningTrack) {
        const resolved = resolveLanguageModel();
        void triggerRollingPrewarmForNextLesson({
          track: owningTrack,
          currentLessonId: lessonId,
          masteryMap: result.store.mastery,
          model: resolved?.model ?? null,
        }).catch(() => {});
      }
    }

    return Response.json({
      ...result,
      dbInfo: getDbInfo(),
    });
  } catch (err) {
    if (err instanceof LearningEngineError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error("[api/learning/attempts POST]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "提交评分失败" },
      { status: 500 },
    );
  }
}
