import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTraceRecorder,
  subscribeLiveTrace,
} from "../lib/agent-trace";
import {
  closeDbForTesting,
  getFullAgentTraceFromDb,
  listTraceRunsFromDb,
} from "../lib/db";
import { sanitizeTracePayload } from "../lib/trace-sanitizer";

function withMemoryDb(fn: () => Promise<void> | void) {
  return async () => {
    const prev = process.env.LEARNOS_DB_PATH;
    process.env.LEARNOS_DB_PATH = ":memory:";
    closeDbForTesting();
    try {
      await fn();
    } finally {
      closeDbForTesting();
      if (prev === undefined) delete process.env.LEARNOS_DB_PATH;
      else process.env.LEARNOS_DB_PATH = prev;
    }
  };
}

test(
  "Trace Scenario 1: single tool call (present_interactive_check) records complete arguments, result & duration",
  withMemoryDb(async () => {
    const trace = new AgentTraceRecorder({
      runId: "run-single-001",
      conversationId: "agent-main",
      provider: "deepseek",
      model: "deepseek-chat",
      modelLabel: "DeepSeek (deepseek-chat)",
      userPrompt: "帮我出一道 Java 变量填空题",
    });

    trace.recordRunStarted({ day: "2026-11-21" });
    trace.startModelRequest({
      iteration: 1,
      messageCount: 1,
      availableTools: ["present_interactive_check"],
    });

    const args = {
      mode: "fill_blank",
      lessonId: "java-1",
      lessonTitle: "Java 变量与类型",
      prompt: "补全下方声明：",
      starterCode: "___1___ age = 20;",
      blanks: [{ id: "blank-1", label: "空(1)", answer: "int" }],
    };

    const result = await trace.wrapToolExecution({
      toolCallId: "tc-check-001",
      toolName: "present_interactive_check",
      args,
      execute: () => ({
        kind: "interactive_check",
        checkId: "chk-abc123",
        ...args,
      }),
    });

    assert.equal(result.checkId, "chk-abc123");

    trace.recordModelResponse({
      iteration: 1,
      text: "已为你生成填空题。",
      finishReason: "tool-calls",
      requestedToolCalls: [
        {
          toolCallId: "tc-check-001",
          toolName: "present_interactive_check",
          input: args,
        },
      ],
    });
    trace.recordRunCompleted({
      finalResponse: "请在上方卡片完成填空作答。",
      stepCount: 1,
    });

    const loaded = getFullAgentTraceFromDb("run-single-001");
    assert.ok(loaded);
    assert.equal(loaded!.run.status, "completed");
    assert.equal(loaded!.run.final_response, "请在上方卡片完成填空作答。");
    assert.equal(loaded!.toolCalls.length, 1);

    const tc = loaded!.toolCalls[0];
    assert.equal(tc.tool_call_id, "tc-check-001");
    assert.equal(tc.tool_name, "present_interactive_check");
    assert.equal(tc.execution_status, "succeeded");
    assert.deepEqual(tc.arguments, args);
    assert.equal((tc.result as { checkId: string }).checkId, "chk-abc123");
    assert.ok(typeof tc.duration_ms === "number" && tc.duration_ms >= 0);
  }),
);

