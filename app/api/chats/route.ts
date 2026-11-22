import type { UIMessage } from "ai";
import {
  type ChatThreadKind,
  archiveChatThreadInDb,
  deleteChatThreadFromDb,
  getChatThreadFromDb,
  getChatThreadMetaFromDb,
  getChatThreadPageFromDb,
  listChatThreadsFromDb,
  restoreChatThreadInDb,
  saveChatThreadToDb,
  updateChatThreadSummaryInDb,
  upsertChatThreadMetaInDb,
} from "../../../lib/db";
import { prepareContextForLLM } from "../../../lib/context-manager";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    if (url.searchParams.get("list") === "1") {
      return Response.json({
        threads: listChatThreadsFromDb(50, { includeArchived }),
      });
    }
    const threadId = url.searchParams.get("threadId");
    if (!threadId) {
      return Response.json({
        threads: listChatThreadsFromDb(50, { includeArchived }),
      });
    }
    const limitParam = url.searchParams.get("limit");
    const beforeParam = url.searchParams.get("beforeIndex");
    const limit = limitParam ? Number(limitParam) : undefined;
    const beforeIndex = beforeParam ? Number(beforeParam) : undefined;
    const page = getChatThreadPageFromDb(threadId, {
      limit: Number.isFinite(limit) && (limit ?? 0) > 0 ? limit : undefined,
      beforeIndex: Number.isFinite(beforeIndex) ? beforeIndex : undefined,
    });
    const meta = getChatThreadMetaFromDb(threadId);
    return Response.json({
      threadId,
      messages: page.messages,
      totalCount: page.totalCount,
      hasMore: page.hasMore,
      nextBeforeIndex: page.nextBeforeIndex,
      meta,
    });
  } catch (err) {
    console.error("[api/chats GET]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "读取对话失败" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: "create" | "rename" | "compact" | "archive" | "restore";
      threadId?: string;
      title?: string;
      trackId?: string;
      lessonId?: string;
      threadKind?: ChatThreadKind;
    };

    if (body.action === "archive" && body.threadId) {
      const meta = archiveChatThreadInDb(body.threadId);
      if (!meta) {
        return Response.json({ error: "未找到对应会话" }, { status: 404 });
      }
      return Response.json({ ok: true, meta });
    }

    if (body.action === "restore" && body.threadId) {
      const meta = restoreChatThreadInDb(body.threadId);
      if (!meta) {
        return Response.json({ error: "未找到对应会话" }, { status: 404 });
      }
      return Response.json({ ok: true, meta });
    }

    if (body.action === "compact" && body.threadId) {
      const existing = getChatThreadFromDb(body.threadId);
      const meta = getChatThreadMetaFromDb(body.threadId);
      const prepared = prepareContextForLLM({
        messages: existing,
        existingSummary: meta?.summary,
        existingSummaryCount: meta?.summaryMsgCount,
        aggressive: true,
      });
      if (prepared.threadSummary) {
        updateChatThreadSummaryInDb(
          body.threadId,
          prepared.threadSummary,
          prepared.summaryCoveredCount,
        );
      }
      return Response.json({
        ok: true,
        meta: getChatThreadMetaFromDb(body.threadId),
        stats: prepared.stats,
      });
    }

    const threadId =
      body.threadId?.trim() || `chat-${crypto.randomUUID().slice(0, 8)}`;
    const meta = upsertChatThreadMetaInDb(threadId, {
      title: body.title?.trim() || undefined,
      trackId: body.trackId ?? null,
      lessonId: body.lessonId ?? null,
      threadKind: body.threadKind ?? null,
      scope: "agent",
    });
    return Response.json({ ok: true, threadId, meta });
  } catch (err) {
    console.error("[api/chats POST]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "创建对话失败" },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const { threadId, scope, messages, title, trackId, lessonId } =
      (await request.json()) as {
        threadId: string;
        scope?: string;
        messages: UIMessage[];
        title?: string;
        trackId?: string;
        lessonId?: string;
      };
    if (!threadId || !Array.isArray(messages)) {
      return Response.json({ error: "参数无效" }, { status: 400 });
    }
    saveChatThreadToDb(threadId, scope || "agent", messages, {
      title,
      trackId,
      lessonId,
    });
    return Response.json({ ok: true, meta: getChatThreadMetaFromDb(threadId) });
  } catch (err) {
    console.error("[api/chats PUT]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "保存对话失败" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const threadId = url.searchParams.get("threadId");
    if (!threadId) {
      return Response.json({ error: "缺少 threadId" }, { status: 400 });
    }
    deleteChatThreadFromDb(threadId);
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[api/chats DELETE]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "删除对话失败" },
      { status: 500 },
    );
  }
}
