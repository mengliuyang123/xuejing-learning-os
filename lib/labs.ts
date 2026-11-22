import type { Lesson } from "./learning";

export type HandsOnLab = {
  id: string;
  unitId: string;
  title: string;
  language: "json" | "sql" | "python" | "http" | "text";
  prompt: string;
  starterCode: string;
  solution: string;
  hints: string[];
  checks: Array<{
    description: string;
    mode: "valid_json" | "includes" | "regex";
    pattern?: string;
    flags?: string;
  }>;
};

const BUILTIN_LABS: Record<string, Omit<HandsOnLab, "id" | "unitId">> = {
  json: {
    title: "动手构造一个工具返回 JSON",
    language: "json",
    prompt:
      '请写出合法的 JSON 对象，包含字符串字段 "city"（值为 "上海"）和数字数组字段 "temps"（至少 2 个数字）。',
    starterCode: '{\n  "city": "",\n  "temps": []\n}',
    solution: '{\n  "city": "上海",\n  "temps": [22, 24]\n}',
    hints: [
      "JSON 的键名和字符串都必须使用英文双引号",
      "数组使用方括号 [22, 24]，元素之间用英文逗号分隔",
    ],
    checks: [
      { description: "必须是合法可解析的 JSON", mode: "valid_json" },
      { description: '包含 "city" 字段且值为 "上海"', mode: "regex", pattern: '"city"\\s*:\\s*"上海"' },
      { description: '包含 "temps" 数字数组（至少 2 项）', mode: "regex", pattern: '"temps"\\s*:\\s*\\[\\s*-?\\d+(?:\\.\\d+)?\\s*,\\s*-?\\d+' },
    ],
  },
  api: {
    title: "手写一个带查询参数的 GET 请求",
    language: "http",
    prompt:
      "构造一条请求上海天气的 HTTP GET 请求行，路径为 /weather，查询参数 city=Shanghai。",
    starterCode: "GET /weather?",
    solution: "GET /weather?city=Shanghai",
    hints: ["HTTP 方法写在最前面（GET）", "查询参数格式为 key=value，跟在 ? 后面"],
    checks: [
      { description: "使用 GET 方法", mode: "regex", pattern: "^\\s*GET\\s+", flags: "i" },
      { description: "包含 /weather 路径", mode: "includes", pattern: "/weather" },
      { description: "包含查询参数 city=Shanghai", mode: "regex", pattern: "city=Shanghai", flags: "i" },
    ],
  },
  tools: {
    title: "构造标准 Tool Calling 参数对象",
    language: "json",
    prompt:
      '模型决定调用日程查询工具 read_calendar。请输出包含 "tool": "read_calendar" 以及 "arguments"（内含 "day": "2026-11-21"）的合法 JSON。',
    starterCode: '{\n  "tool": "",\n  "arguments": {\n    \n  }\n}',
    solution: '{\n  "tool": "read_calendar",\n  "arguments": {\n    "day": "2026-11-21"\n  }\n}',
    hints: [
      '顶层需要 "tool" 和 "arguments" 两个键',
      'arguments 对象内部包含 "day" 字符串字段',
    ],
    checks: [
      { description: "必须是合法 JSON", mode: "valid_json" },
      { description: '指定工具名 "read_calendar"', mode: "regex", pattern: '"tool"\\s*:\\s*"read_calendar"' },
      { description: 'arguments 中包含 "day" 参数', mode: "regex", pattern: '"day"\\s*:\\s*"\\d{4}-\\d{2}-\\d{2}"' },
    ],
  },
  react: {
    title: "补全一步 ReAct 思考与行动循环",
    language: "text",
    prompt:
      "已知日历 14:00 已被会议占用。请写出一轮包含 Thought（思考）、Action（动作）与 Observation（观测）的 ReAct 轨迹，体现「读取新空档后再提议」。",
    starterCode: "Thought: 14:00 已被会议占用，我需要...\nAction: \nObservation: ",
    solution:
      "Thought: 14:00 已被会议占用，我需要先查询今天剩余空闲时段。\nAction: read_calendar({ day: \"today\" })\nObservation: 16:00-17:30 空闲，可安排学习。",
    hints: [
      "必须包含 Thought、Action、Observation 三个阶段",
      "Action 应调用读取空档/日历类工具而不是重复提交冲突时段",
    ],
    checks: [
      { description: "包含 Thought 推理阶段", mode: "regex", pattern: "Thought\\s*[:：]", flags: "i" },
      { description: "包含 Action 工具动作", mode: "regex", pattern: "Action\\s*[:：].*(calendar|slot|空档|日历|查询)", flags: "i" },
      { description: "包含 Observation 观测结果", mode: "regex", pattern: "Observation\\s*[:：]", flags: "i" },
    ],
  },
  recovery: {
    title: "编写工具异常处理策略伪代码",
    language: "python",
    prompt:
      "用伪代码或 Python 写出一个区分「参数缺失(400)」与「临时超时(503)」的异常处理分支：参数缺失应提示补充输入，503 应有限次重试。",
    starterCode: "if error_code == 400:\n    # 你的处理\nelif error_code == 503:\n    # 你的处理",
    solution:
      'if error_code == 400:\n    return "缺少必填参数，请补充后再调用"\nelif error_code == 503:\n    retry(max_attempts=2)',
    hints: ["区分 400 输入错误与 503 临时故障", "503 分支需体现有限次重试（retry）"],
    checks: [
      { description: "处理 400 参数错误分支", mode: "regex", pattern: "400" },
      { description: "处理 503 临时故障分支", mode: "regex", pattern: "503" },
      { description: "体现有限次重试（retry / 重试）", mode: "regex", pattern: "retry|重试", flags: "i" },
    ],
  },
};