test(
  "Trace Scenario 2: multiple tool calls (save_memory, create_learning_track, present_interactive_check, record_learning_assessment) correlate strictly by tool_call_id",
  withMemoryDb(async () => {
    const trace = new AgentTraceRecorder({
      runId: "run-multi-002",
      conversationId: "agent-main",
      provider: "deepseek",
      model: "deepseek-chat",
      modelLabel: "DeepSeek (deepseek-chat)",
      userPrompt: "我每天晚上 20:00 后学 45 分钟，帮我建 Java 轨道并做首次评测",
    });

    trace.recordRunStarted();
    trace.startModelRequest({
      iteration: 1,
      messageCount: 1,
      availableTools: [
        "save_memory",
        "create_learning_track",
        "present_interactive_check",
        "record_learning_assessment",
      ],
    });

    await trace.wrapToolExecution({
      toolCallId: "tc-m1",
      toolName: "save_memory",
      args: { category: "constraint", text: "每晚 20:00 后学习 45 分钟" },
      execute: () => ({ kind: "memory_saved", memoryId: "mem-101" }),
      captureStateChanges: () => [
        {
          entityType: "memory",
          entityId: "mem-101",
          action: "create",
          beforeState: null,
          afterState: { text: "每晚 20:00 后学习 45 分钟" },
        },
      ],
    });

    await trace.wrapToolExecution({
      toolCallId: "tc-t2",
      toolName: "create_learning_track",
      args: { title: "Java 后端", units: [{ title: "JVM 内存" }] },
      execute: () => ({ kind: "track_created", planId: "plan-202" }),
      captureStateChanges: () => [
        {
          entityType: "learning_track",
          entityId: "plan-202",
          action: "create",
          beforeState: { trackCount: 0 },
          afterState: { trackCount: 1, title: "Java 后端" },
        },
        {
          entityType: "study_plan",
          entityId: "plan-202",
          action: "create",
          beforeState: { blockCount: 0 },
          afterState: { blockCount: 3 },
        },
      ],
    });

    await trace.wrapToolExecution({
      toolCallId: "tc-c3",
      toolName: "present_interactive_check",
      args: { mode: "code", lessonId: "u-1", prompt: "写一个 HelloWorld" },
      execute: () => ({ kind: "interactive_check", checkId: "chk-303" }),
    });

    await trace.wrapToolExecution({
      toolCallId: "tc-a4",
      toolName: "record_learning_assessment",
      args: { lessonId: "u-1", correct: true, summary: "掌握良好" },
      execute: () => ({
        kind: "mastery_update",
        attemptId: "att-404",
        before: 20,
        after: 62,
      }),
      captureStateChanges: () => [
        {
          entityType: "learning_state",
          entityId: "u-1",
          action: "update",
          beforeState: { mastery: 20 },
          afterState: { mastery: 62 },
        },
        {
          entityType: "assessment_record",
          entityId: "att-404",
          action: "create",
          beforeState: null,
          afterState: { correct: true },
        },
      ],
    });

    trace.recordRunCompleted({ finalResponse: "四项工具均已执行完成。", stepCount: 2 });

    const loaded = getFullAgentTraceFromDb("run-multi-002");
    assert.ok(loaded);
    assert.equal(loaded!.toolCalls.length, 4);
    assert.deepEqual(
      loaded!.toolCalls.map((t) => t.tool_call_id),
      ["tc-m1", "tc-t2", "tc-c3", "tc-a4"],
    );
    assert.equal(loaded!.stateChanges.length, 5);
    assert.equal(
      loaded!.stateChanges.filter((s) => s.tool_call_id === "tc-t2").length,
      2,
    );
    assert.equal(
      loaded!.stateChanges.filter((s) => s.tool_call_id === "tc-a4").length,
      2,
    );

    // Filter by tool name works in SQLite
    const filtered = listTraceRunsFromDb({ toolName: "record_learning_assessment" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].run_id, "run-multi-002");
  }),
);

