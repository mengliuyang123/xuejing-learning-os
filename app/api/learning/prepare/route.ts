import { NextResponse } from "next/server";
import { resolveLanguageModel } from "../../../../lib/ai-config";
import {
  resolveGraphNeighborsForLesson,
  resolveNextRollingLesson,
} from "../../../../lib/curriculum-planner";
import {
  getLatestLessonContentVersionFromDb,
  getLessonPreparationFromDb,
  listTeachingActivitiesForLessonFromDb,
  loadStoreFromDb,
} from "../../../../lib/db";
import {
  type PriorKnowledgeLevel,
  getLessonById,
  today,
} from "../../../../lib/learning";
import type { ClientModelConfig } from "../../../../lib/model-config";
import {
  type LessonResearchBrief,
  prepareLessonInDepth,
  triggerRollingPrewarmForNextLesson,
} from "../../../../lib/topic-researcher";
import type { KnowledgeAcquisitionMode } from "../../../../lib/web-research";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const lessonId = url.searchParams.get("lessonId")?.trim();
    if (!lessonId) {
      return NextResponse.json({ error: "缺少 lessonId" }, { status: 400 });
    }
    const day = url.searchParams.get("day")?.trim() || today();
    const store = loadStoreFromDb(day);
    const owningTrack =
      (store.goalPlans || []).find((p) =>
        p.units.some((u) => u.id === lessonId),
      ) || null;
    const neighborhood = owningTrack
      ? resolveGraphNeighborsForLesson(owningTrack.units, lessonId, {
          blueprintVersion: owningTrack.blueprintVersion ?? 1,
          mastery: store.mastery,
        })
      : null;

    const preparation = getLessonPreparationFromDb(lessonId);
    const lessonContent = getLatestLessonContentVersionFromDb(lessonId);
    const teachingActivities = listTeachingActivitiesForLessonFromDb(lessonId, 10);

    const trackBpVersion = owningTrack?.blueprintVersion ?? 1;
    const cachedBpVersion =
      (preparation?.brief as LessonResearchBrief | undefined)
        ?.blueprintVersion ??
      (preparation?.brief as LessonResearchBrief | undefined)?.contract
        ?.blueprintVersion ??
      1;
    const isStale = Boolean(
      preparation &&
        (preparation.status === "ready" || preparation.status === "fallback") &&
        cachedBpVersion < trackBpVersion,
    );

    const nextRollingLesson = owningTrack
      ? resolveNextRollingLesson(owningTrack.units, lessonId, store.mastery)
      : null;

    return NextResponse.json({
      preparation,
      lessonContent,
      teachingActivities,
      contract: neighborhood?.contract ?? null,
      blueprintVersion: trackBpVersion,
      isStale,
      nextRollingLessonId: nextRollingLesson?.id ?? null,
    });
  } catch (err) {
    console.error("[api/learning/prepare GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "读取备课缓存失败" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      lessonId?: string;
      trackId?: string;
      mode?: KnowledgeAcquisitionMode;
      learnerLevel?: PriorKnowledgeLevel;
      userUrls?: string[];
      userNotes?: string;
      forceRefresh?: boolean;
      prewarm?: boolean;
      day?: string;
      clientModelConfig?: ClientModelConfig | null;
    };

    const lessonId = body.lessonId?.trim();
    if (!lessonId) {
      return NextResponse.json({ error: "缺少 lessonId" }, { status: 400 });
    }

    const day = body.day || today();
    const store = loadStoreFromDb(day);
    const lesson = getLessonById(store, lessonId);
    if (!lesson) {
      return NextResponse.json(
        { error: `未找到课程 ${lessonId}` },
        { status: 404 },
      );
    }

    const owningTrack =
      (store.goalPlans || []).find(
        (p) =>
          (body.trackId && p.id === body.trackId) ||
          p.units.some((u) => u.id === lessonId),
      ) || null;

    const resolved = resolveLanguageModel(body.clientModelConfig);
    const learnerLevel: PriorKnowledgeLevel =
      body.learnerLevel || owningTrack?.priorKnowledge || "intermediate";

    const prepared = await prepareLessonInDepth({
      lesson,
      trackId: owningTrack?.id ?? body.trackId ?? null,
      trackTitle: owningTrack?.title,
      trackGoal: owningTrack?.goal,
      trackUnits: owningTrack?.units,
      blueprintId: owningTrack?.blueprintId,
      blueprintVersion: owningTrack?.blueprintVersion ?? 1,
      researchPackageId: owningTrack?.researchPackageId,
      masteryMap: store.mastery,
      reuseTrackResearch: !body.forceRefresh && body.mode !== "user_materials",
      learnerLevel,
      mode: body.mode || "auto_web",
      userUrls: body.userUrls,
      userNotes: body.userNotes,
      forceRefresh: Boolean(body.forceRefresh),
      model: resolved?.model ?? null,
      clientConfig: body.clientModelConfig,
      abortSignal: request.signal,
    });

    // N+1 Rolling Prewarm: When preparing current lesson N (not itself a prewarm call),
    // silently trigger background preparation of lesson N+1 reusing the track's global ResearchPackage.
    let nextPrewarmLessonId: string | null = null;
    if (!body.prewarm && owningTrack) {
      const nextCandidate = resolveNextRollingLesson(
        owningTrack.units,
        lesson.id,
        store.mastery,
      );
      nextPrewarmLessonId = nextCandidate?.id ?? null;
      if (nextCandidate) {
        void triggerRollingPrewarmForNextLesson({
          track: owningTrack,
          currentLessonId: lesson.id,
          masteryMap: store.mastery,
          model: resolved?.model ?? null,
          clientConfig: body.clientModelConfig,
        }).catch((err) => {
          console.error("[api/learning/prepare] N+1 rolling prewarm error:", err);
        });
      }
    }

    return NextResponse.json({
      ok: true,
      prepared,
      nextPrewarmLessonId,
    });
  } catch (err) {
    console.error("[api/learning/prepare POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "深度备课失败" },
      { status: 500 },
    );
  }
}
