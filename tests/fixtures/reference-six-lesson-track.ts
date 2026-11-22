import {
  type Block,
  type GoalPlan,
  type Lesson,
  type Store,
  emptyStore,
} from "../../lib/learning";
import {
  scheduleTrackUnitsInOrder,
  validateTrackUnits,
} from "../../lib/curriculum-planner";

export const REFERENCE_SIX_TRACK_ID = "ref-track-ai-agent-6";

/**
 * E2E-001 (AC #6): Deterministic 6-lesson reference track fixture for automated
 * regression tests. Real user journeys dynamically size tracks (1..16 lessons);
 * automated regression tests load this fixed 6-lesson reference curriculum.
 */
export function createReferenceSixLessonTrack(day = "2026-11-21"): {
  plan: GoalPlan;
  slots: Block[];
} {
  const units: Lesson[] = [
    {
      id: "ref-u1-llm-api",
      title: "LLM 是怎样被调用的：Token、上下文与 API",
      subtitle: "理解消息数组、Token 预算与基础 API 调用",
      minutes: 45,
      requires: [],
      concept: "大模型基于上下文预测下一个 Token，通过 messages 数组与参数控制输出。",
      objective: "理解 Token 计费、上下文窗口边界与标准 Chat Completions 请求结构。",
      completionCriteria: "能够写出最小 API 请求结构并通过 Token 与上下文测验（掌握度 ≥ 80%）。",
      example: 'const res = await fetch("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model, messages }) });',
      question: "LLM 的无状态 API 如何维持多轮对话记忆？",
      choices: [
        "每次请求由客户端携带必要历史消息与摘要",
        "模型服务端永久记住所有本地变量",
        "只传最后一条用户消息即可自动恢复全部历史",
      ],
      answer: 0,
      feedback: "HTTP Chat API 本身无状态，需要应用层管理上下文消息窗口。",
      practiceType: "code",
      practiceLanguage: "typescript",
    },
    {
      id: "ref-u2-prompt-structure",
      title: "Prompt 结构：角色分工与指令约束",
      subtitle: "System / User / Assistant 职责边界",
      minutes: 35,
      requires: ["ref-u1-llm-api"],
      concept: "通过系统指令定义边界与输出格式，用少样本示例降低输出波动。",
      objective: "掌握 System/User 分层设计与约束提示写法，避免指令漂移。",
      completionCriteria: "能够区分系统约束与用户输入边界并通过结构化提示测验（掌握度 ≥ 80%）。",
      example: 'messages: [{ role: "system", content: "仅输出合法 JSON" }, { role: "user", content: input }]',
      question: "将不可变的安全与格式约束放在哪个角色最稳妥？",
      choices: ["system", "assistant", "random"],
      answer: 0,
      feedback: "system 角色用于声明高优先级边界与输出契约。",
      practiceType: "text",
    },
    {
      id: "ref-u3-structured-output",
      title: "结构化输出：把自由文本变成 Schema 数据",
      subtitle: "JSON Schema 与 Zod 强校验",
      minutes: 40,
      requires: ["ref-u2-prompt-structure"],
      concept: "用 JSON Schema / Zod 约束模型输出，并在程序侧严格校验后才能驱动下游业务。",
      objective: "使用 Schema 约束并校验模型返回数据，安全处理解析失败。",
      completionCriteria: "编写一份 Zod Schema 并正确处理校验失败回退（掌握度 ≥ 80%）。",
      example: 'const PlanSchema = z.object({ title: z.string(), minutes: z.number().int() });',
      question: "为什么收到模型 JSON 字符串后仍要在程序侧校验 Schema？",
      choices: [
        "防止字段缺失、类型漂移破坏下游状态",
        "只是为了增加代码行数",
        "因为 JSON 不支持数组",
      ],
      answer: 0,
      feedback: "确定性 Schema 校验是防止幻觉污染业务状态的最后一道防线。",
      practiceType: "code",
      practiceLanguage: "typescript",
    },
    {
      id: "ref-u4-function-calling",
      title: "Function Calling：模型如何安全请求外部工具",
      subtitle: "工具声明、参数校验与宿主执行",
      minutes: 45,
      requires: ["ref-u3-structured-output"],
      concept: "模型只提出工具调用意图与参数，由宿主程序校验权限与参数后执行并回填 Observation。",
      objective: "厘清模型与宿主程序的职责边界，实现一次安全的工具调用闭环。",
      completionCriteria: "正确排列工具调用责任链并通过参数异常处置测验（掌握度 ≥ 80%）。",
      example: 'if (call.name === "get_weather") return runWeatherTool(args);',
      question: "模型发起工具调用请求后，实际执行数据库读写的是谁？",
      choices: ["宿主应用代码", "语言模型权重本身", "前端 CSS"],
      answer: 0,
      feedback: "所有副作用必须由宿主代码在校验后执行，模型只产出结构化调用请求。",
      practiceType: "code",
      practiceLanguage: "typescript",
    },
    {
      id: "ref-u5-react-loop",
      title: "ReAct 循环：Thought → Action → Observation",
      subtitle: "多步推理、终止条件与错误恢复",
      minutes: 45,
      requires: ["ref-u4-function-calling"],
      concept: "Agent 通过交替执行动作与读取观测结果逐步收敛，必须设置步数上限与错误恢复策略。",
      objective: "掌握 ReAct 执行循环顺序、最大步数保护与工具失败恢复策略。",
      completionCriteria: "正确排序 ReAct 完整步骤并设计有限步数终止逻辑（掌握度 ≥ 80%）。",
      example: "for (let step = 0; step < MAX_STEPS; step++) { /* model -> tool -> observation */ }",
      question: "ReAct 循环中若工具返回“时段已冲突”，下一步应该怎么做？",
      choices: [
        "读取最新空闲窗口并重新生成候选方案",
        "死循环重复提交同一冲突时段",
        "忽略错误直接宣称已排课成功",
      ],
      answer: 0,
      feedback: "Observation 改变了环境状态，下一步推理必须基于最新观测。",
      practiceType: "code",
      practiceLanguage: "typescript",
    },
    {
      id: "ref-u6-memory-rag",
      title: "记忆、RAG 与 Agent 架构收敛",
      subtitle: "上下文预算、长期记忆与可观测审计",
      minutes: 45,
      requires: ["ref-u5-react-loop"],
      concept: "用分层上下文压缩、结构化长期记忆与全链路 Trace 保障 Agent 长期可维护。",
      objective: "设计分层上下文预算、长期记忆过滤规则与执行轨迹审计方案。",
      completionCriteria: "完成上下文压缩与记忆边界设计测验（掌握度 ≥ 80%）。",
      example: "const ctx = prepareContextForLLM({ messages, budgetTokens: 16000 });",
      question: "当对话历史逼近上下文窗口上限时，哪种做法最合理？",
      choices: [
        "折叠陈旧工具输出并滚动摘要早期轮次，保留近期关键上下文",
        "直接报错清空用户全部学习记录",
        "把全部数据库原始表每次都拼接进 Prompt",
      ],
      answer: 0,
      feedback: "分层折叠与滚动摘要既控制 Token 预算，又不丢失关键决策上下文。",
      practiceType: "text",
    },
  ];

  const check = validateTrackUnits(units, { strictGoalFields: true });
  if (!check.ok) {
    throw new Error(`Reference 6-lesson fixture invalid: ${check.errors.join("; ")}`);
  }

  const slots = scheduleTrackUnitsInOrder(units, [], day, {
    startMin: 1140,
    endMin: 1350,
    dailyMinutes: 60,
  });

  const plan: GoalPlan = {
    id: REFERENCE_SIX_TRACK_ID,
    version: `${REFERENCE_SIX_TRACK_ID}-v1`,
    goal: "系统掌握 AI Agent 核心原理与工程落地（标准 6 节回归参考轨道）",
    title: "AI Agent 开发 · 原理入门（参考套件）",
    days: 10,
    daily: 60,
    start: 1140,
    depth: "standard",
    scopeNote: "自动化回归固定 6 节参考课程",
    priorKnowledge: "intermediate",
    units,
    slots,
  };

  return { plan, slots };
}

export function createReferenceSixLessonStore(day = "2026-11-21"): Store {
  const { plan, slots } = createReferenceSixLessonTrack(day);
  const mastery: Record<string, number> = {};
  for (const u of plan.units) mastery[u.id] = 0;
  return {
    ...emptyStore(day),
    activeTrackId: plan.id,
    goalPlans: [plan],
    blocks: slots,
    mastery,
  };
}
