import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import {
  archiveChatThreadInDb,
  closeDbForTesting,
  getDb,
  getFullAgentTraceFromDb,
  listAuditFromDb,
  listChatThreadsFromDb,
  markRunningAgentRunsCancelledForThreadInDb,
  markStaleRunningTasksInterruptedInDb,
  restoreChatThreadInDb,
  upsertChatThreadMetaInDb,
  upsertTraceRunInDb,
  upsertTraceToolCallInDb,
} from "../lib/db";
import {
  prepareContextForLLM,
  resolveModelContextBudget,
} from "../lib/context-manager";
import { formatStoreContextForLLM } from "../lib/ai-config";
import { emptyStore, type Store } from "../lib/learning";

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "learnos-wave3-"));
  const dbPath = join(dir, "test.sqlite");
  process.env.LEARNOS_DB_PATH = dbPath;
  return {
    cleanup() {
      closeDbForTesting();
      delete process.env.LEARNOS_DB_PATH;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

test("Wave 3 (AGENT-11, FAIL-07, cross-run tool_call_id isolation, cancelled/interrupted Run sync)", () => {
  const env = makeTempDb();
  try {
    const now = new Date().toISOString();

    // Two distinct runs reuse the EXACT same model tool_call_id='call_e2e_toolerror'
    upsertTraceRunInDb({
      run_id: "run-a",
      conversation_id: "thread-a",
      user_id: "local",
      route: "agent",
      provider: "mock",
      model: "mock-1",
      model_label: "mock-1",
      user_prompt: "run a",
      started_at: now,
      completed_at: now,
      status: "completed",
      total_duration_ms: 100,
      step_count: 1,
      tool_call_count: 1,
      reasoning_chars: 0,
      final_response: "done a",
      error_message: null,
      trace_write_errors: 0,
      tool_names: ["propose_reschedule"],
    });
    upsertTraceToolCallInDb({
      tool_call_id: "call_e2e_toolerror",
      run_id: "run-a",
      step_id: "s1",
      tool_name: "propose_reschedule",
      arguments: { blockId: "b1" },
      requested_at: now,
      started_at: now,
      completed_at: now,
      execution_status: "succeeded",
      result: { ok: true },
      error: null,
      duration_ms: 10,
    });
    // Re-sync run-a summary
    upsertTraceRunInDb({
      run_id: "run-a",
      conversation_id: "thread-a",
      user_id: "local",
      route: "agent",
      provider: "mock",
      model: "mock-1",
      model_label: "mock-1",
      user_prompt: "run a",
      started_at: now,
      completed_at: now,
      status: "completed",
      total_duration_ms: 100,
      step_count: 1,
      tool_call_count: 1,
      reasoning_chars: 0,
      final_response: "done a",
      error_message: null,
      trace_write_errors: 0,
      tool_names: ["propose_reschedule"],
    });

    // Run B uses the SAME tool_call_id, fails in tool execution, yet completes its final response
    upsertTraceToolCallInDb({
      tool_call_id: "call_e2e_toolerror",
      run_id: "run-b",
      step_id: "s2",
      tool_name: "manage_calendar_block",
      arguments: { action: "delete", blockId: "nonexistent" },
      requested_at: now,
      started_at: now,
      completed_at: now,
      execution_status: "failed",
      result: null,
      error: "未找到日程块",
      duration_ms: 5,
    });
    upsertTraceRunInDb({
      run_id: "run-b",
      conversation_id: "thread-b",
      user_id: "local",
      route: "agent",
      provider: "mock",
      model: "mock-1",
      model_label: "mock-1",
      user_prompt: "run b",
      started_at: now,
      completed_at: now,
      status: "completed",
      total_duration_ms: 80,
      step_count: 1,
      tool_call_count: 1,
      reasoning_chars: 0,
      final_response: "done b",
      error_message: null,
      trace_write_errors: 0,
      tool_names: ["manage_calendar_block"],
    });

    // Verify cross-run isolation
    const traceA = getFullAgentTraceFromDb("run-a");
    const traceB = getFullAgentTraceFromDb("run-b");
    assert.equal(traceA?.toolCalls.length, 1);
    assert.equal(traceA?.toolCalls[0].tool_name, "propose_reschedule");
    assert.equal(traceB?.toolCalls.length, 1);
    assert.equal(traceB?.toolCalls[0].tool_name, "manage_calendar_block");
    assert.equal(traceB?.toolCalls[0].execution_status, "failed");

    // Verify AGENT-11 / FAIL-07: Run B summary tool_calls_json accurately marks ok=false!
    const audit = listAuditFromDb(10);
    const runB = audit.runs.find((r) => r.runId === "run-b");
    assert.ok(runB);
    assert.equal(runB.toolCalls[0].toolName, "manage_calendar_block");
    assert.equal(runB.toolCalls[0].ok, false);

    // Verify cancelled & interrupted agent_runs reconciliation
    upsertTraceRunInDb({
      run_id: "run-cancel",
      conversation_id: "thread-cancel",
      user_id: "local",
      route: "agent",
      provider: "mock",
      model: "mock-1",
      model_label: "mock-1",
      user_prompt: "cancel me",
      started_at: now,
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
    });
    upsertTraceRunInDb({
      run_id: "run-crash",
      conversation_id: "thread-crash",
      user_id: "local",
      route: "agent",
      provider: "mock",
      model: "mock-1",
      model_label: "mock-1",
      user_prompt: "crash me",
      started_at: now,
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
    });

    assert.equal(markRunningAgentRunsCancelledForThreadInDb("thread-cancel"), 1);
    markStaleRunningTasksInterruptedInDb(new Set());

    const db = getDb();
    const cancelRow = db
      .prepare("SELECT status FROM agent_runs WHERE run_id = ?")
      .get("run-cancel") as { status: string };
    const crashRow = db
      .prepare("SELECT status FROM agent_runs WHERE run_id = ?")
      .get("run-crash") as { status: string };
    assert.equal(cancelRow.status, "cancelled");
    assert.equal(crashRow.status, "interrupted");
  } finally {
    env.cleanup();
  }
});

test("Wave 3 (CTX-10/11/17/18, FAIL-21, MEM-09, CONV-11): Adaptive model budget, toolSchemaTokens accounting, oversized single message degradation, unrelated chat memory filtering, and thread archive/restore", () => {
  const env = makeTempDb();
  try {
    // CTX-10 / CTX-17: Model-adaptive budget
    assert.equal(resolveModelContextBudget("mock-4k"), 2880);
    assert.equal(resolveModelContextBudget("deepseek-chat"), 24000);
    assert.equal(resolveModelContextBudget("custom-model", 4000), 2880);

    // CTX-11 / FAIL-21 / CTX-18: Oversized 50,000 Chinese char message degraded before hitting model
    const giantText = "测试".repeat(25000) + "【末尾唯一标记-END】";
    const msgs: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: giantText }] },
    ];
    const prep = prepareContextForLLM({
      messages: msgs,
      taskType: "chat",
      systemPromptTokens: 600,
      toolSchemaTokens: 2600,
      maxContextTokens: 8000,
    });
    assert.equal(prep.stats.toolSchemaTokens, 2600);
    assert.equal(prep.stats.inputDegraded, true);
    assert.ok(prep.stats.compactedTokens < 8000);
    const sentText = prep.messagesForLLM[0].parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    assert.ok(sentText.includes("【末尾唯一标记-END】"));
    assert.ok(sentText.length < giantText.length);

    // MEM-09: Unrelated general chat does NOT inject learning memories
    const store: Store = {
      ...emptyStore("2026-11-21"),
      memories: [
        {
          id: "m1",
          label: "学习偏好",
          category: "preference",
          text: "偏好晚上 19:00 学习 AI Agent",
        },
      ],
    };
    const chatCtx = formatStoreContextForLLM(store, "2026-11-21", {
      taskType: "chat",
    });
    const planCtx = formatStoreContextForLLM(store, "2026-11-21", {
      taskType: "plan",
    });
    assert.equal(chatCtx.includes("偏好晚上 19:00"), false);
    assert.equal(planCtx.includes("偏好晚上 19:00"), true);

    // CONV-03 / CONV-11: Thread kind persistence & archive/restore lifecycle
    const meta = upsertChatThreadMetaInDb("chat-plan-1", {
      title: "规划讨论",
      trackId: "tr-1",
      threadKind: "planning",
    });
    assert.equal(meta.threadKind, "planning");
    assert.equal(meta.archivedAt, null);

    archiveChatThreadInDb("chat-plan-1");
    assert.equal(
      listChatThreadsFromDb(50, { includeArchived: false }).some(
        (t) => t.threadId === "chat-plan-1",
      ),
      false,
    );
    assert.equal(
      listChatThreadsFromDb(50, { includeArchived: true }).some(
        (t) => t.threadId === "chat-plan-1" && Boolean(t.archivedAt),
      ),
      true,
    );

    restoreChatThreadInDb("chat-plan-1");
    assert.equal(
      listChatThreadsFromDb(50, { includeArchived: false }).some(
        (t) => t.threadId === "chat-plan-1" && !t.archivedAt,
      ),
      true,
    );
  } finally {
    env.cleanup();
  }
});