export function getLabForLesson(lesson: Lesson): HandsOnLab {
  const builtin = BUILTIN_LABS[lesson.id];
  if (builtin) {
    return { id: `lab-${lesson.id}`, unitId: lesson.id, ...builtin };
  }

  // Dynamic smart lab generation for SQL / Python / general custom GoalPlan units
  const combined = `${lesson.title} ${lesson.concept} ${lesson.example}`;
  if (/SELECT|FROM|WHERE|GROUP BY|JOIN/i.test(combined)) {
    const needsWhere = /WHERE/i.test(lesson.example);
    const needsGroup = /GROUP BY/i.test(lesson.example);
    return {
      id: `lab-${lesson.id}`,
      unitId: lesson.id,
      title: `SQL 实操：${lesson.title}`,
      language: "sql",
      prompt: `根据本节「${lesson.title}」的写法，编写一条查询 orders 表的 SQL 语句${
        needsGroup
          ? "（包含 GROUP BY 汇总）"
          : needsWhere
            ? "（包含 WHERE 条件过滤）"
            : "（使用 SELECT 和 FROM）"
      }。`,
      starterCode: "SELECT \nFROM orders",
      solution: lesson.example,
      hints: ["SELECT 后写目标列，FROM 后跟 orders", "语句末尾可加分号 ;"],
      checks: [
        { description: "包含 SELECT 关键字", mode: "regex", pattern: "\\bSELECT\\b", flags: "i" },
        { description: "包含 FROM orders", mode: "regex", pattern: "\\bFROM\\s+orders\\b", flags: "i" },
        ...(needsWhere
          ? [{ description: "包含 WHERE 条件子句", mode: "regex" as const, pattern: "\\bWHERE\\b", flags: "i" }]
          : []),
        ...(needsGroup
          ? [{ description: "包含 GROUP BY 分组子句", mode: "regex" as const, pattern: "\\bGROUP\\s+BY\\b", flags: "i" }]
          : []),
      ],
    };
  }

  if (/def |for |in \[|price =|counts/i.test(combined)) {
    const needsDef = /def /i.test(lesson.example);
    const needsFor = /for /i.test(lesson.example);
    return {
      id: `lab-${lesson.id}`,
      unitId: lesson.id,
      title: `Python 实操：${lesson.title}`,
      language: "python",
      prompt: `参考「${lesson.title}」，写出一段可复用的 Python 代码${
        needsDef
          ? "（使用 def 定义函数并 return 返回值）"
          : needsFor
            ? "（使用 for 循环遍历列表）"
            : "（定义变量并完成计算）"
      }。`,
      starterCode: needsDef ? "def calc(values):\n    " : "# 在此编写你的 Python 代码\n",
      solution: lesson.example,
      hints: ["注意 Python 缩进与冒号", "保持变量命名清晰"],
      checks: needsDef
        ? [
            { description: "使用 def 定义函数", mode: "regex", pattern: "\\bdef\\s+\\w+\\s*\\(" },
            { description: "包含 return 返回语句", mode: "regex", pattern: "\\breturn\\b" },
          ]
        : needsFor
          ? [
              { description: "包含 for ... in 循环", mode: "regex", pattern: "\\bfor\\s+\\w+\\s+in\\b" },
              { description: "包含循环体计算或赋值", mode: "regex", pattern: "=|\\+=" },
            ]
          : [
              { description: "包含变量赋值语句", mode: "regex", pattern: "\\w+\\s*=" },
              { description: "包含表达式运算", mode: "regex", pattern: "[+\\-*/]" },
            ],
    };
  }

  return {
    id: `lab-${lesson.id}`,
    unitId: lesson.id,
    title: `微实践任务：${lesson.title}`,
    language: "text",
    prompt: `请用自己的话写下「${lesson.title}」的一个最小应用场景，包含「输入/条件」和「预期结果」两部分。`,
    starterCode: "输入/条件：\n预期结果：",
    solution: lesson.example,
    hints: ["至少写清输入条件与可观察的预期结果", "长度不少于 15 个字"],
    checks: [
      { description: "内容充实（至少 15 个字符）", mode: "regex", pattern: "[\\s\\S]{15,}" },
      { description: "包含输入或条件描述", mode: "regex", pattern: "输入|条件|场景|目标|例子" },
      { description: "包含结果或输出描述", mode: "regex", pattern: "结果|输出|标准|步骤|回应" },
    ],
  };
}

export type LabEvaluation = {
  passed: boolean;
  passedCount: number;
  totalCount: number;
  results: Array<{ description: string; ok: boolean; detail?: string }>;
};

export function evaluateLabSubmission(
  lab: HandsOnLab,
  code: string,
): LabEvaluation {
  const trimmed = code.trim();
  const results = lab.checks.map((c) => {
    if (c.mode === "valid_json") {
      try {
        JSON.parse(trimmed);
        return { description: c.description, ok: true };
      } catch (e) {
        return {
          description: c.description,
          ok: false,
          detail: e instanceof Error ? e.message : "JSON 语法有误",
        };
      }
    }
    if (c.mode === "includes") {
      const ok = trimmed.includes(c.pattern || "");
      return { description: c.description, ok };
    }
    const re = new RegExp(c.pattern || "", c.flags || "");
    return { description: c.description, ok: re.test(trimmed) };
  });

  const passedCount = results.filter((r) => r.ok).length;
  return {
    passed: passedCount === results.length && results.length > 0,
    passedCount,
    totalCount: results.length,
    results,
  };
}
