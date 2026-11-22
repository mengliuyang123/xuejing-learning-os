import { generateText, type LanguageModel } from "ai";
import { z } from "zod";
import {
  buildDeepSeekCallConfig,
  extractModelIdFromInstance,
  isDeepSeekModelInstance,
} from "./deepseek-config";
import type {
  Block,
  GoalPlan,
  Lesson,
  Memory,
  PriorKnowledgeLevel,
  TrackDepth,
} from "./learning";
import { demoUnits, schedulePlan } from "./goal-plan";
import { extractMemoryPreferences } from "./scheduler";
import {
  MAX_DYNAMIC_LESSONS,
  MIN_DYNAMIC_LESSONS,
  normalizeLessonGoalFields,
  recommendLessonCount,
  validateTrackUnits,
} from "./curriculum-planner";
import { shuffleChoiceExerciseSpec } from "./learning-engine";
import type { TopicResearchResult } from "./topic-researcher";

const nonEmpty = z.string().min(1);

const curriculumSchema = z.object({
  title: nonEmpty,
  units: z
    .array(
      z.object({
        chapterTitle: nonEmpty.optional(),
        sectionTitle: nonEmpty.optional(),
        title: nonEmpty,
        objective: nonEmpty.optional(),
        completionCriteria: nonEmpty.optional(),
        concept: nonEmpty,
        example: nonEmpty,
        question: nonEmpty,
        choices: z.array(nonEmpty).length(3),
        answer: z.number().int().min(0).max(2),
        feedback: nonEmpty,
        requiresIndices: z
          .array(z.number().int().min(0).max(MAX_DYNAMIC_LESSONS - 1))
          .optional(),
        minutes: z.number().int().min(15).max(120).optional(),
      }),
    )
    .min(MIN_DYNAMIC_LESSONS)
    .max(MAX_DYNAMIC_LESSONS),
});

