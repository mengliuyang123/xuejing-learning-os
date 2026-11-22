import crypto from "node:crypto";
import {
  generateText,
  stepCountIs,
  tool as defineAiTool,
  type LanguageModel,
  type ToolSet,
} from "ai";
import type { z } from "zod";
import { AgentTraceRecorder } from "./agent-trace";
import { estimateTextTokens } from "./context-manager";
import {
  type DeepSeekTaskProfile,
  buildDeepSeekCallConfig,
  extractDeepSeekUsageSummary,
  extractModelIdFromInstance,
  isDeepSeekModelInstance,
} from "./deepseek-config";
import {
  findAgentTaskByIdempotencyKeyInDb,
  upsertAgentTaskInDb,
} from "./db";

export type AgentExecutionMode = "react" | "structured" | "hybrid";

export type ToolPermissionCategory =
  | "read"
  | "research"
  | "content_generation"
  | "learning"
  | "assessment"
  | "planning"
  | "memory"
  | "system";

export type AgentTaskKind =
  | "research"
  | "curriculum"
  | "lesson_preparation"
  | "teaching"
  | "general_chat";

export interface AgentTaskIdentity {
  taskId: string;
  runId: string;
  workflowId?: string;
  parentTaskId?: string;
  kind: AgentTaskKind;
  goalId?: string;
  trackId?: string;
  lessonId?: string;
  learningSessionId?: string;
}

export interface AgentTaskMetrics {
  inputTokens: number;
  outputTokens: number;
  toolResultTokens: number;
  contextBuildMs: number;
  stepsUsed: number;
  toolCallsUsed: number;
  durationMs: number;
}

export class UnauthorizedToolError extends Error {
  readonly code = "UNAUTHORIZED_TOOL_CALL";
  readonly toolName: string;
  readonly category: ToolPermissionCategory;

  constructor(toolName: string, category: ToolPermissionCategory, taskName: string) {
    super(
      `权限拒绝：任务「${taskName}」无权调用工具「${toolName}」（类别：${category}）。`,
    );
    this.name = "UnauthorizedToolError";
    this.toolName = toolName;
    this.category = category;
  }
}

export class AgentBudgetExceededError extends Error {
  readonly code = "AGENT_BUDGET_EXCEEDED";
  constructor(message: string) {
    super(message);
    this.name = "AgentBudgetExceededError";
  }
}

export interface RegisteredAgentTool<TArgs = unknown, TResult = unknown> {
  name: string;
  category: ToolPermissionCategory;
  description: string;
  writeOperation?: boolean;
  requiresUserConfirmation?: boolean;
  inputSchema: z.ZodType<TArgs>;
  execute: (
    args: TArgs,
    ctx: {
      identity: AgentTaskIdentity;
      abortSignal?: AbortSignal;
      idempotencyKey?: string;
    },
  ) => Promise<TResult> | TResult;
}

/**
 * Permission-scoped Tool Registry shared across all Planner tasks.
 * Enforces category & allowlist isolation, Zod argument validation, write idempotency,
 * and AbortSignal checks.
 */
export class AgentToolRegistry {
  private readonly tools = new Map<string, RegisteredAgentTool>();
  private readonly completedWrites = new Map<string, unknown>();

  register<TArgs, TResult>(def: RegisteredAgentTool<TArgs, TResult>): this {
    this.tools.set(def.name, def as RegisteredAgentTool);
    return this;
  }

  get(name: string): RegisteredAgentTool | undefined {
    return this.tools.get(name);
  }

  listByCategory(category: ToolPermissionCategory): RegisteredAgentTool[] {
    return [...this.tools.values()].filter((t) => t.category === category);
  }

  listNames(): string[] {
    return [...this.tools.keys()];
  }

  assertAuthorized(
    toolName: string,
    allowedTools: ReadonlySet<string>,
    allowedCategories: ReadonlySet<ToolPermissionCategory> | undefined,
    taskName: string,
  ): RegisteredAgentTool {
    const def = this.tools.get(toolName);
    if (!def) {
      throw new UnauthorizedToolError(toolName, "system", taskName);
    }
    if (!allowedTools.has(toolName)) {
      throw new UnauthorizedToolError(toolName, def.category, taskName);
    }
    if (allowedCategories && !allowedCategories.has(def.category)) {
      throw new UnauthorizedToolError(toolName, def.category, taskName);
    }
    return def;
  }

