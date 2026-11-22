import {
  insertTraceEventInDb,
  insertTraceStateChangeInDb,
  recordDomainEventInDb,
  upsertTraceRunInDb,
  upsertTraceToolCallInDb,
} from "./db";
import type { DomainEventType } from "./domain-activities";
import { redactSensitiveString, sanitizeTracePayload } from "./trace-sanitizer";
import type {
  AgentStateChangeTrace,
  AgentStateEntityType,
  AgentToolCallTrace,
  AgentTraceEvent,
  AgentTraceEventType,
  AgentTraceRun,
  FullAgentTrace,
  LiveTraceMessage,
} from "./trace-types";

export type LiveTraceListener = (message: LiveTraceMessage) => void;

const globalForTraceBus = globalThis as unknown as {
  __learnosTraceListeners?: Set<LiveTraceListener>;
};

function getTraceListeners(): Set<LiveTraceListener> {
  if (!globalForTraceBus.__learnosTraceListeners) {
    globalForTraceBus.__learnosTraceListeners = new Set();
  }
  return globalForTraceBus.__learnosTraceListeners;
}

/**
 * Subscribe to real-time Agent Execution Trace events across all active runs.
 * Unsubscribing ONLY removes this read-only listener and NEVER affects any running LLM task.
 */
export function subscribeLiveTrace(listener: LiveTraceListener): () => void {
  const listeners = getTraceListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishLiveTrace(message: LiveTraceMessage): void {
  for (const listener of getTraceListeners()) {
    try {
      listener(message);
    } catch (err) {
      console.error("[AgentTraceBus] listener error:", err);
    }
  }
}

export type TraceStorageHooks = {
  upsertRun: (run: AgentTraceRun) => void;
  insertEvent: (event: AgentTraceEvent) => void;
  upsertToolCall: (tc: AgentToolCallTrace) => void;
  insertStateChange: (sc: AgentStateChangeTrace) => void;
};

const DEFAULT_STORAGE: TraceStorageHooks = {
  upsertRun: upsertTraceRunInDb,
  insertEvent: insertTraceEventInDb,
  upsertToolCall: upsertTraceToolCallInDb,
  insertStateChange: insertTraceStateChangeInDb,
};

export type StateChangeSpec = {
  entityType: AgentStateEntityType;
  entityId: string;
  action: AgentStateChangeTrace["action"];
  beforeState?: unknown;
  afterState?: unknown;
  source?: string;
  status?: "succeeded" | "failed";
  error?: string | null;
};

export class AgentTraceRecorder {
  public readonly run: AgentTraceRun;
  public readonly events: AgentTraceEvent[] = [];
  public readonly toolCalls: AgentToolCallTrace[] = [];
  public readonly stateChanges: AgentStateChangeTrace[] = [];

  private seq = 0;
  private startedAtMs: number;
  private storage: TraceStorageHooks;
  private currentModelSpanId: string | null = null;
  private currentModelReqStartedMs: number | null = null;
  private toolCallMap = new Map<string, AgentToolCallTrace>();

  constructor(
    init: {
      runId: string;
      conversationId: string;
      userId?: string;
      route?: "agent" | "tutor";
      provider: string;
      model: string;
      modelLabel: string;
      userPrompt: string;
    },
    storage?: Partial<TraceStorageHooks>,
  ) {
    this.startedAtMs = Date.now();
    const nowIso = new Date(this.startedAtMs).toISOString();
    this.storage = { ...DEFAULT_STORAGE, ...(storage || {}) };
    this.run = {
      run_id: init.runId,
      conversation_id: init.conversationId || "agent-main",
      user_id: init.userId || "local-desktop-user",
      route: init.route || "agent",
      provider: init.provider || "unknown",
      model: init.model || "unknown",
      model_label: init.modelLabel || init.model || "unknown",
      user_prompt: redactSensitiveString(init.userPrompt || ""),
      started_at: nowIso,
      completed_at: null,
      status: "running",
      total_duration_ms: 0,
      step_count: 0,
      tool_call_count: 0,
      reasoning_chars: 0,
      final_response: null,
      error_message: null,
      trace_write_errors: 0,
      tool_names: [],
    };
  }

  private safeWrite(opName: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.run.trace_write_errors += 1;
      console.error(
        `[AgentTraceRecorder] non-fatal trace write error (${opName}) for run ${this.run.run_id}:`,
        err,
      );
      // Try best-effort update of trace_write_errors count if run row itself is writable
      if (opName !== "upsertRun") {
        try {
          this.storage.upsertRun({ ...this.run });
        } catch {}
      }
    }
  }

  private nextStepId(prefix: string): string {
    this.seq += 1;
    return `${this.run.run_id}-s${String(this.seq).padStart(3, "0")}-${prefix}`;
  }

  private appendEvent(params: {
    prefix: string;
    eventType: AgentTraceEventType;
    parentSpanId?: string | null;
    durationMs?: number | null;
    status: AgentTraceEvent["status"];
    toolCallId?: string | null;
    toolName?: string | null;
    payload: Record<string, unknown>;
  }): AgentTraceEvent {
    const sanitizedPayload = (sanitizeTracePayload(params.payload) ||
      {}) as Record<string, unknown>;
    const event: AgentTraceEvent = {
      step_id: this.nextStepId(params.prefix),
      run_id: this.run.run_id,
      parent_span_id: params.parentSpanId ?? null,
      seq: this.seq,
      event_type: params.eventType,
      timestamp: new Date().toISOString(),
      duration_ms: params.durationMs ?? null,
      status: params.status,
      tool_call_id: params.toolCallId ?? null,
      tool_name: params.toolName ?? null,
      payload: sanitizedPayload,
    };

    this.events.push(event);
    this.run.total_duration_ms = Math.max(0, Date.now() - this.startedAtMs);

    this.safeWrite("insertEvent", () => this.storage.insertEvent(event));
    this.safeWrite("upsertRun", () => this.storage.upsertRun({ ...this.run }));

    publishLiveTrace({
      kind: "event",
      runId: this.run.run_id,
      event,
      run: { ...this.run },
    });

    return event;
  }

  getActiveModelSpanId(): string | null {
    return this.currentModelSpanId;
  }

  recordRunStarted(meta?: Record<string, unknown>): AgentTraceEvent {
    this.safeWrite("upsertRun", () => this.storage.upsertRun({ ...this.run }));
    publishLiveTrace({ kind: "run", run: { ...this.run } });
    return this.appendEvent({
      prefix: "start",
      eventType: "run.started",
      status: "ok",
      payload: {
        user_prompt: this.run.user_prompt,
        conversation_id: this.run.conversation_id,
        user_id: this.run.user_id,
        provider: this.run.provider,
        model: this.run.model,
        ...(meta || {}),
      },
    });
  }

  startModelRequest(meta: {
    iteration: number;
    messageCount: number;
    availableTools: string[];
    attachedContext?: unknown;
  }): AgentTraceEvent {
    this.currentModelReqStartedMs = Date.now();
    const ev = this.appendEvent({
      prefix: `mreq${meta.iteration}`,
      eventType: "model.request",
      status: "running",
      payload: {
        iteration: meta.iteration,
        provider: this.run.provider,
        model: this.run.model,
        message_count: meta.messageCount,
        available_tools: meta.availableTools,
        attached_context: meta.attachedContext ?? null,
      },
    });
    this.currentModelSpanId = ev.step_id;
    return ev;
  }

  recordModelResponse(params: {
    iteration: number;
    text: string;
    reasoningText?: string;
    finishReason?: string;
    usage?: Record<string, unknown> | null;
    requestedToolCalls?: Array<{
      toolCallId: string;
      toolName: string;
      input: unknown;
    }>;
  }): AgentTraceEvent {
    const durationMs =
      this.currentModelReqStartedMs !== null
        ? Math.max(0, Date.now() - this.currentModelReqStartedMs)
        : null;
    const parentSpanId = this.currentModelSpanId;

    this.run.step_count = Math.max(this.run.step_count, params.iteration);
    if (params.reasoningText) {
      this.run.reasoning_chars += params.reasoningText.length;
    }

    const requested = (params.requestedToolCalls || []).map((tc) => ({
      tool_call_id: tc.toolCallId,
      tool_name: tc.toolName,
      arguments: sanitizeTracePayload(tc.input),
    }));

    const ev = this.appendEvent({
      prefix: `mres${params.iteration}`,
      eventType: "model.response",
      parentSpanId,
      durationMs,
      status: "ok",
      payload: {
        iteration: params.iteration,
        provider: this.run.provider,
        model: this.run.model,
        finish_reason: params.finishReason || "未提供",
        visible_output: params.text || "",
        reasoning: params.reasoningText?.trim()
          ? params.reasoningText
          : null,
        reasoning_provided: Boolean(params.reasoningText?.trim()),
        usage: params.usage ?? null,
        requested_tool_calls: requested,
      },
    });

    this.currentModelReqStartedMs = null;
    return ev;
  }

  recordToolRequested(params: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    parentSpanId?: string | null;
  }): AgentTraceEvent {
    const nowIso = new Date().toISOString();
    const sanitizedArgs = sanitizeTracePayload(params.args);

    const ev = this.appendEvent({
      prefix: "treq",
      eventType: "tool.requested",
      parentSpanId: params.parentSpanId ?? this.currentModelSpanId,
      status: "ok",
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      payload: {
        tool_call_id: params.toolCallId,
        tool_name: params.toolName,
        arguments: sanitizedArgs,
        execution_status: "requested",
      },
    });

    const tc: AgentToolCallTrace = {
      tool_call_id: params.toolCallId,
      run_id: this.run.run_id,
      step_id: ev.step_id,
      tool_name: params.toolName,
      arguments: sanitizedArgs,
      requested_at: nowIso,
      started_at: null,
      completed_at: null,
      execution_status: "requested",
      result: null,
      error: null,
      duration_ms: null,
    };

    if (!this.toolCallMap.has(params.toolCallId)) {
      this.toolCalls.push(tc);
      this.run.tool_call_count = this.toolCalls.length;
      this.run.tool_names = this.toolCalls.map((t) => t.tool_name);
    }
    this.toolCallMap.set(params.toolCallId, tc);

    this.safeWrite("upsertToolCall", () => this.storage.upsertToolCall(tc));
    this.safeWrite("upsertRun", () => this.storage.upsertRun({ ...this.run }));
    publishLiveTrace({ kind: "tool_call", runId: this.run.run_id, toolCall: tc });

    return ev;
  }

  recordToolStarted(params: {
    toolCallId: string;
    toolName: string;
    parentSpanId?: string | null;
  }): AgentTraceEvent {
    const nowIso = new Date().toISOString();
    const existing = this.toolCallMap.get(params.toolCallId);
    if (existing) {
      existing.started_at = nowIso;
      existing.execution_status = "running";
      this.safeWrite("upsertToolCall", () =>
        this.storage.upsertToolCall({ ...existing }),
      );
      publishLiveTrace({
        kind: "tool_call",
        runId: this.run.run_id,
        toolCall: { ...existing },
      });
    }

    return this.appendEvent({
      prefix: "tstart",
      eventType: "tool.started",
      parentSpanId: params.parentSpanId ?? existing?.step_id ?? this.currentModelSpanId,
      status: "running",
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      payload: {
        tool_call_id: params.toolCallId,
        tool_name: params.toolName,
        execution_status: "running",
      },
    });
  }

  recordToolCompleted(params: {
    toolCallId: string;
    toolName: string;
    result: unknown;
    durationMs: number;
    parentSpanId?: string | null;
  }): AgentTraceEvent {
    const nowIso = new Date().toISOString();
    const sanitizedResult = sanitizeTracePayload(params.result);
    const existing = this.toolCallMap.get(params.toolCallId);
    if (existing) {
      existing.completed_at = nowIso;
      existing.execution_status = "succeeded";
      existing.result = sanitizedResult;
      existing.duration_ms = params.durationMs;
      this.safeWrite("upsertToolCall", () =>
        this.storage.upsertToolCall({ ...existing }),
      );
      publishLiveTrace({
        kind: "tool_call",
        runId: this.run.run_id,
        toolCall: { ...existing },
      });
    }

    return this.appendEvent({
      prefix: "tdone",
      eventType: "tool.completed",
      parentSpanId: params.parentSpanId ?? existing?.step_id ?? this.currentModelSpanId,
      durationMs: params.durationMs,
      status: "ok",
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      payload: {
        tool_call_id: params.toolCallId,
        tool_name: params.toolName,
        execution_status: "succeeded",
        duration_ms: params.durationMs,
        result: sanitizedResult,
      },
    });
  }

  recordToolFailed(params: {
    toolCallId: string;
    toolName: string;
    error: string;
    result?: unknown;
    durationMs: number;
    parentSpanId?: string | null;
  }): AgentTraceEvent {
    const nowIso = new Date().toISOString();
    const cleanError = redactSensitiveString(params.error);
    const sanitizedResult =
      params.result !== undefined ? sanitizeTracePayload(params.result) : null;
    const existing = this.toolCallMap.get(params.toolCallId);
    if (existing) {
      existing.completed_at = nowIso;
      existing.execution_status = "failed";
      existing.error = cleanError;
      existing.result = sanitizedResult;
      existing.duration_ms = params.durationMs;
      this.safeWrite("upsertToolCall", () =>
        this.storage.upsertToolCall({ ...existing }),
      );
      publishLiveTrace({
        kind: "tool_call",
        runId: this.run.run_id,
        toolCall: { ...existing },
      });
    }

    return this.appendEvent({
      prefix: "tfail",
      eventType: "tool.failed",
      parentSpanId: params.parentSpanId ?? existing?.step_id ?? this.currentModelSpanId,
      durationMs: params.durationMs,
      status: "error",
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      payload: {
        tool_call_id: params.toolCallId,
        tool_name: params.toolName,
        execution_status: "failed",
        duration_ms: params.durationMs,
        error: cleanError,
        result: sanitizedResult,
      },
    });
  }

  recordStateChange(params: {
    toolCallId?: string | null;
    parentSpanId?: string | null;
    spec: StateChangeSpec;
  }): AgentStateChangeTrace {
    const nowIso = new Date().toISOString();
    const sc: AgentStateChangeTrace = {
      change_id: `chg-${crypto.randomUUID().slice(0, 10)}`,
      run_id: this.run.run_id,
      tool_call_id: params.toolCallId ?? null,
      entity_type: params.spec.entityType,
      entity_id: params.spec.entityId,
      action: params.spec.action,
      before_state:
        params.spec.beforeState !== undefined
          ? sanitizeTracePayload(params.spec.beforeState)
          : null,
      after_state:
        params.spec.afterState !== undefined
          ? sanitizeTracePayload(params.spec.afterState)
          : null,
      source: params.spec.source || "agent-tool",
      status: params.spec.status || "succeeded",
      error: params.spec.error ? redactSensitiveString(params.spec.error) : null,
      timestamp: nowIso,
    };

    this.stateChanges.push(sc);
    this.safeWrite("insertStateChange", () => this.storage.insertStateChange(sc));

    if (sc.status === "succeeded") {
      const domainTypeMap: Partial<Record<AgentStateEntityType, DomainEventType>> = {
        learning_track: "GoalCreated",
        assessment_record: "AssessmentCompleted",
        memory: "MemoryUpdated",
        study_plan: "CalendarChanged",
        schedule_replanning: "CalendarChanged",
      };
      const mappedEventType = domainTypeMap[sc.entity_type];
      if (mappedEventType) {
        this.safeWrite("recordDomainEvent", () =>
          recordDomainEventInDb({
            eventType: mappedEventType,
            entityType: sc.entity_type,
            entityId: sc.entity_id,
            summary: `${mappedEventType} (${sc.action}) · ${sc.source}`,
            payload: {
              tool_call_id: sc.tool_call_id,
              action: sc.action,
              after_state: sc.after_state,
            },
            runId: this.run.run_id,
          }),
        );
      }
    }

    publishLiveTrace({
      kind: "state_change",
      runId: this.run.run_id,
      stateChange: sc,
    });

    this.appendEvent({
      prefix: "state",
      eventType: "state.changed",
      parentSpanId: params.parentSpanId ?? this.currentModelSpanId,
      status: sc.status === "failed" ? "error" : "ok",
      toolCallId: sc.tool_call_id,
      toolName: sc.source.startsWith("tool:") ? sc.source.slice(5) : null,
      payload: {
        change_id: sc.change_id,
        entity_type: sc.entity_type,
        entity_id: sc.entity_id,
        action: sc.action,
        source: sc.source,
        status: sc.status,
        error: sc.error,
        before_state: sc.before_state,
        after_state: sc.after_state,
      },
    });

    return sc;
  }

  recordRunCompleted(params: {
    finalResponse: string;
    stepCount?: number;
    reasoningChars?: number;
  }): AgentTraceEvent {
    const nowIso = new Date().toISOString();
    const cleanFinal = redactSensitiveString(params.finalResponse || "");
    this.run.status = "completed";
    this.run.completed_at = nowIso;
    this.run.total_duration_ms = Math.max(0, Date.now() - this.startedAtMs);
    this.run.final_response = cleanFinal;
    if (params.stepCount !== undefined) {
      this.run.step_count = Math.max(this.run.step_count, params.stepCount);
    }
    if (params.reasoningChars !== undefined) {
      this.run.reasoning_chars = Math.max(
        this.run.reasoning_chars,
        params.reasoningChars,
      );
    }

    return this.appendEvent({
      prefix: "done",
      eventType: "run.completed",
      durationMs: this.run.total_duration_ms,
      status: "ok",
      payload: {
        status: "completed",
        total_duration_ms: this.run.total_duration_ms,
        step_count: this.run.step_count,
        tool_call_count: this.run.tool_call_count,
        state_change_count: this.stateChanges.length,
        final_response: cleanFinal,
        trace_write_errors: this.run.trace_write_errors,
      },
    });
  }

  recordRunFailed(params: {
    errorMessage: string;
    cancelled?: boolean;
    stepCount?: number;
  }): AgentTraceEvent {
    const nowIso = new Date().toISOString();
    const cleanErr = redactSensitiveString(params.errorMessage || "执行失败");
    this.run.status = params.cancelled ? "cancelled" : "failed";
    this.run.completed_at = nowIso;
    this.run.total_duration_ms = Math.max(0, Date.now() - this.startedAtMs);
    this.run.error_message = cleanErr;
    if (params.stepCount !== undefined) {
      this.run.step_count = Math.max(this.run.step_count, params.stepCount);
    }

    return this.appendEvent({
      prefix: "fail",
      eventType: "run.failed",
      durationMs: this.run.total_duration_ms,
      status: "error",
      payload: {
        status: this.run.status,
        total_duration_ms: this.run.total_duration_ms,
        error: cleanErr,
        trace_write_errors: this.run.trace_write_errors,
      },
    });
  }

  /**
   * Instruments a single tool execution end-to-end:
   * tool.requested -> tool.started -> execute() -> tool.completed / tool.failed -> state.changed
   * Never swallows tool execution return values; guarantees tool_call_id correlation.
   */
  async wrapToolExecution<TResult>(params: {
    toolCallId?: string;
    toolName: string;
    args: unknown;
    execute: () => Promise<TResult> | TResult;
    captureStateChanges?: (result: TResult) => StateChangeSpec[] | Promise<StateChangeSpec[]>;
  }): Promise<TResult> {
    const toolCallId =
      params.toolCallId ||
      `tc-${this.run.run_id.slice(-6)}-${crypto.randomUUID().slice(0, 8)}`;

    const reqEvent = this.recordToolRequested({
      toolCallId,
      toolName: params.toolName,
      args: params.args,
    });
    this.recordToolStarted({
      toolCallId,
      toolName: params.toolName,
      parentSpanId: reqEvent.step_id,
    });

    const t0 = Date.now();
    try {
      const result = await params.execute();
      const durationMs = Math.max(0, Date.now() - t0);

      const isLogicalError =
        Boolean(result) &&
        typeof result === "object" &&
        "error" in (result as Record<string, unknown>) &&
        typeof (result as Record<string, unknown>).error === "string" &&
        !("kind" in (result as Record<string, unknown>));

      if (isLogicalError) {
        this.recordToolFailed({
          toolCallId,
          toolName: params.toolName,
          error: String((result as Record<string, unknown>).error),
          result,
          durationMs,
          parentSpanId: reqEvent.step_id,
        });
      } else {
        this.recordToolCompleted({
          toolCallId,
          toolName: params.toolName,
          result,
          durationMs,
          parentSpanId: reqEvent.step_id,
        });

        if (params.captureStateChanges) {
          try {
            const specs = await params.captureStateChanges(result);
            for (const spec of specs) {
              this.recordStateChange({
                toolCallId,
                parentSpanId: reqEvent.step_id,
                spec: {
                  ...spec,
                  source: spec.source || `tool:${params.toolName}`,
                },
              });
            }
          } catch (stateErr) {
            // Tool succeeded, but downstream state persistence/capture failed -> record visibly!
            this.recordStateChange({
              toolCallId,
              parentSpanId: reqEvent.step_id,
              spec: {
                entityType: "learning_state",
                entityId: toolCallId,
                action: "failed",
                source: `tool:${params.toolName}`,
                status: "failed",
                error:
                  stateErr instanceof Error
                    ? stateErr.message
                    : String(stateErr),
              },
            });
          }
        }
      }

      return result;
    } catch (err) {
      const durationMs = Math.max(0, Date.now() - t0);
      const errMsg = err instanceof Error ? err.message : String(err);
      this.recordToolFailed({
        toolCallId,
        toolName: params.toolName,
        error: errMsg,
        durationMs,
        parentSpanId: reqEvent.step_id,
      });
      throw err;
    }
  }

  snapshot(): FullAgentTrace {
    return {
      run: { ...this.run },
      events: [...this.events],
      toolCalls: [...this.toolCalls],
      stateChanges: [...this.stateChanges],
    };
  }
}
