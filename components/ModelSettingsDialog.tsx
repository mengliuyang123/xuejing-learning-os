"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CheckCircle2,
  Download,
  Loader2,
  RotateCcw,
  Upload,
  XCircle,
} from "lucide-react";
import {
  type ClientModelConfig,
  type ModelProviderId,
  PROVIDER_PRESETS,
  isDesktopSafeStorageAvailable,
} from "../lib/model-config";
import { exportWorkspaceJSON, parseWorkspaceBackup } from "../lib/ics";
import { TRANSITION_FAST, TRANSITION_STATE } from "../lib/motion";
import { useLearningStore } from "./LearningStore";

export default function ModelSettingsDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const {
    s,
    now,
    live,
    activeModelName,
    modelConfig,
    setModelConfig,
    saveStoreState,
    showToast,
  } = useLearningStore();

  const [provider, setProvider] = useState<ModelProviderId>(
    modelConfig.provider || "auto",
  );
  const [baseUrl, setBaseUrl] = useState(modelConfig.baseUrl || "");
  const [apiKey, setApiKey] = useState(modelConfig.apiKey || "");
  const [modelId, setModelId] = useState(modelConfig.modelId || "");
  const [thinkingMode, setThinkingMode] = useState<
    "auto" | "enabled" | "disabled"
  >(modelConfig.thinkingMode || "auto");
  const [reasoningEffort, setReasoningEffort] = useState<
    "low" | "high" | "max"
  >(modelConfig.reasoningEffort || "high");
  const [testing, setTesting] = useState(false);
  const [safeStorageReady, setSafeStorageReady] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void isDesktopSafeStorageAvailable().then(setSafeStorageReady);
  }, []);

  const selectedPreset = PROVIDER_PRESETS.find((p) => p.id === provider);
  const isDeepSeekSelected =
    provider === "deepseek" ||
    /deepseek/i.test(baseUrl) ||
    /deepseek/i.test(modelId);

  function selectProvider(next: ModelProviderId) {
    setProvider(next);
    setTestResult(null);
    const preset = PROVIDER_PRESETS.find((p) => p.id === next);
    if (preset) {
      setBaseUrl(preset.defaultBaseUrl);
      setModelId(preset.defaultModel);
    }
  }

  function buildConfig(): ClientModelConfig {
    if (provider === "auto") {
      return {
        provider: "auto",
        thinkingMode,
        reasoningEffort,
      };
    }
    return {
      provider,
      baseUrl: baseUrl.trim() || undefined,
      apiKey: apiKey.trim() || undefined,
      modelId: modelId.trim() || undefined,
      ...(isDeepSeekSelected ? { thinkingMode, reasoningEffort } : {}),
    };
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/model-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientModelConfig: buildConfig() }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestResult({
          ok: true,
          message: `连接成功：${data.label}（${data.latencyMs}ms）`,
        });
      } else {
        setTestResult({ ok: false, message: data.error || "连接测试失败" });
      }
    } catch {
      setTestResult({ ok: false, message: "网络请求失败，请确认本机服务运行中。" });
    } finally {
      setTesting(false);
    }
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const cfg = buildConfig();
    setModelConfig(cfg);
    showToast(
      cfg.provider === "auto"
        ? "已切换为自动读取本机环境配置。"
        : `已保存模型配置（${selectedPreset?.name || cfg.provider} · ${cfg.modelId}）。`,
    );
    onClose();
  }

  async function handleExportBackup() {
    let payloadStr = "";
    try {
      const res = await fetch(
        `/api/state?export=full&day=${encodeURIComponent(now)}`,
        { cache: "no-store" },
      );
      if (res.ok) {
        const full = await res.json();
        payloadStr = JSON.stringify(full, null, 2);
      }
    } catch {}
    if (!payloadStr) {
      payloadStr = exportWorkspaceJSON(s);
    }
    const blob = new Blob([payloadStr], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `xuejing-backup-${now}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("已导出全量学习数据备份（不含 API Key）。");
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseWorkspaceBackup(String(reader.result || ""), now);
      if (!parsed) {
        showToast("备份文件格式无效，未覆盖现有数据。");
        return;
      }
      saveStoreState(parsed, now, "已成功导入备份并恢复图谱、日历与记忆。");
      onClose();
    };
    reader.readAsText(file);
  }

  return (
    <div className="wb-settings-panel">
      {/* Compact Connection Status Pill */}
      <div
        className={
          "wb-settings-status " + (live ? "is-connected" : "is-unconfigured")
        }
      >
        <span className="wb-status-dot" aria-hidden="true" />
        <div className="wb-settings-status-copy">
          <strong>
            {live ? `已连接 · ${activeModelName || "当前模型"}` : "尚未配置模型密钥"}
          </strong>
          <span>
            {safeStorageReady
              ? "密钥已通过系统安全存储加密保存于本机，不会明文写入浏览器。"
              : "密钥仅保存在本机浏览器中，不会上传到第三方服务器。"}
          </span>
        </div>
      </div>

      {/* Model Configuration Form */}
      <form className="wb-form" onSubmit={handleSave}>
        <label>
          模型服务商
          <select
            value={provider}
            onChange={(e) => selectProvider(e.target.value as ModelProviderId)}
          >
            <option value="auto">自动（读取本机 .env 配置）</option>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {provider !== "auto" && selectedPreset && (
            <span className="wb-form-hint">{selectedPreset.hint}</span>
          )}
        </label>

        <AnimatePresence initial={false}>
          {provider !== "auto" && (
            <motion.div
              key="custom-provider-fields"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={TRANSITION_STATE}
              style={{ overflow: "hidden" }}
            >
              <div className="wb-form">
                <div className="wb-form-pair">
                  <label>
                    模型 ID
                    <input
                      required
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      placeholder={
                        selectedPreset?.defaultModel || "deepseek-flash"
                      }
                    />
                  </label>
                  <label>
                    API Key
                    <input
                      required
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={selectedPreset?.placeholderKey || "sk-..."}
                    />
                  </label>
                </div>

                <label>
                  接口地址（Base URL，可选）
                  <input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={
                      selectedPreset?.defaultBaseUrl ||
                      "https://api.deepseek.com"
                    }
                  />
                </label>

                {isDeepSeekSelected && (
                  <div className="wb-form-pair">
                    <label>
                      深度思考
                      <select
                        value={thinkingMode}
                        onChange={(e) =>
                          setThinkingMode(
                            e.target.value as "auto" | "enabled" | "disabled",
                          )
                        }
                      >
                        <option value="auto">自动按任务分配</option>
                        <option value="enabled">始终开启</option>
                        <option value="disabled">关闭（快速响应）</option>
                      </select>
                    </label>
                    <label>
                      思考强度
                      <select
                        value={reasoningEffort}
                        disabled={thinkingMode === "disabled"}
                        onChange={(e) =>
                          setReasoningEffort(
                            e.target.value as "low" | "high" | "max",
                          )
                        }
                      >
                        <option value="low">轻量快速 (low)</option>
                        <option value="high">均衡推荐 (high)</option>
                        <option value="max">深度推理 (max)</option>
                      </select>
                    </label>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {testResult && (
            <motion.div
              key="test-result"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={TRANSITION_FAST}
              role="status"
              className={
                "wb-settings-feedback " + (testResult.ok ? "is-ok" : "is-err")
              }
            >
              {testResult.ok ? (
                <CheckCircle2 size={14} aria-hidden="true" />
              ) : (
                <XCircle size={14} aria-hidden="true" />
              )}
              <span>{testResult.message}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="wb-settings-actions">
          <button type="submit" className="wb-button wb-primary">
            保存模型配置
          </button>
          <button
            type="button"
            disabled={testing}
            onClick={() => void handleTest()}
            className="wb-button"
          >
            {testing ? (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : (
              <RotateCcw size={13} aria-hidden="true" />
            )}
            <span>{testing ? "测试中…" : "测试连接"}</span>
          </button>
        </div>
      </form>

      {/* Local Backup & Restore Section */}
      <div className="wb-settings-section">
        <div className="wb-settings-section-head">
          <h3>数据备份与迁移</h3>
          <span className="wb-form-hint">导出或恢复全部课程、日程与记忆</span>
        </div>
        <div className="wb-form-pair">
          <button
            type="button"
            onClick={() => void handleExportBackup()}
            className="wb-button"
          >
            <Download size={13} aria-hidden="true" />
            <span>导出 JSON 备份</span>
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="wb-button"
          >
            <Upload size={13} aria-hidden="true" />
            <span>导入备份恢复</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleImportFile}
          />
        </div>
      </div>
    </div>
  );
}
