import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UIMessage } from "ai";
import {
  type AgentRunRecord,
  type AssessmentAttempt,
  type Block,
  type DbInfo,
  type GoalPlan,
  type MasteryMeta,
  type Memory,
  type PlanDiff,
  type PlanRevision,
  type SessionExecutionLog,
  type Store,
  DEFAULT_SCHEDULE_SETTINGS,
  buildDecisionTrace,
  emptyStore,
  hasPrerequisiteCycle,
} from "./learning";
import type {
  AgentStateChangeTrace,
  AgentToolCallTrace,
  AgentTraceEvent,
  AgentTraceRun,
  FullAgentTrace,
} from "./trace-types";
import type { DomainEventRecord } from "./domain-activities";
import { safeTraceJson } from "./trace-sanitizer";
import {
  type TrackScopeAdjustmentInput,
  type TrackScopeAdjustmentResult,
  reconcileTrackUnitsAndSchedule,
} from "./curriculum-planner";

export const CURRENT_DB_SCHEMA_VERSION = 1;

export class SchemaVersionError extends Error {
  readonly code = "SCHEMA_VERSION_UNSUPPORTED";
  readonly foundVersion: number;
  readonly supportedVersion: number;

  constructor(foundVersion: number, supportedVersion: number) {
    super(
      `数据库 Schema 版本 (v${foundVersion}) 高于当前应用支持的版本 (v${supportedVersion})，为防止数据损坏已阻止读写，请升级应用后重试。`,
    );
    this.name = "SchemaVersionError";
    this.foundVersion = foundVersion;
    this.supportedVersion = supportedVersion;
  }
}

export class StateVersionConflictError extends Error {
  readonly code = "STATE_VERSION_CONFLICT";
  readonly expectedVersion: number;
  readonly currentVersion: number;

