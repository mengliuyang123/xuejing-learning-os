import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";
import {
  buildDeepSeekCallConfig,
  convertDeepSeekUsage,
  extractDeepSeekUsageSummary,
  formatDeepSeekApiError,
  formatDeepSeekLatestReminder,
  getDeepSeekModelSpec,
  isDeepSeekProvider,
  transformDeepSeekRequestBody,
} from "../lib/deepseek-config";
import {
  foldOldToolOutputs,
  resolveModelContextBudget,
} from "../lib/context-manager";
import { PROVIDER_PRESETS } from "../lib/model-config";

test("DeepSeek model specs, provider detection, and 1M context budgets", () => {
  const flash = getDeepSeekModelSpec("deepseek-flash");
  assert.ok(flash);
  assert.equal(flash.contextWindow, 1_000_000);
  assert.equal(flash.maxOutputTokens, 384_000);
  assert.equal(flash.defaultThinkingEnabled, true);
  assert.equal(flash.supportsVision, true);

  const pro = getDeepSeekModelSpec("deepseek-v4-pro");
  assert.ok(pro);
  assert.equal(pro.contextWindow, 1_000_000);
  assert.equal(pro.supportsVision, false);

  assert.equal(resolveModelContextBudget("deepseek-flash"), 64000);
  assert.equal(resolveModelContextBudget("deepseek-v4-pro"), 64000);
  assert.equal(resolveModelContextBudget("deepseek-chat"), 24000);

  assert.equal(
    isDeepSeekProvider({ baseUrl: "https://api.deepseek.com" }),
    true,
  );
  assert.equal(isDeepSeekProvider({ providerName: "deepseek" }), true);
  assert.equal(
    isDeepSeekProvider({
      providerName: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "deepseek/deepseek-chat",
    }),
    false,
  );

  const dsPreset = PROVIDER_PRESETS.find((p) => p.id === "deepseek");
  assert.equal(dsPreset?.defaultModel, "deepseek-flash");
  assert.equal(dsPreset?.defaultBaseUrl, "https://api.deepseek.com");
});

test("buildDeepSeekCallConfig optimizes parameters per task profile and isolates non-DeepSeek", () => {
  const ping = buildDeepSeekCallConfig("fast_ping", {
    isDeepSeek: true,
    modelId: "deepseek-flash",
  });
  assert.equal(ping.thinkingEnabled, false);
  assert.equal(ping.temperature, 0);
  assert.equal(ping.maxOutputTokens, 32);
  assert.deepEqual(ping.providerOptions?.deepseek.thinking, {
    type: "disabled",
  });

  const structured = buildDeepSeekCallConfig("structured_deep", {
    isDeepSeek: true,
    modelId: "deepseek-flash",
  });
  assert.equal(structured.thinkingEnabled, false);
  assert.equal(structured.jsonMode, true);
  assert.equal(structured.maxOutputTokens, undefined);
  assert.deepEqual(structured.providerOptions?.deepseek.response_format, {
    type: "json_object",
  });

  const tutorLearn = buildDeepSeekCallConfig("tutor_chat", {
    isDeepSeek: true,
    modelId: "deepseek-flash",
    taskType: "learn",
    latestReminderDay: "2026-11-21",
  });
  assert.equal(tutorLearn.thinkingEnabled, true);
  assert.equal(tutorLearn.reasoningEffort, "high");
  assert.equal(tutorLearn.temperature, undefined);
  assert.equal(tutorLearn.maxOutputTokens, undefined);
  assert.equal(
    tutorLearn.providerOptions?.deepseek.deepseek_latest_reminder,
    "2026-11-21,星期六,,Web,中文",
  );

  const curriculumFlash = buildDeepSeekCallConfig("curriculum_planning", {
    isDeepSeek: true,
    modelId: "deepseek-flash",
  });
  assert.equal(curriculumFlash.maxOutputTokens, undefined);

  const researchFlash = buildDeepSeekCallConfig("react_research", {
    isDeepSeek: true,
    modelId: "deepseek-flash",
  });
  assert.equal(researchFlash.maxOutputTokens, undefined);

  const legacyChatClamped = buildDeepSeekCallConfig("tutor_chat", {
    isDeepSeek: true,
    modelId: "deepseek-chat",
    taskType: "learn",
    maxOutputTokensOverride: 20_000,
  });
  assert.equal(legacyChatClamped.maxOutputTokens, 8192);

  const tutorChat = buildDeepSeekCallConfig("tutor_chat", {
    isDeepSeek: true,
    modelId: "deepseek-flash",
    taskType: "chat",
  });
  assert.equal(tutorChat.reasoningEffort, "low");

  const nonDs = buildDeepSeekCallConfig("tutor_chat", {
    isDeepSeek: false,
    modelId: "gpt-4.1-mini",
    taskType: "learn",
  });
  assert.equal(nonDs.providerOptions, undefined);
});

