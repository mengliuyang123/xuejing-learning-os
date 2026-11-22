import test from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import {
  estimateMessagesTokens,
  foldOldToolOutputs,
  isContextOverflowError,
  prepareContextForLLM,
} from "../lib/context-manager";
import {
  closeDbForTesting,
  deleteChatThreadFromDb,
  getChatThreadFromDb,
  getChatThreadMetaFromDb,
  listChatThreadsFromDb,
  loadStoreFromDb,
  saveChatThreadToDb,
  saveStoreToDb,
  updateChatThreadSummaryInDb,
  upsertChatThreadMetaInDb,
} from "../lib/db";
import { initial } from "../lib/learning";

function makeToolMessage(
  id: string,
  toolName: string,
  input: unknown,
  output: unknown,
  text: string,
  reasoning?: string,
): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      ...(reasoning ? [{ type: "reasoning" as const, text: reasoning }] : []),
      {
        type: `tool-${toolName}`,
        toolCallId: `tc-${id}`,
        state: "output-available",
        input,
        output,
      } as unknown as UIMessage["parts"][number],
      { type: "text" as const, text },
    ],
  };
}

function makeUserMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

test("Context Manager Layer 1: folds old tool JSON outputs (>2 turns ago) while keeping recent 2 turns intact", () => {
  const bigWorkspaceSnapshot = {
    today: "2026-11-21",
    tracks: Array.from({ length: 4 }, (_, i) => ({
      id: `track-${i}`,
      title: `课程轨道 ${i}`,
      units: Array.from({ length: 6 }, (_, j) => ({
        id: `u-${i}-${j}`,
        title: `第 ${j + 1} 课核心原理与实战演练`,
        concept: "详细概念解释与大量先修依赖说明字段".repeat(8),
        mastery: 45,
      })),
    })),
    upcomingBlocks: Array.from({ length: 16 }, (_, i) => ({
      id: `blk-${i}`,
      day: "2026-11-21",
      title: `学习日程块 ${i}`,
      minutes: 45,
    })),
  };

  const bigTrackCreated = {
    kind: "track_created",
    plan: {
      id: "plan-java",
      title: "Java 后端核心速通",
      units: Array.from({ length: 5 }, (_, i) => ({
        id: `java-${i}`,
        title: `Java 第 ${i + 1} 课`,
        concept: "JVM 内存模型与面向对象机制详解".repeat(10),
      })),
      slots: Array.from({ length: 5 }, (_, i) => ({
        id: `slot-${i}`,
        day: "2026-11-21",
        start: 1200 + i * 30,
        minutes: 30,
        title: `Java 第 ${i + 1} 课`,
      })),
    },
  };

  const messages: UIMessage[] = [
    // Turn 1 (old -> should be folded)
    makeUserMessage("u1", "看看我当前的学习进度"),
    makeToolMessage(
      "a1",
      "read_workspace_state",
      {},
      bigWorkspaceSnapshot,
      "我读取了你的当前工作区。",
      "内部思考：先读取状态，再决定下一步计划…".repeat(12),
    ),
    // Turn 2 (old -> should be folded)
    makeUserMessage("u2", "帮我创建 Java 后端学习轨道"),
    makeToolMessage(
      "a2",
      "create_learning_track",
      { title: "Java 后端核心速通", goal: "求职面试" },
      bigTrackCreated,
      "已创建 Java 后端核心速通轨道。",
    ),
    // Turn 3 (recent -> must stay verbatim)
    makeUserMessage("u3", "开始第一节课并出一道填空题"),
    makeToolMessage(
      "a3",
      "present_interactive_check",
      { mode: "fill_blank", lessonTitle: "类与对象" },
      {
        kind: "interactive_check",
        checkId: "chk-recent",
        mode: "fill_blank",
        lessonTitle: "类与对象",
        starterCode: "User u = ___1___ User();",
      },
      "请完成上方代码填空题。",
    ),
    // Turn 4 (recent -> must stay verbatim)
    makeUserMessage("u4", "我填 new"),
    makeToolMessage(
      "a4",
      "record_learning_assessment",
      { lessonId: "java-0", correct: true },
      {
        kind: "mastery_update",
        lessonTitle: "类与对象",
        before: 20,
        after: 65,
        correct: true,
      },
      "答对了！掌握度已提升到 65%。",
    ),
  ];

  const beforeTokens = estimateMessagesTokens(messages);
  const { messages: folded, foldedToolCount } = foldOldToolOutputs(messages, 2);
  const afterTokens = estimateMessagesTokens(folded);

  assert.equal(foldedToolCount, 2);
  assert.ok(
    afterTokens < beforeTokens * 0.4,
    `Expected >60% token reduction, got before=${beforeTokens}, after=${afterTokens}`,
  );

  // Turns 1 & 2 tool outputs are folded to short summaries and old reasoning stripped
  const a1Tool = folded[1].parts.find((p) => p.type.startsWith("tool-")) as {
    output: { _folded?: boolean; summary?: string };
  };
  assert.equal(a1Tool.output._folded, true);
  assert.match(a1Tool.output.summary || "", /read_workspace_state/);
  assert.ok(!folded[1].parts.some((p) => p.type === "reasoning"));

  const a2Tool = folded[3].parts.find((p) => p.type.startsWith("tool-")) as {
    output: { _folded?: boolean; summary?: string };
  };
  assert.equal(a2Tool.output._folded, true);
  assert.match(a2Tool.output.summary || "", /Java 后端核心速通/);

  // Recent Turns 3 & 4 remain 100% verbatim
  const a3Tool = folded[5].parts.find((p) => p.type.startsWith("tool-")) as {
    output: { checkId?: string; _folded?: boolean };
  };
  assert.equal(a3Tool.output._folded, undefined);
  assert.equal(a3Tool.output.checkId, "chk-recent");
});

