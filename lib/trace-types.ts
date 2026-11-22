/**
 * Structured Agent Execution Trace domain types.
 * Covers Phase 2 (Structured Trace), Phase 3 (State Changes), Phase 5 (Real-Time Streaming),
 * and Phase 6 (Security & Reliability).
 */

export type AgentTraceEventType =
  | "run.started"
  | "model.request"
  | "model.response"
  | "tool.requested"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "state.changed"
  | "run.completed"
  | "run.failed";

export type AgentTraceRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentToolExecutionStatus =
  | "requested"
  | "running"
  | "succeeded"
  | "failed";

export type AgentStateEntityType =
  | "learning_state"
  | "assessment_record"
  | "memory"
  | "learning_track"
  | "study_plan"
  | "schedule_replanning";

export type AgentTraceRun = {
  run_id: string;
  conversation_id: string;
  user_id: string;
  route: "agent" | "tutor";
  provider: string;
  model: string;
  model_label: string;
  user_prompt: string;
  started_at: string;
  completed_at: string | null;
  status: AgentTraceRunStatus;
  total_duration_ms: number;
  step_count: number;
  tool_call_count: number;
  reasoning_chars: number;
  final_response: string | null;
  error_message: string | null;
  trace_write_errors: number;
  tool_names: string[];
};

export type AgentTraceEvent = {
  step_id: string;
  run_id: string;
  parent_span_id: string | null;
  seq: number;
  event_type: AgentTraceEventType;
  timestamp: string;
  duration_ms: number | null;
  status: "ok" | "running" | "error" | "skipped";
  tool_call_id: string | null;
  tool_name: string | null;
  payload: Record<string, unknown>;
};

export type AgentToolCallTrace = {
  tool_call_id: string;
  run_id: string;
  step_id: string;
  tool_name: string;
  arguments: unknown;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  execution_status: AgentToolExecutionStatus;
  result: unknown | null;
  error: string | null;
  duration_ms: number | null;
};

export type AgentStateChangeTrace = {
  change_id: string;
  run_id: string;
  tool_call_id: string | null;
  entity_type: AgentStateEntityType;
  entity_id: string;
  action: "create" | "update" | "delete" | "propose" | "failed";
  before_state: unknown | null;
  after_state: unknown | null;
  source: string;
  status: "succeeded" | "failed";
  error: string | null;
  timestamp: string;
};

export type FullAgentTrace = {
  run: AgentTraceRun;
  events: AgentTraceEvent[];
  toolCalls: AgentToolCallTrace[];
  stateChanges: AgentStateChangeTrace[];
};

export type LiveTraceMessage =
  | {
      kind: "run";
      run: AgentTraceRun;
    }
  | {
      kind: "event";
      runId: string;
      event: AgentTraceEvent;
      run: AgentTraceRun;
    }
  | {
      kind: "tool_call";
      runId: string;
      toolCall: AgentToolCallTrace;
    }
  | {
      kind: "state_change";
      runId: string;
      stateChange: AgentStateChangeTrace;
    };