  async invoke<TResult = unknown>(opts: {
    toolName: string;
    rawArgs: unknown;
    allowedTools: ReadonlySet<string>;
    allowedCategories?: ReadonlySet<ToolPermissionCategory>;
    taskName: string;
    identity: AgentTaskIdentity;
    abortSignal?: AbortSignal;
    idempotencyKey?: string;
    trace?: AgentTraceRecorder;
    toolCallId?: string;
  }): Promise<{ result: TResult; resultTokens: number; replayed: boolean }> {
    if (opts.abortSignal?.aborted) {
      throw new Error("TASK_ABORTED");
    }
    const def = this.assertAuthorized(
      opts.toolName,
      opts.allowedTools,
      opts.allowedCategories,
      opts.taskName,
    );

    const parsed = def.inputSchema.safeParse(opts.rawArgs);
    if (!parsed.success) {
      throw new Error(
        `工具「${opts.toolName}」参数校验失败：${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("；")}`,
      );
    }

    const writeKey =
      def.writeOperation && opts.idempotencyKey
        ? `${opts.toolName}:${opts.idempotencyKey}`
        : null;
    if (writeKey && this.completedWrites.has(writeKey)) {
      const cached = this.completedWrites.get(writeKey) as TResult;
      return {
        result: cached,
        resultTokens: estimateTextTokens(JSON.stringify(cached ?? {})),
        replayed: true,
      };
    }

    const runExec = async () => {
      const out = await def.execute(parsed.data, {
        identity: opts.identity,
        abortSignal: opts.abortSignal,
        idempotencyKey: opts.idempotencyKey,
      });
      if (writeKey) this.completedWrites.set(writeKey, out);
      return out as TResult;
    };

    const result = opts.trace
      ? await opts.trace.wrapToolExecution({
          toolCallId: opts.toolCallId,
          toolName: opts.toolName,
          args: parsed.data,
          execute: runExec,
        })
      : await runExec();

    const resultTokens = estimateTextTokens(
      typeof result === "string" ? result : JSON.stringify(result ?? {}),
    );
    return { result, resultTokens, replayed: false };
  }
}

export interface AgentTaskDefinition<TInput, TOutput> {
  name: string;
  kind: AgentTaskKind;
  mode: AgentExecutionMode;
  maxSteps: number;
  timeoutMs: number;
  tokenBudget: number;
  allowedTools: string[];
  allowedCategories?: ToolPermissionCategory[];
  buildContext: (input: TInput) => Promise<{
    system: string;
    prompt: string;
    metadata?: Record<string, unknown>;
  }>;
  validateOutput: (output: unknown) => TOutput;
}

export function extractJsonObjectFromText(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("模型输出中未找到合法 JSON 对象");
  }
}

export type RuntimeModelExecutor = (params: {
  system: string;
  prompt: string;
  mode: AgentExecutionMode;
  maxSteps: number;
  tools: ToolSet;
  abortSignal: AbortSignal;
}) => Promise<{
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  stepsUsed?: number;
  cacheReadTokens?: number;
  cacheHitRate?: number;
  reasoningTokens?: number;
}>;

/**
 * Shared Unified Agent Runtime supporting:
 * - Structured Generation
 * - Bounded ReAct Execution
 * - Hybrid Execution
 * with AbortSignal, Timeout, Token Budget, Permission-Scoped Tool Registry,
 * SQLite task persistence, idempotency, and AgentTraceRecorder integration.
 */
