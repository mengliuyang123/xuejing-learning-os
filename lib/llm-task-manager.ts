import type { UIMessage } from "ai";
import type { LLMTaskRecord, LLMTaskStatus } from "./db";

export type LLMTaskSnapshot = LLMTaskRecord & {
  messages: UIMessage[];
  previewText: string;
};

export type LLMTaskEventType =
  | "started"
  | "progress"
  | "tool_output"
  | "completed"
  | "cancelled"
  | "failed"
  | "hydrated"
  | "thread_updated";

export type LLMTaskEvent = {
  type: LLMTaskEventType;
  taskId: string;
  threadId: string;
  status: LLMTaskStatus | "idle";
  task: LLMTaskSnapshot | null;
  messages: UIMessage[];
  toolCallId?: string;
  toolName?: string;
  toolOutput?: unknown;
  error?: string;
};

export type LLMTaskListener = (event: LLMTaskEvent) => void;

export type LLMTaskStatusSummary = {
  threadId?: string;
  taskId: string | null;
  status: LLMTaskStatus | "idle";
  isRunning: boolean;
  userPrompt: string;
  previewText: string;
  errorMessage?: string;
  activeTasks: LLMTaskSnapshot[];
  latestTask: LLMTaskSnapshot | null;
};

export type StartLLMTaskInput = {
  threadId?: string;
  taskId?: string;
  userText: string;
  baseMessages?: UIMessage[];
  modelLabel?: string;
  requestPayload?: Record<string, unknown>;
};

export type LLMTaskStorageAdapter = {
  saveTask: (task: LLMTaskRecord, syncChatThread?: boolean) => Promise<void>;
  loadThread: (threadId: string) => Promise<{
    messages: UIMessage[];
    latestTask: LLMTaskRecord | null;
    tasks?: LLMTaskRecord[];
  }>;
  loadTask: (taskId: string) => Promise<LLMTaskRecord | null>;
  cancelServerTask: (taskId: string) => Promise<void>;
  saveThreadMessages: (threadId: string, messages: UIMessage[]) => Promise<void>;
  clearThread: (threadId: string) => Promise<void>;
};

export type LLMTaskStreamAdapter = (params: {
  taskId: string;
  threadId: string;
  messages: UIMessage[];
  requestPayload: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<Response>;

function extractAssistantPreview(msg: UIMessage | null): string {
  if (!msg || !Array.isArray(msg.parts)) return "";
  const texts: string[] = [];
  for (const p of msg.parts) {
    if (p.type === "text" && p.text) {
      texts.push(p.text);
    }
  }
  return texts.join("").trim();
}

function cloneMessage(msg: UIMessage): UIMessage {
  return {
    ...msg,
    parts: msg.parts.map((p) => ({ ...p })),
  };
}

function createDefaultStorageAdapter(): LLMTaskStorageAdapter {
  return {
    async saveTask(task, syncChatThread = true) {
      await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, syncChatThread }),
      });
    },
    async loadThread(threadId) {
      const res = await fetch(
        `/api/tasks?threadId=${encodeURIComponent(threadId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return { messages: [], latestTask: null, tasks: [] };
      const data = (await res.json()) as {
        messages?: UIMessage[];
        latestTask?: LLMTaskRecord | null;
        tasks?: LLMTaskRecord[];
      };
      return {
        messages: Array.isArray(data.messages) ? data.messages : [],
        latestTask: data.latestTask || null,
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
      };
    },
    async loadTask(taskId) {
      const res = await fetch(
        `/api/tasks?taskId=${encodeURIComponent(taskId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { task?: LLMTaskRecord | null };
      return data.task || null;
    },
    async cancelServerTask(taskId) {
      await fetch(`/api/tasks?taskId=${encodeURIComponent(taskId)}`, {
        method: "DELETE",
      });
    },
    async saveThreadMessages(threadId, messages) {
      await fetch("/api/chats", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          scope: "agent",
          messages,
        }),
      });
    },
    async clearThread(threadId) {
      await fetch(`/api/chats?threadId=${encodeURIComponent(threadId)}`, {
        method: "DELETE",
      });
    },
  };
}

