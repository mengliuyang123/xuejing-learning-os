import { generateText } from "ai";
import { resolveLanguageModel } from "../../../lib/ai-config";
import {
  buildDeepSeekCallConfig,
  extractDeepSeekUsageSummary,
  formatDeepSeekApiError,
} from "../../../lib/deepseek-config";
import type { ClientModelConfig } from "../../../lib/model-config";

export async function POST(request: Request) {
  try {
    const { clientModelConfig } = (await request.json()) as {
      clientModelConfig?: ClientModelConfig;
    };
    const resolved = resolveLanguageModel(clientModelConfig);
    if (!resolved) {
      return Response.json(
        {
          ok: false,
          error: "未填写 API Key 或模型 ID，也未检测到服务端 .env.local 配置。",
        },
        { status: 400 },
      );
    }

    const callCfg = buildDeepSeekCallConfig("fast_ping", {
      isDeepSeek: resolved.isDeepSeek,
      modelId: resolved.modelId,
    });

    const t0 = Date.now();
    const res = await generateText({
      model: resolved.model,
      prompt: "Reply with OK in one word.",
      maxOutputTokens: callCfg.maxOutputTokens,
      temperature: callCfg.temperature,
      providerOptions: callCfg.providerOptions as Parameters<
        typeof generateText
      >[0]["providerOptions"],
      abortSignal: request.signal,
    });

    const usageSummary = extractDeepSeekUsageSummary(res.usage);

    return Response.json({
      ok: true,
      label: resolved.label,
      isDeepSeek: resolved.isDeepSeek,
      latencyMs: Date.now() - t0,
      reply: res.text.trim().slice(0, 40) || "OK",
      usage: usageSummary,
    });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: formatDeepSeekApiError(err),
      },
      { status: 500 },
    );
  }
}
