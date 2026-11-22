import {
  free,
  offset,
  lessons,
  type Block,
  type GoalPlan,
  type Lesson,
  type Memory,
} from "./learning";
import { extractMemoryPreferences } from "./scheduler";

export type UnitContent = Pick<
  Lesson,
  | "title"
  | "concept"
  | "example"
  | "question"
  | "choices"
  | "answer"
  | "feedback"
> & {
  requiresIndices?: number[];
};

type OutlineRow = [
  string,
  string,
  string,
  string,
  string[],
  number,
  string,
  number[]?,
];

const sql: OutlineRow[] = [
  [
    "从订单表读取数据",
    "SELECT 指定要读取的列，FROM 指定数据表。先选少量字段，确认每一行代表的对象。",
    "SELECT order_id, amount FROM orders;",
    "要只返回订单金额，应写哪条语句？",
    [
      "SELECT amount FROM orders",
      "SELECT orders FROM amount",
      "DELETE FROM orders",
    ],
    0,
    "列名跟在 SELECT 后面，表名跟在 FROM 后面。",
    [],
  ],
  [
    "用条件缩小结果",
    "WHERE 在分组之前筛选原始记录。可以用比较运算符筛金额，也可以用 AND 拼接条件。",
    "SELECT * FROM orders WHERE amount >= 100;",
    "要把金额恰好为 100 的订单也选中，该用哪个条件？",
    ["amount > 100", "amount >= 100", "amount < 100"],
    1,
    "大于等于会保留边界值 100。",
    [0],
  ],
  [
    "按客户汇总订单",
    "GROUP BY 将相同客户的记录归为一组，SUM 把每组中的金额相加。",
    "SELECT customer_id, SUM(amount) FROM orders GROUP BY customer_id;",
    "客户 A 的两笔金额为 30 和 50，SUM 的结果是多少？",
    ["2", "40", "80"],
    2,
    "SUM 相加得到 80，COUNT 和 AVG 分别得到 2 和 40。",
    [0],
  ],
  [
    "关联用户与复购分析",
    "用 JOIN 关联订单表与用户表，再配合 WHERE 与 GROUP BY 计算高价值客户复购率。",
    "SELECT u.city, SUM(o.amount)\nFROM orders o JOIN users u ON o.customer_id = u.id\nWHERE o.amount >= 100\nGROUP BY u.city;",
    "在关联分析中，WHERE 与 GROUP BY 的执行顺序是？",
    ["先 GROUP BY 再 WHERE", "先 WHERE 过滤行再 GROUP BY 汇总", "两者同时执行"],
    1,
    "WHERE 先过滤原始行，再由 GROUP BY 分组聚合。",
    [1, 2],
  ],
];

const python: OutlineRow[] = [
  [
    "把数据存进变量",
    "变量名引用一个值。先把原始数值命名，再用表达式完成计算。",
    "price = 12\ncount = 3\ntotal = price * count",
    "total 的值是多少？",
    ["15", "36", "123"],
    1,
    "乘法运算得到 12 × 3 = 36。",
    [],
  ],
  [
    "遍历一组数据",
    "列表保存一组有序的值。for 循环逐项取值，累加器在每轮更新。",
    "total = 0\nfor value in [2, 4, 6]:\n    total += value",
    "循环结束后 total 的值是多少？",
    ["6", "3", "12"],
    2,
    "累加器依次变为 2、6、12。",
    [0],
  ],
  [
    "字典归类与清洗",
    "字典用键值对做映射。遍历记录时用 dict.get 统计每类出现次数或过滤缺失值。",
    'counts = {}\nfor tag in ["A", "B", "A"]:\n    counts[tag] = counts.get(tag, 0) + 1',
    '循环结束后 counts["A"] 的值是？',
    ["1", "2", "报错 KeyError"],
    1,
    "get(tag, 0) 避免了首次访问缺失键报错，累加得到 2。",
    [0],
  ],
  [
    "封装一个统计函数",
    "用 def 为一段计算命名，用 return 把结果交给调用者。为边界输入写一个测试。",
    "def average(values):\n    return sum(values) / len(values) if values else 0",
    "average([]) 会返回什么？",
    ["0", "空字符串", "发生除零错误"],
    0,
    "空列表会进入 else 分支，在除法执行前返回 0。",
    [1, 2],
  ],
];

