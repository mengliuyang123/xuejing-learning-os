export type ModelProviderId =
  | "auto"
  | "gateway"
  | "openai"
  | "deepseek"
  | "gemini"
  | "openrouter"
  | "custom";

export type ClientModelConfig = {
  provider: ModelProviderId;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  contextWindowTokens?: number;
  /** Optional DeepSeek thinking mode preference ("auto" picks per task) */
  thinkingMode?: "auto" | "enabled" | "disabled";
  /** Optional DeepSeek reasoning effort when thinking is enabled */
  reasoningEffort?: "low" | "high" | "max";
};

export const MODEL_CONFIG_STORAGE_KEY = "xushi.model-config.v1";

export type ProviderPreset = {
  id: Exclude<ModelProviderId, "auto">;
  name: string;
  defaultBaseUrl: string;
  defaultModel: string;
  placeholderKey: string;
  hint: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "gateway",
    name: "Vercel AI Gateway",
    defaultBaseUrl: "",
    defaultModel: "openai/gpt-4.1-mini",
    placeholderKey: "vck_...",
    hint: "支持 openai/*、anthropic/*、google/* 等统一路由模型 ID",
  },
  {
    id: "deepseek",
    name: "DeepSeek 直连",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-flash",
    placeholderKey: "sk-...",
    hint: "推荐 deepseek-flash（1M 上下文·思考/极速双模式·视觉理解）或 deepseek-v4-pro（旗舰深度推理）",
  },
  {
    id: "openai",
    name: "OpenAI 直连",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    placeholderKey: "sk-proj-...",
    hint: "支持 gpt-4.1-mini、gpt-4.1、gpt-4o 等支持 Function Calling 的模型",
  },
  {
    id: "gemini",
    name: "Google Gemini (OpenAI 兼容)",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    placeholderKey: "AIza...",
    hint: "使用 Google AI Studio API Key，推荐 gemini-2.5-flash",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "google/gemini-2.5-flash",
    placeholderKey: "sk-or-v1-...",
    hint: "聚合全球主流模型，支持按模型 ID 灵活切换",
  },
  {
    id: "custom",
    name: "自定义 OpenAI 兼容接口",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen2.5:14b",
    placeholderKey: "可填任意 Key 或 ollama",
    hint: "支持通义千问、Kimi、硅基流动、Ollama 等所有 OpenAI 兼容端点",
  },
];

type DesktopSecretsBridge = {
  isDesktop?: boolean;
  secrets?: {
    isAvailable?: () => Promise<boolean>;
    get?: (key: string) => Promise<string | null>;
    set?: (key: string, value: string) => Promise<{ ok: boolean }>;
    delete?: (key: string) => Promise<{ ok: boolean }>;
  };
};

const SECRET_API_KEY_NAME = "model_api_key";

function getDesktopSecretsBridge(): DesktopSecretsBridge["secrets"] | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { learnosDesktop?: DesktopSecretsBridge })
    .learnosDesktop;
  return bridge?.isDesktop && bridge.secrets ? bridge.secrets : null;
}

export async function isDesktopSafeStorageAvailable(): Promise<boolean> {
  try {
    const secrets = getDesktopSecretsBridge();
    if (!secrets?.isAvailable) return false;
    return Boolean(await secrets.isAvailable());
  } catch {
    return false;
  }
}

export function readClientModelConfig(): ClientModelConfig {
  if (typeof window === "undefined") return { provider: "auto" };
  try {
    const raw = JSON.parse(
      localStorage.getItem(MODEL_CONFIG_STORAGE_KEY) || "null",
    );
    if (raw && typeof raw === "object" && typeof raw.provider === "string") {
      return raw as ClientModelConfig;
    }
  } catch {}
  return { provider: "auto" };
}

/**
 * Hydrates client model configuration, decrypting the API key via Electron safeStorage
 * when running inside the desktop app (and automatically migrating any legacy plaintext key).
 */
export async function readClientModelConfigAsync(): Promise<ClientModelConfig> {
  const base = readClientModelConfig();
  const secrets = getDesktopSecretsBridge();
  if (!secrets?.isAvailable || !secrets.get) return base;
  try {
    const available = await secrets.isAvailable();
    if (!available) return base;
    const encryptedKey = await secrets.get(SECRET_API_KEY_NAME);
    if (encryptedKey) {
      return { ...base, apiKey: encryptedKey };
    }
    // Seamless one-time migration: move legacy plaintext key out of localStorage into safeStorage
    if (base.apiKey?.trim() && secrets.set) {
      const res = await secrets.set(SECRET_API_KEY_NAME, base.apiKey.trim());
      if (res?.ok) {
        const sanitized = { ...base };
        delete sanitized.apiKey;
        localStorage.setItem(
          MODEL_CONFIG_STORAGE_KEY,
          JSON.stringify(sanitized),
        );
      }
    }
  } catch {}
  return base;
}

export function saveClientModelConfig(config: ClientModelConfig) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MODEL_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {}
}

/**
 * Persists model configuration. Inside Electron with safeStorage available,
 * encrypts apiKey via OS credential vault and strips plaintext apiKey from localStorage.
 */
export async function saveClientModelConfigSecure(
  config: ClientModelConfig,
): Promise<void> {
  if (typeof window === "undefined") return;
  const secrets = getDesktopSecretsBridge();
  if (secrets?.isAvailable && secrets.set && secrets.delete) {
    try {
      const available = await secrets.isAvailable();
      if (available) {
        const trimmedKey = config.apiKey?.trim() || "";
        if (trimmedKey) {
          const res = await secrets.set(SECRET_API_KEY_NAME, trimmedKey);
          if (res?.ok) {
            const sanitized = { ...config };
            delete sanitized.apiKey;
            localStorage.setItem(
              MODEL_CONFIG_STORAGE_KEY,
              JSON.stringify(sanitized),
            );
            return;
          }
        } else {
          await secrets.delete(SECRET_API_KEY_NAME);
          const sanitized = { ...config };
          delete sanitized.apiKey;
          localStorage.setItem(
            MODEL_CONFIG_STORAGE_KEY,
            JSON.stringify(sanitized),
          );
          return;
        }
      }
    } catch {}
  }
  saveClientModelConfig(config);
}

export function isClientConfigActive(cfg?: ClientModelConfig | null): boolean {
  if (!cfg || cfg.provider === "auto") return false;
  return Boolean(cfg.apiKey?.trim() && cfg.modelId?.trim());
}