export async function executeAgentTask<TInput, TOutput>(opts: {
  definition: AgentTaskDefinition<TInput, TOutput>;
  input: TInput;
  identity: Partial<AgentTaskIdentity> & { kind?: AgentTaskKind };
  model?: LanguageModel | string | null;
  modelLabel?: string;
  providerName?: string;
  registry?: AgentToolRegistry;
  abortSignal?: AbortSignal;
  idempotencyKey?: string;
  persistTask?: boolean;
  customExecutor?: RuntimeModelExecutor;
  maxRepairAttempts?: number;
}): Promise<{
  output: TOutput;
  identity: AgentTaskIdentity;
  metrics: AgentTaskMetrics;
  replayed: boolean;
}> {
  const startedMs = Date.now();
  const identity: AgentTaskIdentity = {
    taskId: opts.identity.taskId || `task-${crypto.randomUUID().slice(0, 10)}`,
    runId: opts.identity.runId || `run-${crypto.randomUUID().slice(0, 10)}`,
    workflowId: opts.identity.workflowId,
    parentTaskId: opts.identity.parentTaskId,
    kind: opts.identity.kind || opts.definition.kind,
    goalId: opts.identity.goalId,
    trackId: opts.identity.trackId,
    lessonId: opts.identity.lessonId,
    learningSessionId: opts.identity.learningSessionId,
  };

  // Task-level idempotency check in SQLite
  if (opts.persistTask !== false && opts.idempotencyKey) {
    try {
      const prior = findAgentTaskByIdempotencyKeyInDb(opts.idempotencyKey);
      if (prior && prior.status === "completed" && prior.result != null) {
        const validated = opts.definition.validateOutput(prior.result);
        return {
          output: validated,
          identity: {
            ...identity,
            taskId: prior.taskId,
            runId: prior.runId,
          },
          metrics: {
            inputTokens: prior.inputTokens,
            outputTokens: prior.outputTokens,
            toolResultTokens: prior.toolResultTokens,
            contextBuildMs: prior.contextBuildMs,
            stepsUsed: 0,
            toolCallsUsed: 0,
            durationMs: Date.now() - startedMs,
          },
          replayed: true,
        };
      }
    } catch {
      // Fall through to fresh execution
    }
  }

  const ctxStart = Date.now();
  const built = await opts.definition.buildContext(opts.input);
  const contextBuildMs = Date.now() - ctxStart;
  const promptTokens =
    estimateTextTokens(built.system) + estimateTextTokens(built.prompt);

  const metrics: AgentTaskMetrics = {
    inputTokens: promptTokens,
    outputTokens: 0,
    toolResultTokens: 0,
    contextBuildMs,
    stepsUsed: 0,
    toolCallsUsed: 0,
    durationMs: 0,
  };

  if (opts.persistTask !== false) {
    try {
      upsertAgentTaskInDb({
        taskId: identity.taskId,
        runId: identity.runId,
        workflowId: identity.workflowId,
        parentTaskId: identity.parentTaskId,
        kind: identity.kind,
        mode: opts.definition.mode,
        status: "running",
        goalId: identity.goalId,
        trackId: identity.trackId,
        lessonId: identity.lessonId,
        learningSessionId: identity.learningSessionId,
        idempotencyKey: opts.idempotencyKey,
        inputTokens: metrics.inputTokens,
        contextBuildMs,
      });
    } catch {}
  }

  const trace = new AgentTraceRecorder({
    runId: identity.runId,
    conversationId:
      identity.workflowId ||
      identity.learningSessionId ||
      identity.lessonId ||
      identity.taskId,
    route: "agent",
    provider: opts.providerName || "runtime",
    model: opts.modelLabel || (typeof opts.model === "string" ? opts.model : "runtime-model"),
    modelLabel: opts.modelLabel || opts.definition.name,
    userPrompt: `[${opts.definition.name}] ${built.prompt.slice(0, 240)}`,
  });

  // Compose Timeout + External AbortSignal
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("AGENT_TASK_TIMEOUT")),
    Math.max(1000, opts.definition.timeoutMs),
  );
  const onExternalAbort = () => controller.abort(opts.abortSignal?.reason);
  if (opts.abortSignal?.aborted) {
    controller.abort(opts.abortSignal.reason);
  } else {
    opts.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  const allowedSet = new Set(opts.definition.allowedTools);
  const allowedCatSet = opts.definition.allowedCategories
    ? new Set(opts.definition.allowedCategories)
    : undefined;

  // Bind ONLY authorized tools into the Vercel AI SDK ToolSet
  const aiTools: ToolSet = {};
  if (opts.registry && opts.definition.mode !== "structured") {
    for (const toolName of opts.definition.allowedTools) {
      const def = opts.registry.get(toolName);
      if (!def) continue;
      if (allowedCatSet && !allowedCatSet.has(def.category)) continue;
      aiTools[toolName] = defineAiTool({
        description: def.description,
        inputSchema: def.inputSchema,
        execute: async (args, toolOpts) => {
          if (controller.signal.aborted) {
            throw new Error("TASK_ABORTED");
          }
          if (metrics.toolCallsUsed >= opts.definition.maxSteps * 2) {
            throw new AgentBudgetExceededError(
              `工具调用次数达到上限（${opts.definition.maxSteps * 2}）`,
            );
          }
          const invoked = await opts.registry!.invoke({
            toolName,
            rawArgs: args,
            allowedTools: allowedSet,
            allowedCategories: allowedCatSet,
            taskName: opts.definition.name,
            identity,
            abortSignal: controller.signal,
            trace,
            toolCallId: toolOpts?.toolCallId,
          });
          metrics.toolCallsUsed++;
          metrics.toolResultTokens += invoked.resultTokens;
          if (
            metrics.inputTokens + metrics.toolResultTokens >
            opts.definition.tokenBudget
          ) {
            throw new AgentBudgetExceededError(
              `上下文 Token 预算已耗尽（上限 ${opts.definition.tokenBudget}）`,
            );
          }
          return invoked.result;
        },
      });
    }
  }

  const runExecutor: RuntimeModelExecutor =
    opts.customExecutor ||
    (async (p) => {
      if (!opts.model) {
        throw new Error("未配置可用 LLM Model，无法执行 Agent Runtime 任务。");
      }
      const hasTools = Object.keys(p.tools).length > 0 && p.mode !== "structured";
      const isDeepSeek = isDeepSeekModelInstance(opts.model);
      const modelId = extractModelIdFromInstance(opts.model);
      const profile: DeepSeekTaskProfile =
        p.mode === "structured"
          ? opts.definition.kind === "curriculum"
            ? "curriculum_planning"
            : opts.definition.kind === "lesson_preparation"
              ? "structured_deep"
              : "structured_fast"
          : "react_research";

      const callCfg = buildDeepSeekCallConfig(profile, {
        isDeepSeek,
        modelId,
      });

      const invokeModel = async (
        promptStr: string,
        overrideDisableThinking = false,
      ) => {
        const effectiveCfg = overrideDisableThinking
          ? buildDeepSeekCallConfig(
              profile === "curriculum_planning"
                ? "structured_deep"
                : "structured_fast",
              {
                isDeepSeek,
                modelId,
                userThinkingMode: "disabled",
              },
            )
          : callCfg;

        return generateText({
          model: opts.model!,
          system: p.system,
          prompt: promptStr,
          tools: hasTools ? p.tools : undefined,
          stopWhen: hasTools ? stepCountIs(Math.max(1, p.maxSteps)) : undefined,
          maxOutputTokens: effectiveCfg.maxOutputTokens,
          temperature: effectiveCfg.temperature,
          providerOptions: effectiveCfg.providerOptions as Parameters<
            typeof generateText
          >[0]["providerOptions"],
          abortSignal: p.abortSignal,
        });
      };

      let res = await invokeModel(p.prompt, false);

      // DeepSeek JSON Output official guard (json_mode.md #4):
      // If non-JSON output was replaced by spaces (U+0020), retry once with non-thinking JSON reinforcement.
      if (isDeepSeek && callCfg.jsonMode && !res.text.trim()) {
        res = await invokeModel(
          `${p.prompt}\n\n[JSON 输出重试提醒] 请严格只输出一个合法的 JSON 对象，不要包含任何 Markdown 代码块或非 JSON 文本。`,
          true,
        );
      }

      const usageSummary = extractDeepSeekUsageSummary(res.usage);
      return {
        text: res.text,
        inputTokens:
          usageSummary?.inputTokens || estimateTextTokens(p.system + p.prompt),
        outputTokens:
          usageSummary?.outputTokens || estimateTextTokens(res.text),
        stepsUsed: Array.isArray(res.steps) ? res.steps.length : 1,
        cacheReadTokens: usageSummary?.cacheReadTokens ?? 0,
        cacheHitRate: usageSummary?.cacheHitRate ?? 0,
        reasoningTokens: usageSummary?.reasoningTokens ?? 0,
      };
    });

  try {
    const maxAttempts = Math.max(1, (opts.maxRepairAttempts ?? 1) + 1);
    let lastValidationErr: string | null = null;
    let promptText = built.prompt;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (controller.signal.aborted) {
        throw new Error("TASK_ABORTED");
      }
      trace.startModelRequest({
        iteration: attempt,
        messageCount: attempt,
        availableTools: Object.keys(aiTools),
      });

      const res = await runExecutor({
        system: built.system,
        prompt: promptText,
        mode: opts.definition.mode,
        maxSteps: opts.definition.maxSteps,
        tools: aiTools,
        abortSignal: controller.signal,
      });

      metrics.inputTokens = Math.max(
        metrics.inputTokens,
        res.inputTokens ?? metrics.inputTokens,
      );
      metrics.outputTokens += res.outputTokens ?? estimateTextTokens(res.text);
      metrics.stepsUsed += res.stepsUsed ?? 1;

      trace.recordModelResponse({
        iteration: attempt,
        text: res.text.slice(0, 600),
        finishReason: "stop",
        usage: {
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          ...(typeof res.cacheReadTokens === "number"
            ? {
                cacheReadTokens: res.cacheReadTokens,
                cacheHitRate: res.cacheHitRate ?? 0,
              }
            : {}),
          ...(typeof res.reasoningTokens === "number" && res.reasoningTokens > 0
            ? { reasoningTokens: res.reasoningTokens }
            : {}),
        },
      });

      try {
        const parsed = extractJsonObjectFromText(res.text);
        const output = opts.definition.validateOutput(parsed);
        metrics.durationMs = Date.now() - startedMs;

        trace.recordRunCompleted({
          finalResponse: res.text.slice(0, 600),
          stepCount: metrics.stepsUsed,
          reasoningChars: 0,
        });

        if (opts.persistTask !== false) {
          try {
            upsertAgentTaskInDb({
              taskId: identity.taskId,
              runId: identity.runId,
              workflowId: identity.workflowId,
              parentTaskId: identity.parentTaskId,
              kind: identity.kind,
              mode: opts.definition.mode,
              status: "completed",
              goalId: identity.goalId,
              trackId: identity.trackId,
              lessonId: identity.lessonId,
              learningSessionId: identity.learningSessionId,
              idempotencyKey: opts.idempotencyKey,
              inputTokens: metrics.inputTokens,
              outputTokens: metrics.outputTokens,
              toolResultTokens: metrics.toolResultTokens,
              contextBuildMs: metrics.contextBuildMs,
              result: output,
            });
          } catch {}
        }

        return { output, identity, metrics, replayed: false };
      } catch (valErr) {
        lastValidationErr =
          valErr instanceof Error ? valErr.message : String(valErr);
        if (attempt >= maxAttempts) {
          throw new Error(
            `输出校验失败（已达最大修复次数 ${maxAttempts}）：${lastValidationErr}`,
          );
        }
        promptText = `${built.prompt}\n\n【上一次输出校验未通过，请仅修复以下错误并重新输出合法 JSON】\n${lastValidationErr}`;
      }
    }

    throw new Error(lastValidationErr || "任务未产出合法结果");
  } catch (err) {
    const isCancelled =
      controller.signal.aborted ||
      (err instanceof Error &&
        (err.message === "TASK_ABORTED" || err.name === "AbortError"));
    const status = isCancelled ? "cancelled" : "failed";
    const errorMessage = err instanceof Error ? err.message : String(err);

    trace.recordRunFailed({
      errorMessage,
      cancelled: isCancelled,
      stepCount: metrics.stepsUsed,
    });

    if (opts.persistTask !== false) {
      try {
        upsertAgentTaskInDb({
          taskId: identity.taskId,
          runId: identity.runId,
          workflowId: identity.workflowId,
          parentTaskId: identity.parentTaskId,
          kind: identity.kind,
          mode: opts.definition.mode,
          status,
          goalId: identity.goalId,
          trackId: identity.trackId,
          lessonId: identity.lessonId,
          learningSessionId: identity.learningSessionId,
          idempotencyKey: opts.idempotencyKey,
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          toolResultTokens: metrics.toolResultTokens,
          contextBuildMs: metrics.contextBuildMs,
          errorMessage,
        });
      } catch {}
    }

    throw err;
  } finally {
    clearTimeout(timeout);
    opts.abortSignal?.removeEventListener("abort", onExternalAbort);
  }
}