test(
  "Trace Scenario 3: tool failure (both logical error and thrown exception) records tool.failed with error message",
  withMemoryDb(async () => {
    const trace = new AgentTraceRecorder({
      runId: "run-fail-003",
      conversationId: "agent-main",
      provider: "openai",
      model: "gpt-4o",
      modelLabel: "OpenAI (gpt-4o)",
      userPrompt: "评估不存在的课程",
    });

    trace.recordRunStarted();

    // Logical error return ({ error: ... })
    const logical = await trace.wrapToolExecution({
      toolCallId: "tc-err-1",
      toolName: "record_learning_assessment",
      args: { lessonId: "non-existent", correct: true },
      execute: () => ({ error: "未找到 lessonId=non-existent" }),
    });
    assert.equal((logical as { error: string }).error, "未找到 lessonId=non-existent");

    // Thrown runtime exception
    await assert.rejects(
      () =>
        trace.wrapToolExecution({
          toolCallId: "tc-err-2",
          toolName: "create_learning_track",
          args: { title: "Bad Track" },
          execute: () => {
            throw new Error("数据库连接超时");
          },
        }),
      /数据库连接超时/,
    );

    trace.recordRunFailed({ errorMessage: "工具执行异常终止" });

    const loaded = getFullAgentTraceFromDb("run-fail-003");
    assert.ok(loaded);
    assert.equal(loaded!.run.status, "failed");
    assert.equal(loaded!.toolCalls.length, 2);
    assert.equal(loaded!.toolCalls[0].execution_status, "failed");
    assert.match(loaded!.toolCalls[0].error || "", /non-existent/);
    assert.equal(loaded!.toolCalls[1].execution_status, "failed");
    assert.match(loaded!.toolCalls[1].error || "", /数据库连接超时/);

    const failedEvents = loaded!.events.filter((e) => e.event_type === "tool.failed");
    assert.equal(failedEvents.length, 2);
  }),
);

test(
  "Trace Scenario 4: tool succeeds but downstream state update fails -> tool.completed + failed state.changed",
  withMemoryDb(async () => {
    const trace = new AgentTraceRecorder({
      runId: "run-state-fail-004",
      conversationId: "agent-main",
      provider: "deepseek",
      model: "deepseek-chat",
      modelLabel: "DeepSeek",
      userPrompt: "保存我的学习记忆",
    });

    trace.recordRunStarted();
    const out = await trace.wrapToolExecution({
      toolCallId: "tc-ok-state-fail",
      toolName: "save_memory",
      args: { category: "goal", text: "学习 Rust" },
      execute: () => ({ kind: "memory_saved", memoryId: "mem-x" }),
      captureStateChanges: () => {
        throw new Error("SQLITE_BUSY: 写入学习状态锁冲突");
      },
    });

    // Core tool result is preserved intact!
    assert.equal(out.memoryId, "mem-x");
    trace.recordRunCompleted({ finalResponse: "已尝试写入记忆。" });

    const loaded = getFullAgentTraceFromDb("run-state-fail-004");
    assert.ok(loaded);
    assert.equal(loaded!.toolCalls[0].execution_status, "succeeded");
    assert.equal(loaded!.stateChanges.length, 1);
    assert.equal(loaded!.stateChanges[0].status, "failed");
    assert.match(loaded!.stateChanges[0].error || "", /SQLITE_BUSY/);
    assert.equal(loaded!.stateChanges[0].tool_call_id, "tc-ok-state-fail");
  }),
);

test(
  "Trace Scenario 5: direct LLM answer without tool calls does not fabricate reasoning or fake tools",
  withMemoryDb(async () => {
    const trace = new AgentTraceRecorder({
      runId: "run-direct-005",
      conversationId: "agent-main",
      provider: "openai",
      model: "gpt-4o-mini",
      modelLabel: "OpenAI (gpt-4o-mini)",
      userPrompt: "什么是 Java 的多态？",
    });

    trace.recordRunStarted();
    trace.startModelRequest({
      iteration: 1,
      messageCount: 1,
      availableTools: ["save_memory"],
    });
    trace.recordModelResponse({
      iteration: 1,
      text: "多态是指同一接口在不同子类中表现出不同的具体行为。",
      finishReason: "stop",
      usage: null,
      requestedToolCalls: [],
    });
    trace.recordRunCompleted({
      finalResponse: "多态是指同一接口在不同子类中表现出不同的具体行为。",
      stepCount: 1,
    });

    const loaded = getFullAgentTraceFromDb("run-direct-005");
    assert.ok(loaded);
    assert.equal(loaded!.toolCalls.length, 0);
    assert.equal(loaded!.stateChanges.length, 0);

    const modelRes = loaded!.events.find((e) => e.event_type === "model.response");
    assert.ok(modelRes);
    assert.equal(modelRes!.payload.reasoning, null);
    assert.equal(modelRes!.payload.reasoning_provided, false);
    assert.equal(modelRes!.payload.usage, null);
  }),
);

