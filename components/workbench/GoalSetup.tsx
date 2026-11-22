"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { useLearningStore } from "../LearningStore";
import type { DbInfo, GoalPlan, Store } from "../../lib/learning";

type GoalResult = {
  plan?: GoalPlan;
  firstLessonContent?: { status: string } | null;
  error?: string;
};

const MODE_HINTS: Record<string, string> = {
  auto_web: "默认模式：Agent 先联网检索权威资料与常见误区，再规划课程与首课。",
  quick_draft: "快速模式：直接基于模型自身知识生成路线，适合快速了解基础概念。",
  user_materials: "资料模式：优先围绕你提供的网页链接或学习笔记来设计路径。",
};

export default function GoalSetup({
  onDiscuss,
  onFinish,
  onBusyChange,
}: {
  onDiscuss: (prompt: string) => void;
  onFinish: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { now, modelConfig, syncStoreFromServer } = useLearningStore();
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    title: string;
    lessons: number;
    first: string;
  } | null>(null);
  const [mode, setMode] = useState("auto_web");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);

  async function refresh(signal?: AbortSignal) {
    const response = await fetch(
      "/api/state?day=" + encodeURIComponent(now),
      { cache: "no-store", signal },
    );
    const payload = (await response.json()) as {
      store?: Store;
      dbInfo?: DbInfo;
    };
    if (!response.ok || !payload.store) {
      throw new Error("无法读取最新工作区，请刷新后查看轨道。");
    }
    if (mounted.current) syncStoreFromServer(payload.store, payload.dbInfo);
    return payload.store;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current || result) return;
    const data = new FormData(event.currentTarget);
    const goal = String(data.get("goal")).trim();
    const notes = String(data.get("notes") || "").trim();
    const urls = String(data.get("urls") || "")
      .split(/\s+/)
      .filter(Boolean);
    if (!goal || (mode === "user_materials" && !notes && !urls.length)) {
      setError(
        !goal
          ? "请填写学习目标。"
          : "请至少提供一条参考链接或一段学习笔记。",
      );
      return;
    }
    if (
      urls.some((value) => {
        try {
          return !["https:", "http:"].includes(new URL(value).protocol);
        } catch {
          return true;
        }
      })
    ) {
      setError("资料链接需以 https:// 或 http:// 开头。");
      return;
    }
    setError("");
    const input = {
      goal,
      priorKnowledge: String(data.get("level")),
      days: Number(data.get("days")),
      dailyMinutes: Number(data.get("minutes")),
      depth: String(data.get("depth")),
      mode,
      userNotes: notes || undefined,
      userUrls: urls,
      day: now,
    };

    if (
      (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ===
      "discuss"
    ) {
      const levels: Record<string, string> = {
        beginner: "初学",
        intermediate: "了解基础",
        advanced: "有实战经验",
      };
      const depths: Record<string, string> = {
        crash: "速学",
        standard: "标准",
        deep: "深入",
      };
      onDiscuss(
        `我想学习「${goal}」。目前${levels[input.priorKnowledge]}，计划 ${input.days} 天、每天 ${input.dailyMinutes} 分钟，深度选${depths[input.depth]}。请先跟我讨论学习路线，等我明确同意后再创建轨道和日程。资料模式：${mode}。${urls.length ? "\n" + urls.join("\n") : ""}${notes ? "\n" + notes : ""}`,
      );
      return;
    }

    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    onBusyChange(true);
    try {
      const response = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          ...input,
          action: "start_goal",
          clientModelConfig: modelConfig,
        }),
      });
      const payload = (await response.json()) as GoalResult;
      if (!response.ok || !payload.plan) {
        throw new Error(payload.error || "学习计划生成失败。");
      }
      const status = payload.firstLessonContent?.status;
      if (mounted.current) {
        setResult({
          title: payload.plan.title,
          lessons: payload.plan.units.length,
          first:
            status === "ready"
              ? "首课已备好，可直接开始学习"
              : status === "limited"
                ? "首课已生成基础版本，可在课堂继续深化"
                : "首课尚未就绪，可在课堂一键备课",
        });
      }
      await refresh(controller.signal);
    } catch (failure) {
      if (!mounted.current) return;
      if (controller.signal.aborted) {
        setError("已停止请求。若轨道已经生成，可以在知识图谱中查看。");
      } else {
        setError(
          failure instanceof Error ? failure.message : "学习计划生成失败。",
        );
      }
      await refresh().catch(() => {});
    } finally {
      request.current = null;
      if (mounted.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }

  if (result) {
    return (
      <div className="wb-goal-result" role="status">
        <h3>{result.title}</h3>
        <p>
          共 {result.lessons} 节课程 · {result.first}
        </p>
        {error && (
          <p className="wb-form-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="wb-button wb-primary"
          disabled={busy}
          onClick={onFinish}
        >
          打开知识图谱 <ArrowRight size={15} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <form className="wb-form" onSubmit={submit} aria-label="学习目标设置">
      <fieldset disabled={busy} className="wb-form">
        <label>
          学习目标
          <input
            autoFocus
            required
            name="goal"
            maxLength={180}
            aria-invalid={error.includes("学习目标") || undefined}
            placeholder="例如：用 Pandas 完成数据清洗、分析与可视化实战"
          />
        </label>
        <div className="wb-form-pair">
          <label>
            目前基础
            <select name="level" defaultValue="beginner">
              <option value="beginner">初学入门</option>
              <option value="intermediate">了解基础</option>
              <option value="advanced">有实战经验</option>
            </select>
          </label>
          <label>
            学习深度
            <select name="depth" defaultValue="standard">
              <option value="standard">标准实战</option>
              <option value="crash">速学聚焦</option>
              <option value="deep">系统深入</option>
            </select>
          </label>
          <label>
            目标周期（天）
            <input
              type="number"
              name="days"
              min={1}
              max={365}
              defaultValue={14}
              required
            />
          </label>
          <label>
            每天可投入（分钟）
            <input
              type="number"
              name="minutes"
              min={5}
              max={480}
              defaultValue={45}
              required
            />
          </label>
        </div>
        <label>
          知识获取方式
          <select value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="auto_web">先联网研究权威资料（推荐）</option>
            <option value="quick_draft">使用模型已有知识快速开始</option>
            <option value="user_materials">优先使用我提供的参考资料</option>
          </select>
          <span className="wb-form-hint">{MODE_HINTS[mode]}</span>
        </label>
        {mode === "user_materials" && (
          <>
            <label>
              参考链接（每行一条）
              <textarea
                name="urls"
                rows={2}
                maxLength={2000}
                placeholder="https://..."
              />
            </label>
            <label>
              已有笔记或教材片段
              <textarea
                name="notes"
                rows={3}
                maxLength={4000}
                placeholder="粘贴课程提纲、笔记或关键章节内容…"
              />
            </label>
          </>
        )}
      </fieldset>
      {error && (
        <p className="wb-form-error" role="alert">
          {error}
        </p>
      )}
      {busy ? (
        <div className="wb-toolbar">
          <p role="status" className="wb-form-hint">
            {mode === "auto_web"
              ? "正在联网研究并规划知识图谱与首课…"
              : "正在生成知识图谱与首课…"}
          </p>
          <button
            className="wb-button"
            type="button"
            onClick={() => request.current?.abort()}
          >
            停止生成
          </button>
        </div>
      ) : (
        <div className="wb-toolbar">
          <button
            className="wb-button wb-primary"
            type="submit"
            value="create"
          >
            直接创建轨道并排课
          </button>
          <button className="wb-button" type="submit" value="discuss">
            <Sparkles size={14} aria-hidden="true" /> 先和助手讨论路线
          </button>
        </div>
      )}
    </form>
  );
}