function createDefaultStreamAdapter(): LLMTaskStreamAdapter {
  return async ({ taskId, threadId, messages, requestPayload, signal }) => {
    return fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...requestPayload,
        taskId,
        threadId,
        messages,
      }),
      signal,
    });
  };
}

type InternalTaskHandle = {
  record: LLMTaskRecord;
  controller: AbortController;
  lastSavedAt: number;
};

type SubscriberEntry = {
  listener: LLMTaskListener;
  filter?: { threadId?: string; taskId?: string };
};

export class LLMTaskManager {
  private storage: LLMTaskStorageAdapter;
  private streamAdapter: LLMTaskStreamAdapter;
  private tasks = new Map<string, InternalTaskHandle>();
  private latestTaskByThread = new Map<string, string>();
  private threadMessages = new Map<string, UIMessage[]>();
  private hydratedThreads = new Set<string>();
  private subscribers = new Set<SubscriberEntry>();

  constructor(opts?: {
    storage?: LLMTaskStorageAdapter;
    streamAdapter?: LLMTaskStreamAdapter;
  }) {
    this.storage = opts?.storage || createDefaultStorageAdapter();
    this.streamAdapter = opts?.streamAdapter || createDefaultStreamAdapter();
  }

  /**
   * Subscribe to task lifecycle & streaming events.
   * Unmounting a page/component ONLY calls the returned unsubscribe callback
   * and NEVER aborts the running LLM stream.
   */
  subscribe(
    listener: LLMTaskListener,
    filter?: { threadId?: string; taskId?: string },
  ): () => void {
    const entry: SubscriberEntry = { listener, filter };
    this.subscribers.add(entry);
    return () => {
      this.subscribers.delete(entry);
    };
  }

  private emit(event: LLMTaskEvent) {
    for (const sub of this.subscribers) {
      if (sub.filter?.threadId && sub.filter.threadId !== event.threadId) {
        continue;
      }
      if (sub.filter?.taskId && sub.filter.taskId !== event.taskId) {
        continue;
      }
      try {
        sub.listener(event);
      } catch (err) {
        console.error("[LLMTaskManager] listener error:", err);
      }
    }
  }

  private toSnapshot(record: LLMTaskRecord): LLMTaskSnapshot {
    const combined: UIMessage[] =
      record.assistantMessage && record.assistantMessage.parts.length > 0
        ? [...record.baseMessages, cloneMessage(record.assistantMessage)]
        : [...record.baseMessages];
    return {
      ...record,
      assistantMessage: record.assistantMessage
        ? cloneMessage(record.assistantMessage)
        : null,
      messages: combined,
      previewText: extractAssistantPreview(record.assistantMessage),
    };
  }

  getThreadMessages(threadId = "agent-main"): UIMessage[] {
    const activeTaskId = this.latestTaskByThread.get(threadId);
    if (activeTaskId) {
      const handle = this.tasks.get(activeTaskId);
      if (handle && handle.record.status === "running") {
        return this.toSnapshot(handle.record).messages;
      }
    }
    return [...(this.threadMessages.get(threadId) || [])];
  }

  setThreadMessages(
    threadId: string,
    messages: UIMessage[],
    persist = true,
  ): void {
    const cloned = messages.map(cloneMessage);
    this.threadMessages.set(threadId, cloned);
    this.hydratedThreads.add(threadId);
    if (persist) {
      void this.storage.saveThreadMessages(threadId, cloned).catch(() => {});
    }
    const latestId = this.latestTaskByThread.get(threadId);
    const latestHandle = latestId ? this.tasks.get(latestId) : undefined;
    this.emit({
      type: "thread_updated",
      taskId: latestId || "",
      threadId,
      status: latestHandle?.record.status || "idle",
      task: latestHandle ? this.toSnapshot(latestHandle.record) : null,
      messages: cloned,
    });
  }