test(
  "Trace Scenario 6: multi-turn ReAct execution links each round's model.request -> model.response -> tool -> next round",
  withMemoryDb(async () => {
    const trace = new AgentTraceRecorder({
      runId: "run-multiturn-006",
      conversationId: "agent-main",
      provider: "deepseek",
      model: "deepseek-reasoner",
      modelLabel: "DeepSeek Reasoner",
      userPrompt: "先读取当前状态再出题",
    });

    trace.recordRunStarted();

    // Round 1
    const req1 = trace.startModelRequest({
      iteration: 1,
      messageCount: 1,
      availableTools: ["read_workspace_state", "present_interactive_check"],
    });
    await trace.wrapToolExecution({
      toolCallId: "tc-r1",
      toolName: "read_workspace_state",
      args: {},
      execute: () => ({ tracks: 1 }),
    });
    trace.recordModelResponse({
      iteration: 1,
      text: "",
      reasoningText: "先观测工作区状态",
      finishReason: "tool-calls",
      requestedToolCalls: [
        { toolCallId: "tc-r1", toolName: "read_workspace_state", input: {} },
      ],
    });

    // Round 2
    const req2 = trace.startModelRequest({
      iteration: 2,
      messageCount: 3,
      availableTools: ["read_workspace_state", "present_interactive_check"],
    });
    await trace.wrapToolExecution({
      toolCallId: "tc-r2",
      toolName: "present_interactive_check",
      args: { mode: "order_steps", steps: ["编译", "加载", "执行"] },
      execute: () => ({ kind: "interactive_check", checkId: "chk-r2" }),
    });
    trace.recordModelResponse({
      iteration: 2,
      text: "请排出正确顺序。",
      finishReason: "stop",
      requestedToolCalls: [
        {
          toolCallId: "tc-r2",
          toolName: "present_interactive_check",
          input: { mode: "order_steps" },
        },
      ],
    });

    trace.recordRunCompleted({ finalResponse: "请排出正确顺序。", stepCount: 2 });

    const loaded = getFullAgentTraceFromDb("run-multiturn-006");
    assert.ok(loaded);
    assert.equal(loaded!.run.step_count, 2);
    assert.equal(loaded!.events.filter((e) => e.event_type === "model.request").length, 2);
    assert.equal(loaded!.events.filter((e) => e.event_type === "model.response").length, 2);
    assert.notEqual(req1.step_id, req2.step_id);
  }),
);

