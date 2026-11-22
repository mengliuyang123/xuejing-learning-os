import {
  type FSRSRating,
  computeRetrievability,
  previewFSRSRatings,
  reviewFSRS,
  updateBKT,
} from "./bkt-fsrs";

export type TrackDepth = "crash" | "standard" | "deep";
export type PriorKnowledgeLevel = "beginner" | "intermediate" | "advanced";

export type DeferredTopicEntry = {
  topic: string;
  targetLessonId?: string;
  targetLessonTitle: string;
  reason?: string;
};

/**
 * Versioned Adaptive Lesson Contract attached to each node in the Knowledge Graph.
 * Prevents single-lesson blind generation from spoiling downstream chapters or repeating prerequisites.
 */
export type LessonContract = {
  /** 承接的前置能力（已由前驱节点覆盖，本课只快速衔接不重复展开） */
  assumedPrior: string[];
  /** 本节必须掌握的核心概念与最小可验证成果 */
  inScope: string[];
  /** 明确留给后续节点的知识与完整实现（严禁在本课提前讲完） */
  outOfScope: string[];
  /** 结构化后继承接映射：具体留给哪一节后继课 */
  deferredTo: DeferredTopicEntry[];
  /** 贯穿式实践在本节只推进哪一小步（可一句话自然预告下一课） */
  progressionStep: string;
  /** 契约所属的图谱蓝图版本号 */
  blueprintVersion: number;
};

export type Lesson = {
  id: string;
  title: string;
  subtitle: string;
  minutes: number;
  requires: string[];
  concept: string;
  objective?: string;
  completionCriteria?: string;
  example: string;
  question: string;
  choices: string[];
  answer: number;
  feedback: string;
  practiceType?: "code" | "text";
  practiceLanguage?: string;
  practicePrompt?: string;
  starterCode?: string;
  /** Versioned scope & progression contract derived from the Knowledge Graph */
  contract?: LessonContract;
  /** 大章节标题（Major Chapter / Stage Title, LLM 自由命名） */
  stageTitle?: string;
  /** 大章节导语或阶段目标（Optional Major Chapter Summary） */
  stageSubtitle?: string;
  /** 小章节/子专题标题（Sub-chapter / Section Title, LLM 自由命名） */
  moduleTitle?: string;
  /** 小章节说明（Optional Sub-chapter Summary） */
  moduleSubtitle?: string;
  outcomeIds?: string[];
  recommendedActivities?: string[];
};

export const BUILTIN_TRACK_ID = "builtin-ai-agent";

export const lessons: Lesson[] = [
  {
    id: "json",
    title: "JSON 数据结构",
    subtitle: "读懂工具之间传递的数据",
    minutes: 15,
    requires: [],
    concept:
      "JSON 用对象表示键值关系，用数组表示有顺序的集合。对象的键和字符串值都要用双引号包围。",
    example: '{"city": "上海", "days": [1, 2]}',
    question: "示例中 days 字段的值是什么类型？",
    choices: ["字符串", "数组", "对象"],
    answer: 1,
    feedback: "方括号表示数组，这里保存了两个数值。",
  },
  {
    id: "api",
    title: "API 基础",
    subtitle: "连接程序与外部服务",
    minutes: 20,
    requires: ["json"],
    concept:
      "API 约定了程序如何请求服务。客户端提供方法、路径和参数，服务端返回状态码与数据。",
    example: 'GET /weather?city=Shanghai\n→ 200 OK\n{"temperature": 22}',
    question: "哪里可以判断这个请求在 HTTP 层是否成功？",
    choices: ["城市名称", "请求路径", "响应状态码"],
    answer: 2,
    feedback: "200 是成功状态码。响应数据还需要根据业务规则检查。",
  },
  {
    id: "tools",
    title: "理解工具调用",
    subtitle: "Tool Calling",
    minutes: 45,
    requires: ["api", "json"],
    concept:
      "语言模型根据工具描述选择工具，并生成结构化参数。宿主程序校验参数、执行函数，再把结果交还给模型。这样，模型就能结合外部数据回答问题。",
    example:
      '用户：上海现在几度？\n模型 → get_weather({ "city": "上海" })\n程序 → { "temperature": 22, "unit": "°C" }\n模型 → 上海现在是 22°C。',
    question: "模型输出 get_weather 的调用参数后，由谁实际获取天气数据？",
    choices: [
      "语言模型直接访问天气数据库",
      "宿主程序校验参数并执行工具",
      "用户手动提交请求",
    ],
    answer: 1,
    feedback:
      "工具调用分两步。模型提出调用，宿主程序校验并执行，得到的观测结果再进入上下文。",
  },
  {
    id: "react",
    title: "构建 ReAct 循环",
    subtitle: "从工具结果决定下一步",
    minutes: 30,
    requires: ["tools"],
    concept:
      "Agent 根据任务选择一个动作，执行工具并读取观测结果，再判断任务是否完成。终止条件和调用次数上限可以避免无休止的循环。",
    example:
      "目标：为下午安排复习\n动作：读取日历 → 观测：15:00 有空\n动作：查询到期知识点 → 观测：JSON\n结果：生成 15:00 的复习建议",
    question: "工具返回“该时段已占用”后应怎么做？",
    choices: [
      "重复提交同一时段",
      "标记任务已完成",
      "读取新的可用时段再生成方案",
    ],
    answer: 2,
    feedback: "新的观测改变了约束，下一步动作应使用最新数据。",
  },
  {
    id: "recovery",
    title: "工具异常处理",
    subtitle: "让调用失败后仍有下一步",
    minutes: 25,
    requires: ["tools"],
    concept:
      "调用工具可能超时、缺少参数或返回空结果。宿主程序应区分临时错误与输入错误，记录结果并决定重试、补充输入或停止。",
    example:
      "参数缺少 city → 请求补充城市\n临时超时 → 有限次数重试\n达到重试上限 → 返回可理解的错误",
    question: "缺少必填参数时应该如何处理？",
    choices: ["补充参数再调用", "无限重试", "伪造结果"],
    answer: 0,
    feedback: "参数错误需要修正输入，重复同样的请求无法解决问题。",
  },
];

export type Block = {
  id: string;
  day: string;
  start: number;
  minutes: number;
  title: string;
  kind: "学习" | "复习" | "生活" | "工作";
  lesson?: string;
  done?: boolean;
  locked?: boolean;
  splitGroup?: string;
};

export type ScheduleSettings = {
  sleepStart: number; // default 1380 (23:00)
  sleepEnd: number; // default 420 (07:00)
};

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  sleepStart: 1380,
  sleepEnd: 420,
};