  /**
   * Updates a specific tool output inside a thread's message history (e.g.
   * persisting a user's selected quiz option or survey selection) and writes to SQLite.
   */
  updateToolOutput(
    threadId: string,
    toolCallId: string,
    patch: Record<string, unknown>,
  ): void {
    const current = this.getThreadMessages(threadId);
    const next = current.map((m) => {
      if (m.role !== "assistant") return m;
      return {
        ...m,
        parts: m.parts.map((p) => {
          if (
            "toolCallId" in p &&
            p.toolCallId === toolCallId &&
            "output" in p &&
            p.output &&
            typeof p.output === "object"
          ) {
            return {
              ...p,
              output: {
                ...(p.output as Record<string, unknown>),
                ...patch,
              },
            };
          }
          return p;
        }),
      };
    });
    this.setThreadMessages(threadId, next, true);
  }

  async clearThread(threadId = "agent-main"): Promise<void> {
    const latestId = this.latestTaskByThread.get(threadId);
    if (latestId) {
      const handle = this.tasks.get(latestId);
      if (handle && handle.record.status === "running") {
        await this.cancel(latestId);
      }
      this.latestTaskByThread.delete(threadId);
    }
    this.threadMessages.set(threadId, []);
    await this.storage.clearThread(threadId).catch(() => {});
    this.emit({
      type: "thread_updated",
      taskId: "",
      threadId,
      status: "idle",
      task: null,
      messages: [],
    });
  }

  /**
   * Hydrates thread messages and latest task state from SQLite.
   * If a task for this thread is currently running in memory, preserves the
   * live in-flight stream state without overwriting it!
   */
  async hydrateThread(threadId = "agent-main"): Promise<UIMessage[]> {
    const activeId = this.latestTaskByThread.get(threadId);
    const activeHandle = activeId ? this.tasks.get(activeId) : undefined;
    if (activeHandle && activeHandle.record.status === "running") {
      const snap = this.toSnapshot(activeHandle.record);
      this.threadMessages.set(threadId, snap.messages);
      this.hydratedThreads.add(threadId);
      return snap.messages;
    }

    try {
      const loaded = await this.storage.loadThread(threadId);
      // Re-check in case a task started while loadThread was awaiting
      const nowActiveId = this.latestTaskByThread.get(threadId);
      const nowActive = nowActiveId ? this.tasks.get(nowActiveId) : undefined;
      if (nowActive && nowActive.record.status === "running") {
        return this.toSnapshot(nowActive.record).messages;
      }

      let resolvedMessages = loaded.messages;
      if (loaded.latestTask) {
        const existingLocal = this.tasks.get(loaded.latestTask.taskId);
        if (!existingLocal) {
          this.tasks.set(loaded.latestTask.taskId, {
            record: loaded.latestTask,
            controller: new AbortController(),
            lastSavedAt: Date.now(),
          });
        }
        this.latestTaskByThread.set(threadId, loaded.latestTask.taskId);

        const taskMessages = this.toSnapshot(loaded.latestTask).messages;
        if (taskMessages.length >= resolvedMessages.length) {
          resolvedMessages = taskMessages;
        }
      }

      this.threadMessages.set(threadId, resolvedMessages);
      this.hydratedThreads.add(threadId);

      const latestTaskRecord = loaded.latestTask
        ? this.toSnapshot(loaded.latestTask)
        : null;

      this.emit({
        type: "hydrated",
        taskId: loaded.latestTask?.taskId || "",
        threadId,
        status: loaded.latestTask?.status || "idle",
        task: latestTaskRecord,
        messages: resolvedMessages,
      });

      return resolvedMessages;
    } catch {
      return this.getThreadMessages(threadId);
    }
  }

  /**
   * Returns current status for a threadId, taskId, or global overview of all concurrent tasks.
   */
  getStatus(threadIdOrTaskId?: string): LLMTaskStatusSummary {
    const activeTasks: LLMTaskSnapshot[] = [];
    for (const handle of this.tasks.values()) {
      if (handle.record.status === "running") {
        activeTasks.push(this.toSnapshot(handle.record));
      }
    }

    let targetHandle: InternalTaskHandle | undefined;
    if (threadIdOrTaskId) {
      if (this.tasks.has(threadIdOrTaskId)) {
        targetHandle = this.tasks.get(threadIdOrTaskId);
      } else {
        const tid = this.latestTaskByThread.get(threadIdOrTaskId);
        if (tid) targetHandle = this.tasks.get(tid);
      }
    } else if (activeTasks.length > 0) {
      targetHandle = this.tasks.get(activeTasks[0].taskId);
    } else {
      const mainTid = this.latestTaskByThread.get("agent-main");
      if (mainTid) targetHandle = this.tasks.get(mainTid);
    }

    const latestSnap = targetHandle ? this.toSnapshot(targetHandle.record) : null;
    const isRunning =
      latestSnap?.status === "running" ||
      (!threadIdOrTaskId && activeTasks.length > 0);

    return {
      threadId: targetHandle?.record.threadId || threadIdOrTaskId,
      taskId: latestSnap?.taskId || null,
      status: latestSnap?.status || "idle",
      isRunning,
      userPrompt: latestSnap?.userPrompt || "",
      previewText: latestSnap?.previewText || "",
      errorMessage: latestSnap?.errorMessage,
      activeTasks,
      latestTask: latestSnap,
    };
  }