test("Context Manager Layer 2 & 3: rolling compaction above 70% budget, SQLite thread_summary persistence & overflow detection", () => {
  const prev = process.env.LEARNOS_DB_PATH;
  process.env.LEARNOS_DB_PATH = ":memory:";
  closeDbForTesting();

  try {
    const longMessages: UIMessage[] = [];
    for (let i = 1; i <= 8; i++) {
      longMessages.push(
        makeUserMessage(
          `u-${i}`,
          `第 ${i} 轮提问：请详细讲解 Java 第 ${i} 个知识点，包含代码示例、内存布局与常见面试追问。`,
        ),
      );
      longMessages.push({
        id: `a-${i}`,
        role: "assistant",
        parts: [
          {
            type: "text",
            text: `第 ${i} 轮详细讲解内容：`.concat(
              "在 JVM 中，堆内存负责存储对象实例，栈帧保存局部变量表和操作数栈，元空间保存类元数据。".repeat(
                8,
              ),
            ),
          },
        ],
      });
    }

    // Trigger Layer 2 rolling compaction with a small budget (exceeds 70% of 1000 tokens)
    const prepared = prepareContextForLLM({
      messages: longMessages,
      systemPromptTokens: 150,
      maxContextTokens: 1000,
      compactionThresholdRatio: 0.7,
      recentTurnsToKeepOnCompaction: 2,
    });

    assert.equal(prepared.stats.rollingCompacted, true);
    assert.equal(prepared.summaryUpdated, true);
    assert.ok(prepared.threadSummary && prepared.threadSummary.includes("第 1 轮提问"));
    assert.equal(prepared.messagesForLLM.length, 4); // last 2 turns (2 user + 2 assistant)
    assert.ok(prepared.stats.savedPct >= 40);

    // Save full UI history + rolling summary to SQLite -> UI keeps all 16 messages while summary persists
    saveChatThreadToDb("track-java", "agent", longMessages, {
      title: "轨道 · Java 后端",
      trackId: "java",
    });
    updateChatThreadSummaryInDb(
      "track-java",
      prepared.threadSummary!,
      prepared.summaryCoveredCount,
    );

    const uiMessages = getChatThreadFromDb("track-java");
    assert.equal(uiMessages.length, 16, "Frontend UI must retain full history");

    const meta = getChatThreadMetaFromDb("track-java");
    assert.ok(meta);
    assert.equal(meta!.hasSummary, true);
    assert.equal(meta!.summaryMsgCount, prepared.summaryCoveredCount);
    assert.equal(meta!.trackId, "java");

    // Layer 3: Overflow error classifier & aggressive compaction
    assert.equal(
      isContextOverflowError(
        new Error("This model's maximum context length is 128000 tokens (context_length_exceeded)"),
      ),
      true,
    );
    assert.equal(isContextOverflowError(new Error("401 Authentication Fails")), false);

    const aggressive = prepareContextForLLM({
      messages: longMessages,
      existingSummary: prepared.threadSummary,
      existingSummaryCount: prepared.summaryCoveredCount,
      aggressive: true,
    });
    assert.equal(aggressive.stats.aggressive, true);
    assert.equal(aggressive.messagesForLLM.length, 2); // only latest turn kept
  } finally {
    closeDbForTesting();
    if (prev === undefined) delete process.env.LEARNOS_DB_PATH;
    else process.env.LEARNOS_DB_PATH = prev;
  }
});

test("Multi-Session & Track-Scoped Threading: creating/deleting threads never clears SQLite graph, schedule, or memories", () => {
  const prev = process.env.LEARNOS_DB_PATH;
  process.env.LEARNOS_DB_PATH = ":memory:";
  closeDbForTesting();

  try {
    const store = initial("2026-11-21");
    store.memories.push({
      id: "mem-keep",
      label: "学习目标",
      category: "goal",
      text: "长期掌握 Java 与 Python",
    });
    saveStoreToDb(store, { trigger: "init" });

    upsertChatThreadMetaInDb("track-java", {
      title: "轨道 · Java 后端",
      trackId: "java",
    });
    saveChatThreadToDb("track-java", "agent", [
      makeUserMessage("uj1", "学习 Java 类与对象"),
    ]);

    upsertChatThreadMetaInDb("chat-temp", {
      title: "临时问答",
    });
    saveChatThreadToDb("chat-temp", "agent", [
      makeUserMessage("ut1", "随便问个问题"),
    ]);

    const list = listChatThreadsFromDb();
    assert.equal(list.length, 2);
    assert.ok(list.some((t) => t.threadId === "track-java" && t.trackId === "java"));

    // Delete temporary thread
    deleteChatThreadFromDb("chat-temp");
    assert.equal(listChatThreadsFromDb().length, 1);

    // Core SQLite memories & workspace state remain 100% intact
    const reloadedStore = loadStoreFromDb("2026-11-21");
    assert.equal(reloadedStore.memories.length, 1);
    assert.equal(reloadedStore.memories[0].id, "mem-keep");
  } finally {
    closeDbForTesting();
    if (prev === undefined) delete process.env.LEARNOS_DB_PATH;
    else process.env.LEARNOS_DB_PATH = prev;
  }
});