const english: OutlineRow[] = [
  [
    "用一句话介绍自己",
    "用 I’m… 介绍身份，用 I work on… 说明正在做的事，再邀请对方回应。",
    "I’m Lin. I work on data projects. What about you?",
    "哪一句最适合询问对方的情况？",
    ["What about you?", "I worked yesterday.", "It is a table."],
    0,
    "What about you? 会把同一个话题自然地交给对方。",
    [],
  ],
  [
    "提出清晰的问题",
    "Could you…? 可以礼貌地提出请求。没听懂时可以直接请对方重复。",
    "Could you say that again, please?",
    "想请对方放慢语速，哪句合适？",
    ["I spoke slowly.", "Could you speak more slowly?", "I have a pen."],
    1,
    "Could you speak more slowly? 明确了希望对方采取的动作。",
    [0],
  ],
  [
    "完成一段往返对话",
    "回答后增加一个相关细节，再用问题邀请对方继续说。",
    "A: What do you enjoy?\nB: I like hiking on weekends. Do you hike too?",
    "回答后如何延续这个话题？",
    ["换一个无关话题", "只重复 yes", "询问对方的相关经历"],
    2,
    "相关的开放问题让对方有内容可接。",
    [1],
  ],
];

function project(topic: string): OutlineRow[] {
  return [
    [
      "确定成功标准",
      "把目标拆成一个能展示的小作品，并写下观察者可以检验的标准。",
      `目标：${topic}\n写下要完成的作品、使用场景和一条验收标准。`,
      "哪种标准最容易验证？",
      ["感觉自己懂了", "独立完成一个样例并解释关键步骤", "收藏十份资料"],
      1,
      "可观察的作品和解释能提供学习证据。",
      [],
    ],
    [
      "拆解一个完整范例",
      "挑一个和目标相符的范例，标注输入、操作和输出。改变一个条件，预测结果。",
      `为「${topic}」选一个最小范例，记录原条件、改动和前后结果。`,
      "要判断一个条件的作用，第一次试验应怎么做？",
      ["同时改动所有条件", "只读结论", "只改一个条件并对比结果"],
      2,
      "控制其他条件可以让差异更容易解释。",
      [0],
    ],
    [
      "排查常见误区",
      "列出最容易出错的两个边界场景，分别设计最小反例并记录修复方法。",
      `针对「${topic}」写出一个容易失败的边界输入，以及对应的检查清单。`,
      "遇到错误结果时最有效的第一步是？",
      ["复现最小失败样例并定位变量", "直接重做全部内容", "忽略边界情况"],
      0,
      "最小复现可以最快定位根因。",
      [0],
    ],
    [
      "独立完成目标作品",
      "关掉范例，独立复现流程，再用第一课的标准检验结果。记录一个差异和修订办法。",
      `完成「${topic}」的小作品后写下：我能独立完成什么？哪里仍需要提示？`,
      "哪一步最能检验能否独立应用？",
      ["在新任务上复现并检查结果", "照抄范例", "重复看同一份材料"],
      0,
      "独立迁移到新任务能暴露仍需练习的环节。",
      [1, 2],
    ],
  ];
}

export function demoUnits(goal: string): {
  title: string;
  units: UnitContent[];
} {
  if (/agent|智能体|工具调用|大模型应用/i.test(goal))
    return {
      title: "构建能调用工具的智能体",
      units: [
        { ...lessons[2], requiresIndices: [] },
        { ...lessons[3], requiresIndices: [0] },
        { ...lessons[4], requiresIndices: [0] },
      ],
    };
  const topic =
    goal
      .replace(/^(学习目标[：:]|我想要?|我希望|帮我|学习目标是)/, "")
      .split(/[，。；\n]/)
      .filter(Boolean)[0]
      ?.trim() || goal;
  const [title, rows]: [string, OutlineRow[]] = /sql|数据库查询/i.test(goal)
    ? ["SQL 数据查询与分析", sql]
    : /python|pandas/i.test(goal)
      ? ["Python 数据处理入门", python]
      : /英语|英文|english/i.test(goal)
        ? ["英语口语练习", english]
        : [topic.slice(0, 60), project(topic)];
  return {
    title,
    units: rows.map(
      (
        [title, concept, example, question, choices, answer, feedback, reqs],
        idx,
      ) => ({
        title,
        concept,
        example,
        question,
        choices,
        answer,
        feedback,
        requiresIndices: reqs ?? (idx > 0 ? [idx - 1] : []),
      }),
    ),
  };
}