export type AssessmentAttempt = {
  id: string;
  lessonId: string;
  kind: "quiz" | "lab" | "diagnostic" | "recall";
  correct: boolean;
  durationSeconds?: number;
  attemptedAt: string;
};

export type SessionExecutionLog = {
  id: string;
  lessonId: string;
  lessonTitle: string;
  plannedMinutes: number;
  actualMinutes: number;
  interruptions: number;
  energy?: "high" | "medium" | "low";
  completedAt: string;
};

export type MemoryCategory =
  | "goal"
  | "preference"
  | "constraint"
  | "weakness"
  | "record";

export type MemoryConstraint = {
  preferredPeriod?: "morning" | "afternoon" | "evening";
  preferredStart?: number;
  preferredEnd?: number;
  maxSessionMinutes?: number;
};

export type Memory = {
  id: string;
  label: string;
  category?: MemoryCategory;
  text: string;
  constraint?: MemoryConstraint;
  source?: "user" | "agent" | "system";
  confidence?: number;
  expiresAt?: string; // YYYY-MM-DD optional TTL for temporary constraints
  createdAt?: string;
};

export type PlanDiffMove = {
  blockId: string;
  title: string;
  oldDay: string;
  oldStart: number;
  oldMinutes: number;
  newDay: string;
  newStart: number;
  newMinutes: number;
};

export type PlanDiff = {
  added: Array<{ title: string; day: string; start: number; minutes: number; kind: string }>;
  removed: Array<{ title: string; day: string; start: number; minutes: number; kind: string }>;
  moved: PlanDiffMove[];
};

export type PlanRevision = {
  id: string;
  versionSeq?: number;
  parentRevisionId?: string | null;
  trigger: string;
  summary: string;
  beforeCount: number;
  afterCount: number;
  diff: PlanDiff;
  createdAt: string;
};

export type AgentRunToolRecord = {
  toolName: string;
  ok: boolean;
  summary?: string;
};

export type AgentRunRecord = {
  runId: string;
  route: "agent" | "tutor";
  modelLabel: string;
  userPrompt: string;
  reasoningChars: number;
  stepCount: number;
  toolCalls: AgentRunToolRecord[];
  status: "completed" | "error";
  errorMessage?: string;
  latencyMs: number;
  createdAt: string;
};

export type DbInfo = {
  path: string;
  sizeBytes: number;
  runCount: number;
  revisionCount: number;
  threadCount: number;
};

export type MasteryOrigin = "verified" | "self_reported" | "skipped";

export type MasteryMeta = {
  pKnown?: number;
  stabilityDays: number;
  difficulty?: number;
  lapses?: number;
  reps?: number;
  fsrsState?: number;
  consecutiveFailures?: number;
  lastReviewDay?: string;
  nextReviewDay: string;
  attempts: number;
  lastResult?: boolean;
  updatedAt?: string;
  masteryOrigin?: MasteryOrigin;
};

export type DecisionFactor = {
  kind: "prerequisite" | "mastery" | "calendar" | "memory" | "review";
  label: string;
  detail: string;
  impact: "positive" | "constraint" | "warning";
};

export type DecisionTrace = {
  id: string;
  timestamp: string;
  targetLessonId?: string;
  targetTitle: string;
  summary: string;
  factors: DecisionFactor[];
  alternatives?: string[];
};

export type GoalPlan = {
  id: string;
  version: string;
  goal: string;
  title: string;
  days: number;
  daily: number;
  start: number;
  units: Lesson[];
  slots: Block[];
  depth?: TrackDepth;
  scopeNote?: string;
  priorKnowledge?: PriorKnowledgeLevel;
  /** Canonical CurriculumBlueprint ID & integer version backing this Knowledge Graph */
  blueprintId?: string;
  blueprintVersion?: number;
  /** Track-level global ResearchPackage ID reused across lesson preparations */
  researchPackageId?: string;
  archived?: boolean;
  archivedAt?: string;
};

export type CourseTrack = {
  id: string;
  title: string;
  goal: string;
  units: Lesson[];
  days?: number;
  daily?: number;
  depth?: TrackDepth;
  scopeNote?: string;
  priorKnowledge?: PriorKnowledgeLevel;
  blueprintId?: string;
  blueprintVersion?: number;
  researchPackageId?: string;
  builtIn?: boolean;
  archived?: boolean;
  archivedAt?: string;
};

export type Store = {
  stateVersion?: number;
  activeTrackId?: string;
  goalPlans?: GoalPlan[];
  mastery: Record<string, number>;
  masteryMeta?: Record<string, MasteryMeta>;
  blocks: Block[];
  memories: Memory[];
  decision: string;
  decisionTrace?: DecisionTrace;
  scheduleSettings?: ScheduleSettings;
  attempts?: AssessmentAttempt[];
  executionLogs?: SessionExecutionLog[];
  paceFactor?: number;
};

export type RescheduleChange = {
  blockId: string;
  title: string;
  lesson?: string;
  oldDay: string;
  oldStart: number;
  oldMinutes: number;
  newSlots: Array<{
    day: string;
    start: number;
    minutes: number;
    title?: string;
  }>;
};

export type RescheduleOption = {
  id: string;
  label: string;
  summary: string;
  score: number;
  tags: string[];
  changes: RescheduleChange[];
  insertEvent?: Block;
};

export type RescheduleProposal = {
  kind: "reschedule";
  title: string;
  reason: string;
  options: RescheduleOption[];
};

export type MemoryProposal = {
  kind: "memory_proposal";
  action: "add" | "update" | "remove";
  targetId?: string;
  category: MemoryCategory;
  label: string;
  text: string;
  reason: string;
  constraint?: MemoryConstraint;
};

export type LessonRecommendationCard = {
  kind: "lesson";
  title: string;
  lessonId: string;
  trackTitle: string;
  mastery: number;
  minutes: number;
  concept: string;
  prerequisites: Array<{
    id: string;
    title: string;
    mastery: number;
    met: boolean;
  }>;
};

export type DecisionTraceCardData = {
  kind: "decision";
  trace: DecisionTrace;
};

export type ActiveRecallCardData = {
  kind: "active_recall";
  lessonId: string;
  title: string;
  trackTitle: string;
  question: string;
  answerConcept: string;
  example: string;
  retrievability: number;
  stabilityDays: number;
  difficulty: number;
  ratingPreviews: Array<{
    rating: FSRSRating;
    label: string;
    intervalDays: number;
  }>;
};