test(
  "Trace Scenario 7: switching pages (unsubscribing live trace listener) mid-run does not stop recording and restores full trace",
  withMemoryDb(async () => {
    const trace = new AgentTraceRecorder({
      runId: "run-live-switch-007",
      conversationId: "agent-main",
      provider: "deepseek",
      model: "deepseek-chat",
      modelLabel: "DeepSeek",
      userPrompt: "生成并切换页面",
    });

    const receivedBeforeLeave: string[] = [];
    const unsubAuditPage = subscribeLiveTrace((msg) => {
      if (msg.kind === "event" && msg.runId === "run-live-switch-007") {
        receivedBeforeLeave.push(msg.event.event_type);
      }
    });

    trace.recordRunStarted();
    trace.startModelRequest({
      iteration: 1,
      messageCount: 1,
      availableTools: ["save_memory"],
    });
    assert.deepEqual(receivedBeforeLeave, ["run.started", "model.request"]);

    // User switches away from Audit page -> unsubscribe ONLY removes read-only listener
    unsubAuditPage();

    // Agent continues running uninterrupted in background
    await trace.wrapToolExecution({
      toolCallId: "tc-bg-1",
      toolName: "save_memory",
      args: { category: "preference", text: "偏好代码填空题" },
      execute: () => ({ kind: "memory_saved", memoryId: "mem-bg" }),
    });
    trace.recordRunCompleted({ finalResponse: "后台执行完成。" });

    // Old unsubscribed listener received no further events
    assert.equal(receivedBeforeLeave.length, 2);

    // User returns to Audit page -> loads full trace from SQLite
    const recovered = getFullAgentTraceFromDb("run-live-switch-007");
    assert.ok(recovered);
    assert.equal(recovered!.run.status, "completed");
    assert.equal(recovered!.toolCalls.length, 1);
    assert.ok(recovered!.events.some((e) => e.event_type === "tool.completed"));
    assert.ok(recovered!.events.some((e) => e.event_type === "run.completed"));
  }),
);

test("Trace Scenario 8: reopening SQLite file database after app restart restores historical trace by run_id", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "learnos-trace-test-"));
  const dbFile = join(tempDir, "test-trace.sqlite");
  const prev = process.env.LEARNOS_DB_PATH;
  process.env.LEARNOS_DB_PATH = dbFile;
  closeDbForTesting();

  try {
    // Session 1: write trace and close DB (simulating app quit)
    const trace = new AgentTraceRecorder({
      runId: "run-persist-008",
      conversationId: "conv-reopen",
      provider: "gemini",
      model: "gemini-2.5-flash",
      modelLabel: "Gemini 2.5 Flash",
      userPrompt: "持久化历史 Trace 验证",
    });
    trace.recordRunStarted();
    await trace.wrapToolExecution({
      toolCallId: "tc-p8",
      toolName: "present_interactive_check",
      args: { mode: "short_answer", prompt: "解释 FSRS 稳定期" },
      execute: () => ({ kind: "interactive_check", checkId: "chk-p8" }),
    });
    trace.recordRunCompleted({ finalResponse: "持久化完成。" });

    closeDbForTesting();

    // Session 2: reopen same SQLite file and reload by run_id
    const reloaded = getFullAgentTraceFromDb("run-persist-008");
    assert.ok(reloaded);
    assert.equal(reloaded!.run.run_id, "run-persist-008");
    assert.equal(reloaded!.run.provider, "gemini");
    assert.equal(reloaded!.run.model, "gemini-2.5-flash");
    assert.equal(reloaded!.run.final_response, "持久化完成。");
    assert.equal(reloaded!.toolCalls.length, 1);
    assert.equal(reloaded!.toolCalls[0].tool_call_id, "tc-p8");
  } finally {
    closeDbForTesting();
    if (prev === undefined) delete process.env.LEARNOS_DB_PATH;
    else process.env.LEARNOS_DB_PATH = prev;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

test(
  "Trace Scenario 9: concurrent agent runs keep events, tool calls, and state changes strictly isolated",
  withMemoryDb(async () => {
    const traceA = new AgentTraceRecorder({
      runId: "run-concurrent-A",
      conversationId: "thread-A",
      provider: "deepseek",
      model: "deepseek-chat",
      modelLabel: "DeepSeek",
      userPrompt: "并发任务 A",
    });
    const traceB = new AgentTraceRecorder({
      runId: "run-concurrent-B",
      conversationId: "thread-B",
      provider: "openai",
      model: "gpt-4o",
      modelLabel: "OpenAI",
      userPrompt: "并发任务 B",
    });

    traceA.recordRunStarted();
    traceB.recordRunStarted();

    await Promise.all([
      traceA.wrapToolExecution({
        toolCallId: "tc-A1",
        toolName: "save_memory",
        args: { text: "A 记忆" },
        execute: async () => {
          await new Promise((r) => setTimeout(r, 20));
          return { kind: "memory_saved", memoryId: "mem-A" };
        },
        captureStateChanges: () => [
          {
            entityType: "memory",
            entityId: "mem-A",
            action: "create",
            afterState: { owner: "A" },
          },
        ],
      }),
      traceB.wrapToolExecution({
        toolCallId: "tc-B1",
        toolName: "create_learning_track",
        args: { title: "B 轨道" },
        execute: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return { kind: "track_created", planId: "plan-B" };
        },
        captureStateChanges: () => [
          {
            entityType: "learning_track",
            entityId: "plan-B",
            action: "create",
            afterState: { owner: "B" },
          },
        ],
      }),
    ]);

    traceA.recordRunCompleted({ finalResponse: "完成 A" });
    traceB.recordRunCompleted({ finalResponse: "完成 B" });

    const loadedA = getFullAgentTraceFromDb("run-concurrent-A");
    const loadedB = getFullAgentTraceFromDb("run-concurrent-B");

    assert.ok(loadedA && loadedB);
    assert.equal(loadedA!.toolCalls.length, 1);
    assert.equal(loadedA!.toolCalls[0].tool_call_id, "tc-A1");
    assert.equal(loadedA!.stateChanges[0].entity_id, "mem-A");
    assert.ok(loadedA!.events.every((e) => e.run_id === "run-concurrent-A"));

    assert.equal(loadedB!.toolCalls.length, 1);
    assert.equal(loadedB!.toolCalls[0].tool_call_id, "tc-B1");
    assert.equal(loadedB!.stateChanges[0].entity_id, "plan-B");
    assert.ok(loadedB!.events.every((e) => e.run_id === "run-concurrent-B"));
  }),
);

