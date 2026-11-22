import {
  getChatThreadFromDb,
  getLatestLlmTaskForThreadFromDb,
  getLlmTaskFromDb,
  listLlmTasksFromDb,
  markRunningAgentRunsCancelledForThreadInDb,
  upsertLlmTaskInDb,
  type LLMTaskRecord,
} from "../../../lib/db";
import {
  cancelServerTask,
  ensureBootTaskHygiene,
  getActiveServerTaskIds,
} from "../../../lib/server-task-registry";

export async function GET(request: Request) {
  const interruptedCount = ensureBootTaskHygiene();
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get("taskId");
  const threadId = searchParams.get("threadId");

  if (taskId) {
    const task = getLlmTaskFromDb(taskId);
    return Response.json({
      task,
      interruptedCount,
      activeServerTaskIds: Array.from(getActiveServerTaskIds()),
    });
  }

  if (threadId) {
    const latestTask = getLatestLlmTaskForThreadFromDb(threadId);
    const messages = getChatThreadFromDb(threadId);
    const tasks = listLlmTasksFromDb(threadId, 10);
    return Response.json({
      threadId,
      latestTask,
      tasks,
      messages,
      interruptedCount,
      activeServerTaskIds: Array.from(getActiveServerTaskIds()),
    });
  }

  const tasks = listLlmTasksFromDb(undefined, 25);
  return Response.json({
    tasks,
    interruptedCount,
    activeServerTaskIds: Array.from(getActiveServerTaskIds()),
  });
}

export async function POST(request: Request) {
  try {
    ensureBootTaskHygiene();
    const body = (await request.json()) as {
      task?: LLMTaskRecord;
      syncChatThread?: boolean;
    };
    if (!body.task || !body.task.taskId || !body.task.threadId) {
      return Response.json({ error: "缺少有效 task 参数" }, { status: 400 });
    }
    upsertLlmTaskInDb(body.task, body.syncChatThread !== false);
    return Response.json({ ok: true, taskId: body.task.taskId });
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : "保存任务状态失败",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  ensureBootTaskHygiene();
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get("taskId");
  if (!taskId) {
    return Response.json({ error: "缺少 taskId" }, { status: 400 });
  }

  const abortedOnServer = cancelServerTask(taskId);
  const existing = getLlmTaskFromDb(taskId);
  if (existing && existing.status === "running") {
    const nowIso = new Date().toISOString();
    upsertLlmTaskInDb(
      {
        ...existing,
        status: "cancelled",
        errorMessage: "用户手动取消生成",
        updatedAt: nowIso,
        completedAt: nowIso,
      },
      true,
    );
    markRunningAgentRunsCancelledForThreadInDb(existing.threadId);
  }

  return Response.json({
    ok: true,
    taskId,
    abortedOnServer,
  });
}