export async function generateCurriculumPlan(opts: {
  goal: string;
  day: string;
  blocks: Block[];
  memories: Memory[];
  days?: number;
  daily?: number;
  start?: number;
  endLimit?: number;
  depth?: TrackDepth;
  scopeNote?: string;
  priorKnowledge?: PriorKnowledgeLevel;
  researchContext?: TopicResearchResult | null;
  planId?: string;
  priorUnits?: Lesson[];
  priorTitle?: string;
  model?: LanguageModel | string;
  abortSignal?: AbortSignal;
}): Promise<{ plan: GoalPlan; scheduled: boolean }> {
  const prefs = extractMemoryPreferences(opts.memories);
  const start = opts.start ?? prefs.preferredStart ?? 1140;
  const endLimit = opts.endLimit ?? prefs.preferredEnd ?? 1380;
  const windowMinutes = Math.max(30, endLimit - start);
  const daily = Math.min(
    180,
    Math.max(
      15,
      opts.daily ??
        (prefs.preferredStart !== undefined && prefs.preferredEnd !== undefined
          ? windowMinutes
          : prefs.maxSessionMinutes ?? 45),
    ),
  );
  const sessionCap = prefs.maxSessionMinutes
    ? Math.min(daily, prefs.maxSessionMinutes)
    : Math.min(daily, 60);
  const days = Math.min(90, Math.max(1, opts.days ?? 7));
  const planId = opts.planId || crypto.randomUUID();
  const sizing = recommendLessonCount({
    goal: opts.goal,
    days,
    dailyMinutes: daily,
    depth: opts.depth,
    scopeNote: opts.scopeNote,
    priorKnowledge: opts.priorKnowledge,
    avgLessonMinutes: sessionCap,
  });

  let title = opts.priorTitle;
  let units = opts.priorUnits;

  if (!units) {
    let outline: {
      title: string;
      units: Array<{
        chapterTitle?: string;
        sectionTitle?: string;
        title: string;
        objective?: string;
        completionCriteria?: string;
        concept: string;
        example: string;
        question: string;
        choices: string[];
        answer: number;
        feedback: string;
        requiresIndices?: number[];
        minutes?: number;
      }>;
    } = demoUnits(opts.goal);

    if (opts.model) {
      const memorySummary = opts.memories
        .filter((m) => m.category !== "record")
        .slice(0, 6)
        .map((m) => `[${m.label}] ${m.text}`)
        .join("；");

      try {
        const isDeepSeek = isDeepSeekModelInstance(opts.model);
        const callCfg = buildDeepSeekCallConfig("structured_fast", {
          isDeepSeek,
          modelId: extractModelIdFromInstance(opts.model),
          maxOutputTokensOverride: 6144,
        });
        const sysPrompt = [
          "你是中文自适应课程设计师。请严格返回一个合法的 JSON 对象（只输出 JSON，不要包含 Markdown 代码块或多余文字）。",
          'JSON 字段结构：{ "title": "课程总标题", "units": [ { "chapterTitle": "大章节标题（由你根据学科自由命名）", "sectionTitle": "小章节标题（由你自由划分）", "title": "课时标题", "objective": "本课明确学习目标", "completionCriteria": "本课可验证完成条件", "concept": "核心概念讲解", "example": "具体代码示例或场景", "question": "三选一测验题干", "choices": ["选项A", "选项B", "选项C"], "answer": 0, "feedback": "解析", "requiresIndices": [], "minutes": 45 } ] }。',
          `请根据学科真实知识架构、学习目标与已有基础自由决定课程总节数与章节结构（完全不限固定节数，多少节都可以；可按大章节 chapterTitle → 小章节 sectionTitle → 课时 title 自由分层；时间预算参考建议约 ${sizing.recommended} 节）。构建真实的先修依赖 DAG（允许独立小章节/课时分支并行后再汇聚，requiresIndices 引用前置课的 0-based 索引，首课为空数组）。每节必须具备明确 objective 与 completionCriteria，建议单课时不超过 ${sessionCap} 分钟。`,
          opts.scopeNote ? `用户范围与深度要求：${opts.scopeNote}` : "",
          opts.researchContext
            ? `前置主题研究结论（${opts.researchContext.domain} · ${opts.researchContext.effectiveMode}）：${opts.researchContext.summary}\n推荐先修：${opts.researchContext.recommendedPrerequisites.join("；")}\n常见误区：${opts.researchContext.commonPitfalls.join("；")}`
            : "",
          memorySummary ? `学习者长期记忆：${memorySummary}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        const userPrompt = `请为以下学习目标生成结构化 JSON 微课方案：${opts.goal}（周期：${days} 天，每日可用约 ${daily} 分钟，单次上限约 ${sessionCap} 分钟）。`;

        let res = await generateText({
          model: opts.model,
          abortSignal: opts.abortSignal,
          maxOutputTokens: callCfg.maxOutputTokens,
          temperature: callCfg.temperature,
          providerOptions: callCfg.providerOptions as Parameters<
            typeof generateText
          >[0]["providerOptions"],
          system: sysPrompt,
          prompt: userPrompt,
        });
        if (isDeepSeek && !res.text.trim()) {
          res = await generateText({
            model: opts.model,
            abortSignal: opts.abortSignal,
            maxOutputTokens: callCfg.maxOutputTokens,
            temperature: 0.2,
            providerOptions: callCfg.providerOptions as Parameters<
              typeof generateText
            >[0]["providerOptions"],
            system: sysPrompt,
            prompt: `${userPrompt}\n\n请只输出合法 JSON 对象，不要包含额外文字。`,
          });
        }

        const cleaned = res.text
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/i, "");
        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        const jsonSlice =
          firstBrace >= 0 && lastBrace > firstBrace
            ? cleaned.slice(firstBrace, lastBrace + 1)
            : cleaned;
        const parsed = curriculumSchema.safeParse(JSON.parse(jsonSlice));
        if (parsed.success) {
          outline = parsed.data;
        } else {
          console.error(
            "[curriculum-gen] JSON schema validation failed, using fallback:",
            parsed.error.issues.slice(0, 3),
          );
        }
      } catch (err) {
        console.error("[curriculum-gen] JSON generation failed, using fallback:", err);
      }
    }

    title = outline.title;
    units = outline.units.map((u, i) => {
      const validReqs = (u.requiresIndices || [])
        .filter((idx) => idx >= 0 && idx < i)
        .map((idx) => `${planId}-${idx}`);
      const unitMin = Math.min(
        sessionCap,
        Math.max(15, u.minutes || sessionCap),
      );
      const shuffledQuiz = shuffleChoiceExerciseSpec("choice", {
        choices: u.choices,
        correctChoiceIndex: u.answer,
        explanation: u.feedback,
      });
      return normalizeLessonGoalFields({
        title: u.title,
        objective: u.objective,
        completionCriteria: u.completionCriteria,
        concept: u.concept,
        example: u.example,
        question: u.question,
        choices: shuffledQuiz.choices || u.choices,
        answer: shuffledQuiz.correctChoiceIndex ?? u.answer,
        feedback: shuffledQuiz.explanation || u.feedback,
        id: `${planId}-${i}`,
        subtitle: title!,
        minutes: unitMin,
        stageTitle: u.chapterTitle?.trim() || undefined,
        moduleTitle: u.sectionTitle?.trim() || undefined,
        requires: validReqs.length
          ? validReqs
          : i > 0
            ? [`${planId}-${i - 1}`]
            : [],
      });
    });

    const check = validateTrackUnits(units, { strictGoalFields: true });
    if (!check.ok) {
      throw new Error(`生成的课程依赖校验失败：${check.errors.join("；")}`);
    }
  }

  const plan: GoalPlan = {
    id: planId,
    version: crypto.randomUUID(),
    goal: opts.goal,
    title: title!,
    days,
    daily,
    start,
    depth: sizing.depth,
    scopeNote: opts.scopeNote?.trim() || undefined,
    priorKnowledge: sizing.priorKnowledge,
    units,
    slots: [],
  };

  // Try scheduling strictly inside [start, endLimit]; if too tight, relax days up to 14
  let slots = schedulePlan(plan, opts.blocks, opts.day, endLimit);
  if (!slots && days < 14) {
    plan.days = Math.max(days, units.length + 2);
    slots = schedulePlan(plan, opts.blocks, opts.day, endLimit);
  }
  if (slots) {
    plan.slots = slots;
    plan.units = plan.units.map((u) => ({
      ...u,
      minutes: slots!.find((b) => b.lesson === u.id)?.minutes || u.minutes,
    }));
  }

  return { plan, scheduled: Boolean(slots && slots.length) };
}