export type MemorySavedCard = {
  kind: "memory_saved";
  memoryId: string;
  action: "add" | "update" | "remove";
  category: MemoryCategory;
  label: string;
  text: string;
  reason?: string;
  constraint?: MemoryConstraint;
  expiresAt?: string;
  source?: "user" | "agent" | "system";
  confidence?: number;
};

export type TrackCreatedCard = {
  kind: "track_created";
  plan: GoalPlan;
  note?: string;
};

export type InteractiveCheckMode =
  | "choice"
  | "multi_choice"
  | "fill_blank"
  | "code"
  | "order_steps"
  | "short_answer";

export type InteractiveBlankSlot = {
  id: string;
  label?: string;
  placeholder?: string;
  answer?: string;
};

export type InteractiveCheckCard = {
  kind: "interactive_check";
  checkId: string;
  exerciseId?: string;
  deduplicated?: boolean;
  mode: InteractiveCheckMode;
  lessonId?: string;
  lessonTitle?: string;
  prompt: string;
  choices?: string[];
  correctChoiceIndex?: number;
  correctChoiceIndices?: number[];
  blanks?: InteractiveBlankSlot[];
  steps?: string[];
  correctStepsOrder?: string[];
  starterCode?: string;
  expectedOutput?: string;
  rubricPoints?: string[];
  language?: string;
  hint?: string;
  explanation?: string;
  savedUserAnswer?: string;
  savedChoiceIndex?: number;
  savedChoiceIndices?: number[];
  savedBlanks?: Record<string, string>;
  savedOrder?: string[];
};

export type MasteryNextStep = {
  label: string;
  prompt: string;
  targetLessonId?: string;
  openGraph?: boolean;
};

export type MasteryDiagnostic = {
  strength?: string;
  misconception?: string;
  keyTakeaway?: string;
};

export type MasteryUpdateCard = {
  kind: "mastery_update";
  attemptId: string;
  lessonId: string;
  lessonTitle: string;
  correct: boolean;
  skip?: boolean;
  before: number;
  after: number;
  nextReviewDay: string;
  unlockedTitles: string[];
  summary: string;
  checkMode?: string;
  stabilityBefore?: number;
  stabilityAfter?: number;
  diagnostic?: MasteryDiagnostic;
  remediationTriggered?: boolean;
  nextSteps?: MasteryNextStep[];
};

export type CalendarUpdatedCard = {
  kind: "calendar_updated";
  action: "add" | "update" | "delete" | "complete";
  block: Block;
  summary: string;
};

export type VisualResourceItem = {
  title: string;
  imageUrl: string;
  sourceUrl: string;
  sourceName: string;
  description?: string;
  cached?: boolean;
};

export type VisualResourceCardData = {
  kind: "visual_resource";
  query: string;
  items: VisualResourceItem[];
};

export type OnboardingQuestion = {
  id: string;
  question: string;
  options: string[];
};

export type OnboardingSurveyCardData = {
  kind: "onboarding_survey";
  surveyId: string;
  topic: string;
  title?: string;
  questions: OnboardingQuestion[];
  ctaLabel?: string;
  footerNote?: string;
  savedSelections?: Record<string, number>;
};

export type RoadmapStageItem = {
  stageTitle: string;
  topics: string;
  icon?: "book" | "code" | "table" | "rocket";
};

export type RoadmapStagesCardData = {
  kind: "roadmap_stages";
  title: string;
  stages: RoadmapStageItem[];
};

export type DataChartPoint = {
  xLabel: string;
  xValue: number;
  yValue: number;
};

export type DataChartCardData = {
  kind: "data_chart";
  title: string;
  xHeader: string;
  yHeader: string;
  points: DataChartPoint[];
  chartType?: "scatter" | "line";
  caption?: string;
};

export type VisualExplanationType = "mermaid" | "svg" | "interactive_widget";

export type VisualExplanationStep = {
  stepNumber: number;
  title: string;
  explanation: string;
  highlightIds?: string[];
  mermaid?: string;
};

export type VisualExplanationWidgetSpec = {
  widgetType: "timeline" | "parameter_explorer";
  config: Record<string, unknown>;
};

export type VisualExplanationCardData = {
  kind: "visual_explanation";
  visualId: string;
  lessonId: string;
  conceptId: string;
  contractVersion: number;
  title: string;
  summary?: string;
  caption?: string;
  visualType: VisualExplanationType;
  mermaid?: string;
  svg?: string;
  widget?: VisualExplanationWidgetSpec;
  steps?: VisualExplanationStep[];
  cacheHit?: boolean;
  skillUsed?: string;
  sanitizationWarnings?: string[];
};

export type AgentCard =
  | RescheduleProposal
  | MemoryProposal
  | MemorySavedCard
  | TrackCreatedCard
  | LessonRecommendationCard
  | DecisionTraceCardData
  | ActiveRecallCardData
  | InteractiveCheckCard
  | MasteryUpdateCard
  | CalendarUpdatedCard
  | VisualResourceCardData
  | VisualExplanationCardData
  | OnboardingSurveyCardData
  | RoadmapStagesCardData
  | DataChartCardData;

export function today() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
  }).format(new Date());
}