test(
  "Trace Scenario 10: sensitive credentials are redacted, huge payloads are bounded, and trace DB write errors never break core execution",
  withMemoryDb(async () => {
    // 1. Redaction & Payload Bounds
    const dirty = {
      apiKey: "sk-1234567890abcdef1234567890",
      headers: {
        Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.supersecretpayload",
      },
      prompt: "请使用密钥 sk-abcdef1234567890xyz 来测试接口",
      hugeBlob: "X".repeat(30_000),
    };
    const cleaned = sanitizeTracePayload(dirty) as Record<string, unknown>;
    const serialized = JSON.stringify(cleaned);
    assert.ok(!serialized.includes("sk-1234567890abcdef"));
    assert.ok(!serialized.includes("sk-abcdef1234567890xyz"));
    assert.ok(!serialized.includes("supersecretpayload"));
    assert.equal(cleaned.apiKey, "[REDACTED]");
    assert.ok(serialized.includes("[REDACTED_API_KEY]"));
    assert.ok(serialized.includes("truncated"));

    // 2. Non-fatal trace write failure observability
    const faultyTrace = new AgentTraceRecorder(
      {
        runId: "run-write-err-010",
        conversationId: "agent-main",
        provider: "deepseek",
        model: "deepseek-chat",
        modelLabel: "DeepSeek",
        userPrompt: "写入异常容错测试",
      },
      {
        insertEvent: () => {
          throw new Error("Simulated disk full");
        },
      },
    );

    const coreResult = await faultyTrace.wrapToolExecution({
      toolCallId: "tc-safe-10",
      toolName: "save_memory",
      args: { apiKey: "sk-secret999999999999", text: "核心业务仍应成功" },
      execute: () => ({ ok: true, value: 42 }),
    });

    assert.deepEqual(coreResult, { ok: true, value: 42 });
    assert.ok(
      faultyTrace.run.trace_write_errors > 0,
      "Trace persistence failure must be observable via trace_write_errors",
    );
    assert.equal(
      (faultyTrace.toolCalls[0].arguments as Record<string, unknown>).apiKey,
      "[REDACTED]",
    );
  }),
);
