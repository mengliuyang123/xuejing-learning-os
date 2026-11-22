import { getDbInfo } from "../../../../lib/db";
import {
  type ExerciseSpec,
  LearningEngineError,
  type LearningSessionMode,
  registerExercise,
  startLearningSession,
} from "../../../../lib/learning-engine";
import type { InteractiveCheckMode } from "../../../../lib/learning";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const lessonId = url.searchParams.get("lessonId");
    const exerciseId = url.searchParams.get("exerciseId") || undefined;
    const day = url.searchParams.get("day") || undefined;
    if (!lessonId) {
      return Response.json({ error: "缺少 lessonId 参数" }, { status: 400 });
    }
    const data = startLearningSession({ lessonId, exerciseId, day });
    return Response.json({ ...data, dbInfo: getDbInfo() });
  } catch (err) {
    if (err instanceof LearningEngineError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error("[api/learning/session GET]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "加载学习会话失败" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      lessonId: string;
      trackId?: string;
      mode?: LearningSessionMode;
      contentVersion?: string;
      exerciseId?: string;
      day?: string;
      registerExercise?: {
        mode: InteractiveCheckMode;
        prompt: string;
        spec: ExerciseSpec;
        source?: "curriculum" | "tutor_candidate";
      };
    };

    if (!body?.lessonId) {
      return Response.json({ error: "缺少 lessonId" }, { status: 400 });
    }

    const sessionData = startLearningSession({
      lessonId: body.lessonId,
      trackId: body.trackId,
      mode: body.mode,
      contentVersion: body.contentVersion,
      exerciseId: body.exerciseId,
      day: body.day,
    });

    if (body.registerExercise) {
      const reg = registerExercise({
        lessonId: body.lessonId,
        learningSessionId: sessionData.session.learning_session_id,
        mode: body.registerExercise.mode,
        prompt: body.registerExercise.prompt,
        spec: body.registerExercise.spec,
        source: body.registerExercise.source || "curriculum",
      });
      const refreshed = startLearningSession({
        lessonId: body.lessonId,
        trackId: body.trackId,
        mode: body.mode,
        exerciseId: reg.exercise.exercise_id,
        day: body.day,
      });
      return Response.json({
        ...refreshed,
        registeredExercise: reg.exercise,
        deduplicated: reg.deduplicated,
        dbInfo: getDbInfo(),
      });
    }

    return Response.json({ ...sessionData, dbInfo: getDbInfo() });
  } catch (err) {
    if (err instanceof LearningEngineError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error("[api/learning/session POST]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "启动学习会话失败" },
      { status: 500 },
    );
  }
}