  constructor(expectedVersion: number, currentVersion: number) {
    super(
      `状态已被其他写入更新（期望版本 v${expectedVersion}，当前版本 v${currentVersion}），已阻止静默覆盖，请刷新后重试。`,
    );
    this.name = "StateVersionConflictError";
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

export class PrerequisiteCycleError extends Error {
  readonly code = "CYCLIC_PREREQUISITE_DETECTED";
  readonly trackId: string;

  constructor(trackId: string, title: string) {
    super(`课程轨道「${title}」存在循环先修依赖，已拒绝保存。`);
    this.name = "PrerequisiteCycleError";
    this.trackId = trackId;
  }
}

const globalForDb = globalThis as unknown as {
  __learnosDb?: DatabaseSync;
  __learnosDbPath?: string;
};

export function resolveDbPath(): string {
  if (process.env.LEARNOS_DB_PATH) return process.env.LEARNOS_DB_PATH;
  return join(process.cwd(), "data", "learnos.sqlite");
}

function initSchema(db: DatabaseSync) {
  const versionRow = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  const existingVersion = Number(versionRow?.user_version ?? 0);
  if (existingVersion > CURRENT_DB_SCHEMA_VERSION) {
    throw new SchemaVersionError(existingVersion, CURRENT_DB_SCHEMA_VERSION);
  }

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS workspace_state (
      id TEXT PRIMARY KEY,
      active_track_id TEXT,
      pace_factor REAL NOT NULL DEFAULT 1.0,
      sleep_start INTEGER NOT NULL DEFAULT 1380,
      sleep_end INTEGER NOT NULL DEFAULT 420,
      decision_summary TEXT NOT NULL DEFAULT '',
      decision_trace_json TEXT,
      state_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goal_plans (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      goal TEXT NOT NULL,
      title TEXT NOT NULL,
      days INTEGER NOT NULL,
      daily INTEGER NOT NULL,
      start_min INTEGER NOT NULL,
      units_json TEXT NOT NULL,
      slots_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      depth TEXT,
      scope_note TEXT,
      prior_knowledge TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mastery_states (
      lesson_id TEXT PRIMARY KEY,
      score INTEGER NOT NULL DEFAULT 0,
      meta_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS calendar_blocks (
      id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      start_min INTEGER NOT NULL,
      minutes INTEGER NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      lesson_id TEXT,
      done INTEGER NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 0,
      split_group TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      category TEXT NOT NULL,
      text TEXT NOT NULL,
      constraint_json TEXT,
      source TEXT NOT NULL DEFAULT 'user',
      confidence REAL NOT NULL DEFAULT 1.0,
      expires_at TEXT,
      created_at TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assessment_attempts (
      id TEXT PRIMARY KEY,
      lesson_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      correct INTEGER NOT NULL,
      duration_seconds INTEGER,
      attempted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_execution_logs (
      id TEXT PRIMARY KEY,
      lesson_id TEXT NOT NULL,
      lesson_title TEXT NOT NULL,
      planned_minutes INTEGER NOT NULL,
      actual_minutes INTEGER NOT NULL,
      interruptions INTEGER NOT NULL DEFAULT 0,
      energy TEXT,
      completed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_threads (
      thread_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      title TEXT,
      track_id TEXT,
      lesson_id TEXT,
      summary TEXT,
      summary_msg_count INTEGER NOT NULL DEFAULT 0,
      thread_kind TEXT,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      route TEXT NOT NULL,
      model_label TEXT NOT NULL,
      user_prompt TEXT NOT NULL,
      reasoning_chars INTEGER NOT NULL DEFAULT 0,
      step_count INTEGER NOT NULL DEFAULT 1,
      tool_calls_json TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      conversation_id TEXT NOT NULL DEFAULT 'agent-main',
      user_id TEXT NOT NULL DEFAULT 'local-desktop-user',
      provider TEXT NOT NULL DEFAULT 'unknown',
      model TEXT NOT NULL DEFAULT 'unknown',
      started_at TEXT,
      completed_at TEXT,
      final_response TEXT,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      trace_write_errors INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS agent_trace_events (
      step_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      parent_span_id TEXT,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_tool_calls (
      tool_call_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      execution_status TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      duration_ms INTEGER,
      PRIMARY KEY (run_id, tool_call_id)
    );

    CREATE TABLE IF NOT EXISTS agent_state_changes (
      change_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      tool_call_id TEXT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_state_json TEXT,
      after_state_json TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_revisions (
      id TEXT PRIMARY KEY,
      version_seq INTEGER NOT NULL DEFAULT 1,
      parent_revision_id TEXT,
      trigger TEXT NOT NULL,
      summary TEXT NOT NULL,
      before_count INTEGER NOT NULL,
      after_count INTEGER NOT NULL,
      diff_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_tasks (
      task_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      user_prompt TEXT NOT NULL,
      model_label TEXT NOT NULL,
      request_payload_json TEXT NOT NULL,
      base_messages_json TEXT NOT NULL,
      assistant_message_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS domain_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      run_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_sessions (
      learning_session_id TEXT PRIMARY KEY,
      lesson_id TEXT NOT NULL,
      track_id TEXT,
      content_version TEXT NOT NULL DEFAULT 'v1',
      current_mode TEXT NOT NULL DEFAULT 'learn',
      active_exercise_id TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      completion_status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS exercises (
      exercise_id TEXT PRIMARY KEY,
      lesson_id TEXT NOT NULL,
      learning_session_id TEXT,
      mode TEXT NOT NULL,
      prompt TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'curriculum',
      dedupe_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS exercise_attempts (
      attempt_id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE NOT NULL,
      exercise_id TEXT NOT NULL,
      learning_session_id TEXT NOT NULL,
      lesson_id TEXT NOT NULL,
      submitted_answer_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'graded',
      score INTEGER NOT NULL DEFAULT 0,
      correct INTEGER NOT NULL DEFAULT 0,
      error_type TEXT NOT NULL DEFAULT 'none',
      correct_answer_json TEXT,
      feedback TEXT NOT NULL DEFAULT '',
      position_matches_json TEXT,
      grader_version TEXT NOT NULL DEFAULT 'deterministic-v1',
      created_at TEXT NOT NULL,
      graded_at TEXT
    );

    CREATE TABLE IF NOT EXISTS plan_drafts (
      draft_id TEXT PRIMARY KEY,
      source_attempt_id TEXT UNIQUE NOT NULL,
      lesson_id TEXT NOT NULL,
      trigger_reason TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      candidate_activity_json TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      impact_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS research_cache (
      cache_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      domain TEXT NOT NULL,
      mode TEXT NOT NULL,
      query_or_topic TEXT NOT NULL,
      learner_level TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      sources_json TEXT NOT NULL,
      unverified_claims_json TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lesson_preparations (
      lesson_id TEXT PRIMARY KEY,
      track_id TEXT,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      learner_level TEXT NOT NULL,
      brief_json TEXT,
      tutorial_json TEXT,
      sources_json TEXT,
      quality_report_json TEXT,
      error_message TEXT,
      updated_at TEXT NOT NULL
    );

    -- V1.0 Agent-Native Architecture Tables (additive, 100% backwards-compatible)
    CREATE TABLE IF NOT EXISTS agent_workflows (
      workflow_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      goal_id TEXT,
      track_id TEXT,
      lesson_id TEXT,
      input_json TEXT NOT NULL,
      context_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_tasks (
      task_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workflow_id TEXT,
      parent_task_id TEXT,
      kind TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      goal_id TEXT,
      track_id TEXT,
      lesson_id TEXT,
      learning_session_id TEXT,
      idempotency_key TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      tool_result_tokens INTEGER NOT NULL DEFAULT 0,
      context_build_ms INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS research_packages (
      package_id TEXT PRIMARY KEY,
      cache_key TEXT NOT NULL,
      goal TEXT NOT NULL,
      topic TEXT NOT NULL,
      learner_level TEXT NOT NULL,
      purpose TEXT NOT NULL,
      strategy_version TEXT NOT NULL DEFAULT 'v1',
      effective_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      package_json TEXT NOT NULL,
      coverage_json TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS curriculum_blueprints (
      blueprint_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      track_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      research_package_id TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      blueprint_json TEXT NOT NULL,
      validation_report_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS teaching_decisions (
      decision_id TEXT PRIMARY KEY,
      workflow_id TEXT,
      task_id TEXT,
      run_id TEXT,
      goal_id TEXT,
      track_id TEXT,
      lesson_id TEXT NOT NULL,
      learning_session_id TEXT NOT NULL,
      action TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      rationale TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS teaching_activities (
      activity_id TEXT PRIMARY KEY,
      lesson_id TEXT NOT NULL,
      learning_session_id TEXT,
      decision_id TEXT,
      activity_type TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      grading_mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      spec_json TEXT NOT NULL,
      linked_exercise_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lesson_content_versions (
      content_id TEXT PRIMARY KEY,
      lesson_id TEXT NOT NULL,
      track_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      depth TEXT NOT NULL DEFAULT 'standard',
      status TEXT NOT NULL DEFAULT 'ready',
      research_package_id TEXT,
      blueprint_id TEXT,
      content_json TEXT NOT NULL,
      quality_report_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visual_explainer_cache (
      cache_key TEXT PRIMARY KEY,
      visual_id TEXT NOT NULL,
      lesson_id TEXT NOT NULL,
      contract_version INTEGER NOT NULL DEFAULT 1,
      concept_id TEXT NOT NULL,
      visual_type TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_visual_cache_lesson ON visual_explainer_cache(lesson_id, contract_version);

    CREATE INDEX IF NOT EXISTS idx_blocks_day ON calendar_blocks(day);
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_runs_created ON agent_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trace_events_run ON agent_trace_events(run_id, seq ASC);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON agent_tool_calls(run_id, requested_at ASC);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON agent_tool_calls(tool_name);
    CREATE INDEX IF NOT EXISTS idx_state_changes_run ON agent_state_changes(run_id, timestamp ASC);
    CREATE INDEX IF NOT EXISTS idx_revisions_created ON plan_revisions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_tasks_thread ON llm_tasks(thread_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_domain_events_created ON domain_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_sessions_lesson ON learning_sessions(lesson_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_exercises_lesson ON exercises(lesson_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_exercises_dedupe ON exercises(dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_attempts_exercise ON exercise_attempts(exercise_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_plan_drafts_status ON plan_drafts(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_research_cache_kind ON research_cache(kind, expires_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lesson_prep_track ON lesson_preparations(track_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflows_state ON agent_workflows(state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_workflow ON agent_tasks(workflow_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_idemp ON agent_tasks(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_research_pkg_cache ON research_packages(cache_key, expires_at DESC);
    CREATE INDEX IF NOT EXISTS idx_blueprints_track ON curriculum_blueprints(track_id, version DESC);
    CREATE INDEX IF NOT EXISTS idx_teaching_decisions_lesson ON teaching_decisions(lesson_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_teaching_activities_lesson ON teaching_activities(lesson_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lesson_content_ver ON lesson_content_versions(lesson_id, version DESC);
  `);

  // Safe idempotent column migration for existing SQLite databases created before Agent Execution Trace v2
  const migrations = [
    "ALTER TABLE agent_runs ADD COLUMN conversation_id TEXT NOT NULL DEFAULT 'agent-main'",
    "ALTER TABLE agent_runs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local-desktop-user'",
    "ALTER TABLE agent_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'unknown'",
    "ALTER TABLE agent_runs ADD COLUMN model TEXT NOT NULL DEFAULT 'unknown'",
    "ALTER TABLE agent_runs ADD COLUMN started_at TEXT",
    "ALTER TABLE agent_runs ADD COLUMN completed_at TEXT",
    "ALTER TABLE agent_runs ADD COLUMN final_response TEXT",
    "ALTER TABLE agent_runs ADD COLUMN tool_call_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE agent_runs ADD COLUMN trace_write_errors INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE chat_threads ADD COLUMN title TEXT",
    "ALTER TABLE chat_threads ADD COLUMN track_id TEXT",
    "ALTER TABLE chat_threads ADD COLUMN lesson_id TEXT",
    "ALTER TABLE chat_threads ADD COLUMN summary TEXT",
    "ALTER TABLE chat_threads ADD COLUMN summary_msg_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE workspace_state ADD COLUMN state_version INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE goal_plans ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE goal_plans ADD COLUMN archived_at TEXT",
    "ALTER TABLE goal_plans ADD COLUMN depth TEXT",
    "ALTER TABLE goal_plans ADD COLUMN scope_note TEXT",
    "ALTER TABLE goal_plans ADD COLUMN prior_knowledge TEXT",
    "ALTER TABLE plan_revisions ADD COLUMN version_seq INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE plan_revisions ADD COLUMN parent_revision_id TEXT",
    "ALTER TABLE chat_threads ADD COLUMN thread_kind TEXT",
    "ALTER TABLE chat_threads ADD COLUMN archived_at TEXT",
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists
    }
  }

  // Migrate legacy agent_tool_calls (single PK tool_call_id) -> composite PK (run_id, tool_call_id)
  // so two distinct runs reusing the same model tool_call_id never overwrite each other.
  try {
    const cols = db
      .prepare("PRAGMA table_info(agent_tool_calls)")
      .all() as Array<{ name: string; pk: number }>;
    const runCol = cols.find((c) => c.name === "run_id");
    if (runCol && runCol.pk === 0) {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE agent_tool_calls_v2 (
          tool_call_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          arguments_json TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          execution_status TEXT NOT NULL,
          result_json TEXT,
          error TEXT,
          duration_ms INTEGER,
          PRIMARY KEY (run_id, tool_call_id)
        );
        INSERT OR IGNORE INTO agent_tool_calls_v2
          (tool_call_id, run_id, step_id, tool_name, arguments_json, requested_at, started_at, completed_at, execution_status, result_json, error, duration_ms)
        SELECT tool_call_id, run_id, step_id, tool_name, arguments_json, requested_at, started_at, completed_at, execution_status, result_json, error, duration_ms
        FROM agent_tool_calls;
        DROP TABLE agent_tool_calls;
        ALTER TABLE agent_tool_calls_v2 RENAME TO agent_tool_calls;
        CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON agent_tool_calls(run_id, requested_at ASC);
        CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON agent_tool_calls(tool_name);
        COMMIT;
      `);
    }
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    console.warn("[db] agent_tool_calls composite PK migration skipped:", err);
  }
  db.exec(`PRAGMA user_version = ${CURRENT_DB_SCHEMA_VERSION}`);
}

export function getDb(): DatabaseSync {
  const dbPath = resolveDbPath();
  if (globalForDb.__learnosDb && globalForDb.__learnosDbPath === dbPath) {
    return globalForDb.__learnosDb;
  }
  if (dbPath !== ":memory:") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  try {
    initSchema(db);
  } catch (err) {
    try {
      db.close();
    } catch {}
    throw err;
  }
  globalForDb.__learnosDb = db;
  globalForDb.__learnosDbPath = dbPath;
  return db;
}

export function closeDbForTesting() {
  if (globalForDb.__learnosDb) {
    try {
      globalForDb.__learnosDb.close();
    } catch {}
    globalForDb.__learnosDb = undefined;
    globalForDb.__learnosDbPath = undefined;
  }
}

export function computeBlockDiff(before: Block[], after: Block[]): PlanDiff {
  const beforeMap = new Map(before.map((b) => [b.id, b]));
  const afterMap = new Map(after.map((b) => [b.id, b]));

  const added: PlanDiff["added"] = [];
  const removed: PlanDiff["removed"] = [];
  const moved: PlanDiff["moved"] = [];

  for (const b of after) {
    const prev = beforeMap.get(b.id);
    if (!prev) {
      added.push({
        title: b.title,
        day: b.day,
        start: b.start,
        minutes: b.minutes,
        kind: b.kind,
      });
    } else if (
      prev.day !== b.day ||
      prev.start !== b.start ||
      prev.minutes !== b.minutes
    ) {
      moved.push({
        blockId: b.id,
        title: b.title,
        oldDay: prev.day,
        oldStart: prev.start,
        oldMinutes: prev.minutes,
        newDay: b.day,
        newStart: b.start,
        newMinutes: b.minutes,
      });
    }
  }

  for (const b of before) {
    if (!afterMap.has(b.id)) {
      removed.push({
        title: b.title,
        day: b.day,
        start: b.start,
        minutes: b.minutes,
        kind: b.kind,
      });
    }
  }

  return { added, removed, moved };
}

export function loadStoreFromDb(day: string): Store {
  const db = getDb();
  const ws = db
    .prepare("SELECT * FROM workspace_state WHERE id = 'default'")
    .get() as Record<string, unknown> | undefined;

  if (!ws) {
    return emptyStore(day);
  }

  const planRows = db
    .prepare("SELECT * FROM goal_plans ORDER BY sort_order ASC")
    .all() as Array<Record<string, unknown>>;
  const goalPlans: GoalPlan[] = planRows.map((r) => ({
    id: String(r.id),
    version: String(r.version),
    goal: String(r.goal),
    title: String(r.title),
    days: Number(r.days),
    daily: Number(r.daily),
    start: Number(r.start_min),
    units: JSON.parse(String(r.units_json)),
    slots: JSON.parse(String(r.slots_json)),
    depth: r.depth ? (String(r.depth) as GoalPlan["depth"]) : undefined,
    scopeNote: r.scope_note ? String(r.scope_note) : undefined,
    priorKnowledge: r.prior_knowledge
      ? (String(r.prior_knowledge) as GoalPlan["priorKnowledge"])
      : undefined,
    archived: Boolean(r.archived),
    archivedAt: r.archived_at ? String(r.archived_at) : undefined,
  }));

  const masteryRows = db
    .prepare("SELECT * FROM mastery_states")
    .all() as Array<Record<string, unknown>>;
  const mastery: Record<string, number> = {};
  const masteryMeta: Record<string, MasteryMeta> = {};
  for (const r of masteryRows) {
    const id = String(r.lesson_id);
    mastery[id] = Number(r.score);
    if (r.meta_json) {
      masteryMeta[id] = JSON.parse(String(r.meta_json));
    }
  }

  const blockRows = db
    .prepare("SELECT * FROM calendar_blocks ORDER BY day ASC, start_min ASC")
    .all() as Array<Record<string, unknown>>;
  const blocks: Block[] = blockRows.map((r) => ({
    id: String(r.id),
    day: String(r.day),
    start: Number(r.start_min),
    minutes: Number(r.minutes),
    title: String(r.title),
    kind: String(r.kind) as Block["kind"],
    lesson: r.lesson_id ? String(r.lesson_id) : undefined,
    done: Boolean(r.done),
    locked: Boolean(r.locked),
    splitGroup: r.split_group ? String(r.split_group) : undefined,
  }));

  const memRows = db
    .prepare("SELECT * FROM memories ORDER BY sort_order ASC")
    .all() as Array<Record<string, unknown>>;
  const memories: Memory[] = memRows.map((r) => ({
    id: String(r.id),
    label: String(r.label),
    category: String(r.category) as Memory["category"],
    text: String(r.text),
    constraint: r.constraint_json
      ? JSON.parse(String(r.constraint_json))
      : undefined,
    source: (r.source ? String(r.source) : "user") as Memory["source"],
    confidence: r.confidence !== null ? Number(r.confidence) : 1.0,
    expiresAt: r.expires_at ? String(r.expires_at) : undefined,
    createdAt: r.created_at ? String(r.created_at) : undefined,
  }));

  const attemptRows = db
    .prepare(
      "SELECT * FROM assessment_attempts ORDER BY attempted_at DESC LIMIT 100",
    )
    .all() as Array<Record<string, unknown>>;
  const attempts: AssessmentAttempt[] = attemptRows.map((r) => ({
    id: String(r.id),
    lessonId: String(r.lesson_id),
    kind: String(r.kind) as AssessmentAttempt["kind"],
    correct: Boolean(r.correct),
    durationSeconds:
      r.duration_seconds !== null ? Number(r.duration_seconds) : undefined,
    attemptedAt: String(r.attempted_at),
  }));

  const execRows = db
    .prepare(
      "SELECT * FROM session_execution_logs ORDER BY completed_at DESC LIMIT 50",
    )
    .all() as Array<Record<string, unknown>>;
  const executionLogs: SessionExecutionLog[] = execRows.map((r) => ({
    id: String(r.id),
    lessonId: String(r.lesson_id),
    lessonTitle: String(r.lesson_title),
    plannedMinutes: Number(r.planned_minutes),
    actualMinutes: Number(r.actual_minutes),
    interruptions: Number(r.interruptions),
    energy: (r.energy ? String(r.energy) : undefined) as SessionExecutionLog["energy"],
    completedAt: String(r.completed_at),
  }));

  const store: Store = {
    stateVersion: Number(ws.state_version ?? 1),
    activeTrackId: ws.active_track_id ? String(ws.active_track_id) : undefined,
    goalPlans,
    mastery,
    masteryMeta,
    blocks,
    memories,
    scheduleSettings: {
      sleepStart: Number(ws.sleep_start ?? DEFAULT_SCHEDULE_SETTINGS.sleepStart),
      sleepEnd: Number(ws.sleep_end ?? DEFAULT_SCHEDULE_SETTINGS.sleepEnd),
    },
    attempts,
    executionLogs,
    paceFactor: Number(ws.pace_factor ?? 1.0),
    decision: String(ws.decision_summary || ""),
    decisionTrace: ws.decision_trace_json
      ? JSON.parse(String(ws.decision_trace_json))
      : undefined,
  };

  if (!store.decisionTrace) {
    store.decisionTrace = buildDecisionTrace(store, day);
  }
  return store;
}

function bumpGoalPlanVersion(plan: GoalPlan, revSeq: number): string {
  const base = plan.version.replace(/-v\d+$/, "");
  return `${base}-v${revSeq}`;
}

export function saveStoreToDb(
  store: Store,
  opts: { trigger?: string; summary?: string; expectedVersion?: number } = {},
): { revisionRecorded: boolean; stateVersion: number; revisionSeq?: number } {
  for (const plan of store.goalPlans || []) {
    if (Array.isArray(plan.units) && hasPrerequisiteCycle(plan.units)) {
      throw new PrerequisiteCycleError(plan.id, plan.title);
    }
  }

  const db = getDb();
  const nowIso = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    const wsRow = db
      .prepare("SELECT state_version FROM workspace_state WHERE id = 'default'")
      .get() as { state_version?: number } | undefined;
    const currentVersion = wsRow ? Number(wsRow.state_version ?? 1) : 0;
    const expectedVersion =
      opts.expectedVersion !== undefined
        ? opts.expectedVersion
        : store.stateVersion;
    if (
      expectedVersion !== undefined &&
      expectedVersion !== currentVersion
    ) {
      throw new StateVersionConflictError(expectedVersion, currentVersion);
    }
    const nextStateVersion = currentVersion + 1;

    // Read previous blocks inside the write transaction to compute structured Plan Change Diff
    const prevRows = db
      .prepare("SELECT * FROM calendar_blocks")
      .all() as Array<Record<string, unknown>>;
    const prevBlocks: Block[] = prevRows.map((r) => ({
      id: String(r.id),
      day: String(r.day),
      start: Number(r.start_min),
      minutes: Number(r.minutes),
      title: String(r.title),
      kind: String(r.kind) as Block["kind"],
      lesson: r.lesson_id ? String(r.lesson_id) : undefined,
      done: Boolean(r.done),
      locked: Boolean(r.locked),
      splitGroup: r.split_group ? String(r.split_group) : undefined,
    }));

    const diff = computeBlockDiff(prevBlocks, store.blocks);
    const hasBlockChange =
      diff.added.length > 0 || diff.removed.length > 0 || diff.moved.length > 0;

    let nextRevSeq: number | undefined;
    let parentRevisionId: string | null = null;
    if (hasBlockChange) {
      const lastRev = db
        .prepare(
          "SELECT id, version_seq FROM plan_revisions ORDER BY version_seq DESC, created_at DESC LIMIT 1",
        )
        .get() as { id?: string; version_seq?: number } | undefined;
      nextRevSeq = Number(lastRev?.version_seq ?? 0) + 1;
      parentRevisionId = lastRev?.id ? String(lastRev.id) : null;
    }

    const sleep = store.scheduleSettings || DEFAULT_SCHEDULE_SETTINGS;
    db.prepare(
      `INSERT INTO workspace_state
        (id, active_track_id, pace_factor, sleep_start, sleep_end, decision_summary, decision_trace_json, state_version, updated_at)
       VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        active_track_id = excluded.active_track_id,
        pace_factor = excluded.pace_factor,
        sleep_start = excluded.sleep_start,
        sleep_end = excluded.sleep_end,
        decision_summary = excluded.decision_summary,
        decision_trace_json = excluded.decision_trace_json,
        state_version = excluded.state_version,
        updated_at = excluded.updated_at`,
    ).run(
      store.activeTrackId ?? null,
      store.paceFactor ?? 1.0,
      sleep.sleepStart,
      sleep.sleepEnd,
      store.decision || "",
      store.decisionTrace ? JSON.stringify(store.decisionTrace) : null,
      nextStateVersion,
      nowIso,
    );

    const changedLessonIds = new Set<string>();
    if (hasBlockChange) {
      const prevMap = new Map(prevBlocks.map((b) => [b.id, b]));
      const nextMap = new Map(store.blocks.map((b) => [b.id, b]));
      for (const b of store.blocks) {
        const prev = prevMap.get(b.id);
        if (
          b.lesson &&
          (!prev ||
            prev.day !== b.day ||
            prev.start !== b.start ||
            prev.minutes !== b.minutes)
        ) {
          changedLessonIds.add(b.lesson);
        }
      }
      for (const b of prevBlocks) {
        if (b.lesson && !nextMap.has(b.id)) {
          changedLessonIds.add(b.lesson);
        }
      }
    }

    db.exec("DELETE FROM goal_plans");
    const insPlan = db.prepare(
      `INSERT INTO goal_plans
        (id, version, goal, title, days, daily, start_min, units_json, slots_json, sort_order, depth, scope_note, prior_knowledge, archived, archived_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    (store.goalPlans || []).forEach((p, idx) => {
      const touchesPlan =
        hasBlockChange &&
        nextRevSeq !== undefined &&
        (p.units.some((u) => changedLessonIds.has(u.id)) ||
          (changedLessonIds.size === 0 && p.id === store.activeTrackId));
      const persistedVersion =
        touchesPlan && nextRevSeq !== undefined
          ? bumpGoalPlanVersion(p, nextRevSeq)
          : p.version;
      insPlan.run(
        p.id,
        persistedVersion,
        p.goal,
        p.title,
        p.days,
        p.daily,
        p.start,
        JSON.stringify(p.units),
        JSON.stringify(p.slots),
        idx,
        p.depth ?? null,
        p.scopeNote ?? null,
        p.priorKnowledge ?? null,
        p.archived ? 1 : 0,
        p.archivedAt ?? null,
        nowIso,
      );
    });

    db.exec("DELETE FROM mastery_states");
    const insMastery = db.prepare(
      `INSERT INTO mastery_states (lesson_id, score, meta_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    );
    const lessonIds = new Set([
      ...Object.keys(store.mastery || {}),
      ...Object.keys(store.masteryMeta || {}),
    ]);
    for (const lid of lessonIds) {
      insMastery.run(
        lid,
        store.mastery[lid] ?? 0,
        store.masteryMeta?.[lid]
          ? JSON.stringify(store.masteryMeta[lid])
          : null,
        nowIso,
      );
    }

    db.exec("DELETE FROM calendar_blocks");
    const insBlock = db.prepare(
      `INSERT INTO calendar_blocks
        (id, day, start_min, minutes, title, kind, lesson_id, done, locked, split_group, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of store.blocks) {
      insBlock.run(
        b.id,
        b.day,
        b.start,
        b.minutes,
        b.title,
        b.kind,
        b.lesson ?? null,
        b.done ? 1 : 0,
        b.locked ? 1 : 0,
        b.splitGroup ?? null,
        nowIso,
      );
    }

    db.exec("DELETE FROM memories");
    const insMem = db.prepare(
      `INSERT INTO memories
        (id, label, category, text, constraint_json, source, confidence, expires_at, created_at, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    store.memories.forEach((m, idx) => {
      insMem.run(
        m.id,
        m.label,
        m.category || "preference",
        m.text,
        m.constraint ? JSON.stringify(m.constraint) : null,
        m.source || "user",
        m.confidence ?? 1.0,
        m.expiresAt ?? null,
        m.createdAt ?? null,
        idx,
        nowIso,
      );
    });

    db.exec("DELETE FROM assessment_attempts");
    const insAttempt = db.prepare(
      `INSERT INTO assessment_attempts
        (id, lesson_id, kind, correct, duration_seconds, attempted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const a of (store.attempts || []).slice(0, 100)) {
      insAttempt.run(
        a.id,
        a.lessonId,
        a.kind,
        a.correct ? 1 : 0,
        a.durationSeconds ?? null,
        a.attemptedAt,
      );
    }

    db.exec("DELETE FROM session_execution_logs");
    const insExec = db.prepare(
      `INSERT INTO session_execution_logs
        (id, lesson_id, lesson_title, planned_minutes, actual_minutes, interruptions, energy, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of (store.executionLogs || []).slice(0, 50)) {
      insExec.run(
        e.id,
        e.lessonId,
        e.lessonTitle,
        e.plannedMinutes,
        e.actualMinutes,
        e.interruptions,
        e.energy ?? null,
        e.completedAt,
      );
    }

    if (hasBlockChange) {
      const trigger = opts.trigger || "日程变更";
      const parts: string[] = [];
      if (diff.added.length) parts.push(`新增 ${diff.added.length} 项`);
      if (diff.moved.length) parts.push(`调整 ${diff.moved.length} 项`);
      if (diff.removed.length) parts.push(`移除 ${diff.removed.length} 项`);
      const summary =
        opts.summary ||
        (store.decision?.trim()
          ? store.decision.slice(0, 160)
          : `日程计划变更：${parts.join("，")}`);

      const revId = "rev-" + crypto.randomUUID().slice(0, 10);
      db.prepare(
        `INSERT INTO plan_revisions
          (id, version_seq, parent_revision_id, trigger, summary, before_count, after_count, diff_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        revId,
        nextRevSeq ?? 1,
        parentRevisionId,
        trigger,
        summary,
        prevBlocks.length,
        store.blocks.length,
        JSON.stringify(diff),
        nowIso,
      );

      db.prepare(
        `INSERT INTO domain_events
          (event_id, event_type, entity_type, entity_id, summary, payload_json, run_id, created_at)
         VALUES (?, 'PlanVersionCreated', 'study_plan', ?, ?, ?, NULL, ?)`,
      ).run(
        "evt-" + crypto.randomUUID().slice(0, 10),
        revId,
        `${trigger}：${summary}`,
        safeTraceJson({
          trigger,
          versionSeq: nextRevSeq ?? 1,
          parentRevisionId,
          beforeCount: prevBlocks.length,
          afterCount: store.blocks.length,
          added: diff.added.length,
          moved: diff.moved.length,
          removed: diff.removed.length,
        }),
        nowIso,
      );
    }

    db.exec("COMMIT");
    return {
      revisionRecorded: hasBlockChange,
      stateVersion: nextStateVersion,
      revisionSeq: nextRevSeq,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function createPreResetSnapshotInDb(): string | null {
  const dbPath = resolveDbPath();
  if (dbPath === ":memory:") return null;
  const db = getDb();
  const backupDir = join(dirname(dbPath), "backups");
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = join(backupDir, `pre-reset-${stamp}.sqlite`);
  const escaped = snapshotPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  return snapshotPath;
}

export function clearAllDataInDb() {
  const db = getDb();
  db.exec(`
    BEGIN IMMEDIATE;
    DELETE FROM workspace_state;
    DELETE FROM goal_plans;
    DELETE FROM mastery_states;
    DELETE FROM calendar_blocks;
    DELETE FROM memories;
    DELETE FROM assessment_attempts;
    DELETE FROM session_execution_logs;
    DELETE FROM chat_threads;
    DELETE FROM agent_runs;
    DELETE FROM agent_trace_events;
    DELETE FROM agent_tool_calls;
    DELETE FROM agent_state_changes;
    DELETE FROM plan_revisions;
    DELETE FROM llm_tasks;
    DELETE FROM domain_events;
    DELETE FROM learning_sessions;
    DELETE FROM exercises;
    DELETE FROM exercise_attempts;
    DELETE FROM lesson_preparations;
    DELETE FROM research_cache;
    DELETE FROM agent_workflows;
    DELETE FROM agent_tasks;
    DELETE FROM research_packages;
    DELETE FROM curriculum_blueprints;
    DELETE FROM teaching_decisions;
    DELETE FROM teaching_activities;
    DELETE FROM lesson_content_versions;
    DELETE FROM plan_drafts;
    COMMIT;
  `);
}

export type ChatThreadKind = "course" | "planning" | "general";

export type ChatThreadMeta = {
  threadId: string;
  title: string;
  scope: string;
  threadKind?: ChatThreadKind;
  archivedAt?: string | null;
  trackId?: string;
  lessonId?: string;
  messageCount: number;
  hasSummary: boolean;
  summary?: string;
  summaryMsgCount: number;
  updatedAt: string;
  preview: string;
};

function deriveThreadTitleFromMessages(
  threadId: string,
  messages: UIMessage[],
): string {
  for (const m of messages) {
    if (m.role === "user") {
      const text = (m.parts || [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .replace(/^\[[^\]]+\]\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (text) return text.slice(0, 28) + (text.length > 28 ? "…" : "");
    }
  }
  if (threadId === "agent-main") return "默认学习对话";
  return "新对话";
}

function extractLastPreview(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const txt = (m.parts || [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (txt) return txt.slice(0, 64);
  }
  return "";
}

function rowToThreadMeta(r: Record<string, unknown>): ChatThreadMeta {
  let messages: UIMessage[] = [];
  try {
    const parsed = JSON.parse(String(r.messages_json || "[]"));
    if (Array.isArray(parsed)) messages = parsed;
  } catch {}
  const threadId = String(r.thread_id);
  const explicitTitle = r.title ? String(r.title).trim() : "";
  const summary = r.summary ? String(r.summary).trim() : "";
  return {
    threadId,
    title: explicitTitle || deriveThreadTitleFromMessages(threadId, messages),
    scope: String(r.scope || "agent"),
    threadKind: r.thread_kind
      ? (String(r.thread_kind) as ChatThreadKind)
      : undefined,
    archivedAt: r.archived_at ? String(r.archived_at) : null,
    trackId: r.track_id ? String(r.track_id) : undefined,
    lessonId: r.lesson_id ? String(r.lesson_id) : undefined,
    messageCount: messages.length,
    hasSummary: Boolean(summary),
    summary: summary || undefined,
    summaryMsgCount: Number(r.summary_msg_count ?? 0),
    updatedAt: String(r.updated_at || new Date().toISOString()),
    preview: extractLastPreview(messages),
  };
}

export function getChatThreadFromDb(threadId: string): UIMessage[] {
  const db = getDb();
  const row = db
    .prepare("SELECT messages_json FROM chat_threads WHERE thread_id = ?")
    .get(threadId) as { messages_json?: string } | undefined;
  if (!row?.messages_json) return [];
  try {
    const parsed = JSON.parse(row.messages_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getChatThreadPageFromDb(
  threadId: string,
  opts?: { limit?: number; beforeIndex?: number },
): {
  messages: UIMessage[];
  totalCount: number;
  hasMore: boolean;
  nextBeforeIndex: number;
} {
  const all = getChatThreadFromDb(threadId);
  const totalCount = all.length;
  if (!opts?.limit || opts.limit <= 0) {
    return {
      messages: all,
      totalCount,
      hasMore: false,
      nextBeforeIndex: 0,
    };
  }
  const end =
    opts.beforeIndex !== undefined && opts.beforeIndex >= 0
      ? Math.min(totalCount, opts.beforeIndex)
      : totalCount;
  const start = Math.max(0, end - opts.limit);
  return {
    messages: all.slice(start, end),
    totalCount,
    hasMore: start > 0,
    nextBeforeIndex: start,
  };
}

export function getChatThreadMetaFromDb(
  threadId: string,
): ChatThreadMeta | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM chat_threads WHERE thread_id = ?")
    .get(threadId) as Record<string, unknown> | undefined;
  return row ? rowToThreadMeta(row) : null;
}

export function listChatThreadsFromDb(
  limit = 40,
  opts: { includeArchived?: boolean } = {},
): ChatThreadMeta[] {
  const db = getDb();
  const rows = (
    opts.includeArchived
      ? db
          .prepare("SELECT * FROM chat_threads ORDER BY updated_at DESC LIMIT ?")
          .all(limit)
      : db
          .prepare(
            "SELECT * FROM chat_threads WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ?",
          )
          .all(limit)
  ) as Array<Record<string, unknown>>;
  return rows.map(rowToThreadMeta);
}

export function upsertChatThreadMetaInDb(
  threadId: string,
  meta: {
    title?: string;
    trackId?: string | null;
    lessonId?: string | null;
    scope?: string;
    threadKind?: ChatThreadKind | null;
  },
): ChatThreadMeta {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO chat_threads (thread_id, scope, messages_json, updated_at, title, track_id, lesson_id, thread_kind)
     VALUES (?, ?, '[]', ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       title = COALESCE(excluded.title, chat_threads.title),
       track_id = COALESCE(excluded.track_id, chat_threads.track_id),
       lesson_id = COALESCE(excluded.lesson_id, chat_threads.lesson_id),
       thread_kind = COALESCE(excluded.thread_kind, chat_threads.thread_kind),
       updated_at = excluded.updated_at`,
  ).run(
    threadId,
    meta.scope || "agent",
    nowIso,
    meta.title ?? null,
    meta.trackId ?? null,
    meta.lessonId ?? null,
    meta.threadKind ?? null,
  );
  return getChatThreadMetaFromDb(threadId)!;
}

export function archiveChatThreadInDb(threadId: string): ChatThreadMeta | null {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    "UPDATE chat_threads SET archived_at = ?, updated_at = ? WHERE thread_id = ?",
  ).run(nowIso, nowIso, threadId);
  return getChatThreadMetaFromDb(threadId);
}

export function restoreChatThreadInDb(threadId: string): ChatThreadMeta | null {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    "UPDATE chat_threads SET archived_at = NULL, updated_at = ? WHERE thread_id = ?",
  ).run(nowIso, threadId);
  return getChatThreadMetaFromDb(threadId);
}

export function updateChatThreadSummaryInDb(
  threadId: string,
  summary: string,
  coveredCount: number,
) {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO chat_threads (thread_id, scope, messages_json, updated_at, summary, summary_msg_count)
     VALUES (?, 'agent', '[]', ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       summary = excluded.summary,
       summary_msg_count = excluded.summary_msg_count,
       updated_at = excluded.updated_at`,
  ).run(threadId, nowIso, summary, coveredCount);
}

export function saveChatThreadToDb(
  threadId: string,
  scope: string,
  messages: UIMessage[],
  meta?: { title?: string; trackId?: string; lessonId?: string },
) {
  const db = getDb();
  const derivedTitle =
    meta?.title?.trim() ||
    (messages.length > 0
      ? deriveThreadTitleFromMessages(threadId, messages)
      : null);
  db.prepare(
    `INSERT INTO chat_threads (thread_id, scope, messages_json, updated_at, title, track_id, lesson_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       scope = excluded.scope,
       messages_json = excluded.messages_json,
       updated_at = excluded.updated_at,
       title = COALESCE(chat_threads.title, excluded.title),
       track_id = COALESCE(excluded.track_id, chat_threads.track_id),
       lesson_id = COALESCE(excluded.lesson_id, chat_threads.lesson_id)`,
  ).run(
    threadId,
    scope,
    JSON.stringify(messages),
    new Date().toISOString(),
    derivedTitle,
    meta?.trackId ?? null,
    meta?.lessonId ?? null,
  );
}

export function deleteChatThreadFromDb(threadId: string) {
  const db = getDb();
  db.prepare("DELETE FROM chat_threads WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM llm_tasks WHERE thread_id = ?").run(threadId);
}

export type LLMTaskStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export type LLMTaskRecord = {
  taskId: string;
  threadId: string;
  status: LLMTaskStatus;
  userPrompt: string;
  modelLabel: string;
  requestPayload: Record<string, unknown>;
  baseMessages: UIMessage[];
  assistantMessage: UIMessage | null;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

function rowToLlmTask(r: Record<string, unknown>): LLMTaskRecord {
  let requestPayload: Record<string, unknown> = {};
  let baseMessages: UIMessage[] = [];
  let assistantMessage: UIMessage | null = null;
  try {
    requestPayload = JSON.parse(String(r.request_payload_json || "{}"));
  } catch {}
  try {
    baseMessages = JSON.parse(String(r.base_messages_json || "[]"));
  } catch {}
  try {
    if (r.assistant_message_json) {
      assistantMessage = JSON.parse(String(r.assistant_message_json));
    }
  } catch {}

  return {
    taskId: String(r.task_id),
    threadId: String(r.thread_id),
    status: String(r.status) as LLMTaskStatus,
    userPrompt: String(r.user_prompt),
    modelLabel: String(r.model_label),
    requestPayload,
    baseMessages,
    assistantMessage,
    errorMessage: r.error_message ? String(r.error_message) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    completedAt: r.completed_at ? String(r.completed_at) : undefined,
  };
}

/**
 * Atomically upserts an LLMTaskRecord and synchronizes the thread's messages
 * in `chat_threads` so SQLite always holds the latest incremental or final state.
 */
export function upsertLlmTaskInDb(
  task: LLMTaskRecord,
  syncChatThread = true,
) {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO llm_tasks
        (task_id, thread_id, status, user_prompt, model_label, request_payload_json, base_messages_json, assistant_message_json, error_message, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
        status = excluded.status,
        model_label = excluded.model_label,
        request_payload_json = excluded.request_payload_json,
        base_messages_json = excluded.base_messages_json,
        assistant_message_json = excluded.assistant_message_json,
        error_message = excluded.error_message,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at`,
    ).run(
      task.taskId,
      task.threadId,
      task.status,
      task.userPrompt.slice(0, 500),
      task.modelLabel,
      JSON.stringify(task.requestPayload),
      JSON.stringify(task.baseMessages),
      task.assistantMessage ? JSON.stringify(task.assistantMessage) : null,
      task.errorMessage ?? null,
      task.createdAt,
      task.updatedAt || nowIso,
      task.completedAt ?? null,
    );

    if (syncChatThread) {
      const combined: UIMessage[] =
        task.assistantMessage && task.assistantMessage.parts.length > 0
          ? [...task.baseMessages, task.assistantMessage]
          : [...task.baseMessages];
      const derivedTitle = deriveThreadTitleFromMessages(
        task.threadId,
        combined,
      );
      db.prepare(
        `INSERT INTO chat_threads (thread_id, scope, messages_json, updated_at, title)
         VALUES (?, 'agent', ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           messages_json = excluded.messages_json,
           updated_at = excluded.updated_at,
           title = COALESCE(chat_threads.title, excluded.title)`,
      ).run(
        task.threadId,
        JSON.stringify(combined),
        task.updatedAt || nowIso,
        derivedTitle,
      );
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getLlmTaskFromDb(taskId: string): LLMTaskRecord | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM llm_tasks WHERE task_id = ?")
    .get(taskId) as Record<string, unknown> | undefined;
  return row ? rowToLlmTask(row) : null;
}

export function getLatestLlmTaskForThreadFromDb(
  threadId: string,
): LLMTaskRecord | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM llm_tasks WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(threadId) as Record<string, unknown> | undefined;
  return row ? rowToLlmTask(row) : null;
}

export function listLlmTasksFromDb(
  threadId?: string,
  limit = 25,
): LLMTaskRecord[] {
  const db = getDb();
  const rows = (
    threadId
      ? db
          .prepare(
            "SELECT * FROM llm_tasks WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(threadId, limit)
      : db
          .prepare("SELECT * FROM llm_tasks ORDER BY created_at DESC LIMIT ?")
          .all(limit)
  ) as Array<Record<string, unknown>>;
  return rows.map(rowToLlmTask);
}

/**
 * Requirement #12: When the app restarts after a close or crash, any task left
 * with status='running' that is not actively executing in the current process
 * MUST be marked as 'interrupted' rather than faking a 'running' state.
 */
export function markStaleRunningTasksInterruptedInDb(
  activeInProcessTaskIds: Set<string> = new Set(),
): number {
  const db = getDb();
  const runningRows = db
    .prepare("SELECT * FROM llm_tasks WHERE status = 'running'")
    .all() as Array<Record<string, unknown>>;

  let interruptedCount = 0;
  const nowIso = new Date().toISOString();

  for (const r of runningRows) {
    const tid = String(r.task_id);
    if (activeInProcessTaskIds.has(tid)) continue;
    const task = rowToLlmTask(r);
    task.status = "interrupted";
    task.errorMessage = "应用关闭或重启导致生成任务中断";
    task.updatedAt = nowIso;
    task.completedAt = nowIso;
    upsertLlmTaskInDb(task, true);
    interruptedCount++;
  }

  // Also reconcile orphaned 'running' agent_runs, agent_tasks & in-flight agent_workflows on boot/restart
  db.prepare(
    `UPDATE agent_runs
     SET status = 'interrupted',
         completed_at = COALESCE(completed_at, ?),
         error_message = COALESCE(error_message, '应用关闭或重启导致运行中断')
     WHERE status = 'running'`,
  ).run(nowIso);

  const runningAgentTasks = db
    .prepare("SELECT task_id FROM agent_tasks WHERE status = 'running'")
    .all() as Array<{ task_id: string }>;
  for (const row of runningAgentTasks) {
    if (activeInProcessTaskIds.has(String(row.task_id))) continue;
    db.prepare(
      `UPDATE agent_tasks
       SET status = 'interrupted',
           completed_at = COALESCE(completed_at, ?),
           updated_at = ?,
           error_message = COALESCE(error_message, '应用关闭或重启导致后台任务中断')
       WHERE task_id = ?`,
    ).run(nowIso, nowIso, String(row.task_id));
    interruptedCount++;
  }

  db.prepare(
    `UPDATE agent_workflows
     SET state = 'interrupted',
         updated_at = ?,
         last_error = COALESCE(last_error, '应用关闭或重启导致工作流中断，可恢复重跑')
     WHERE state IN (
       'goal_analyzing', 'research_planning', 'research_running',
       'research_validating', 'curriculum_generating', 'curriculum_validating',
       'first_lesson_preparing', 'preparing', 'validating'
     )`,
  ).run(nowIso);

  db.prepare(
    `UPDATE lesson_preparations
     SET status = 'failed',
         updated_at = ?,
         error_message = COALESCE(error_message, '应用关闭或重启导致备课中断，请重新准备')
     WHERE status IN ('researching', 'drafting')`,
  ).run(nowIso);

  return interruptedCount;
}

export function markRunningAgentRunsCancelledForThreadInDb(
  conversationId: string,
): number {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const res = db
    .prepare(
      `UPDATE agent_runs
       SET status = 'cancelled',
           completed_at = ?,
           error_message = COALESCE(error_message, '用户手动取消生成')
       WHERE conversation_id = ? AND status = 'running'`,
    )
    .run(nowIso, conversationId);
  return Number(res.changes ?? 0);
}

export function upsertTraceRunInDb(run: AgentTraceRun) {
  const db = getDb();
  // AGENT-11 / FAIL-07: derive accurate per-tool ok flag from agent_tool_calls instead of guessing from run.status
  const tcRows = db
    .prepare(
      "SELECT tool_name, execution_status FROM agent_tool_calls WHERE run_id = ? ORDER BY requested_at ASC",
    )
    .all(run.run_id) as Array<{ tool_name: string; execution_status: string }>;
  const toolSummary =
    tcRows.length > 0
      ? tcRows.map((r) => ({
          toolName: String(r.tool_name),
          ok: String(r.execution_status) === "succeeded",
        }))
      : run.tool_names.map((toolName) => ({
          toolName,
          ok: run.status !== "failed" && run.status !== "cancelled",
        }));
  const toolSummaryJson = safeTraceJson(toolSummary);
  db.prepare(
    `INSERT INTO agent_runs
      (run_id, route, model_label, user_prompt, reasoning_chars, step_count, tool_calls_json, status, error_message, latency_ms, created_at,
       conversation_id, user_id, provider, model, started_at, completed_at, final_response, tool_call_count, trace_write_errors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
      route = excluded.route,
      model_label = excluded.model_label,
      user_prompt = excluded.user_prompt,
      reasoning_chars = excluded.reasoning_chars,
      step_count = excluded.step_count,
      tool_calls_json = excluded.tool_calls_json,
      status = excluded.status,
      error_message = excluded.error_message,
      latency_ms = excluded.latency_ms,
      conversation_id = excluded.conversation_id,
      user_id = excluded.user_id,
      provider = excluded.provider,
      model = excluded.model,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      final_response = excluded.final_response,
      tool_call_count = excluded.tool_call_count,
      trace_write_errors = excluded.trace_write_errors`,
  ).run(
    run.run_id,
    run.route,
    run.model_label,
    run.user_prompt.slice(0, 1200),
    run.reasoning_chars,
    run.step_count,
    toolSummaryJson,
    run.status,
    run.error_message ?? null,
    run.total_duration_ms,
    run.started_at,
    run.conversation_id,
    run.user_id,
    run.provider,
    run.model,
    run.started_at,
    run.completed_at ?? null,
    run.final_response ? run.final_response.slice(0, 16000) : null,
    run.tool_call_count,
    run.trace_write_errors,
  );
}

export function insertTraceEventInDb(event: AgentTraceEvent) {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO agent_trace_events
      (step_id, run_id, parent_span_id, seq, event_type, timestamp, duration_ms, status, tool_call_id, tool_name, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.step_id,
    event.run_id,
    event.parent_span_id ?? null,
    event.seq,
    event.event_type,
    event.timestamp,
    event.duration_ms ?? null,
    event.status,
    event.tool_call_id ?? null,
    event.tool_name ?? null,
    safeTraceJson(event.payload),
  );
}

export function upsertTraceToolCallInDb(tc: AgentToolCallTrace) {
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_tool_calls
      (tool_call_id, run_id, step_id, tool_name, arguments_json, requested_at, started_at, completed_at, execution_status, result_json, error, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
      step_id = excluded.step_id,
      arguments_json = excluded.arguments_json,
      started_at = COALESCE(excluded.started_at, agent_tool_calls.started_at),
      completed_at = COALESCE(excluded.completed_at, agent_tool_calls.completed_at),
      execution_status = excluded.execution_status,
      result_json = COALESCE(excluded.result_json, agent_tool_calls.result_json),
      error = COALESCE(excluded.error, agent_tool_calls.error),
      duration_ms = COALESCE(excluded.duration_ms, agent_tool_calls.duration_ms)`,
  ).run(
    tc.tool_call_id,
    tc.run_id,
    tc.step_id,
    tc.tool_name,
    safeTraceJson(tc.arguments),
    tc.requested_at,
    tc.started_at ?? null,
    tc.completed_at ?? null,
    tc.execution_status,
    tc.result !== undefined && tc.result !== null
      ? safeTraceJson(tc.result)
      : null,
    tc.error ?? null,
    tc.duration_ms ?? null,
  );
}

export function insertTraceStateChangeInDb(sc: AgentStateChangeTrace) {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO agent_state_changes
      (change_id, run_id, tool_call_id, entity_type, entity_id, action, before_state_json, after_state_json, source, status, error, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sc.change_id,
    sc.run_id,
    sc.tool_call_id ?? null,
    sc.entity_type,
    sc.entity_id,
    sc.action,
    sc.before_state !== undefined && sc.before_state !== null
      ? safeTraceJson(sc.before_state)
      : null,
    sc.after_state !== undefined && sc.after_state !== null
      ? safeTraceJson(sc.after_state)
      : null,
    sc.source,
    sc.status,
    sc.error ?? null,
    sc.timestamp,
  );
}

function rowToTraceRun(r: Record<string, unknown>): AgentTraceRun {
  let toolNames: string[] = [];
  try {
    const parsed = JSON.parse(String(r.tool_calls_json || "[]"));
    if (Array.isArray(parsed)) {
      toolNames = parsed
        .map((item) =>
          item && typeof item === "object" && "toolName" in item
            ? String((item as { toolName: unknown }).toolName)
            : "",
        )
        .filter(Boolean);
    }
  } catch {}

  const rawStatus = String(r.status || "completed");
  const normalizedStatus: AgentTraceRun["status"] =
    rawStatus === "running" ||
    rawStatus === "completed" ||
    rawStatus === "failed" ||
    rawStatus === "cancelled"
      ? rawStatus
      : rawStatus === "error"
        ? "failed"
        : "completed";

  return {
    run_id: String(r.run_id),
    conversation_id: String(r.conversation_id || "agent-main"),
    user_id: String(r.user_id || "local-desktop-user"),
    route: (String(r.route) === "tutor" ? "tutor" : "agent") as
      | "agent"
      | "tutor",
    provider: String(r.provider || "unknown"),
    model: String(r.model || r.model_label || "unknown"),
    model_label: String(r.model_label || "unknown"),
    user_prompt: String(r.user_prompt || ""),
    started_at: String(r.started_at || r.created_at),
    completed_at: r.completed_at ? String(r.completed_at) : null,
    status: normalizedStatus,
    total_duration_ms: Number(r.latency_ms ?? 0),
    step_count: Number(r.step_count ?? 0),
    tool_call_count: Number(r.tool_call_count ?? toolNames.length),
    reasoning_chars: Number(r.reasoning_chars ?? 0),
    final_response: r.final_response ? String(r.final_response) : null,
    error_message: r.error_message ? String(r.error_message) : null,
    trace_write_errors: Number(r.trace_write_errors ?? 0),
    tool_names: toolNames,
  };
}

export function getFullAgentTraceFromDb(runId: string): FullAgentTrace | null {
  const db = getDb();
  const runRow = db
    .prepare("SELECT * FROM agent_runs WHERE run_id = ?")
    .get(runId) as Record<string, unknown> | undefined;
  if (!runRow) return null;

  const eventRows = db
    .prepare(
      "SELECT * FROM agent_trace_events WHERE run_id = ? ORDER BY seq ASC, timestamp ASC",
    )
    .all(runId) as Array<Record<string, unknown>>;

  const events: AgentTraceEvent[] = eventRows.map((r) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(String(r.payload_json || "{}"));
    } catch {}
    return {
      step_id: String(r.step_id),
      run_id: String(r.run_id),
      parent_span_id: r.parent_span_id ? String(r.parent_span_id) : null,
      seq: Number(r.seq ?? 0),
      event_type: String(r.event_type) as AgentTraceEvent["event_type"],
      timestamp: String(r.timestamp),
      duration_ms:
        r.duration_ms !== null && r.duration_ms !== undefined
          ? Number(r.duration_ms)
          : null,
      status: String(r.status) as AgentTraceEvent["status"],
      tool_call_id: r.tool_call_id ? String(r.tool_call_id) : null,
      tool_name: r.tool_name ? String(r.tool_name) : null,
      payload,
    };
  });

  const tcRows = db
    .prepare(
      "SELECT * FROM agent_tool_calls WHERE run_id = ? ORDER BY requested_at ASC",
    )
    .all(runId) as Array<Record<string, unknown>>;

  const toolCalls: AgentToolCallTrace[] = tcRows.map((r) => {
    let args: unknown = {};
    let result: unknown = null;
    try {
      args = JSON.parse(String(r.arguments_json || "{}"));
    } catch {}
    try {
      if (r.result_json) result = JSON.parse(String(r.result_json));
    } catch {}
    return {
      tool_call_id: String(r.tool_call_id),
      run_id: String(r.run_id),
      step_id: String(r.step_id),
      tool_name: String(r.tool_name),
      arguments: args,
      requested_at: String(r.requested_at),
      started_at: r.started_at ? String(r.started_at) : null,
      completed_at: r.completed_at ? String(r.completed_at) : null,
      execution_status: String(
        r.execution_status,
      ) as AgentToolCallTrace["execution_status"],
      result,
      error: r.error ? String(r.error) : null,
      duration_ms:
        r.duration_ms !== null && r.duration_ms !== undefined
          ? Number(r.duration_ms)
          : null,
    };
  });

  const scRows = db
    .prepare(
      "SELECT * FROM agent_state_changes WHERE run_id = ? ORDER BY timestamp ASC",
    )
    .all(runId) as Array<Record<string, unknown>>;

  const stateChanges: AgentStateChangeTrace[] = scRows.map((r) => {
    let beforeState: unknown = null;
    let afterState: unknown = null;
    try {
      if (r.before_state_json) {
        beforeState = JSON.parse(String(r.before_state_json));
      }
    } catch {}
    try {
      if (r.after_state_json) {
        afterState = JSON.parse(String(r.after_state_json));
      }
    } catch {}
    return {
      change_id: String(r.change_id),
      run_id: String(r.run_id),
      tool_call_id: r.tool_call_id ? String(r.tool_call_id) : null,
      entity_type: String(r.entity_type) as AgentStateChangeTrace["entity_type"],
      entity_id: String(r.entity_id),
      action: String(r.action) as AgentStateChangeTrace["action"],
      before_state: beforeState,
      after_state: afterState,
      source: String(r.source),
      status: String(r.status) as AgentStateChangeTrace["status"],
      error: r.error ? String(r.error) : null,
      timestamp: String(r.timestamp),
    };
  });

  const run = rowToTraceRun(runRow);
  if (toolCalls.length > 0) {
    run.tool_call_count = toolCalls.length;
    run.tool_names = toolCalls.map((t) => t.tool_name);
  }

  return { run, events, toolCalls, stateChanges };
}

export function listTraceRunsFromDb(opts?: {
  limit?: number;
  status?: string;
  toolName?: string;
  search?: string;
}): AgentTraceRun[] {
  const db = getDb();
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (opts?.status && opts.status !== "all") {
    if (opts.status === "failed") {
      where.push("(r.status = 'failed' OR r.status = 'error')");
    } else {
      where.push("r.status = ?");
      params.push(opts.status);
    }
  }

  if (opts?.search && opts.search.trim()) {
    const q = `%${opts.search.trim()}%`;
    where.push("(r.run_id LIKE ? OR r.user_prompt LIKE ? OR r.model_label LIKE ?)");
    params.push(q, q, q);
  }

  if (opts?.toolName && opts.toolName !== "all") {
    where.push(
      "(EXISTS (SELECT 1 FROM agent_tool_calls tc WHERE tc.run_id = r.run_id AND tc.tool_name = ?) OR r.tool_calls_json LIKE ?)",
    );
    params.push(opts.toolName, `%${opts.toolName}%`);
  }

  const sql = `
    SELECT r.*
    FROM agent_runs r
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY r.created_at DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToTraceRun);
}

export function recordAgentRunToDb(run: AgentRunRecord) {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO agent_runs
      (run_id, route, model_label, user_prompt, reasoning_chars, step_count, tool_calls_json, status, error_message, latency_ms, created_at,
       conversation_id, user_id, provider, model, started_at, completed_at, tool_call_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.runId,
    run.route,
    run.modelLabel,
    run.userPrompt.slice(0, 400),
    run.reasoningChars,
    run.stepCount,
    JSON.stringify(run.toolCalls),
    run.status,
    run.errorMessage ?? null,
    run.latencyMs,
    run.createdAt,
    "agent-main",
    "local-desktop-user",
    "unknown",
    run.modelLabel,
    run.createdAt,
    run.createdAt,
    run.toolCalls.length,
  );
}

export function recordDomainEventInDb(
  event: Omit<DomainEventRecord, "eventId" | "createdAt"> & {
    eventId?: string;
    createdAt?: string;
  },
): DomainEventRecord {
  const db = getDb();
  const full: DomainEventRecord = {
    eventId: event.eventId || "evt-" + crypto.randomUUID().slice(0, 10),
    eventType: event.eventType,
    entityType: event.entityType,
    entityId: event.entityId,
    summary: event.summary,
    payload: event.payload || {},
    runId: event.runId ?? null,
    createdAt: event.createdAt || new Date().toISOString(),
  };
  db.prepare(
    `INSERT OR REPLACE INTO domain_events
      (event_id, event_type, entity_type, entity_id, summary, payload_json, run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    full.eventId,
    full.eventType,
    full.entityType,
    full.entityId,
    full.summary,
    safeTraceJson(full.payload),
    full.runId ?? null,
    full.createdAt,
  );
  return full;
}

export function listDomainEventsFromDb(limit = 50): DomainEventRecord[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM domain_events ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(String(r.payload_json || "{}"));
    } catch {}
    return {
      eventId: String(r.event_id),
      eventType: String(r.event_type) as DomainEventRecord["eventType"],
      entityType: String(r.entity_type),
      entityId: String(r.entity_id),
      summary: String(r.summary),
      payload,
      runId: r.run_id ? String(r.run_id) : null,
      createdAt: String(r.created_at),
    };
  });
}

export function listAuditFromDb(
  limit = 40,
  filters?: { status?: string; toolName?: string; search?: string },
): {
  runs: AgentRunRecord[];
  traceRuns: AgentTraceRun[];
  revisions: PlanRevision[];
  domainEvents: DomainEventRecord[];
  dbInfo: DbInfo;
} {
  const db = getDb();
  const traceRuns = listTraceRunsFromDb({
    limit,
    status: filters?.status,
    toolName: filters?.toolName,
    search: filters?.search,
  });

  const runRows = db
    .prepare("SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  const runs: AgentRunRecord[] = runRows.map((r) => ({
    runId: String(r.run_id),
    route: String(r.route) as AgentRunRecord["route"],
    modelLabel: String(r.model_label),
    userPrompt: String(r.user_prompt),
    reasoningChars: Number(r.reasoning_chars),
    stepCount: Number(r.step_count),
    toolCalls: JSON.parse(String(r.tool_calls_json || "[]")),
    status: (String(r.status) === "completed" ? "completed" : "error") as AgentRunRecord["status"],
    errorMessage: r.error_message ? String(r.error_message) : undefined,
    latencyMs: Number(r.latency_ms),
    createdAt: String(r.created_at),
  }));

  const revRows = db
    .prepare("SELECT * FROM plan_revisions ORDER BY version_seq DESC, created_at DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  const revisions: PlanRevision[] = revRows.map((r) => ({
    id: String(r.id),
    versionSeq: Number(r.version_seq ?? 1),
    parentRevisionId: r.parent_revision_id ? String(r.parent_revision_id) : null,
    trigger: String(r.trigger),
    summary: String(r.summary),
    beforeCount: Number(r.before_count),
    afterCount: Number(r.after_count),
    diff: JSON.parse(String(r.diff_json)),
    createdAt: String(r.created_at),
  }));

  const domainEvents = listDomainEventsFromDb(limit);

  return { runs, traceRuns, revisions, domainEvents, dbInfo: getDbInfo() };
}

export function clearAuditLogsInDb() {
  const db = getDb();
  db.exec(`
    BEGIN IMMEDIATE;
    DELETE FROM agent_runs;
    DELETE FROM agent_trace_events;
    DELETE FROM agent_tool_calls;
    DELETE FROM agent_state_changes;
    DELETE FROM plan_revisions;
    DELETE FROM domain_events;
    COMMIT;
  `);
}

export function getDbInfo(): DbInfo {
  const db = getDb();
  const dbPath = resolveDbPath();
  let sizeBytes = 0;
  try {
    if (dbPath !== ":memory:" && existsSync(dbPath)) {
      sizeBytes = statSync(dbPath).size;
    }
  } catch {}

  const runCount = Number(
    (
      db.prepare("SELECT COUNT(*) AS c FROM agent_runs").get() as {
        c: number;
      }
    )?.c ?? 0,
  );
  const revisionCount = Number(
    (
      db.prepare("SELECT COUNT(*) AS c FROM plan_revisions").get() as {
        c: number;
      }
    )?.c ?? 0,
  );
  const threadCount = Number(
    (
      db.prepare("SELECT COUNT(*) AS c FROM chat_threads").get() as {
        c: number;
      }
    )?.c ?? 0,
  );

  return {
    path: dbPath === ":memory:" ? ":memory:" : "data/learnos.sqlite",
    sizeBytes,
    runCount,
    revisionCount,
    threadCount,
  };
}

export type FullWorkspaceBackup = {
  schema: "xushi-learnos-backup-v2";
  schemaVersion: number;
  exportedAt: string;
  store: Store;
  learningSessions: Array<Record<string, unknown>>;
  exercises: Array<Record<string, unknown>>;
  exerciseAttempts: Array<Record<string, unknown>>;
  planDrafts: Array<Record<string, unknown>>;
  chatThreads: Array<{
    threadId: string;
    scope: string;
    title: string | null;
    trackId: string | null;
    lessonId: string | null;
    summary: string | null;
    summaryMsgCount: number;
    updatedAt: string;
    messages: UIMessage[];
  }>;
  planRevisions: PlanRevision[];
  domainEvents: DomainEventRecord[];
};

/**
 * Full-stack JSON backup export (DB-19) covering store, exercises, formal attempts,
 * learning sessions, plan drafts, chat threads, plan revisions, and domain events.
 * Explicitly excludes API keys and client model credentials.
 */
export function exportFullBackupFromDb(day: string): FullWorkspaceBackup {
  const db = getDb();
  const store = loadStoreFromDb(day);

  const learningSessions = db
    .prepare("SELECT * FROM learning_sessions ORDER BY updated_at DESC")
    .all() as Array<Record<string, unknown>>;
  const exercises = (
    db
      .prepare("SELECT * FROM exercises ORDER BY created_at DESC")
      .all() as Array<Record<string, unknown>>
  ).map((r) => ({
    ...r,
    spec: (() => {
      try {
        return JSON.parse(String(r.spec_json || "{}"));
      } catch {
        return {};
      }
    })(),
  }));
  const exerciseAttempts = (
    db
      .prepare("SELECT * FROM exercise_attempts ORDER BY created_at DESC")
      .all() as Array<Record<string, unknown>>
  ).map((r) => ({
    ...r,
    submitted_answer: (() => {
      try {
        return JSON.parse(String(r.submitted_answer_json || "{}"));
      } catch {
        return {};
      }
    })(),
    correct_answer: (() => {
      try {
        return r.correct_answer_json
          ? JSON.parse(String(r.correct_answer_json))
          : null;
      } catch {
        return null;
      }
    })(),
    position_matches: (() => {
      try {
        return r.position_matches_json
          ? JSON.parse(String(r.position_matches_json))
          : null;
      } catch {
        return null;
      }
    })(),
  }));
  const planDrafts = db
    .prepare("SELECT * FROM plan_drafts ORDER BY created_at DESC")
    .all() as Array<Record<string, unknown>>;

  const threadRows = db
    .prepare("SELECT * FROM chat_threads ORDER BY updated_at DESC")
    .all() as Array<Record<string, unknown>>;
  const chatThreads = threadRows.map((r) => {
    let messages: UIMessage[] = [];
    try {
      const parsed = JSON.parse(String(r.messages_json || "[]"));
      if (Array.isArray(parsed)) messages = parsed;
    } catch {}
    return {
      threadId: String(r.thread_id),
      scope: String(r.scope || "agent"),
      title: r.title ? String(r.title) : null,
      trackId: r.track_id ? String(r.track_id) : null,
      lessonId: r.lesson_id ? String(r.lesson_id) : null,
      summary: r.summary ? String(r.summary) : null,
      summaryMsgCount: Number(r.summary_msg_count ?? 0),
      updatedAt: String(r.updated_at || ""),
      messages,
    };
  });

  const revRows = db
    .prepare(
      "SELECT * FROM plan_revisions ORDER BY version_seq DESC, created_at DESC",
    )
    .all() as Array<Record<string, unknown>>;
  const planRevisions: PlanRevision[] = revRows.map((r) => ({
    id: String(r.id),
    versionSeq: Number(r.version_seq ?? 1),
    parentRevisionId: r.parent_revision_id ? String(r.parent_revision_id) : null,
    trigger: String(r.trigger),
    summary: String(r.summary),
    beforeCount: Number(r.before_count),
    afterCount: Number(r.after_count),
    diff: JSON.parse(String(r.diff_json)),
    createdAt: String(r.created_at),
  }));

  const domainEvents = listDomainEventsFromDb(200);

  return {
    schema: "xushi-learnos-backup-v2",
    schemaVersion: CURRENT_DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    store,
    learningSessions,
    exercises,
    exerciseAttempts,
    planDrafts,
    chatThreads,
    planRevisions,
    domainEvents,
  };
}

export type TrackImpactSummary = {
  trackId: string;
  title: string;
  archived: boolean;
  lessonCount: number;
  exclusiveLessonCount: number;
  sharedLessonIds: string[];
  futureBlockCount: number;
  completedBlockCount: number;
  exerciseCount: number;
  attemptCount: number;
  sessionCount: number;
  pendingDraftCount: number;
  otherTrackCount: number;
};

function computeExclusiveLessonIds(
  allPlans: Array<{ id: string; units: Array<{ id: string }> }>,
  targetTrackId: string,
): { allIds: string[]; exclusiveIds: string[]; sharedIds: string[] } {
  const target = allPlans.find((p) => p.id === targetTrackId);
  if (!target) return { allIds: [], exclusiveIds: [], sharedIds: [] };
  const otherLessonIds = new Set<string>();
  for (const p of allPlans) {
    if (p.id === targetTrackId) continue;
    for (const u of p.units) otherLessonIds.add(u.id);
  }
  const allIds = target.units.map((u) => u.id);
  const exclusiveIds = allIds.filter((id) => !otherLessonIds.has(id));
  const sharedIds = allIds.filter((id) => otherLessonIds.has(id));
  return { allIds, exclusiveIds, sharedIds };
}

export function getTrackImpactFromDb(
  trackId: string,
): TrackImpactSummary | null {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, title, units_json, archived FROM goal_plans")
    .all() as Array<Record<string, unknown>>;
  const plans = rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    archived: Boolean(r.archived),
    units: (() => {
      try {
        return JSON.parse(String(r.units_json || "[]")) as Array<{ id: string }>;
      } catch {
        return [];
      }
    })(),
  }));
  const target = plans.find((p) => p.id === trackId);
  if (!target) return null;

  const { allIds, exclusiveIds, sharedIds } = computeExclusiveLessonIds(
    plans,
    trackId,
  );
  const countIn = (table: string, col: string, extraWhere = "") => {
    if (!exclusiveIds.length) return 0;
    const placeholders = exclusiveIds.map(() => "?").join(",");
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM ${table} WHERE ${col} IN (${placeholders}) ${extraWhere}`,
      )
      .get(...exclusiveIds) as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  };

  return {
    trackId: target.id,
    title: target.title,
    archived: target.archived,
    lessonCount: allIds.length,
    exclusiveLessonCount: exclusiveIds.length,
    sharedLessonIds: sharedIds,
    futureBlockCount: countIn("calendar_blocks", "lesson_id", "AND done = 0"),
    completedBlockCount: countIn("calendar_blocks", "lesson_id", "AND done = 1"),
    exerciseCount: countIn("exercises", "lesson_id"),
    attemptCount: countIn("exercise_attempts", "lesson_id"),
    sessionCount: countIn("learning_sessions", "lesson_id"),
    pendingDraftCount: countIn(
      "plan_drafts",
      "lesson_id",
      "AND status = 'pending'",
    ),
    otherTrackCount: plans.length - 1,
  };
}

/**
 * DB-24 default action: archive a learning track.
 * Preserves lessons, exercises, attempts, sessions, mastery, and completed history;
 * pauses uncompleted future calendar blocks & pending drafts for exclusive lessons.
 */
export function archiveTrackInDb(
  trackId: string,
  day: string,
): { store: Store; pausedBlocks: number } {
  const db = getDb();
  const nowIso = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db
      .prepare("SELECT id, title, units_json, archived FROM goal_plans ORDER BY sort_order ASC")
      .all() as Array<Record<string, unknown>>;
    const plans = rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      archived: Boolean(r.archived),
      units: JSON.parse(String(r.units_json || "[]")) as Array<{ id: string }>,
    }));
    const target = plans.find((p) => p.id === trackId);
    if (!target) {
      throw new Error(`未找到轨道 ${trackId}`);
    }

    const { exclusiveIds } = computeExclusiveLessonIds(plans, trackId);
    let pausedBlocks = 0;

    db.prepare(
      "UPDATE goal_plans SET archived = 1, archived_at = ?, updated_at = ? WHERE id = ?",
    ).run(nowIso, nowIso, trackId);

    if (exclusiveIds.length > 0) {
      const ph = exclusiveIds.map(() => "?").join(",");
      const delRes = db
        .prepare(
          `DELETE FROM calendar_blocks WHERE done = 0 AND lesson_id IN (${ph})`,
        )
        .run(...exclusiveIds);
      pausedBlocks = Number(delRes.changes ?? 0);

      db.prepare(
        `UPDATE plan_drafts SET status = 'dismissed', resolved_at = ? WHERE status = 'pending' AND lesson_id IN (${ph})`,
      ).run(nowIso, ...exclusiveIds);
    }

    const wsRow = db
      .prepare("SELECT active_track_id, state_version FROM workspace_state WHERE id = 'default'")
      .get() as { active_track_id?: string; state_version?: number } | undefined;
    const nextVersion = Number(wsRow?.state_version ?? 1) + 1;
    const remainingActive = plans.filter((p) => p.id !== trackId && !p.archived);
    const nextActiveId =
      wsRow?.active_track_id === trackId
        ? remainingActive.at(-1)?.id ?? null
        : wsRow?.active_track_id ?? null;

    db.prepare(
      `UPDATE workspace_state SET active_track_id = ?, state_version = ?, updated_at = ? WHERE id = 'default'`,
    ).run(nextActiveId, nextVersion, nowIso);

    db.prepare(
      `INSERT INTO domain_events
        (event_id, event_type, entity_type, entity_id, summary, payload_json, run_id, created_at)
       VALUES (?, 'GoalUpdated', 'goal', ?, ?, ?, NULL, ?)`,
    ).run(
      "evt-" + crypto.randomUUID().slice(0, 10),
      trackId,
      `已归档学习轨道「${target.title}」（保留全部学习历史，暂停 ${pausedBlocks} 个未完成排期）`,
      safeTraceJson({ action: "archive", trackId, pausedBlocks }),
      nowIso,
    );

    db.exec("COMMIT");
    return { store: loadStoreFromDb(day), pausedBlocks };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function restoreTrackInDb(
  trackId: string,
  day: string,
): { store: Store } {
  const db = getDb();
  const nowIso = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare("SELECT id, title FROM goal_plans WHERE id = ?")
      .get(trackId) as { id?: string; title?: string } | undefined;
    if (!row?.id) throw new Error(`未找到轨道 ${trackId}`);

    db.prepare(
      "UPDATE goal_plans SET archived = 0, archived_at = NULL, updated_at = ? WHERE id = ?",
    ).run(nowIso, trackId);

    const wsRow = db
      .prepare("SELECT active_track_id, state_version FROM workspace_state WHERE id = 'default'")
      .get() as { active_track_id?: string; state_version?: number } | undefined;
    const nextVersion = Number(wsRow?.state_version ?? 1) + 1;
    const nextActiveId = wsRow?.active_track_id || trackId;

    db.prepare(
      `UPDATE workspace_state SET active_track_id = ?, state_version = ?, updated_at = ? WHERE id = 'default'`,
    ).run(nextActiveId, nextVersion, nowIso);

    db.prepare(
      `INSERT INTO domain_events
        (event_id, event_type, entity_type, entity_id, summary, payload_json, run_id, created_at)
       VALUES (?, 'GoalUpdated', 'goal', ?, ?, ?, NULL, ?)`,
    ).run(
      "evt-" + crypto.randomUUID().slice(0, 10),
      trackId,
      `已恢复归档轨道「${row.title}」`,
      safeTraceJson({ action: "restore", trackId }),
      nowIso,
    );

    db.exec("COMMIT");
    return { store: loadStoreFromDb(day) };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * DB-24 independent permanent deletion (transactional).
 * Removes the track and records belonging exclusively to its lessons;
 * NEVER touches shared lessons, other tracks, or unrelated memories.
 */
export function permanentlyDeleteTrackInDb(
  trackId: string,
  day: string,
): { store: Store; deletedCounts: { blocks: number; exercises: number; attempts: number; sessions: number } } {
  const db = getDb();
  const nowIso = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db
      .prepare("SELECT id, title, units_json, archived FROM goal_plans ORDER BY sort_order ASC")
      .all() as Array<Record<string, unknown>>;
    const plans = rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      archived: Boolean(r.archived),
      units: JSON.parse(String(r.units_json || "[]")) as Array<{ id: string }>,
    }));
    const target = plans.find((p) => p.id === trackId);
    if (!target) throw new Error(`未找到轨道 ${trackId}`);

    const { exclusiveIds } = computeExclusiveLessonIds(plans, trackId);
    const deletedCounts = { blocks: 0, exercises: 0, attempts: 0, sessions: 0 };

    if (exclusiveIds.length > 0) {
      const ph = exclusiveIds.map(() => "?").join(",");
      deletedCounts.blocks = Number(
        db
          .prepare(`DELETE FROM calendar_blocks WHERE lesson_id IN (${ph})`)
          .run(...exclusiveIds).changes ?? 0,
      );
      deletedCounts.attempts = Number(
        db
          .prepare(`DELETE FROM exercise_attempts WHERE lesson_id IN (${ph})`)
          .run(...exclusiveIds).changes ?? 0,
      );
      deletedCounts.exercises = Number(
        db
          .prepare(`DELETE FROM exercises WHERE lesson_id IN (${ph})`)
          .run(...exclusiveIds).changes ?? 0,
      );
      deletedCounts.sessions = Number(
        db
          .prepare(`DELETE FROM learning_sessions WHERE lesson_id IN (${ph})`)
          .run(...exclusiveIds).changes ?? 0,
      );
      db.prepare(`DELETE FROM plan_drafts WHERE lesson_id IN (${ph})`).run(
        ...exclusiveIds,
      );
      db.prepare(`DELETE FROM mastery_states WHERE lesson_id IN (${ph})`).run(
        ...exclusiveIds,
      );
      db.prepare(
        `DELETE FROM assessment_attempts WHERE lesson_id IN (${ph})`,
      ).run(...exclusiveIds);
      db.prepare(
        `DELETE FROM session_execution_logs WHERE lesson_id IN (${ph})`,
      ).run(...exclusiveIds);
    }

    db.prepare("DELETE FROM goal_plans WHERE id = ?").run(trackId);

    const wsRow = db
      .prepare("SELECT active_track_id, state_version FROM workspace_state WHERE id = 'default'")
      .get() as { active_track_id?: string; state_version?: number } | undefined;
    const nextVersion = Number(wsRow?.state_version ?? 1) + 1;
    const remainingActive = plans.filter((p) => p.id !== trackId && !p.archived);
    const nextActiveId =
      wsRow?.active_track_id === trackId
        ? remainingActive.at(-1)?.id ?? null
        : wsRow?.active_track_id ?? null;

    db.prepare(
      `UPDATE workspace_state SET active_track_id = ?, state_version = ?, updated_at = ? WHERE id = 'default'`,
    ).run(nextActiveId, nextVersion, nowIso);

    db.prepare(
      `INSERT INTO domain_events
        (event_id, event_type, entity_type, entity_id, summary, payload_json, run_id, created_at)
       VALUES (?, 'GoalUpdated', 'goal', ?, ?, ?, NULL, ?)`,
    ).run(
      "evt-" + crypto.randomUUID().slice(0, 10),
      trackId,
      `已永久删除轨道「${target.title}」（清理独占日程 ${deletedCounts.blocks}、练习 ${deletedCounts.exercises}、作答 ${deletedCounts.attempts}）`,
      safeTraceJson({ action: "permanent_delete", trackId, deletedCounts }),
      nowIso,
    );

    db.exec("COMMIT");
    return { store: loadStoreFromDb(day), deletedCounts };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * E2E-001: Adjusts an existing track's scope, depth, and lesson list atomically
 * without corrupting mastered history, completed blocks, or other tracks' schedules.
 */
export function adjustTrackScopeInDb(
  input: TrackScopeAdjustmentInput,
): TrackScopeAdjustmentResult {
  const current = loadStoreFromDb(input.day);
  const adjusted = reconcileTrackUnitsAndSchedule(current, input);
  saveStoreToDb(adjusted.store, {
    trigger: "调整学习范围与深度",
    summary: adjusted.store.decision,
  });
  return {
    ...adjusted,
    store: loadStoreFromDb(input.day),
  };
}

export type ResearchCacheRow = {
  cacheKey: string;
  kind: "topic" | "lesson" | "url";
  domain: string;
  mode: string;
  queryOrTopic: string;
  learnerLevel: string;
  payload: unknown;
  sources: unknown[];
  unverifiedClaims: string[];
  createdAt: string;
  expiresAt: string;
};

export function getResearchCacheFromDb(
  cacheKey: string,
  opts: { allowExpired?: boolean } = {},
): ResearchCacheRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM research_cache WHERE cache_key = ?")
    .get(cacheKey) as Record<string, unknown> | undefined;
  if (!row) return null;
  const expiresAt = String(row.expires_at);
  if (!opts.allowExpired && expiresAt < new Date().toISOString()) {
    return null;
  }
  return {
    cacheKey: String(row.cache_key),
    kind: String(row.kind) as ResearchCacheRow["kind"],
    domain: String(row.domain),
    mode: String(row.mode),
    queryOrTopic: String(row.query_or_topic),
    learnerLevel: String(row.learner_level),
    payload: (() => {
      try {
        return JSON.parse(String(row.payload_json));
      } catch {
        return null;
      }
    })(),
    sources: (() => {
      try {
        const parsed = JSON.parse(String(row.sources_json || "[]"));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })(),
    unverifiedClaims: (() => {
      try {
        const parsed = JSON.parse(String(row.unverified_claims_json || "[]"));
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    })(),
    createdAt: String(row.created_at),
    expiresAt,
  };
}

export function saveResearchCacheToDb(entry: {
  cacheKey: string;
  kind: "topic" | "lesson" | "url";
  domain: string;
  mode: string;
  queryOrTopic: string;
  learnerLevel: string;
  payload: unknown;
  sources: unknown[];
  unverifiedClaims?: string[];
  ttlDays?: number;
}): void {
  const db = getDb();
  const now = new Date();
  const ttlDays = Math.max(1, entry.ttlDays ?? 7);
  const expiresAt = new Date(
    now.getTime() + ttlDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  db.prepare(
    `INSERT INTO research_cache
      (cache_key, kind, domain, mode, query_or_topic, learner_level, payload_json, sources_json, unverified_claims_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
      kind = excluded.kind,
      domain = excluded.domain,
      mode = excluded.mode,
      query_or_topic = excluded.query_or_topic,
      learner_level = excluded.learner_level,
      payload_json = excluded.payload_json,
      sources_json = excluded.sources_json,
      unverified_claims_json = excluded.unverified_claims_json,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at`,
  ).run(
    entry.cacheKey,
    entry.kind,
    entry.domain,
    entry.mode,
    entry.queryOrTopic,
    entry.learnerLevel,
    JSON.stringify(entry.payload ?? {}),
    JSON.stringify(entry.sources ?? []),
    JSON.stringify(entry.unverifiedClaims ?? []),
    now.toISOString(),
    expiresAt,
  );
}

export type LessonPreparationRow = {
  lessonId: string;
  trackId: string | null;
  status: "idle" | "researching" | "drafting" | "ready" | "fallback" | "failed";
  mode: "auto_web" | "quick_draft" | "user_materials";
  learnerLevel: string;
  brief: unknown | null;
  tutorial: unknown | null;
  sources: unknown[];
  qualityReport: unknown | null;
  errorMessage: string | null;
  updatedAt: string;
};

export function getLessonPreparationFromDb(
  lessonId: string,
): LessonPreparationRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM lesson_preparations WHERE lesson_id = ?")
    .get(lessonId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const parse = (raw: unknown) => {
    if (!raw) return null;
    try {
      return JSON.parse(String(raw));
    } catch {
      return null;
    }
  };
  return {
    lessonId: String(row.lesson_id),
    trackId: row.track_id ? String(row.track_id) : null,
    status: String(row.status) as LessonPreparationRow["status"],
    mode: String(row.mode) as LessonPreparationRow["mode"],
    learnerLevel: String(row.learner_level || "intermediate"),
    brief: parse(row.brief_json),
    tutorial: parse(row.tutorial_json),
    sources: Array.isArray(parse(row.sources_json))
      ? (parse(row.sources_json) as unknown[])
      : [],
    qualityReport: parse(row.quality_report_json),
    errorMessage: row.error_message ? String(row.error_message) : null,
    updatedAt: String(row.updated_at),
  };
}

export function upsertLessonPreparationInDb(entry: {
  lessonId: string;
  trackId?: string | null;
  status: LessonPreparationRow["status"];
  mode: LessonPreparationRow["mode"];
  learnerLevel: string;
  brief?: unknown | null;
  tutorial?: unknown | null;
  sources?: unknown[];
  qualityReport?: unknown | null;
  errorMessage?: string | null;
}): LessonPreparationRow {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO lesson_preparations
      (lesson_id, track_id, status, mode, learner_level, brief_json, tutorial_json, sources_json, quality_report_json, error_message, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lesson_id) DO UPDATE SET
      track_id = COALESCE(excluded.track_id, lesson_preparations.track_id),
      status = excluded.status,
      mode = excluded.mode,
      learner_level = excluded.learner_level,
      brief_json = COALESCE(excluded.brief_json, lesson_preparations.brief_json),
      tutorial_json = COALESCE(excluded.tutorial_json, lesson_preparations.tutorial_json),
      sources_json = COALESCE(excluded.sources_json, lesson_preparations.sources_json),
      quality_report_json = COALESCE(excluded.quality_report_json, lesson_preparations.quality_report_json),
      error_message = excluded.error_message,
      updated_at = excluded.updated_at`,
  ).run(
    entry.lessonId,
    entry.trackId ?? null,
    entry.status,
    entry.mode,
    entry.learnerLevel,
    entry.brief !== undefined ? JSON.stringify(entry.brief) : null,
    entry.tutorial !== undefined ? JSON.stringify(entry.tutorial) : null,
    entry.sources !== undefined ? JSON.stringify(entry.sources) : null,
    entry.qualityReport !== undefined
      ? JSON.stringify(entry.qualityReport)
      : null,
    entry.errorMessage ?? null,
    nowIso,
  );
  return getLessonPreparationFromDb(entry.lessonId)!;
}

// =============================================================================
// V1.0 Agent-Native Persistence Helpers (Workflows, Tasks, Research Packages,
// Curriculum Blueprints, Teaching Decisions/Activities, Lesson Content Versions)
// =============================================================================

export type AgentWorkflowRow = {
  workflowId: string;
  kind: "goal" | "lesson";
  state: string;
  goalId: string | null;
  trackId: string | null;
  lessonId: string | null;
  input: unknown;
  context: Record<string, unknown>;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export function upsertAgentWorkflowInDb(entry: {
  workflowId: string;
  kind: "goal" | "lesson";
  state: string;
  goalId?: string | null;
  trackId?: string | null;
  lessonId?: string | null;
  input?: unknown;
  context?: Record<string, unknown>;
  lastError?: string | null;
}): AgentWorkflowRow {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_workflows
      (workflow_id, kind, state, goal_id, track_id, lesson_id, input_json, context_json, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workflow_id) DO UPDATE SET
      state = excluded.state,
      goal_id = COALESCE(excluded.goal_id, agent_workflows.goal_id),
      track_id = COALESCE(excluded.track_id, agent_workflows.track_id),
      lesson_id = COALESCE(excluded.lesson_id, agent_workflows.lesson_id),
      context_json = excluded.context_json,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at`,
  ).run(
    entry.workflowId,
    entry.kind,
    entry.state,
    entry.goalId ?? null,
    entry.trackId ?? null,
    entry.lessonId ?? null,
    JSON.stringify(entry.input ?? {}),
    JSON.stringify(entry.context ?? {}),
    entry.lastError ?? null,
    nowIso,
    nowIso,
  );
  return getAgentWorkflowFromDb(entry.workflowId)!;
}

export function getAgentWorkflowFromDb(
  workflowId: string,
): AgentWorkflowRow | null {
  const db = getDb();
  const r = db
    .prepare("SELECT * FROM agent_workflows WHERE workflow_id = ?")
    .get(workflowId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    workflowId: String(r.workflow_id),
    kind: String(r.kind) as "goal" | "lesson",
    state: String(r.state),
    goalId: r.goal_id ? String(r.goal_id) : null,
    trackId: r.track_id ? String(r.track_id) : null,
    lessonId: r.lesson_id ? String(r.lesson_id) : null,
    input: (() => {
      try {
        return JSON.parse(String(r.input_json || "{}"));
      } catch {
        return {};
      }
    })(),
    context: (() => {
      try {
        return JSON.parse(String(r.context_json || "{}")) as Record<
          string,
          unknown
        >;
      } catch {
        return {};
      }
    })(),
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function listAgentWorkflowsFromDb(limit = 30): AgentWorkflowRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT workflow_id FROM agent_workflows ORDER BY updated_at DESC LIMIT ?",
    )
    .all(limit) as Array<{ workflow_id: string }>;
  return rows
    .map((r) => getAgentWorkflowFromDb(String(r.workflow_id)))
    .filter((x): x is AgentWorkflowRow => Boolean(x));
}

export type AgentTaskRow = {
  taskId: string;
  runId: string;
  workflowId: string | null;
  parentTaskId: string | null;
  kind:
    | "research"
    | "curriculum"
    | "lesson_preparation"
    | "teaching"
    | "general_chat";
  mode: "react" | "structured" | "hybrid";
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  goalId: string | null;
  trackId: string | null;
  lessonId: string | null;
  learningSessionId: string | null;
  idempotencyKey: string | null;
  inputTokens: number;
  outputTokens: number;
  toolResultTokens: number;
  contextBuildMs: number;
  result: unknown | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
};

export function upsertAgentTaskInDb(entry: {
  taskId: string;
  runId: string;
  workflowId?: string | null;
  parentTaskId?: string | null;
  kind: AgentTaskRow["kind"];
  mode: AgentTaskRow["mode"];
  status: AgentTaskRow["status"];
  goalId?: string | null;
  trackId?: string | null;
  lessonId?: string | null;
  learningSessionId?: string | null;
  idempotencyKey?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  toolResultTokens?: number;
  contextBuildMs?: number;
  result?: unknown | null;
  errorMessage?: string | null;
  completedAt?: string | null;
}): AgentTaskRow {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_tasks
      (task_id, run_id, workflow_id, parent_task_id, kind, mode, status, goal_id, track_id, lesson_id, learning_session_id, idempotency_key, input_tokens, output_tokens, tool_result_tokens, context_build_ms, result_json, error_message, started_at, completed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
      status = excluded.status,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      tool_result_tokens = excluded.tool_result_tokens,
      context_build_ms = excluded.context_build_ms,
      result_json = COALESCE(excluded.result_json, agent_tasks.result_json),
      error_message = excluded.error_message,
      completed_at = COALESCE(excluded.completed_at, agent_tasks.completed_at),
      updated_at = excluded.updated_at`,
  ).run(
    entry.taskId,
    entry.runId,
    entry.workflowId ?? null,
    entry.parentTaskId ?? null,
    entry.kind,
    entry.mode,
    entry.status,
    entry.goalId ?? null,
    entry.trackId ?? null,
    entry.lessonId ?? null,
    entry.learningSessionId ?? null,
    entry.idempotencyKey ?? null,
    entry.inputTokens ?? 0,
    entry.outputTokens ?? 0,
    entry.toolResultTokens ?? 0,
    entry.contextBuildMs ?? 0,
    entry.result !== undefined ? safeTraceJson(entry.result) : null,
    entry.errorMessage ?? null,
    nowIso,
    entry.completedAt ?? (entry.status === "running" ? null : nowIso),
    nowIso,
  );
  return getAgentTaskFromDb(entry.taskId)!;
}

export function getAgentTaskFromDb(taskId: string): AgentTaskRow | null {
  const db = getDb();
  const r = db
    .prepare("SELECT * FROM agent_tasks WHERE task_id = ?")
    .get(taskId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    taskId: String(r.task_id),
    runId: String(r.run_id),
    workflowId: r.workflow_id ? String(r.workflow_id) : null,
    parentTaskId: r.parent_task_id ? String(r.parent_task_id) : null,
    kind: String(r.kind) as AgentTaskRow["kind"],
    mode: String(r.mode) as AgentTaskRow["mode"],
    status: String(r.status) as AgentTaskRow["status"],
    goalId: r.goal_id ? String(r.goal_id) : null,
    trackId: r.track_id ? String(r.track_id) : null,
    lessonId: r.lesson_id ? String(r.lesson_id) : null,
    learningSessionId: r.learning_session_id
      ? String(r.learning_session_id)
      : null,
    idempotencyKey: r.idempotency_key ? String(r.idempotency_key) : null,
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    toolResultTokens: Number(r.tool_result_tokens ?? 0),
    contextBuildMs: Number(r.context_build_ms ?? 0),
    result: (() => {
      if (!r.result_json) return null;
      try {
        return JSON.parse(String(r.result_json));
      } catch {
        return null;
      }
    })(),
    errorMessage: r.error_message ? String(r.error_message) : null,
    startedAt: String(r.started_at),
    completedAt: r.completed_at ? String(r.completed_at) : null,
    updatedAt: String(r.updated_at),
  };
}

export function findAgentTaskByIdempotencyKeyInDb(
  idempotencyKey: string,
): AgentTaskRow | null {
  const db = getDb();
  const r = db
    .prepare(
      "SELECT task_id FROM agent_tasks WHERE idempotency_key = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1",
    )
    .get(idempotencyKey) as { task_id?: string } | undefined;
  return r?.task_id ? getAgentTaskFromDb(String(r.task_id)) : null;
}

export function saveResearchPackageToDb(entry: {
  packageId: string;
  cacheKey: string;
  goal: string;
  topic: string;
  learnerLevel: string;
  purpose: string;
  strategyVersion: string;
  effectiveMode: string;
  status: string;
  contentHash: string;
  pkg: unknown;
  coverage: unknown;
  sourceRefs: unknown[];
  ttlDays?: number;
}): void {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + Math.max(1, entry.ttlDays ?? 14) * 24 * 60 * 60 * 1000,
  ).toISOString();
  db.prepare(
    `INSERT INTO research_packages
      (package_id, cache_key, goal, topic, learner_level, purpose, strategy_version, effective_mode, status, content_hash, package_json, coverage_json, source_refs_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(package_id) DO UPDATE SET
      status = excluded.status,
      content_hash = excluded.content_hash,
      package_json = excluded.package_json,
      coverage_json = excluded.coverage_json,
      source_refs_json = excluded.source_refs_json,
      expires_at = excluded.expires_at`,
  ).run(
    entry.packageId,
    entry.cacheKey,
    entry.goal,
    entry.topic,
    entry.learnerLevel,
    entry.purpose,
    entry.strategyVersion,
    entry.effectiveMode,
    entry.status,
    entry.contentHash,
    JSON.stringify(entry.pkg),
    JSON.stringify(entry.coverage),
    JSON.stringify(entry.sourceRefs),
    now.toISOString(),
    expiresAt,
  );
}

export function getResearchPackageByCacheKeyFromDb(
  cacheKey: string,
  opts: { allowExpired?: boolean } = {},
): {
  packageId: string;
  pkg: unknown;
  createdAt: string;
  expiresAt: string;
  contentHash: string;
  effectiveMode: string;
  strategyVersion: string;
} | null {
  const db = getDb();
  const r = db
    .prepare(
      "SELECT * FROM research_packages WHERE cache_key = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(cacheKey) as Record<string, unknown> | undefined;
  if (!r) return null;
  const expiresAt = String(r.expires_at);
  if (!opts.allowExpired && expiresAt < new Date().toISOString()) {
    return null;
  }
  try {
    return {
      packageId: String(r.package_id),
      pkg: JSON.parse(String(r.package_json)),
      createdAt: String(r.created_at),
      expiresAt,
      contentHash: String(r.content_hash),
      effectiveMode: String(r.effective_mode),
      strategyVersion: String(r.strategy_version),
    };
  } catch {
    return null;
  }
}

/**
 * Resolves a track-level ResearchPackage by explicit packageId or by matching goal/topic,
 * enabling all lessons in a track to reuse global research without repeating web searches.
 */
export function getTrackResearchPackageFromDb(opts: {
  packageId?: string | null;
  goal?: string | null;
  topic?: string | null;
}): {
  packageId: string;
  pkg: unknown;
  createdAt: string;
  expiresAt: string;
  effectiveMode: string;
} | null {
  const db = getDb();
  let r: Record<string, unknown> | undefined;
  if (opts.packageId?.trim()) {
    r = db
      .prepare(
        "SELECT * FROM research_packages WHERE package_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(opts.packageId.trim()) as Record<string, unknown> | undefined;
  }
  if (!r && (opts.goal?.trim() || opts.topic?.trim())) {
    const g = (opts.goal || opts.topic || "").trim();
    const t = (opts.topic || opts.goal || "").trim();
    r = db
      .prepare(
        `SELECT * FROM research_packages
         WHERE goal = ? OR topic = ? OR goal LIKE ? OR topic LIKE ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(g, t, `%${t.slice(0, 32)}%`, `%${t.slice(0, 32)}%`) as
      | Record<string, unknown>
      | undefined;
  }
  if (!r) return null;
  try {
    return {
      packageId: String(r.package_id),
      pkg: JSON.parse(String(r.package_json)),
      createdAt: String(r.created_at),
      expiresAt: String(r.expires_at),
      effectiveMode: String(r.effective_mode),
    };
  } catch {
    return null;
  }
}

export function saveCurriculumBlueprintToDb(entry: {
  blueprintId: string;
  goalId: string;
  trackId?: string | null;
  version: number;
  researchPackageId?: string | null;
  status: string;
  blueprint: unknown;
  validationReport?: unknown;
}): void {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO curriculum_blueprints
      (blueprint_id, goal_id, track_id, version, research_package_id, status, blueprint_json, validation_report_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(blueprint_id) DO UPDATE SET
      track_id = COALESCE(excluded.track_id, curriculum_blueprints.track_id),
      version = excluded.version,
      status = excluded.status,
      blueprint_json = excluded.blueprint_json,
      validation_report_json = excluded.validation_report_json,
      updated_at = excluded.updated_at`,
  ).run(
    entry.blueprintId,
    entry.goalId,
    entry.trackId ?? null,
    entry.version,
    entry.researchPackageId ?? null,
    entry.status,
    JSON.stringify(entry.blueprint),
    entry.validationReport ? JSON.stringify(entry.validationReport) : null,
    nowIso,
    nowIso,
  );
}

export function getLatestCurriculumBlueprintFromDb(
  trackOrGoalId: string,
): { blueprintId: string; version: number; blueprint: unknown; validationReport: unknown } | null {
  const db = getDb();
  const r = db
    .prepare(
      `SELECT * FROM curriculum_blueprints
       WHERE track_id = ? OR goal_id = ? OR blueprint_id = ?
       ORDER BY version DESC, updated_at DESC LIMIT 1`,
    )
    .get(trackOrGoalId, trackOrGoalId, trackOrGoalId) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    blueprintId: String(r.blueprint_id),
    version: Number(r.version ?? 1),
    blueprint: JSON.parse(String(r.blueprint_json)),
    validationReport: r.validation_report_json
      ? JSON.parse(String(r.validation_report_json))
      : null,
  };
}

export function saveTeachingDecisionToDb(entry: {
  decisionId: string;
  workflowId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  goalId?: string | null;
  trackId?: string | null;
  lessonId: string;
  learningSessionId: string;
  action: string;
  conceptId: string;
  objective: string;
  rationale: string;
  decision: unknown;
}): void {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO teaching_decisions
      (decision_id, workflow_id, task_id, run_id, goal_id, track_id, lesson_id, learning_session_id, action, concept_id, objective, rationale, decision_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.decisionId,
    entry.workflowId ?? null,
    entry.taskId ?? null,
    entry.runId ?? null,
    entry.goalId ?? null,
    entry.trackId ?? null,
    entry.lessonId,
    entry.learningSessionId,
    entry.action,
    entry.conceptId,
    entry.objective,
    entry.rationale,
    JSON.stringify(entry.decision),
    nowIso,
  );
}

export function listTeachingDecisionsForLessonFromDb(
  lessonId: string,
  limit = 10,
): Array<{
  decisionId: string;
  action: string;
  conceptId: string;
  objective: string;
  rationale: string;
  createdAt: string;
  decision: unknown;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM teaching_decisions WHERE lesson_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(lessonId, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    decisionId: String(r.decision_id),
    action: String(r.action),
    conceptId: String(r.concept_id),
    objective: String(r.objective),
    rationale: String(r.rationale),
    createdAt: String(r.created_at),
    decision: (() => {
      try {
        return JSON.parse(String(r.decision_json));
      } catch {
        return {};
      }
    })(),
  }));
}

export function saveTeachingActivityToDb(entry: {
  activityId: string;
  lessonId: string;
  learningSessionId?: string | null;
  decisionId?: string | null;
  activityType: string;
  schemaVersion: number;
  gradingMode: string;
  status?: string;
  spec: unknown;
  linkedExerciseId?: string | null;
}): void {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO teaching_activities
      (activity_id, lesson_id, learning_session_id, decision_id, activity_type, schema_version, grading_mode, status, spec_json, linked_exercise_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(activity_id) DO UPDATE SET
      status = excluded.status,
      spec_json = excluded.spec_json,
      linked_exercise_id = COALESCE(excluded.linked_exercise_id, teaching_activities.linked_exercise_id),
      updated_at = excluded.updated_at`,
  ).run(
    entry.activityId,
    entry.lessonId,
    entry.learningSessionId ?? null,
    entry.decisionId ?? null,
    entry.activityType,
    entry.schemaVersion,
    entry.gradingMode,
    entry.status ?? "active",
    JSON.stringify(entry.spec),
    entry.linkedExerciseId ?? null,
    nowIso,
    nowIso,
  );
}

export function listTeachingActivitiesForLessonFromDb(
  lessonId: string,
  limit = 20,
): Array<{
  activityId: string;
  lessonId: string;
  learningSessionId: string | null;
  decisionId: string | null;
  activityType: string;
  schemaVersion: number;
  gradingMode: string;
  status: string;
  spec: unknown;
  linkedExerciseId: string | null;
  createdAt: string;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM teaching_activities WHERE lesson_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(lessonId, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    activityId: String(r.activity_id),
    lessonId: String(r.lesson_id),
    learningSessionId: r.learning_session_id
      ? String(r.learning_session_id)
      : null,
    decisionId: r.decision_id ? String(r.decision_id) : null,
    activityType: String(r.activity_type),
    schemaVersion: Number(r.schema_version ?? 1),
    gradingMode: String(r.grading_mode),
    status: String(r.status),
    spec: (() => {
      try {
        return JSON.parse(String(r.spec_json));
      } catch {
        return {};
      }
    })(),
    linkedExerciseId: r.linked_exercise_id
      ? String(r.linked_exercise_id)
      : null,
    createdAt: String(r.created_at),
  }));
}

export function saveLessonContentVersionToDb(entry: {
  contentId: string;
  lessonId: string;
  trackId?: string | null;
  version: number;
  depth: string;
  status: string;
  researchPackageId?: string | null;
  blueprintId?: string | null;
  content: unknown;
  qualityReport?: unknown;
}): void {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO lesson_content_versions
      (content_id, lesson_id, track_id, version, depth, status, research_package_id, blueprint_id, content_json, quality_report_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(content_id) DO UPDATE SET
      status = excluded.status,
      content_json = excluded.content_json,
      quality_report_json = excluded.quality_report_json`,
  ).run(
    entry.contentId,
    entry.lessonId,
    entry.trackId ?? null,
    entry.version,
    entry.depth,
    entry.status,
    entry.researchPackageId ?? null,
    entry.blueprintId ?? null,
    JSON.stringify(entry.content),
    entry.qualityReport ? JSON.stringify(entry.qualityReport) : null,
    nowIso,
  );
}

export function getLatestLessonContentVersionFromDb(
  lessonId: string,
  depth?: string,
): {
  contentId: string;
  version: number;
  depth: string;
  status: string;
  content: unknown;
  qualityReport: unknown;
  createdAt: string;
} | null {
  const db = getDb();
  const r = (
    depth
      ? db
          .prepare(
            "SELECT * FROM lesson_content_versions WHERE lesson_id = ? AND depth = ? ORDER BY version DESC, created_at DESC LIMIT 1",
          )
          .get(lessonId, depth)
      : db
          .prepare(
            "SELECT * FROM lesson_content_versions WHERE lesson_id = ? ORDER BY version DESC, created_at DESC LIMIT 1",
          )
          .get(lessonId)
  ) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    contentId: String(r.content_id),
    version: Number(r.version ?? 1),
    depth: String(r.depth),
    status: String(r.status),
    content: JSON.parse(String(r.content_json)),
    qualityReport: r.quality_report_json
      ? JSON.parse(String(r.quality_report_json))
      : null,
    createdAt: String(r.created_at),
  };
}

export function getVisualExplainerCacheFromDb(cacheKey: string): {
  cacheKey: string;
  visualId: string;
  lessonId: string;
  contractVersion: number;
  conceptId: string;
  visualType: string;
  spec: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
} | null {
  const db = getDb();
  const r = db
    .prepare("SELECT * FROM visual_explainer_cache WHERE cache_key = ? LIMIT 1")
    .get(cacheKey) as Record<string, unknown> | undefined;
  if (!r) return null;
  try {
    return {
      cacheKey: String(r.cache_key),
      visualId: String(r.visual_id),
      lessonId: String(r.lesson_id),
      contractVersion: Number(r.contract_version ?? 1),
      conceptId: String(r.concept_id),
      visualType: String(r.visual_type),
      spec: JSON.parse(String(r.spec_json)) as Record<string, unknown>,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  } catch {
    return null;
  }
}

export function saveVisualExplainerCacheToDb(entry: {
  cacheKey: string;
  visualId: string;
  lessonId: string;
  contractVersion: number;
  conceptId: string;
  visualType: string;
  spec: Record<string, unknown>;
}): void {
  const db = getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO visual_explainer_cache
      (cache_key, visual_id, lesson_id, contract_version, concept_id, visual_type, spec_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
      visual_id = excluded.visual_id,
      contract_version = excluded.contract_version,
      spec_json = excluded.spec_json,
      updated_at = excluded.updated_at`,
  ).run(
    entry.cacheKey,
    entry.visualId,
    entry.lessonId,
    entry.contractVersion,
    entry.conceptId,
    entry.visualType,
    JSON.stringify(entry.spec),
    nowIso,
    nowIso,
  );
}

export function invalidateVisualCacheForLessonInDb(lessonId: string): number {
  const db = getDb();
  const res = db
    .prepare("DELETE FROM visual_explainer_cache WHERE lesson_id = ?")
    .run(lessonId);
  return Number(res.changes ?? 0);
}
