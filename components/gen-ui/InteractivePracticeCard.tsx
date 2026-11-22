"use client";
import { useState } from "react";
import {
  Check,
  CheckCircle2,
  Code2,
  Eye,
  Lightbulb,
  Loader2,
  MessageSquareText,
  Play,
  RotateCcw,
  Sparkles,
  XCircle,
} from "lucide-react";
import {
  type HandsOnLab,
  type LabEvaluation,
  evaluateLabSubmission,
} from "../../lib/labs";
import type { ClientModelConfig } from "../../lib/model-config";

export default function InteractivePracticeCard({
  lab,
  recorded,
  live,
  modelConfig,
  onComplete,
}: {
  lab: HandsOnLab;
  recorded: boolean;
  live?: boolean;
  modelConfig?: ClientModelConfig;
  onComplete: (passed: boolean) => void;
}) {
  const [code, setCode] = useState(lab.starterCode);
  const [evaluation, setEvaluation] = useState<LabEvaluation | null>(null);
  const [showHint, setShowHint] = useState(false);
  const [showSolution, setShowSolution] = useState(false);
  const [aiReview, setAiReview] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  function runCheck() {
    const res = evaluateLabSubmission(lab, code);
    setEvaluation(res);
  }

  async function requestAiReview() {
    setAiLoading(true);
    setAiError(null);
    const currentEval = evaluation || evaluateLabSubmission(lab, code);
    if (!evaluation) setEvaluation(currentEval);
    try {
      const res = await fetch("/api/lab-eval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lab,
          code,
          evaluation: currentEval,
          clientModelConfig: modelConfig,
        }),
      });
      const data = await res.json();
      if (data.ok) setAiReview(data.review);
      else setAiError(data.error || "点评失败");
    } catch {
      setAiError("网络异常，无法获取 AI 点评。");
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <section className="mt-3 overflow-hidden rounded-xl border border-[#cfdcf6] bg-white shadow-xs">
      <header className="flex items-center justify-between border-b border-[#e2e8f5] bg-[#f2f6ff] px-4 py-2.5 text-xs font-semibold text-[#3553bf]">
        <span className="flex items-center gap-1.5">
          <Code2 size={15} /> 交互式动手实操沙盒
        </span>
        <span className="rounded bg-white px-2 py-0.5 font-mono text-[10px] uppercase text-[#56688f] ring-1 ring-[#dce4f5]">
          {lab.language}
        </span>
      </header>

      <div className="space-y-3 p-4">
        <div>
          <h3 className="text-sm font-semibold text-[#1f2942]">{lab.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-[#55647f]">
            {lab.prompt}
          </p>
        </div>

        <div className="overflow-hidden rounded-lg border border-[#d6deee] bg-[#1e2638]">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5 text-[11px] text-slate-300">
            <span>编辑器 · 即时规则校验{live ? " + AI 深度点评" : ""}</span>
            <button
              type="button"
              onClick={() => {
                setCode(lab.starterCode);
                setEvaluation(null);
                setAiReview(null);
                setAiError(null);
              }}
              className="inline-flex items-center gap-1 text-[11px] text-slate-300 hover:text-white"
            >
              <RotateCcw size={11} /> 重置代码
            </button>
          </div>
          <textarea
            aria-label="实操代码输入"
            rows={5}
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full resize-y border-0 bg-transparent p-3 font-mono text-xs leading-relaxed text-slate-100 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={runCheck}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#395de7] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#2f50d1]"
          >
            <Play size={12} fill="currentColor" /> 运行即时校验
          </button>
          {live && (
            <button
              type="button"
              disabled={aiLoading || !code.trim()}
              onClick={() => void requestAiReview()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#c7d6f8] bg-[#f2f6ff] px-3 py-1.5 text-xs font-semibold text-[#3352c4] hover:bg-[#e5eeff]"
            >
              {aiLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <MessageSquareText size={12} />
              )}
              AI 导师深度点评
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowHint((v) => !v)}
            className="inline-flex items-center gap-1 rounded-lg border border-[#dce2ee] bg-white px-2.5 py-1.5 text-xs text-[#4b5c7d] hover:bg-[#f4f7fc]"
          >
            <Lightbulb size={12} /> {showHint ? "收起提示" : "查看提示"}
          </button>
          <button
            type="button"
            onClick={() => setShowSolution((v) => !v)}
            className="inline-flex items-center gap-1 rounded-lg border border-[#dce2ee] bg-white px-2.5 py-1.5 text-xs text-[#4b5c7d] hover:bg-[#f4f7fc]"
          >
            <Eye size={12} /> {showSolution ? "隐藏参考答案" : "参考答案"}
          </button>
        </div>

        {showHint && (
          <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
            {lab.hints.map((h, i) => (
              <li key={i}>· {h}</li>
            ))}
          </ul>
        )}

        {showSolution && (
          <div className="rounded-lg border border-[#dde4f3] bg-[#f7f9fe] p-3">
            <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-[#4b5e85]">
              <span>参考实现</span>
              <button
                type="button"
                onClick={() => setCode(lab.solution)}
                className="text-[#395de7] hover:underline"
              >
                填入编辑器
              </button>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-[#283652]">
              {lab.solution}
            </pre>
          </div>
        )}

        {aiReview && (
          <div className="rounded-lg border border-[#cfdcf8] bg-[#f4f7ff] p-3 text-xs leading-relaxed text-[#2a3958]">
            <div className="mb-1 flex items-center gap-1.5 font-semibold text-[#3553bf]">
              <Sparkles size={13} /> AI 导师针对性点评
            </div>
            <div className="whitespace-pre-wrap">{aiReview}</div>
          </div>
        )}

        {aiError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {aiError}
          </div>
        )}

        {evaluation && (
          <div
            className={
              "space-y-2 rounded-lg border p-3 " +
              (evaluation.passed
                ? "border-emerald-200 bg-emerald-50/70"
                : "border-amber-200 bg-amber-50/60")
            }
          >
            <div className="flex items-center justify-between text-xs font-semibold">
              <span
                className={
                  evaluation.passed ? "text-emerald-800" : "text-amber-900"
                }
              >
                {evaluation.passed
                  ? `全部 ${evaluation.totalCount} 项检查通过！`
                  : `已通过 ${evaluation.passedCount} / ${evaluation.totalCount} 项，请按提示修改`}
              </span>
            </div>
            <div className="space-y-1">
              {evaluation.results.map((r, i) => (
                <div
                  key={i}
                  className="flex items-start gap-1.5 text-xs text-[#34425c]"
                >
                  {r.ok ? (
                    <CheckCircle2
                      size={14}
                      className="mt-0.5 shrink-0 text-emerald-600"
                    />
                  ) : (
                    <XCircle
                      size={14}
                      className="mt-0.5 shrink-0 text-rose-500"
                    />
                  )}
                  <div>
                    <span>{r.description}</span>
                    {r.detail && (
                      <span className="ml-1.5 text-[11px] text-rose-600">
                        （{r.detail}）
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              disabled={recorded}
              onClick={() => onComplete(evaluation.passed)}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-[#395de7] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#2f50d1] disabled:bg-emerald-100 disabled:text-emerald-800 disabled:opacity-100"
            >
              {recorded ? (
                <>
                  <Check size={13} /> 已计入 BKT 掌握度与 FSRS 复习计划
                </>
              ) : (
                <>
                  <Sparkles size={13} />{" "}
                  {evaluation.passed
                    ? "记录实操通过并更新掌握度"
                    : "记录当前尝试并安排巩固"}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
