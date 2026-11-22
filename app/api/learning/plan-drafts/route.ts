import { getDbInfo } from "../../../../lib/db";
import {
  LearningEngineError,
  applyPlanDraft,
  dismissPlanDraft,
  listPendingPlanDrafts,
} from "../../../../lib/learning-engine";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const lessonId = url.searchParams.get("lessonId") || undefined;
    return Response.json({
      drafts: listPendingPlanDrafts(lessonId),
      dbInfo: getDbInfo(),
    });
  } catch (err) {
    console.error("[api/learning/plan-drafts GET]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "获取排期草案失败" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      draftId: string;
      action: "apply" | "dismiss";
      day?: string;
    };
    if (!body?.draftId || !body?.action) {
      return Response.json({ error: "缺少 draftId 或 action" }, { status: 400 });
    }
    if (body.action === "apply") {
      const res = applyPlanDraft(body.draftId, body.day);
      return Response.json({ ...res, dbInfo: getDbInfo() });
    }
    const res = dismissPlanDraft(body.draftId);
    return Response.json({ ...res, dbInfo: getDbInfo() });
  } catch (err) {
    if (err instanceof LearningEngineError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error("[api/learning/plan-drafts POST]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "处理排期草案失败" },
      { status: 500 },
    );
  }
}
