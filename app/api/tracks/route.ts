import {
  adjustTrackScopeInDb,
  archiveTrackInDb,
  getDbInfo,
  getTrackImpactFromDb,
  permanentlyDeleteTrackInDb,
  restoreTrackInDb,
} from "../../../lib/db";
import {
  type Lesson,
  type PriorKnowledgeLevel,
  type TrackDepth,
  today,
} from "../../../lib/learning";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const trackId = url.searchParams.get("trackId");
    if (!trackId) {
      return Response.json({ error: "缺少 trackId" }, { status: 400 });
    }
    const impact = getTrackImpactFromDb(trackId);
    if (!impact) {
      return Response.json({ error: "未找到对应轨道" }, { status: 404 });
    }
    return Response.json({ impact });
  } catch (err) {
    console.error("[api/tracks GET]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "查询轨道影响范围失败" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: "archive" | "restore" | "permanent_delete" | "adjust_scope";
      trackId?: string;
      confirmTrackId?: string;
      day?: string;
      depth?: TrackDepth;
      scopeNote?: string;
      priorKnowledge?: PriorKnowledgeLevel;
      days?: number;
      dailyMinutes?: number;
      nextUnits?: Lesson[];
      appendUnits?: Array<{
        id?: string;
        title: string;
        concept: string;
        objective?: string;
        completionCriteria?: string;
        example?: string;
        minutes?: number;
        requires?: string[];
        practiceType?: "code" | "text";
        practiceLanguage?: string;
        practicePrompt?: string;
        starterCode?: string;
      }>;
      removeLessonIds?: string[];
    };
    const trackId = body.trackId?.trim();
    const day = body.day || today();
    if (!trackId || !body.action) {
      return Response.json(
        { error: "缺少 action 或 trackId" },
        { status: 400 },
      );
    }

    if (body.action === "archive") {
      const { store, pausedBlocks } = archiveTrackInDb(trackId, day);
      return Response.json({
        ok: true,
        action: "archive",
        pausedBlocks,
        store,
        stateVersion: store.stateVersion ?? 1,
        dbInfo: getDbInfo(),
      });
    }

    if (body.action === "restore") {
      const { store } = restoreTrackInDb(trackId, day);
      return Response.json({
        ok: true,
        action: "restore",
        store,
        stateVersion: store.stateVersion ?? 1,
        dbInfo: getDbInfo(),
      });
    }

    if (body.action === "permanent_delete") {
      if (body.confirmTrackId !== trackId) {
        return Response.json(
          {
            error: "永久删除轨道需要显式确认（confirmTrackId 与 trackId 不一致）",
            code: "CONFIRMATION_REQUIRED",
          },
          { status: 400 },
        );
      }
      const { store, deletedCounts } = permanentlyDeleteTrackInDb(trackId, day);
      return Response.json({
        ok: true,
        action: "permanent_delete",
        deletedCounts,
        store,
        stateVersion: store.stateVersion ?? 1,
        dbInfo: getDbInfo(),
      });
    }

    if (body.action === "adjust_scope") {
      const adjusted = adjustTrackScopeInDb({
        trackId,
        day,
        depth: body.depth,
        scopeNote: body.scopeNote,
        priorKnowledge: body.priorKnowledge,
        days: body.days,
        dailyMinutes: body.dailyMinutes,
        nextUnits: body.nextUnits,
        appendUnits: body.appendUnits,
        removeLessonIds: body.removeLessonIds,
      });
      return Response.json({
        ok: true,
        action: "adjust_scope",
        plan: adjusted.plan,
        addedLessonIds: adjusted.addedLessonIds,
        removedLessonIds: adjusted.removedLessonIds,
        preservedMasteredIds: adjusted.preservedMasteredIds,
        newlyScheduledBlocks: adjusted.newlyScheduledBlocks,
        removedFutureBlockIds: adjusted.removedFutureBlockIds,
        store: adjusted.store,
        stateVersion: adjusted.store.stateVersion ?? 1,
        dbInfo: getDbInfo(),
      });
    }

    return Response.json({ error: "不支持的操作类型" }, { status: 400 });
  } catch (err) {
    console.error("[api/tracks POST]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "轨道操作失败" },
      { status: 500 },
    );
  }
}