function number(text: string) {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = "零一二三四五六七八九";
  if (text === "两") return 2;
  if (text.includes("十")) {
    const [a, b] = text.split("十");
    return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0);
  }
  return digits.indexOf(text);
}

export function constraints(
  prompt: string,
  old?: GoalPlan,
  memories?: Memory[],
) {
  const memPrefs = memories ? extractMemoryPreferences(memories) : undefined;
  const digit = "([零一二两三四五六七八九十0-9]+)";
  const span = prompt.match(new RegExp(digit + "\\s*(?:个)?(星期|周|天)"));
  const duration = prompt.match(new RegExp(digit + "\\s*分钟"));
  const hour = prompt.match(
    new RegExp("(上午|下午|晚上|早上)?\\s*" + digit + "\\s*[:：点时]\\s*(\\d{1,2})?"),
  );
  let start = old?.start ?? memPrefs?.preferredStart ?? 1140;
  if (hour) {
    let h = number(hour[2]);
    if (h < 12 && /下午|晚上/.test(hour[1] || "")) h += 12;
    if (h < 24 && Number(hour[3] || 0) < 60)
      start = h * 60 + Number(hour[3] || 0);
  } else if (/早上|上午/.test(prompt)) start = 540;
  else if (/下午/.test(prompt)) start = 900;
  else if (/晚上/.test(prompt)) start = 1140;

  let daily = duration
    ? number(duration[1])
    : /半小时/.test(prompt)
      ? 30
      : /每天一小时|每天1小时/.test(prompt)
        ? 60
        : (old?.daily ?? memPrefs?.maxSessionMinutes ?? 25);

  if (!duration && !old && memPrefs?.maxSessionMinutes) {
    daily = Math.min(daily, memPrefs.maxSessionMinutes);
  }

  return {
    days: Math.min(
      90,
      Math.max(
        1,
        span ? number(span[1]) * (span[2] === "天" ? 1 : 7) : (old?.days ?? 7),
      ),
    ),
    daily: Math.min(180, Math.max(10, daily)),
    start,
  };
}

export function schedulePlan(
  plan: GoalPlan,
  blocks: Block[],
  day: string,
  endLimit = 1440,
): Block[] | null {
  const ids = new Set(plan.units.map((u) => u.id));
  const occupied = blocks.filter(
    (b) => b.id !== b.lesson + "-session" || !ids.has(b.lesson || "") || b.done,
  );
  const pending = plan.units.filter(
    (u) => !occupied.some((b) => b.done && b.lesson === u.id),
  );
  const slots: Block[] = [];
  const hardEnd = Math.min(1440, Math.max(plan.start + 15, endLimit));

  for (const [i, unit] of pending.entries()) {
    const target = Math.floor(
      (i * (plan.days - 1)) / Math.max(1, pending.length - 1),
    );
    const sessions = Math.ceil(pending.length / plan.days);
    const desired = unit.minutes > 0 ? unit.minutes : Math.floor(plan.daily / sessions);
    const minutes = Math.min(plan.daily, Math.max(15, desired));
    if (minutes < 1) return null;
    let slot: Block | undefined;
    for (let d = target; d < plan.days && !slot; d++) {
      const date = offset(day, d);
      if (
        slots.filter((b) => b.day === date).reduce((a, b) => a + b.minutes, 0) +
          minutes >
        plan.daily
      )
        continue;
      for (let m = plan.start; m + minutes <= hardEnd; m += 5) {
        if (free([...occupied, ...slots], date, m, minutes)) {
          slot = {
            id: unit.id + "-session",
            day: date,
            start: m,
            minutes,
            title: unit.title,
            lesson: unit.id,
            kind: "学习",
          };
          break;
        }
      }
    }
    if (!slot) return null;
    slots.push(slot);
  }
  return slots;
}