export function offset(day: string, n: number) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diffDays(fromDay: string, toDay: string) {
  const a = new Date(fromDay + "T12:00:00Z").getTime();
  const b = new Date(toDay + "T12:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

export function time(n: number) {
  const clamped = Math.max(0, Math.min(1440, Math.round(n)));
  return [Math.floor(clamped / 60), clamped % 60]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
}

export function dateLabel(day: string, options: Intl.DateTimeFormatOptions) {
  return new Date(day + "T12:00:00Z").toLocaleDateString("zh-CN", options);
}

const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function weekdayLabel(day: string): string {
  const idx = (new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7;
  return WEEKDAY_NAMES[idx] || "";
}

export function formatDayWithWeekday(day: string): string {
  const [, m, d] = day.split("-");
  const monthNum = Number(m);
  const dayNum = Number(d);
  const wk = weekdayLabel(day);
  if (!monthNum || !dayNum) return `${day} ${wk}`.trim();
  return `${monthNum}月${dayNum}日 ${wk}`;
}

export function isRemedialBlock(b: Pick<Block, "kind" | "title">): boolean {
  return b.kind === "复习" || /补救|复习|巩固|微复习|回顾/.test(b.title);
}

export function categoryLabel(category: MemoryCategory): string {
  return {
    goal: "学习目标",
    preference: "学习偏好",
    constraint: "时间约束",
    weakness: "薄弱点",
    record: "学习记录",
  }[category];
}

export function inferMemoryCategory(label: string, text: string): MemoryCategory {
  if (/目标/.test(label)) return "goal";
  if (/约束|时间|日程|时长|晚上|上午|下午/.test(label)) return "constraint";
  if (/薄弱|易错|难点|巩固/.test(label)) return "weakness";
  if (/记录|反馈/.test(label)) return "record";
  if (/偏好|风格|习惯/.test(label)) return "preference";
  if (/不超过|分钟|点后|晚上|上午|下午|避开/.test(text)) return "constraint";
  return "preference";
}

function parseChineseNum(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = "零一二三四五六七八九";
  if (text === "两") return 2;
  if (text.includes("十")) {
    const [a, b] = text.split("十");
    return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0);
  }
  return digits.indexOf(text);
}

export function parseMemoryConstraint(text: string): MemoryConstraint | undefined {
  const constraint: MemoryConstraint = {};
  if (/早上|早晨|上午|清晨/.test(text)) {
    constraint.preferredPeriod = "morning";
    constraint.preferredStart = 540;
  } else if (/下午|午后/.test(text)) {
    constraint.preferredPeriod = "afternoon";
    constraint.preferredStart = 900;
  } else if (/晚上|晚间|夜里|下班后|睡前/.test(text)) {
    constraint.preferredPeriod = "evening";
    constraint.preferredStart = 1170;
  }

  // Time range e.g. 19:30-22:30, 19:30–22:30, 19:30 到 22:30
  const rangeMatch = text.match(
    /(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*(?:-|–|~|至|到)\s*(\d{1,2})\s*[:：点时]\s*(\d{1,2})?/,
  );
  if (rangeMatch) {
    let h1 = Number(rangeMatch[1]);
    const m1 = Number(rangeMatch[2] || 0);
    let h2 = Number(rangeMatch[3]);
    const m2 = Number(rangeMatch[4] || 0);
    if (h1 < 12 && /晚上|晚间/.test(text)) h1 += 12;
    if (h2 < 12 && (h1 >= 12 || /晚上|晚间/.test(text))) h2 += 12;
    if (h1 < 24 && h2 <= 24 && m1 < 60 && m2 < 60) {
      constraint.preferredStart = h1 * 60 + m1;
      constraint.preferredEnd = Math.min(1440, h2 * 60 + m2);
      if (h1 < 12) constraint.preferredPeriod = "morning";
      else if (h1 < 18) constraint.preferredPeriod = "afternoon";
      else constraint.preferredPeriod = "evening";
    }
  } else {
    // Strip phrases like "一点语法" / "一点基础" / "一点点" / "1小时" before matching clock hours
    const clockSafeText = text
      .replace(/一点(?:点|语法|基础|代码|概念|印象|经验|知识|皮毛|也不|都不|没)/g, "")
      .replace(/[零一二两三四五六七八九十0-9]+\s*个?\s*小时/g, "");
    const hourMatch = clockSafeText.match(
      /(?:(上午|下午|晚上|早上|晚间)\s*([零一二两三四五六七八九十0-9]+)\s*(?:[:：](\d{1,2})|[点时](?!\s*间))\s*(?:半)?)|(?:(\d{1,2})\s*[:：]\s*(\d{2}))|(?:([零一二两三四五六七八九十0-9]+)\s*点\s*(?:半|整|钟|以后|之后|后|开始))/,
    );
    if (hourMatch) {
      if (hourMatch[4]) {
        const h = Number(hourMatch[4]);
        const min = Number(hourMatch[5] || 0);
        if (h >= 0 && h <= 23 && min < 60) {
          constraint.preferredStart = Math.min(1380, h * 60 + min);
          if (h < 12) constraint.preferredPeriod = "morning";
          else if (h < 18) constraint.preferredPeriod = "afternoon";
          else constraint.preferredPeriod = "evening";
        }
      } else {
        const period = hourMatch[1] || "";
        const rawH = hourMatch[2] || hourMatch[6] || "";
        let h = parseChineseNum(rawH);
        const half = /半/.test(hourMatch[0]);
        const min = hourMatch[3] ? Number(hourMatch[3]) : half ? 30 : 0;
        if (h >= 0 && h <= 23) {
          if (h < 12 && /下午|晚上|晚间/.test(period || clockSafeText)) h += 12;
          constraint.preferredStart = Math.min(1380, h * 60 + min);
          if (h < 12) constraint.preferredPeriod = "morning";
          else if (h < 18) constraint.preferredPeriod = "afternoon";
          else constraint.preferredPeriod = "evening";
        }
      }
    }
  }

  // Hard end boundary e.g. "22:30 为硬边界" / "22:30 前结束" / "不超过 22:30"
  const endMatch = text.match(
    /(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*(?:为硬边界|硬边界|硬截止|前结束|必须结束|前停止|以后不学)/,
  );
  if (endMatch) {
    let h = Number(endMatch[1]);
    const m = Number(endMatch[2] || 0);
    if (h < 12 && /晚上|晚间/.test(text)) h += 12;
    if (h <= 24 && m < 60) {
      constraint.preferredEnd = Math.min(1440, h * 60 + m);
    }
  }

  const splitMatch = text.match(/(\d{2,3})\s*\+\s*(\d{2,3})/);
  const maxMinMatch = text.match(
    /(?:不超过|最多|控制在|每次|单次|上限|拆)\s*([零一二两三四五六七八九十0-9]+)\s*分钟/,
  );
  if (splitMatch) {
    const m = Math.max(Number(splitMatch[1]), Number(splitMatch[2]));
    if (m >= 15 && m <= 180) constraint.maxSessionMinutes = m;
  } else if (maxMinMatch) {
    const m = parseChineseNum(maxMinMatch[1]);
    if (m >= 10 && m <= 180) constraint.maxSessionMinutes = m;
  } else if (/不超过半小时|最多半小时|每次半小时/.test(text)) {
    constraint.maxSessionMinutes = 30;
  }

  return Object.keys(constraint).length ? constraint : undefined;
}

/**
 * Infers an optional expiration date (YYYY-MM-DD) for temporary memory phrases
 * such as "今天", "明天", "明后两天", "这周/本周", "临时", preventing temporary
 * disruptions from permanently polluting long-term scheduling constraints.
 */
export function parseMemoryExpiry(text: string, baseDay: string): string | undefined {
  const explicitDate = text.match(
    /(?:截止|有效期至|到)\s*(\d{4}-\d{2}-\d{2})/,
  );
  if (explicitDate) return explicitDate[1];

  const daysMatch = text.match(/(?:未来|最近|这|接下来)\s*([零一二两三四五六七八九十0-9]+)\s*天/);
  if (daysMatch) {
    const n = parseChineseNum(daysMatch[1]);
    if (n >= 1 && n <= 60) return offset(baseDay, n);
  }

  if (/今晚|今天(?!以后|之后)/.test(text) && !/每天|每日|以后/.test(text)) {
    return offset(baseDay, 1);
  }
  if (/明后两天|未来两天|这两天/.test(text)) {
    return offset(baseDay, 3);
  }
  if (/明天(?!以后|之后)/.test(text) && !/每天|每日/.test(text)) {
    return offset(baseDay, 2);
  }
  if (/这周|本周|这一周/.test(text) && !/每周/.test(text)) {
    return offset(baseDay, 7);
  }
  if (/下周/.test(text) && !/每周/.test(text)) {
    return offset(baseDay, 14);
  }
  if (/临时|出差|考试周/.test(text) && !/每天|每周|长期/.test(text)) {
    return offset(baseDay, 7);
  }
  return undefined;
}

export function isMemoryExpired(m: Memory, day: string): boolean {
  return Boolean(m.expiresAt && m.expiresAt < day);
}

export function getActiveMemories(memories: Memory[], day: string): Memory[] {
  return memories.filter((m) => !isMemoryExpired(m, day));
}

export function getTracks(
  s: Store,
  opts: { includeArchived?: boolean } = {},
): CourseTrack[] {
  const includeArchived = Boolean(opts.includeArchived);
  return (s.goalPlans || [])
    .filter((p) => includeArchived || !p.archived)
    .map((p) => ({
      id: p.id,
      title: p.title,
      goal: p.goal,
      units: p.units,
      days: p.days,
      daily: p.daily,
      depth: p.depth,
      scopeNote: p.scopeNote,
      priorKnowledge: p.priorKnowledge,
      blueprintId: p.blueprintId,
      blueprintVersion: p.blueprintVersion,
      researchPackageId: p.researchPackageId,
      archived: Boolean(p.archived),
      archivedAt: p.archivedAt,
    }));
}

export function getArchivedTracks(s: Store): CourseTrack[] {
  return (s.goalPlans || [])
    .filter((p) => Boolean(p.archived))
    .map((p) => ({
      id: p.id,
      title: p.title,
      goal: p.goal,
      units: p.units,
      days: p.days,
      daily: p.daily,
      depth: p.depth,
      scopeNote: p.scopeNote,
      priorKnowledge: p.priorKnowledge,
      archived: true,
      archivedAt: p.archivedAt,
    }));
}

export function getActiveTrack(s: Store, trackId?: string): CourseTrack | null {
  const activeTracks = getTracks(s, { includeArchived: false });
  const requested = trackId || s.activeTrackId;
  if (requested) {
    const matchActive = activeTracks.find((t) => t.id === requested);
    if (matchActive) return matchActive;
    if (trackId) {
      const matchAny = getTracks(s, { includeArchived: true }).find(
        (t) => t.id === requested,
      );
      if (matchAny) return matchAny;
    }
  }
  if (!activeTracks.length) return null;
  return activeTracks.at(-1) || activeTracks[0];
}

export function getAllLessons(
  s: Store,
  opts: { includeArchived?: boolean } = {},
): Lesson[] {
  const includeArchived = Boolean(opts.includeArchived);
  return (s.goalPlans || [])
    .filter((p) => includeArchived || !p.archived)
    .flatMap((p) => p.units);
}

export function getLessonById(s: Store, id: string): Lesson | undefined {
  return getAllLessons(s, { includeArchived: true }).find((l) => l.id === id);
}

export function getTrackForLesson(
  s: Store,
  lessonId: string,
): CourseTrack | null {
  const allTracks = getTracks(s, { includeArchived: true });
  return (
    allTracks.find((t) => t.units.some((u) => u.id === lessonId)) ||
    allTracks.find((t) => !t.archived) ||
    allTracks[0] ||
    null
  );
}

export function available(s: Store, l: Lesson) {
  return l.requires.every((id) => (s.mastery[id] ?? 0) >= 80);
}

/**
 * Explicit DAG cycle detection (Kahn's algorithm) so cyclic prerequisite graphs are rejected.
 */
export function hasPrerequisiteCycle(units: Lesson[]): boolean {
  const ids = new Set(units.map((u) => u.id));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const u of units) {
    inDegree.set(u.id, 0);
    adj.set(u.id, []);
  }
  for (const u of units) {
    for (const req of u.requires) {
      if (!ids.has(req)) continue;
      adj.get(req)!.push(u.id);
      inDegree.set(u.id, (inDegree.get(u.id) ?? 0) + 1);
    }
  }
  const queue = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const curr = queue.shift()!;
    visited++;
    for (const next of adj.get(curr) || []) {
      const deg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  return visited !== units.length;
}

/**
 * Multi-hop missing prerequisites query (returns all unmastered ancestors in dependency order).
 */
export function getMissingPrerequisites(s: Store, lesson: Lesson): Lesson[] {
  const missing: Lesson[] = [];
  const seen = new Set<string>();
  function visit(curr: Lesson) {
    for (const reqId of curr.requires) {
      if (seen.has(reqId)) continue;
      seen.add(reqId);
      const req = getLessonById(s, reqId);
      if (!req) continue;
      visit(req);
      if ((s.mastery[reqId] ?? 0) < 80) {
        missing.push(req);
      }
    }
  }
  visit(lesson);
  return missing;
}

/**
 * Detects unfinished learning/review blocks in the past (Scenario D: Missed Sessions).
 */
export function getMissedSessions(s: Store, nowDay: string): Block[] {
  return s.blocks
    .filter(
      (b) =>
        (Boolean(b.lesson) || b.kind === "学习" || b.kind === "复习") &&
        !b.done &&
        b.day < nowDay,
    )
    .sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start);
}

export function focusLesson(s: Store, trackId?: string): Lesson | null {
  const track = getActiveTrack(s, trackId);
  if (!track) return null;
  return (
    track.units.find((l) => available(s, l) && (s.mastery[l.id] ?? 0) < 80) ||
    track.units.find((l) => (s.mastery[l.id] ?? 0) < 80) ||
    track.units[0] ||
    null
  );
}

export function getLessonRetrievability(
  s: Store,
  lessonId: string,
  day: string,
): number {
  const m = s.masteryMeta?.[lessonId];
  const score = s.mastery[lessonId] ?? 0;
  if (!m || score === 0) return 0;
  const lastDay = m.lastReviewDay || m.updatedAt || offset(day, -1);
  const elapsed = Math.max(0, diffDays(lastDay, day));
  return Math.round(computeRetrievability(elapsed, m.stabilityDays) * 100);
}

export function dueReviews(s: Store, day: string) {
  const all = getAllLessons(s);
  const meta = s.masteryMeta || {};
  return all
    .map((lesson) => {
      const m = meta[lesson.id];
      const mastery = s.mastery[lesson.id] ?? 0;
      if (!m || mastery === 0) return null;
      const overdueDays = diffDays(m.nextReviewDay, day);
      const retrievability = getLessonRetrievability(s, lesson.id, day);
      if (overdueDays < 0 && retrievability > 88) return null;
      return {
        lesson,
        mastery,
        retrievability,
        stabilityDays: m.stabilityDays,
        difficulty: m.difficulty ?? 5.0,
        nextReviewDay: m.nextReviewDay,
        overdueDays,
      };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .sort(
      (a, b) =>
        a.retrievability - b.retrievability ||
        b.overdueDays - a.overdueDays ||
        a.mastery - b.mastery,
    );
}

export function buildActiveRecallCard(
  s: Store,
  lesson: Lesson,
  day: string,
): ActiveRecallCardData {
  const track = getTrackForLesson(s, lesson.id);
  const meta = s.masteryMeta?.[lesson.id];
  const lastDay = meta?.lastReviewDay || meta?.updatedAt || offset(day, -1);
  const elapsed = Math.max(1, diffDays(lastDay, day));
  const retrievability = meta
    ? Math.round(computeRetrievability(elapsed, meta.stabilityDays) * 100)
    : 75;
  return {
    kind: "active_recall",
    lessonId: lesson.id,
    title: lesson.title,
    trackTitle: track?.title || lesson.subtitle || "个人学习轨道",
    question: lesson.question,
    answerConcept: lesson.concept,
    example: lesson.example,
    retrievability,
    stabilityDays: meta?.stabilityDays ?? 1.5,
    difficulty: meta?.difficulty ?? 5.0,
    ratingPreviews: previewFSRSRatings(meta, elapsed),
  };
}

export function buildDecisionTrace(
  s: Store,
  day: string,
  trackId?: string,
): DecisionTrace {
  const track = getActiveTrack(s, trackId);
  const lesson = focusLesson(s, track?.id);

  if (!track || !lesson) {
    const factors: DecisionFactor[] = [
      {
        kind: "prerequisite",
        label: "尚未创建学习目标",
        detail: "前往「学习工作台」输入任意学习目标，AI 会自动生成带先修图谱的专属微课。",
        impact: "warning",
      },
      {
        kind: "calendar",
        label: s.blocks.length ? `已记录 ${s.blocks.length} 项日程` : "日历当前空白",
        detail: s.blocks.length
          ? "创建学习目标时会自动避开这些已有日程安排空档。"
          : "你可以在「日历规划」添加固定工作/生活日程，或在右侧 Copilot 用自然语言安排。",
        impact: "constraint",
      },
    ];
    if (s.memories.length) {
      factors.push({
        kind: "memory",
        label: `已生效 ${s.memories.length} 条长期记忆`,
        detail: s.memories[0].text,
        impact: "positive",
      });
    }
    return {
      id: `trace-empty-${day}`,
      timestamp: new Date().toISOString(),
      targetTitle: "等待创建学习目标",
      summary:
        "当前空间已清空，你可以从零开始：先在「学习工作台」输入学习目标，或在「日历规划」「长期记忆」中录入你的日程与习惯。",
      factors,
    };
  }

  const factors: DecisionFactor[] = [];

  if (lesson.requires.length) {
    const reqText = lesson.requires
      .map((id) => {
        const req = getLessonById(s, id);
        return `${req?.title || id} (${s.mastery[id] ?? 0}%)`;
      })
      .join("、");
    const met = available(s, lesson);
    factors.push({
      kind: "prerequisite",
      label: met ? "先修依赖已满足" : "存在未达标先修",
      detail: `${reqText} ${met ? "均已达到 80% 解锁阈值" : "需先完成前置知识"}`,
      impact: met ? "positive" : "warning",
    });
  } else {
    factors.push({
      kind: "prerequisite",
      label: "起始核心节点",
      detail: `「${lesson.title}」无前置依赖，可直接开启「${track.title}」路径`,
      impact: "positive",
    });
  }

  const currentMastery = s.mastery[lesson.id] ?? 0;
  factors.push({
    kind: "mastery",
    label: `当前掌握度 ${currentMastery}%`,
    detail:
      currentMastery === 0
        ? "尚未开始学习，处于最近发展区，适合作为下一主攻节点。"
        : currentMastery < 80
          ? `距离 80% 掌握阈值还差 ${80 - currentMastery}%，继续巩固即可解锁后续节点。`
          : "已达到掌握标准，建议转入间隔复习以防遗忘。",
    impact: currentMastery < 80 ? "positive" : "constraint",
  });

  const planned = s.blocks
    .filter((b) => b.day >= day && !b.done && b.lesson === lesson.id)
    .sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start)[0];
  if (planned) {
    factors.push({
      kind: "calendar",
      label: "已匹配日历空档",
      detail: `安排在 ${planned.day === day ? "今天" : planned.day.slice(5)} ${time(planned.start)}–${time(planned.start + planned.minutes)}（${planned.minutes} 分钟），已避开工作与生活日程。`,
      impact: "positive",
    });
  } else {
    factors.push({
      kind: "calendar",
      label: "待安排时段",
      detail: `预计需要 ${lesson.minutes} 分钟，当前日历尚未落位，可让 Agent 自动寻找空档。`,
      impact: "warning",
    });
  }

  const prefMem = s.memories.find(
    (m) =>
      m.category === "constraint" ||
      m.category === "preference" ||
      m.constraint,
  );
  if (prefMem) {
    factors.push({
      kind: "memory",
      label: `引用记忆：${prefMem.label}`,
      detail: prefMem.text,
      impact: "constraint",
    });
  }

  const reviews = dueReviews(s, day);
  if (reviews.length) {
    factors.push({
      kind: "review",
      label: `${reviews.length} 项知识进入复习窗口`,
      detail: `优先复习「${reviews[0].lesson.title}」（掌握度 ${reviews[0].mastery}%，建议复习日 ${reviews[0].nextReviewDay.slice(5)}）。`,
      impact: "warning",
    });
  }

  const alternatives = track.units
    .filter((u) => u.id !== lesson.id)
    .slice(0, 2)
    .map((u) => {
      const m = s.mastery[u.id] ?? 0;
      if (m >= 80) return `「${u.title}」已掌握（${m}%），仅需间隔复习`;
      if (!available(s, u)) return `「${u.title}」先修尚未达标，暂未解锁`;
      return `「${u.title}」可作为备选（当前掌握度 ${m}%）`;
    });

  return {
    id: `trace-${lesson.id}-${day}`,
    timestamp: new Date().toISOString(),
    targetLessonId: lesson.id,
    targetTitle: lesson.title,
    summary:
      factors[0].detail +
      (planned
        ? `；已在 ${planned.day === day ? "今天" : planned.day.slice(5)} ${time(planned.start)} 预留 ${planned.minutes} 分钟。`
        : `；预计投入 ${lesson.minutes} 分钟。`),
    factors,
    alternatives,
  };
}

export function computeMasteryUpdate(
  s: Store,
  lesson: Lesson,
  ok: boolean,
  day: string,
) {
  const before = s.mastery[lesson.id] ?? 0;
  const prevMeta = s.masteryMeta?.[lesson.id];
  const priorP = prevMeta?.pKnown ?? (before > 0 ? before / 100 : 0.32);

  // Genuine Bayesian Knowledge Tracing (BKT) posterior + learning transition.
  // Cold-start honesty: a wrong answer when prior mastery is 0% MUST NOT inflate mastery to 8%.
  const bkt = updateBKT(priorP, ok);
  const after = ok
    ? Math.min(99, Math.max(bkt.score, before >= 55 ? 80 : bkt.score))
    : before === 0
      ? 0
      : Math.max(0, Math.min(before, bkt.score));

  const lastDay = prevMeta?.lastReviewDay || prevMeta?.updatedAt || offset(day, -1);
  const elapsed = Math.max(1, diffDays(lastDay, day));
  const fsrs = reviewFSRS(prevMeta, ok ? 3 : 1, elapsed);
  const nextReviewDay = offset(day, fsrs.nextIntervalDays);
  const nextMastery = { ...s.mastery, [lesson.id]: after };

  const track = getTrackForLesson(s, lesson.id);
  const unlocked = (track?.units || []).filter(
    (u) =>
      u.id !== lesson.id &&
      !available(s, u) &&
      available({ ...s, mastery: nextMastery }, u),
  );

  const consecutiveFailures = ok
    ? 0
    : (prevMeta?.consecutiveFailures ?? 0) + 1;

  return {
    before,
    after,
    delta: after - before,
    pKnown: bkt.pNext,
    stabilityDays: fsrs.stabilityDays,
    difficulty: fsrs.difficulty,
    consecutiveFailures,
    needsRemediation: consecutiveFailures >= 2 || (!ok && after < 55),
    nextReviewDay,
    unlocked,
    meta: {
      pKnown: Number(bkt.pNext.toFixed(4)),
      stabilityDays: fsrs.stabilityDays,
      difficulty: fsrs.difficulty,
      lapses: fsrs.lapses,
      reps: fsrs.reps,
      fsrsState: fsrs.fsrsState,
      consecutiveFailures,
      lastReviewDay: day,
      nextReviewDay,
      attempts: (prevMeta?.attempts ?? 0) + 1,
      lastResult: ok,
      updatedAt: day,
      masteryOrigin: "verified",
    } satisfies MasteryMeta,
  };
}

export function computeFSRSReviewUpdate(
  s: Store,
  lesson: Lesson,
  rating: FSRSRating,
  day: string,
) {
  const before = s.mastery[lesson.id] ?? 0;
  const prevMeta = s.masteryMeta?.[lesson.id];
  const lastDay = prevMeta?.lastReviewDay || prevMeta?.updatedAt || offset(day, -1);
  const elapsed = Math.max(1, diffDays(lastDay, day));
  const fsrs = reviewFSRS(prevMeta, rating, elapsed);

  const bkt = updateBKT(
    prevMeta?.pKnown ?? Math.max(0.25, before / 100),
    rating >= 2,
  );
  const after = Math.min(
    99,
    Math.max(10, Math.round((before + fsrs.masteryDelta + bkt.score) / 2)),
  );
  const nextReviewDay = offset(day, fsrs.nextIntervalDays);

  return {
    before,
    after,
    delta: after - before,
    nextIntervalDays: fsrs.nextIntervalDays,
    nextReviewDay,
    meta: {
      pKnown: Number((after / 100).toFixed(4)),
      stabilityDays: fsrs.stabilityDays,
      difficulty: fsrs.difficulty,
      lapses: fsrs.lapses,
      reps: fsrs.reps,
      fsrsState: fsrs.fsrsState,
      consecutiveFailures: rating === 1 ? (prevMeta?.consecutiveFailures ?? 0) + 1 : 0,
      lastReviewDay: day,
      nextReviewDay,
      attempts: (prevMeta?.attempts ?? 0) + 1,
      lastResult: rating >= 2,
      updatedAt: day,
      masteryOrigin: "verified",
    } satisfies MasteryMeta,
  };
}

export function emptyStore(day: string): Store {
  const base: Store = {
    stateVersion: 0,
    activeTrackId: undefined,
    goalPlans: [],
    mastery: {},
    masteryMeta: {},
    blocks: [],
    memories: [],
    scheduleSettings: { ...DEFAULT_SCHEDULE_SETTINGS },
    attempts: [],
    executionLogs: [],
    paceFactor: 1.0,
    decision:
      "当前空间已清空，你可以从零开始创建学习目标、日程安排与长期记忆。",
  };
  base.decisionTrace = buildDecisionTrace(base, day);
  return base;
}

export function initial(day: string): Store {
  return emptyStore(day);
}

/**
 * Sample fixture used by unit tests (not loaded into the live app by default).
 */
export function demoInitial(day: string): Store {
  const base: Store = {
    activeTrackId: BUILTIN_TRACK_ID,
    goalPlans: [
      {
        id: BUILTIN_TRACK_ID,
        version: "demo-v1",
        goal: "独立构建一个会使用工具的 AI Agent。",
        title: "AI Agent 开发基础",
        days: 7,
        daily: 45,
        start: 600,
        units: lessons,
        slots: [],
      },
    ],
    mastery: { json: 90, api: 85, tools: 62, react: 0, recovery: 0 },
    masteryMeta: {
      json: {
        pKnown: 0.9,
        stabilityDays: 3.5,
        difficulty: 3.4,
        lapses: 0,
        lastReviewDay: offset(day, -4),
        nextReviewDay: day,
        attempts: 2,
        lastResult: true,
        updatedAt: offset(day, -4),
      },
      api: {
        pKnown: 0.85,
        stabilityDays: 3.0,
        difficulty: 4.2,
        lapses: 0,
        lastReviewDay: offset(day, -2),
        nextReviewDay: offset(day, 1),
        attempts: 2,
        lastResult: true,
        updatedAt: offset(day, -2),
      },
      tools: {
        pKnown: 0.62,
        stabilityDays: 1.2,
        difficulty: 5.8,
        lapses: 1,
        lastReviewDay: offset(day, -1),
        nextReviewDay: day,
        attempts: 1,
        lastResult: false,
        updatedAt: offset(day, -1),
      },
    },
    blocks: [
      {
        id: "warm",
        day,
        start: 540,
        minutes: 20,
        title: "API 基础回顾",
        kind: "复习",
        lesson: "api",
        done: true,
      },
      {
        id: "focus",
        day,
        start: 600,
        minutes: 45,
        title: "理解工具调用",
        kind: "学习",
        lesson: "tools",
      },
      {
        id: "lunch",
        day,
        start: 720,
        minutes: 60,
        title: "午餐与散步",
        kind: "生活",
      },
      {
        id: "work",
        day,
        start: 840,
        minutes: 60,
        title: "项目同步会议",
        kind: "工作",
      },
      {
        id: "review",
        day,
        start: 960,
        minutes: 20,
        title: "JSON 主动回忆",
        kind: "复习",
        lesson: "json",
      },
      {
        id: "upcoming-1",
        day: offset(day, 1),
        start: 1170,
        minutes: 30,
        title: "构建 ReAct 循环",
        kind: "学习",
        lesson: "react",
      },
      {
        id: "upcoming-2",
        day: offset(day, 2),
        start: 1170,
        minutes: 25,
        title: "工具异常处理",
        kind: "学习",
        lesson: "recovery",
      },
      ...[35, 50, 25, 60, 40].map((minutes, i): Block => ({
        id: "history-" + i,
        day: offset(day, i - 5),
        start: 540,
        minutes,
        title: i % 2 ? "API 基础练习" : "JSON 阅读与练习",
        kind: "学习",
        lesson: i % 2 ? "api" : "json",
        done: true,
      })),
    ],
    memories: [
      {
        id: "goal",
        label: "学习目标",
        category: "goal",
        text: "独立构建一个会使用工具的 AI Agent。",
        createdAt: offset(day, -5),
      },
      {
        id: "habit",
        label: "学习偏好",
        category: "preference",
        text: "先阅读一个完整示例，再通过练习检验理解。",
        createdAt: offset(day, -5),
      },
      {
        id: "time-pref",
        label: "时间约束",
        category: "constraint",
        text: "偏好上午 10 点或晚上 8 点后专注学习，单次尽量不超过 45 分钟。",
        constraint: {
          preferredPeriod: "evening",
          preferredStart: 1200,
          maxSessionMinutes: 45,
        },
        createdAt: offset(day, -3),
      },
    ],
    decision:
      "API 基础和 JSON 已达到先修要求。日历中有 45 分钟连续空档，适合学习工具调用。",
  };
  base.decisionTrace = buildDecisionTrace(base, day);
  return base;
}

export function migrateStore(raw: unknown, day: string): Store | null {
  if (!raw || typeof raw !== "object") return null;
  const saved = raw as Partial<Store>;
  if (
    !saved.mastery ||
    !Array.isArray(saved.blocks) ||
    !Array.isArray(saved.memories)
  )
    return null;

  const memories: Memory[] = saved.memories.map((m) => {
    const category = m.category || inferMemoryCategory(m.label, m.text);
    const constraint =
      m.constraint ||
      (category === "constraint" || category === "preference"
        ? parseMemoryConstraint(m.text)
        : undefined);
    return { ...m, category, constraint };
  });

  const masteryMeta: Record<string, MasteryMeta> = {
    ...(saved.masteryMeta || {}),
  };
  for (const [k, v] of Object.entries(saved.mastery)) {
    if (!masteryMeta[k] && v > 0) {
      masteryMeta[k] = {
        stabilityDays: v >= 80 ? 3 : 1,
        nextReviewDay: offset(day, v >= 80 ? 2 : 0),
        attempts: 1,
        lastResult: v >= 80,
      };
    }
  }

  const migrated: Store = {
    activeTrackId: saved.activeTrackId || saved.goalPlans?.at(-1)?.id,
    goalPlans: saved.goalPlans || [],
    mastery: saved.mastery,
    masteryMeta,
    blocks: saved.blocks,
    memories,
    scheduleSettings: saved.scheduleSettings || {
      ...DEFAULT_SCHEDULE_SETTINGS,
    },
    attempts: Array.isArray(saved.attempts) ? saved.attempts : [],
    executionLogs: Array.isArray(saved.executionLogs)
      ? saved.executionLogs
      : [],
    paceFactor:
      typeof saved.paceFactor === "number" && saved.paceFactor > 0.4
        ? saved.paceFactor
        : 1.0,
    decision:
      saved.decision ||
      "当前空间已就绪，可以从学习工作台设定你的学习目标。",
    decisionTrace: saved.decisionTrace,
  };
  if (!migrated.decisionTrace) {
    migrated.decisionTrace = buildDecisionTrace(migrated, day);
  }
  return migrated;
}

export function free(
  blocks: Block[],
  day: string,
  start: number,
  duration: number,
  ignore?: string | Set<string>,
) {
  const ignored =
    typeof ignore === "string" ? new Set([ignore]) : ignore || new Set<string>();
  return (
    start >= 0 &&
    start + duration <= 1440 &&
    blocks.every(
      (b) =>
        ignored.has(b.id) ||
        b.day !== day ||
        start + duration <= b.start ||
        start >= b.start + b.minutes,
    )
  );
}

export function findSlot(
  blocks: Block[],
  day: string,
  start: number,
  duration: number,
  ignore?: string | Set<string>,
  endHourLimit = 1350,
) {
  for (let d = 0; d < 8; d++)
    for (
      let m = d === 0 ? Math.max(480, start) : 540;
      m + duration <= endHourLimit;
      m += 5
    ) {
      if (free(blocks, offset(day, d), m, duration, ignore))
        return { day: offset(day, d), start: m };
    }
  return null;
}

// Legacy alias kept for compatibility with any helper imports
export type ResultCard = {
  kind: "lesson" | "decision" | "plan" | "memory";
  title: string;
  body: string;
  lesson?: string;
  block?: string;
  oldStart?: number;
  oldDay?: string;
  day?: string;
  start?: number;
};
