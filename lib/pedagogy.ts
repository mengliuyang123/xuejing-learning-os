import {
  type Lesson,
  type Store,
  available,
  diffDays,
  getLessonRetrievability,
} from "./learning";

export type LearnerStatus =
  | "NOT_STARTED"
  | "LEARNING"
  | "PRACTICING"
  | "NEEDS_REVIEW"
  | "NEEDS_REMEDIATION"
  | "PROFICIENT"
  | "MASTERED";

export type ActivityType =
  | "worked_example"
  | "guided_practice"
  | "independent_practice"
  | "retrieval_practice"
  | "remedial"
  | "diagnostic_skip";

export type PedagogicalStep = {
  id: string;
  label: string;
  action: "read" | "example" | "lab" | "quiz" | "recall";
  prompt: string;
};

export type PedagogicalDirective = {
  conceptId: string;
  status: LearnerStatus;
  statusLabel: string;
  activityType: ActivityType;
  modeLabel: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  estimatedMinutes: number;
  reason: string;
  steps: PedagogicalStep[];
  autoStartPrompt: string;
  autoStartAction?: "read" | "quiz" | "lab" | "recall";
};

export function learnerStatusLabel(status: LearnerStatus): string {
  return {
    NOT_STARTED: "未开始",
    LEARNING: "初学理解",
    PRACTICING: "练习巩固",
    NEEDS_REVIEW: "到期复习",
    NEEDS_REMEDIATION: "需补救巩固",
    PROFICIENT: "熟练掌握",
    MASTERED: "已精通",
  }[status];
}

/**
 * Deterministic 7-state Learner Status classifier combining BKT mastery,
 * consecutive failures, and ts-fsrs retrievability.
 */
export function computeLearnerStatus(
  s: Store,
  lessonId: string,
  day: string,
): LearnerStatus {
  const score = s.mastery[lessonId] ?? 0;
  const meta = s.masteryMeta?.[lessonId];
  const failures = meta?.consecutiveFailures ?? 0;

  if (failures >= 2 || (meta?.lastResult === false && score < 55)) {
    return "NEEDS_REMEDIATION";
  }
  if (score === 0 && (!meta || meta.attempts === 0)) {
    return "NOT_STARTED";
  }
  if (meta && score >= 50) {
    const retrievability = getLessonRetrievability(s, lessonId, day);
    const overdue = diffDays(meta.nextReviewDay, day) >= 0;
    if (overdue || retrievability < 82) {
      return "NEEDS_REVIEW";
    }
  }
  if (score >= 92) return "MASTERED";
  if (score >= 80) return "PROFICIENT";
  if (score >= 45) return "PRACTICING";
  return "LEARNING";
}

/**
 * Deterministic Pedagogical Policy Engine:
 * Decides HOW to teach (mode, difficulty, ordered steps, and automatic opening move)
 * based on 7-state learner status, prerequisite readiness, and available session duration.
 */
