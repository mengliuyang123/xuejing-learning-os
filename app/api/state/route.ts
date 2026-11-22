import {
  PrerequisiteCycleError,
  SchemaVersionError,
  StateVersionConflictError,
  clearAllDataInDb,
  createPreResetSnapshotInDb,
  exportFullBackupFromDb,
  getDbInfo,
  loadStoreFromDb,
  saveStoreToDb,
} from "../../../lib/db";
import { type Store, today } from "../../../lib/learning";

export const dynamic = "force-dynamic";

function mapDbError(err: unknown, fallback: string) {
  if (err instanceof SchemaVersionError) {
    return Response.json(
      {
        error: err.message,
        code: err.code,
        foundVersion: err.foundVersion,
        supportedVersion: err.supportedVersion,
      },
      { status: 409 },
    );
  }
  if (err instanceof StateVersionConflictError) {
    return Response.json(
      {
        error: err.message,
        code: err.code,
        expectedVersion: err.expectedVersion,
        currentVersion: err.currentVersion,
      },
      { status: 409 },
    );
  }
  if (err instanceof PrerequisiteCycleError) {
    return Response.json(
      {
        error: err.message,
        code: err.code,
        trackId: err.trackId,
      },
      { status: 400 },
    );
  }
  return Response.json(
    { error: err instanceof Error ? err.message : fallback },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const day = url.searchParams.get("day") || today();
    if (url.searchParams.get("export") === "full") {
      const backup = exportFullBackupFromDb(day);
      return Response.json(backup);
    }
    const store = loadStoreFromDb(day);
    const dbInfo = getDbInfo();
    return Response.json({
      store,
      dbInfo,
      stateVersion: store.stateVersion ?? 0,
    });
  } catch (err) {
    console.error("[api/state GET]", err);
    return mapDbError(err, "读取 SQLite 状态失败");
  }
}

export async function PUT(request: Request) {
  try {
    const { store, trigger, summary, expectedVersion } =
      (await request.json()) as {
        store: Store;
        trigger?: string;
        summary?: string;
        expectedVersion?: number;
      };
    if (!store || typeof store !== "object") {
      return Response.json({ error: "无效的状态数据" }, { status: 400 });
    }
    const { revisionRecorded, stateVersion, revisionSeq } = saveStoreToDb(
      store,
      { trigger, summary, expectedVersion },
    );
    return Response.json({
      ok: true,
      revisionRecorded,
      stateVersion,
      revisionSeq,
      dbInfo: getDbInfo(),
    });
  } catch (err) {
    console.error("[api/state PUT]", err);
    return mapDbError(err, "写入 SQLite 状态失败");
  }
}

export async function DELETE() {
  try {
    let backupPath: string | null = null;
    try {
      backupPath = createPreResetSnapshotInDb();
    } catch (snapErr) {
      console.warn("[api/state DELETE] snapshot skipped:", snapErr);
    }
    clearAllDataInDb();
    return Response.json({ ok: true, backupPath, dbInfo: getDbInfo() });
  } catch (err) {
    console.error("[api/state DELETE]", err);
    return mapDbError(err, "清空 SQLite 数据失败");
  }
}