  /**
   * Starts a background LLM streaming generation task.
   * If a task is already running on the SAME threadId, cancels the previous task on that thread;
   * tasks on DIFFERENT threadIds run concurrently without interference.
   */
  async start(input: StartLLMTaskInput): Promise<LLMTaskSnapshot> {
    const threadId = input.threadId || "agent-main";
    const taskId = input.taskId || `task-${crypto.randomUUID().slice(0, 10)}`;
    const nowIso = new Date().toISOString();

    // If same thread has an in-flight task, cancel it cleanly before starting the new turn
    const prevTaskId = this.latestTaskByThread.get(threadId);
    if (prevTaskId) {
      const prevHandle = this.tasks.get(prevTaskId);
      if (prevHandle && prevHandle.record.status === "running") {
        await this.cancel(prevTaskId);
      }
    }

    const existingMessages =
      input.baseMessages !== undefined
        ? input.baseMessages.map(cloneMessage)
        : this.getThreadMessages(threadId);

    const userMsg: UIMessage = {
      id: `user-${taskId}`,
      role: "user",
      parts: [{ type: "text", text: input.userText }],
    };

    const baseMessages = [...existingMessages, userMsg];
    const initialAssistant: UIMessage = {
      id: `asst-${taskId}`,
      role: "assistant",
      parts: [],
    };

    const record: LLMTaskRecord = {
      taskId,
      threadId,
      status: "running",
      userPrompt: input.userText,
      modelLabel: input.modelLabel || "Live LLM",
      requestPayload: input.requestPayload || {},
      baseMessages,
      assistantMessage: initialAssistant,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const controller = new AbortController();
    const handle: InternalTaskHandle = {
      record,
      controller,
      lastSavedAt: Date.now(),
    };

    this.tasks.set(taskId, handle);
    this.latestTaskByThread.set(threadId, taskId);
    this.threadMessages.set(threadId, [...baseMessages]);

    // Persist initial running task + user message to SQLite immediately
    await this.storage.saveTask(record, true).catch(() => {});

    const initialSnap = this.toSnapshot(record);
    this.emit({
      type: "started",
      taskId,
      threadId,
      status: "running",
      task: initialSnap,
      messages: initialSnap.messages,
    });

    // Launch stream consumption asynchronously in the background (not awaiting completion here? Wait:
    // Let's return a Promise that resolves when the stream finishes OR provide both sync handle & completion promise?
    // Wait: if a caller calls `await taskManager.start(...)` or starts it without awaiting, let's check:
    // In UI, `void taskManager.start(...)` starts it immediately, while in tests, having `start()` return
    // the initial running `LLMTaskSnapshot` right after the task is registered & persisted in SQLite, AND attaching
    // `waitForTask(taskId)` lets tests inspect the mid-stream state immediately after `await taskManager.start(...)`!).
    void this.consumeStreamInBackground(handle);

    return initialSnap;
  }

  /**
   * Waits for a specific taskId (or the latest task on threadId) to reach a terminal state.
   */
  async waitForCompletion(
    taskIdOrThreadId: string,
    timeoutMs = 30000,
  ): Promise<LLMTaskSnapshot | null> {
    const taskId = this.tasks.has(taskIdOrThreadId)
      ? taskIdOrThreadId
      : this.latestTaskByThread.get(taskIdOrThreadId);
    if (!taskId) return null;

    const current = this.tasks.get(taskId);
    if (!current) return null;
    if (current.record.status !== "running") {
      return this.toSnapshot(current.record);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsub();
        const h = this.tasks.get(taskId);
        resolve(h ? this.toSnapshot(h.record) : null);
      }, timeoutMs);

      const unsub = this.subscribe(
        (ev) => {
          if (
            ev.type === "completed" ||
            ev.type === "cancelled" ||
            ev.type === "failed"
          ) {
            clearTimeout(timer);
            unsub();
            resolve(ev.task);
          }
        },
        { taskId },
      );
    });
  }

  private async consumeStreamInBackground(
    handle: InternalTaskHandle,
  ): Promise<void> {
    const { record, controller } = handle;
    const { taskId, threadId } = record;
    const assistantMsg: UIMessage = record.assistantMessage || {
      id: `asst-${taskId}`,
      role: "assistant",
      parts: [],
    };
    record.assistantMessage = assistantMsg;

    // Helper to checkpoint incremental progress to SQLite & notify subscribers
    const checkpoint = async (forceDbSave = false) => {
      record.updatedAt = new Date().toISOString();
      const snap = this.toSnapshot(record);
      this.threadMessages.set(threadId, snap.messages);

      const now = Date.now();
      if (forceDbSave || now - handle.lastSavedAt >= 200) {
        handle.lastSavedAt = now;
        await this.storage.saveTask(record, true).catch(() => {});
      }

      this.emit({
        type: "progress",
        taskId,
        threadId,
        status: record.status,
        task: snap,
        messages: snap.messages,
      });
    };

    try {
      const response = await this.streamAdapter({
        taskId,
        threadId,
        messages: record.baseMessages,
        requestPayload: record.requestPayload,
        signal: controller.signal,
      });

      if (!response.ok) {
        let errText = `请求失败 (${response.status})`;
        try {
          const raw = await response.text();
          const parsed = JSON.parse(raw) as { error?: string; message?: string };
          errText = parsed.error || parsed.message || raw || errText;
        } catch {}
        throw new Error(errText);
      }

      if (!response.body) {
        throw new Error("响应流为空");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const activeTextParts = new Map<string, number>();
      const activeReasoningParts = new Map<string, number>();
      const activeToolParts = new Map<string, number>();

      const processSseLine = async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") return;

        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          return;
        }

        const type = String(evt.type || "");

        if (type === "start" && typeof evt.messageId === "string") {
          assistantMsg.id = evt.messageId;
          return;
        }

        if (type === "text-start") {
          const id = String(evt.id || "text-default");
          assistantMsg.parts.push({ type: "text", text: "" });
          activeTextParts.set(id, assistantMsg.parts.length - 1);
          return;
        }

        if (type === "text-delta") {
          const id = String(evt.id || "text-default");
          const delta = String(evt.delta ?? evt.textDelta ?? "");
          if (!delta) return;
          let idx = activeTextParts.get(id);
          if (idx === undefined || assistantMsg.parts[idx]?.type !== "text") {
            assistantMsg.parts.push({ type: "text", text: "" });
            idx = assistantMsg.parts.length - 1;
            activeTextParts.set(id, idx);
          }
          const part = assistantMsg.parts[idx] as { type: "text"; text: string };
          part.text += delta;
          await checkpoint(false);
          return;
        }

        if (type === "reasoning-start") {
          const id = String(evt.id || "reasoning-default");
          assistantMsg.parts.push({
            type: "reasoning",
            text: "",
            state: "streaming",
          } as UIMessage["parts"][number]);
          activeReasoningParts.set(id, assistantMsg.parts.length - 1);
          await checkpoint(false);
          return;
        }

        if (type === "reasoning-delta") {
          const id = String(evt.id || "reasoning-default");
          const delta = String(evt.delta ?? evt.textDelta ?? "");
          if (!delta) return;
          let idx = activeReasoningParts.get(id);
          if (
            idx === undefined ||
            assistantMsg.parts[idx]?.type !== "reasoning"
          ) {
            assistantMsg.parts.push({
              type: "reasoning",
              text: "",
              state: "streaming",
            } as UIMessage["parts"][number]);
            idx = assistantMsg.parts.length - 1;
            activeReasoningParts.set(id, idx);
          }
          const part = assistantMsg.parts[idx] as {
            type: "reasoning";
            text: string;
            state?: string;
          };
          part.text += delta;
          await checkpoint(false);
          return;
        }

        if (type === "reasoning-end") {
          const id = String(evt.id || "reasoning-default");
          const idx = activeReasoningParts.get(id);
          if (idx !== undefined && assistantMsg.parts[idx]?.type === "reasoning") {
            (
              assistantMsg.parts[idx] as {
                type: "reasoning";
                text: string;
                state?: string;
              }
            ).state = "done";
            await checkpoint(false);
          }
          return;
        }

        if (
          type === "tool-input-start" ||
          type === "tool-input-available"
        ) {
          const toolCallId = String(evt.toolCallId || crypto.randomUUID());
          const toolName = String(evt.toolName || "tool");
          const input = evt.input ?? {};
          const existingIdx = activeToolParts.get(toolCallId);
          const partObj = {
            type: `tool-${toolName}`,
            toolCallId,
            toolName,
            state:
              type === "tool-input-available"
                ? "input-available"
                : "input-streaming",
            input,
          } as unknown as UIMessage["parts"][number];

          if (existingIdx !== undefined) {
            assistantMsg.parts[existingIdx] = partObj;
          } else {
            assistantMsg.parts.push(partObj);
            activeToolParts.set(toolCallId, assistantMsg.parts.length - 1);
          }
          await checkpoint(false);
          return;
        }

        if (type === "tool-output-available") {
          const toolCallId = String(evt.toolCallId || "");
          const output = evt.output;
          const existingIdx = activeToolParts.get(toolCallId);
          let resolvedToolName = String(evt.toolName || "");

          if (existingIdx !== undefined) {
            const prev = assistantMsg.parts[existingIdx] as Record<
              string,
              unknown
            >;
            resolvedToolName =
              resolvedToolName ||
              String(prev.toolName || "").replace(/^tool-/, "") ||
              String(prev.type || "").replace(/^tool-/, "");
            assistantMsg.parts[existingIdx] = {
              ...prev,
              state: "output-available",
              output,
            } as unknown as UIMessage["parts"][number];
          } else {
            resolvedToolName = resolvedToolName || "tool";
            assistantMsg.parts.push({
              type: `tool-${resolvedToolName}`,
              toolCallId,
              toolName: resolvedToolName,
              state: "output-available",
              input: {},
              output,
            } as unknown as UIMessage["parts"][number]);
            activeToolParts.set(toolCallId, assistantMsg.parts.length - 1);
          }

          await checkpoint(true);
          const snap = this.toSnapshot(record);
          this.emit({
            type: "tool_output",
            taskId,
            threadId,
            status: record.status,
            task: snap,
            messages: snap.messages,
            toolCallId,
            toolName: resolvedToolName,
            toolOutput: output,
          });
          return;
        }

        if (type === "error") {
          const errText = String(
            evt.errorText || evt.error || "流式生成过程中发生异常",
          );
          throw new Error(errText);
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          await processSseLine(line);
        }
      }

      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          await processSseLine(line);
        }
      }

      if (controller.signal.aborted || (record.status as string) === "cancelled") {
        await this.finalizeCancelled(handle);
        return;
      }

      const nowIso = new Date().toISOString();
      record.status = "completed";
      record.updatedAt = nowIso;
      record.completedAt = nowIso;
      await this.storage.saveTask(record, true).catch(() => {});

      const finalSnap = this.toSnapshot(record);
      this.threadMessages.set(threadId, finalSnap.messages);
      this.emit({
        type: "completed",
        taskId,
        threadId,
        status: "completed",
        task: finalSnap,
        messages: finalSnap.messages,
      });
    } catch (err) {
      if (
        controller.signal.aborted ||
        (record.status as string) === "cancelled" ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        await this.finalizeCancelled(handle);
        return;
      }

      const nowIso = new Date().toISOString();
      const errMsg =
        err instanceof Error ? err.message : String(err || "生成失败");
      record.status = "failed";
      record.errorMessage = errMsg;
      record.updatedAt = nowIso;
      record.completedAt = nowIso;
      await this.storage.saveTask(record, true).catch(() => {});

      const failedSnap = this.toSnapshot(record);
      this.threadMessages.set(threadId, failedSnap.messages);
      this.emit({
        type: "failed",
        taskId,
        threadId,
        status: "failed",
        task: failedSnap,
        messages: failedSnap.messages,
        error: errMsg,
      });
    }
  }

  private async finalizeCancelled(handle: InternalTaskHandle): Promise<void> {
    const { record } = handle;
    const nowIso = new Date().toISOString();
    record.status = "cancelled";
    record.errorMessage = "用户已取消生成";
    record.updatedAt = nowIso;
    record.completedAt = nowIso;
    await this.storage.saveTask(record, true).catch(() => {});

    const snap = this.toSnapshot(record);
    this.threadMessages.set(record.threadId, snap.messages);
    this.emit({
      type: "cancelled",
      taskId: record.taskId,
      threadId: record.threadId,
      status: "cancelled",
      task: snap,
      messages: snap.messages,
    });
  }

  /**
   * Explicitly cancels a running LLM generation task by taskId or threadId.
   * Only explicit user cancellation or app shutdown calls this method.
   */
  async cancel(taskIdOrThreadId = "agent-main"): Promise<boolean> {
    const taskId = this.tasks.has(taskIdOrThreadId)
      ? taskIdOrThreadId
      : this.latestTaskByThread.get(taskIdOrThreadId);
    if (!taskId) return false;

    const handle = this.tasks.get(taskId);
    if (!handle || handle.record.status !== "running") return false;

    handle.record.status = "cancelled";
    try {
      handle.controller.abort("USER_CANCELLED");
    } catch {}

    await this.storage.cancelServerTask(taskId).catch(() => {});
    await this.finalizeCancelled(handle);
    return true;
  }

  /**
   * Retries a failed, cancelled, or interrupted task (or the latest turn on threadId).
   */
  async retry(
    taskIdOrThreadId = "agent-main",
    overrideRequestPayload?: Record<string, unknown>,
  ): Promise<LLMTaskSnapshot | null> {
    let record: LLMTaskRecord | null = null;
    if (this.tasks.has(taskIdOrThreadId)) {
      record = this.tasks.get(taskIdOrThreadId)!.record;
    } else {
      const latestId = this.latestTaskByThread.get(taskIdOrThreadId);
      if (latestId && this.tasks.has(latestId)) {
        record = this.tasks.get(latestId)!.record;
      } else {
        const loaded = await this.storage
          .loadThread(taskIdOrThreadId)
          .catch(() => null);
        record = loaded?.latestTask || null;
      }
    }

    if (!record) {
      // Fallback: if thread has messages ending with a user or assistant turn, retry last user message
      const msgs = this.getThreadMessages(taskIdOrThreadId);
      let lastUserIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx < 0) return null;
      const userMsg = msgs[lastUserIdx];
      const userText = userMsg.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      return this.start({
        threadId: taskIdOrThreadId,
        userText,
        baseMessages: msgs.slice(0, lastUserIdx),
        requestPayload: overrideRequestPayload || {},
      });
    }

    if (record.status === "running") {
      await this.cancel(record.taskId);
    }

    // baseMessages in record already ends with the user message for that turn; strip it so start() re-appends cleanly
    const priorMessages =
      record.baseMessages.at(-1)?.role === "user"
        ? record.baseMessages.slice(0, -1)
        : record.baseMessages;

    return this.start({
      threadId: record.threadId,
      userText: record.userPrompt,
      baseMessages: priorMessages,
      modelLabel: record.modelLabel,
      requestPayload: {
        ...record.requestPayload,
        ...(overrideRequestPayload || {}),
      },
    });
  }
}

type GlobalWithTaskManager = typeof globalThis & {
  __learnosClientTaskManager?: LLMTaskManager;
};

export function getClientTaskManager(): LLMTaskManager {
  const g = globalThis as GlobalWithTaskManager;
  if (!g.__learnosClientTaskManager) {
    g.__learnosClientTaskManager = new LLMTaskManager();
  }
  return g.__learnosClientTaskManager;
}