test("transformDeepSeekRequestBody enforces Thinking hygiene, reasoning_content guard, latest_reminder, and JSON guard", () => {
  // 1. Thinking mode + tools: strip ignored params, clamp top_p, backfill missing reasoning_content, inject latest_reminder before last user msg
  const transformedThinking = transformDeepSeekRequestBody({
    model: "deepseek-flash",
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    temperature: 0.7,
    presence_penalty: 0.2,
    frequency_penalty: 0.3,
    top_p: 0.8,
    deepseek_dynamic_context: "Dynamic workspace context",
    deepseek_latest_reminder: formatDeepSeekLatestReminder("2026-11-21"),
    tools: [{ type: "function", function: { name: "read_workspace_state" } }],
    messages: [
      { role: "system", content: "Static rules" },
      { role: "user", content: "Turn 1" },
      {
        role: "assistant",
        content: "Turn 1 reply without saved reasoning",
      },
      { role: "user", content: "Turn 2" },
      {
        role: "assistant",
        reasoning_content: "Thinking before calling tool",
        content: null,
        tool_calls: [{ id: "tc1", type: "function", function: { name: "read_workspace_state", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "tc1", content: "{\"ok\":true}" },
    ],
  });

  assert.equal(transformedThinking.temperature, undefined);
  assert.equal(transformedThinking.presence_penalty, undefined);
  assert.equal(transformedThinking.frequency_penalty, undefined);
  assert.equal(transformedThinking.top_p, 0.95);
  assert.equal(transformedThinking.deepseek_latest_reminder, undefined);
  assert.equal(transformedThinking.deepseek_dynamic_context, undefined);

  const msgs = transformedThinking.messages as Array<Record<string, unknown>>;
  // Assistant message 1 (legacy without reasoning_content) must get empty string to avoid 400
  assert.equal(msgs[2].reasoning_content, "");
  // dynamic system context + latest_reminder must sit immediately before Turn 2 user message (indices 3 & 4), NOT between tool_calls and tool!
  assert.equal(msgs[3].role, "system");
  assert.equal(msgs[3].content, "Dynamic workspace context");
  assert.equal(msgs[4].role, "latest_reminder");
  assert.equal(msgs[4].content, "2026-11-21,星期六,,Web,中文");
  assert.equal(msgs[5].role, "user");
  assert.equal(msgs[5].content, "Turn 2");
  // Assistant tool_calls reasoning_content preserved verbatim
  assert.equal(msgs[6].reasoning_content, "Thinking before calling tool");
  assert.equal(msgs[7].role, "tool");

  // 2. Non-thinking JSON mode: strip reasoning_effort & flash top_p, keep temperature, enforce "json" keyword
  const transformedJson = transformDeepSeekRequestBody({
    model: "deepseek-flash",
    thinking: { type: "disabled" },
    reasoning_effort: "high",
    temperature: 0.2,
    top_p: 0.9,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return a structured summary object." },
      { role: "user", content: "Summarize React hooks." },
    ],
  });

  assert.equal(transformedJson.reasoning_effort, undefined);
  assert.equal(transformedJson.top_p, undefined);
  assert.equal(transformedJson.temperature, 0.2);
  const jsonMsgs = transformedJson.messages as Array<Record<string, unknown>>;
  assert.match(String(jsonMsgs[0].content), /json/i);
});

test("convertDeepSeekUsage & extractDeepSeekUsageSummary accurately report KV cache hits and reasoning tokens", () => {
  const v3Usage = convertDeepSeekUsage({
    prompt_tokens: 4000,
    completion_tokens: 500,
    prompt_cache_hit_tokens: 3200,
    prompt_cache_miss_tokens: 800,
    completion_tokens_details: { reasoning_tokens: 300 },
  });
  assert.equal(v3Usage.inputTokens.total, 4000);
  assert.equal(v3Usage.inputTokens.cacheRead, 3200);
  assert.equal(v3Usage.inputTokens.noCache, 800);
  assert.equal(v3Usage.outputTokens.reasoning, 300);
  assert.equal(v3Usage.outputTokens.text, 200);

  const summary = extractDeepSeekUsageSummary(v3Usage);
  assert.ok(summary);
  assert.equal(summary.cacheReadTokens, 3200);
  assert.equal(summary.cacheMissTokens, 800);
  assert.equal(summary.cacheHitRate, 80);
  assert.equal(summary.reasoningTokens, 300);
});

test("foldOldToolOutputs respects preserveReasoning for DeepSeek Thinking + Tools multi-turn stability", () => {
  const msgs: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Turn 1" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "Deep reasoning chain from turn 1" },
        { type: "text", text: "Answer 1" },
      ],
    },
    { id: "u2", role: "user", parts: [{ type: "text", text: "Turn 2" }] },
    { id: "a2", role: "assistant", parts: [{ type: "text", text: "Answer 2" }] },
    { id: "u3", role: "user", parts: [{ type: "text", text: "Turn 3" }] },
  ];

  const defaultFolded = foldOldToolOutputs(msgs, 2);
  assert.equal(
    defaultFolded.messages[1].parts.some((p) => p.type === "reasoning"),
    false,
  );

  const preserved = foldOldToolOutputs(msgs, 2, { preserveReasoning: true });
  assert.equal(
    preserved.messages[1].parts.some((p) => p.type === "reasoning"),
    true,
  );
});

test("formatDeepSeekApiError maps official HTTP error codes to clear Chinese diagnostics", () => {
  assert.match(formatDeepSeekApiError({ statusCode: 402, message: "Insufficient Balance" }), /402|余额不足/);
  assert.match(formatDeepSeekApiError({ statusCode: 401, message: "Unauthorized" }), /401|认证失败/);
  assert.match(formatDeepSeekApiError({ statusCode: 429, message: "Rate limit" }), /429|上限/);
  assert.match(formatDeepSeekApiError({ statusCode: 503, message: "Server overloaded" }), /503|繁忙/);
});
