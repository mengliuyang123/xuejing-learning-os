import { markStaleRunningTasksInterruptedInDb } from "./db";

type GlobalServerTasks = typeof globalThis & {
  __learnosServerControllers?: Map<string, AbortController>;
  __learnosBootCleaned?: boolean;
};

const g = globalThis as GlobalServerTasks;

function getControllerMap(): Map<string, AbortController> {
  if (!g.__learnosServerControllers) {
    g.__learnosServerControllers = new Map();
  }
  return g.__learnosServerControllers;
}

/**
 * Ensures stale 'running' tasks from a previous closed/crashed app instance
 * are marked 'interrupted' once per process boot.
 */
export function ensureBootTaskHygiene(): number {
  const map = getControllerMap();
  const activeIds = new Set(map.keys());
  if (!g.__learnosBootCleaned) {
    g.__learnosBootCleaned = true;
    return markStaleRunningTasksInterruptedInDb(activeIds);
  }
  return 0;
}

export function resetBootHygieneForTesting() {
  g.__learnosBootCleaned = false;
  getControllerMap().clear();
}

export function registerServerTaskController(taskId: string): AbortController {
  ensureBootTaskHygiene();
  const map = getControllerMap();
  const existing = map.get(taskId);
  if (existing) {
    try {
      existing.abort("REPLACED");
    } catch {}
  }
  const ctrl = new AbortController();
  map.set(taskId, ctrl);
  return ctrl;
}

export function unregisterServerTaskController(taskId: string) {
  getControllerMap().delete(taskId);
}

export function cancelServerTask(taskId: string): boolean {
  const map = getControllerMap();
  const ctrl = map.get(taskId);
  if (!ctrl) return false;
  try {
    ctrl.abort("USER_CANCELLED");
  } catch {}
  map.delete(taskId);
  return true;
}

export function getActiveServerTaskIds(): Set<string> {
  return new Set(getControllerMap().keys());
}