export function decidePedagogicalPlan(
  s: Store,
  lesson: Lesson,
  availableMinutes: number,
  day: string,
): PedagogicalDirective {
  const status = computeLearnerStatus(s, lesson.id, day);
  const statusLabel = learnerStatusLabel(status);
  const mins = Math.max(10, Math.round(availableMinutes || lesson.minutes));
  const prereqsMet = available(s, lesson);

  // 1. Remediation mode when struggling / consecutive failures
  if (status === "NEEDS_REMEDIATION") {
    return {
      conceptId: lesson.id,
      status,
      statusLabel,
      activityType: "remedial",
      modeLabel: "降难补救模式",
      difficulty: "beginner",
      estimatedMinutes: Math.min(mins, 20),
      reason: prereqsMet
        ? "检测到近期连续失误，已自动降低认知负荷：先用生活化类比拆解易错点，再做基础验证。"
        : "存在未达标先修知识，建议先补齐前置概念再继续本节。",
      steps: [
        {
          id: "remedial-explain",
          label: "通俗拆解易错点",
          action: "read",
          prompt: `我在「${lesson.title}」上刚卡壳了，请用最通俗的语言重新拆解核心概念，并指出最容易踩的坑。`,
        },
        {
          id: "remedial-example",
          label: "最小反例演示",
          action: "example",
          prompt: "给我一个最简单的具体例子，一步步带我走一遍。",
        },
        {
          id: "remedial-quiz",
          label: "基础巩固测验",
          action: "quiz",
          prompt: "出一道基础难度的巩固练习题检验我是否真的理解了。",
        },
      ],
      autoStartPrompt: `我在「${lesson.title}」上刚卡壳了，请用更通俗的方式重新拆解核心要点并举一个最小例子。`,
    };
  }

  // 2. Micro-session (<= 18 min) or Due Review -> Retrieval Practice
  if (status === "NEEDS_REVIEW" || mins <= 18) {
    return {
      conceptId: lesson.id,
      status,
      statusLabel,
      activityType: "retrieval_practice",
      modeLabel: mins <= 18 ? `${mins} 分钟碎片速复` : "FSRS 主动回忆模式",
      difficulty: status === "MASTERED" ? "advanced" : "intermediate",
      estimatedMinutes: Math.min(mins, 15),
      reason:
        status === "NEEDS_REVIEW"
          ? "该知识点已进入 FSRS 遗忘临界区，优先采用主动回忆检索练习强化长期记忆。"
          : `当前可用时间较短（${mins} 分钟），采用高密度的「主动回忆 + 速测」微单元，确保完整闭环不中断。`,
      steps: [
        {
          id: "recall",
          label: "FSRS 主动回忆",
          action: "recall",
          prompt: "FSRS 主动回忆",
        },
        {
          id: "quick-quiz",
          label: "1 题变式速测",
          action: "quiz",
          prompt: "出一道新的变式练习题帮我巩固记忆",
        },
      ],
      autoStartPrompt: "FSRS 主动回忆",
      autoStartAction: "recall",
    };
  }

  // 3. Proficient / Mastered -> Independent Practice / Sandbox Transfer
  if (status === "PROFICIENT" || status === "MASTERED") {
    return {
      conceptId: lesson.id,
      status,
      statusLabel,
      activityType: "independent_practice",
      modeLabel: "迁移实战模式",
      difficulty: "advanced",
      estimatedMinutes: Math.min(mins, 35),
      reason: "你已基本掌握概念，跳过重复灌输，直接通过动手实操沙盒与变式题检验迁移能力。",
      steps: [
        {
          id: "lab",
          label: "动手实操沙盒",
          action: "lab",
          prompt: "动手实操沙盒",
        },
        {
          id: "variant-quiz",
          label: "迁移变式测验",
          action: "quiz",
          prompt: "给我出一道真实场景下的进阶变式练习题",
        },
      ],
      autoStartPrompt: "动手实操沙盒",
      autoStartAction: "lab",
    };
  }

  // 4. Practicing (45-79%) -> Guided Practice (Example -> Lab -> Quiz)
  if (status === "PRACTICING") {
    return {
      conceptId: lesson.id,
      status,
      statusLabel,
      activityType: "guided_practice",
      modeLabel: `${mins} 分钟引导实练`,
      difficulty: "intermediate",
      estimatedMinutes: Math.min(mins, 40),
      reason: "概念已初步建立，重点通过「完整示例 → 动手实操 → 结课测验」推动掌握度突破 80% 解锁线。",
      steps: [
        {
          id: "example",
          label: "精讲场景示例",
          action: "example",
          prompt: "举个例子",
        },
        {
          id: "lab",
          label: "动手实操沙盒",
          action: "lab",
          prompt: "动手实操沙盒",
        },
        {
          id: "quiz",
          label: "结课达标测验",
          action: "quiz",
          prompt: "出一道练习题",
        },
      ],
      autoStartPrompt: `请结合我当前的学习偏好，给我一个「${lesson.title}」的完整场景示例并带我开始练习。`,
    };
  }

  // 5. Not Started / Learning -> Worked Example Full Flow
  return {
    conceptId: lesson.id,
    status,
    statusLabel,
    activityType: "worked_example",
    modeLabel: mins >= 45 ? `${mins} 分钟深度学练` : `${mins} 分钟核心入门`,
    difficulty: "beginner",
    estimatedMinutes: mins,
    reason:
      "针对初学阶段采用认知负荷友好的 Worked Example 路径：先精讲核心概念与完整示例，再动手实操与测验验收。",
    steps: [
      {
        id: "concept",
        label: "核心概念精讲",
        action: "read",
        prompt: `请作为我的 1v1 导师开启「${lesson.title}」：用简洁清晰的语言讲透核心概念，并给出一个直观示例。`,
      },
      {
        id: "lab",
        label: "动手实操沙盒",
        action: "lab",
        prompt: "动手实操沙盒",
      },
      {
        id: "quiz",
        label: "随堂验收测验",
        action: "quiz",
        prompt: "出一道练习题",
      },
    ],
    autoStartPrompt: `请作为我的 1v1 导师正式开始「${lesson.title}」：先用清晰结构讲解核心概念，再配一个完整场景示例，最后问我是否准备好进入动手实操。`,
  };
}
