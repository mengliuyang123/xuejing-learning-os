import {
  clearAuditLogsInDb,
  getDbInfo,
  getFullAgentTraceFromDb,
  listAuditFromDb,
} from "../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const runId = url.searchParams.get("runId")?.trim();

    if (runId) {
      const trace = getFullAgentTraceFromDb(runId);
      if (!trace) {
        return Response.json(
          { error: `未找到 run_id=${runId} 对应的运行轨迹` },
          { status: 404 },
        );
      }
      return Response.json({ trace, dbInfo: getDbInfo() });
    }

    const limit = Math.min(
      150,
      Math.max(5, Number(url.searchParams.get("limit") || 50)),
    );
    const status = url.searchParams.get("status") || undefined;
    const toolName = url.searchParams.get("toolName") || undefined;
    const search = url.searchParams.get("q") || undefined;

    return Response.json(listAuditFromDb(limit, { status, toolName, search }));
  } catch (err) {
    console.error("[api/audit GET]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "读取运行轨迹失败" },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  try {
    clearAuditLogsInDb();
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[api/audit DELETE]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "清理运行轨迹失败" },
      { status: 500 },
    );
  }
}
