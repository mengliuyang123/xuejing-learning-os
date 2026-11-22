<div align="center">
  <img src="./public/icons/xuejing-150.png" alt="学径 XueJing Logo" width="88" height="88" />
  <h1>学径 XueJing · Personal AI Learning OS</h1>
  <p><strong>在知识地图与时间轴之间，专注当下这一步。</strong></p>
  <p>
    100% 全栈 TypeScript 构建的本机优先（Local-First）AI 个人学习工作台与智能伴学桌面系统<br/>
    Next.js 16 App Router · React 19 · Vercel AI SDK v6 · Tailwind CSS v4 · FSRS + BKT · Node.js 22 内置 SQLite · Electron
  </p>
</div>

---

## ✨ 项目简介

**学径（XueJing / LearnOS）** 是一款面向深度自学者与终身学习者的 **本机优先个人 AI 学习操作系统（Personal AI Learning OS）**。它将 **大模型自治课程规划**、**先修依赖知识图谱（DAG）**、**认知掌握度追踪（BKT + FSRS）**、**睡眠红线约束日历排程** 与 **苏格拉底式 ReAct 伴学 Agent** 融合在统一的三栏桌面工作台中。

- **零外部服务依赖**：基于 Node.js 22+ 内置 `node:sqlite`（WAL 模式），无需安装或配置 PostgreSQL、Neo4j、Redis 或 Docker。
- **100% 本机数据主权**：所有学习轨道、知识节点掌握度、日程安排、长期学习记忆、对话历史、计划变更 Diff 与 Agent 运行轨迹全部保存在本机单文件 `data/learnos.sqlite` 中，支持一键全量 JSON 备份恢复与 `.ics` 日历导出。
- **Web 与原生桌面双形态**：既可通过浏览器直接访问本地服务，也可通过 Electron 一键启动或打包为 Windows / macOS / Linux 原生桌面应用。
- **多模型直连与无密钥兜底**：支持 DeepSeek（含 `deepseek-flash` / `deepseek-chat` / `deepseek-reasoner` 思考模式）、OpenAI、Google Gemini、OpenRouter、Vercel AI Gateway 及本地 Ollama；未配置 API Key 时自动启用本地同构多步 ReAct 演示引擎。

---

## 📖 核心使用流程与大模型实机演示

下面展示在配置好大模型（以 **DeepSeek `deepseek-flash` 直连** 为例）后，从 **输入学习目标 → 大模型规划生成 10 节课程与首课讲义 → AI 伴学助手生成交互式架构图解与随堂测验 → 课堂答题更新 BKT 掌握度 → 动态 DAG 知识图谱与自动日历排程 → ReAct 全链路轨迹审计** 的完整使用流程。

### 第 1 步：新建学习目标，启动大模型课程规划
点击左侧边栏顶部的 **「+ 新建学习目标」**，填写你想攻克的主题（例如：`深入掌握 AI Agent 架构与 ReAct 工具调用实战`），并选择你的当前基础（初学入门 / 了解基础 / 有实战经验）、学习深度（标准实战 / 速学聚焦 / 系统深入）、目标周期（10 天）、每日可投入时长（45 分钟）以及知识获取方式（支持 **先联网研究权威资料**、**使用模型已有知识快速开始** 或 **基于个人参考资料**）。

点击 **「直接创建轨道并排课」**（或 **「先和助手讨论路线」**），后台大模型工作流会自动完成课程大纲拆解、先修依赖 DAG 构建、首课深度备课与无冲突日历排程：

![第 1 步：新建学习目标弹窗](./docs/screenshots/01-goal-setup.png)

---

### 第 2 步：在「今日工作台」查看生成的轨道并与右侧 AI 伴学助手互动
课程生成完成后，左侧边栏「学习轨道」下会出现新创建的 **`10 天 AI Agent 架构与 ReAct 工具调用实战路径 (0/10)`**，中央「今日工作台」自动聚焦今日主攻课程 **`Agent 系统边界与循环架构`** 与今日 `19:00` 的学习日程。

你可以随时在右侧 **「学习助手」** 对话框中向大模型提问（例如：*“请帮我用可视化图解总结当前第一节课的核心架构，并出一道互动检查题考考我”*）。ReAct 伴学 Agent 会自动展示思考推理过程，并调用 `visual_explainer` 与 `present_interactive_check` 工具在对话流中直接渲染 **4 步交互式 SVG 结构图解卡片** 与随堂练习：

![第 2 步：今日工作台与 AI 伴学助手实时生成图解](./docs/screenshots/02-today-workbench.png)

---

### 第 3 步：进入「互动课堂」学习大模型生成的结构化讲义
点击 **「进入课堂学习」**（或左侧导航 **「课堂」**），即可进入大模型为本节课生成的完整互动课堂：
- 顶部配备 **45 分钟课堂专注计时器**（记录真实学习时长并自动校准个人学习节奏因子 `paceFactor`）；
- 正文包含明确的 **学习目标**、**完成条件**、**课前准备**、生动的 **直觉类比**（如将单次 LLM 调用、固定工作流与自主 Agent 循环进行对比）以及循序渐进的章节详解：

![第 3 步：大模型生成的结构化课堂讲义](./docs/screenshots/03-classroom-teaching.png)

---

### 第 4 步：课堂内联动交互式全景 SVG 架构图解与 AI 导师导学
在课堂讲义下方，系统自动同步嵌入了 AI 助手生成的 **「结构图解 · 全景 (4步) · Agent 循环与系统边界总览」** 沙盒化 SVG 架构图（支持分布步进、全景切换、查看源码与全屏放大）；同时右侧 AI 导师会给出针对本节易错点的辨析题作答引导：

![第 4 步：课堂内嵌交互式 SVG 架构图解與 AI 导师联动](./docs/screenshots/04-classroom-visual-svg.png)

---

### 第 5 步：完成随堂互动练习，实时判分并更新 BKT 认知掌握度
切换到课堂的 **「练习 / 测验」** 区域（或点击右侧助手的 **「去作答」**），直接勾选或填写大模型生成的互动检查题并提交。
- 内置确定性评分引擎实时完成判分（如 **「评分通过 (100 分)，已更新掌握状态」**）；
- 展开详尽的参考解析，同时自动触发 **BKT（贝叶斯知识追踪）+ FSRS（间隔重复算法）** 更新该知识节点的后验掌握度与下次复习时间；若连续答错卡壳，可一键向右侧 AI 导师索取苏格拉底式提示或触发降难补救课程：

![第 5 步：课堂互动练习实时判分与掌握度更新](./docs/screenshots/05-classroom-practice-graded.png)

---

### 第 6 步：在「知识图谱 · 学习路径」总览分阶段课程体系
切换到左侧导航 **「知识图谱」** 的 **「学习路径」** 视图，可以清晰查看大模型规划的 **3 个大章节 · 8 个小章节 · 10 节课** 阶梯路线，实时追踪每节课的预计耗时、先修条件与当前掌握度（可以看到刚刚完成练习的第 1 课掌握度已更新为 **75%**）：

![第 6 步：结构化课程学习路径视图](./docs/screenshots/06-learning-path-stages.png)

---

### 第 7 步：在「知识图谱 · 关系图谱」探索动态 DAG 先修依赖与 FSRS 状态
切换到 **「关系图谱」** 视图，系统通过拓扑分层算法渲染出带先修解锁关系的有向无环图（DAG）：
- 点击任意节点（如 `1.1 Agent 系统边界与循环架构`），下方详情面板即刻展示 **已验证掌握度 (BKT 75%)**、**下次复习日期**、**正课排程时段** 以及 **前置先修 / 后续解锁节点**（如 `1.2 ReAct 轨迹：Thought-Action-Observation` 与 `2.1 工具接口设计与 JSON Schema`），点击即可平滑聚焦跳转：

![第 7 步：动态 DAG 知识图谱与节点掌握度面板](./docs/screenshots/07-knowledge-graph-dag.png)

---

### 第 8 步：在「学习日历」管理睡眠红线保护下的自动排课
切换到左侧导航 **「学习日历」**（支持 **日轴** 与 **周轴** 切换），大模型建课工作流已结合你设定的每日可投入时长（45 分钟）与 **睡眠红线（`23:00–07:00` 严禁排课）**，将 10 节课程自动排入未来 10 天的 `19:00–19:45` 空闲窗口。
- 支持手动添加固定日程、点击 **「助手重排」** 让 AI 根据突发日程冲突自动顺延重排，或点击下载按钮一键导出标准 `.ics` 日历文件：

![第 8 步：自动排课后的学习日历周轴视图](./docs/screenshots/08-study-calendar-week.png)

---

### 第 9 步：在「运行轨迹」审计真实大模型 ReAct 工具调用链与计划变更 Diff
切换到左侧导航 **「运行轨迹」 → 「开发者 Trace」**，所有的后台大模型推理与状态变更都 100% 透明可查：
1. **ReAct Execution Trace 时间线**：精确记录每一次 `deepseek / deepseek-flash` 调用的 `run_id`、总耗时（`19.76s`）、模型请求轮次，以及 `visual_explainer`、`present_interactive_check` 等工具的请求参数、执行耗时与返回结果：

![第 9 步 (A)：真实 DeepSeek ReAct 工具调用执行轨迹](./docs/screenshots/09-execution-trace-react.png)

2. **计划变更 Diff 历史**：切换到 **「计划变更 Diff 历史」** 标签页，可回溯大模型建轨排课或日程重排产生的结构化 Diff（如 `日程数：0 → 10`，清晰列出每一条 `+ 新增`、`调整` 或 `- 移除` 的课程时段）：

![第 9 步 (B)：结构化计划变更 Diff 审计历史](./docs/screenshots/10-plan-diff-audit.png)

---

## 🚀 核心技术架构与模块说明

### 1. Agent-Native 课程研究与生成工作流 (`lib/curriculum-planner.ts`, `lib/topic-researcher.ts`)
- **多模式知识获取**：支持 `auto_web`（联网检索权威资料与常见误区后规划课程）、`quick_draft`（基于模型知识快速构建路线）与 `user_materials`（围绕用户提供的 URL 或笔记定制路线）。
- **端到端自治闭环**：一次目标输入即可自动串联「主题调研 → DAG 课程蓝图生成 → 睡眠红线约束排课 → 首课讲义与互动练习备课」。

### 2. 认知建模与 7 态教学状态机 (`lib/bkt-fsrs.ts`, `lib/pedagogy.ts`, `lib/learning-engine.ts`)
- **FSRS + BKT 双引擎融合**：结合官方 [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs) 间隔重复算法（稳定性 Stability、难度 Difficulty、可提取性 Retrievability）与贝叶斯知识追踪（BKT 后验掌握概率更新）。
- **7 态学习者状态机**：每个知识节点在 `未解锁 (locked)`、`可学 (available)`、`进行中 (in_progress)`、`卡壳补救 (struggling)`、`已掌握 (mastered)`、`待复习 (review_due)` 与 `记忆衰退 (decaying)` 之间动态流转。
- **自适应补救与诊断跳过**：已掌握的先修节点支持「诊断跳过 (`skipAsMastered`)」并自动释放原排程时段；连续答错卡壳时自动触发降难补救块并顺延下游依赖课程。

### 3. 生成式教学 UI 与多语言代码沙盒 (`components/gen-ui/`, `lib/visual-explainer.ts`, `lib/labs.ts`)
- **丰富 Gen-UI 教学组件**：在对话流与课堂中原生渲染主动回忆测验卡（`ActiveRecallCard` / `InteractiveCheckCard`）、沙盒化分步 SVG / Mermaid 动态图解（`VisualExplanationCard`）、知识路线阶段卡（`RoadmapStagesCard`）、FSRS 遗忘曲线图（`RetentionCurveChart`）与计划变更对比卡（`RescheduleCard`）。
- **内置 CodeMirror 代码练习环境**：支持 Python、Java、C++、JavaScript/TypeScript、SQL、HTML、CSS、JSON、Markdown 等语法高亮与即时规则校验。

### 4. 约束规划与超时节奏校准 (`lib/scheduler.ts`)
- **睡眠红线与可行性诊断**：默认锁定 `23:00–07:00` 睡眠红线，自动计算未来 7 天可用窗口与待排课负荷缺口（`FeasibilityAlertCard`）。
- **动态节奏校准 (`paceFactor`)**：课堂计时器（`SessionTimerBar`）记录实际学习耗时，自动校准后续排程的时长预估因子。

### 5. 带有效期 (TTL) 与置信度的长期记忆 (`lib/learning.ts`, `lib/context-manager.ts`)
- **智能提取与过期淘汰**：支持用户显式录入或由 Agent 从对话中提取学习偏好与临时约束（如「明后两天出差」「本周晚上加班」自动标记 `expiresAt`），过期记忆自动退出排程计算与大模型上下文。

### 6. 全链路可观测性与凭证脱敏 (`lib/db.ts`, `lib/agent-trace.ts`, `lib/trace-sanitizer.ts`)
- **100% 落盘可回放**：每次 Agent 推理步骤、工具调用与数据库实体变更均写入 `data/learnos.sqlite`。
- **内置隐私与密钥脱敏**：`trace-sanitizer` 自动拦截并脱敏 payload 中的 `apiKey`、`Authorization: Bearer ...`、`sk-*` 等敏感字段（替换为 `[REDACTED]`），且单条超大 payload 自动截断保护数据库性能。

---

## 🏗️ 系统架构图

```mermaid
flowchart TB
  subgraph UI["前端交互层 (Next.js 16 + React 19 + Electron Shell)"]
    WB["三栏工作台 Workbench<br/>今日 / 课堂 / 图谱 / 日历 / 复习 / 记忆 / 轨迹"]
    COPILOT["ReAct 伴学助手面板<br/>流式对话 + 工具卡片渲染"]
    GENUI["生成式教学 UI (components/gen-ui)<br/>InteractiveCheck / SandboxedSVG / Mermaid / PlanDiff"]
  end

  subgraph ENGINE["领域与认知引擎层 (Full-Stack TypeScript)"]
    RUNTIME["Agent Runtime & Orchestrator<br/>(Vercel AI SDK v6 + Skills Loader)"]
    CURRICULUM["课程研究与蓝图规划<br/>(Topic Researcher + DAG Graph Layout)"]
    COGNITION["BKT + ts-fsrs 认知状态机<br/>(7 态流转 + 卡壳补救 + 间隔复习)"]
    SCHEDULER["约束日历排程引擎<br/>(睡眠红线 + 缺口诊断 + 错课重排)"]
  end

  subgraph DATA["本机持久化与审计层 (Local-First Storage)"]
    SQLITE[("Node.js 22 内置 node:sqlite<br/>data/learnos.sqlite (WAL 模式)")]
    TRACE["Agent Trace Recorder & Sanitizer<br/>(全链路调用审计 + API Key 自动脱敏)"]
  end

  WB --> RUNTIME
  COPILOT --> RUNTIME
  COPILOT --> GENUI
  RUNTIME --> CURRICULUM
  RUNTIME --> COGNITION
  RUNTIME --> SCHEDULER
  CURRICULUM --> SQLITE
  COGNITION --> SQLITE
  SCHEDULER --> SQLITE
  RUNTIME --> TRACE
  TRACE --> SQLITE
```

---

## ⚡ 快速开始

### 1. 环境要求
- **Node.js `>= 22.5.0`**（必须使用 Node.js 22+，项目直接使用 Node.js 内置的 `node:sqlite` 模块，无需任何 C++ 原生编译工具链）
- npm `>= 10`

### 2. 安装依赖

```bash
git clone https://github.com/mengliuyang123/xuejing-learning-os.git
cd xuejing-learning-os
npm install
```

### 3. 启动应用

#### 方式 A：Web 浏览器工作台（开发模式）

```bash
npm run dev
```

启动后在浏览器访问 `http://127.0.0.1:3000`（若 Windows 下 3000 端口被系统保留，可执行 `npx next dev --webpack --hostname 127.0.0.1 -p 5173` 并访问 `http://127.0.0.1:5173`）。

#### 方式 B：Web 生产构建与启动

```bash
npm run build
npm run start
```

生产服务默认监听 `http://127.0.0.1:5173`。

#### 方式 C：Electron 原生桌面客户端

```bash
# 直接以桌面客户端窗口启动
npm run desktop

# 打包免安装桌面目录 (输出至 dist-desktop/)
npm run desktop:pack

# 打包完整桌面安装包 (Windows NSIS & Portable / macOS DMG / Linux AppImage)
npm run desktop:dist
```

---

## 🔑 大模型接入与安全说明

学径支持两种大模型配置方式（**任选其一即可**，未配置时也可直接使用内置本地多步演示模式体验完整功能）：

### 方式一：应用内可视化配置（推荐）
1. 启动应用后，点击左下角 **「设置与数据」**（或快捷键 `Ctrl+,`）。
2. 选择模型服务商预设（支持 **DeepSeek / OpenAI / Google Gemini / OpenRouter / Vercel AI Gateway / 自定义 OpenAI 兼容端点（含 Ollama）**）。
3. 填入你的 API Key 并点击 **「测试连接」**。
4. **隐私说明**：通过界面配置的 API Key 仅保存在你本机的浏览器/桌面客户端 `localStorage`（`xushi.model-config.v1`）中，不会上传到任何第三方服务器。

### 方式二：`.env` 环境变量配置
复制项目根目录下的 [`.env.example`](./.env.example) 为 `.env`：

```bash
cp .env.example .env
```

编辑 `.env` 填入你自己的密钥：

```dotenv
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=your_api_key_here
ATLAS_MODEL=deepseek-flash
```

> [!IMPORTANT]
> **API Key 安全保护机制**
> 1. `.gitignore` 已默认忽略 `.env`、`.env.*`（仅保留 `.env.example`）以及 `data/` 目录下的本机 SQLite 数据库文件，防止在 Git 提交时意外泄露密钥或个人学习数据。
> 2. 运行轨迹审计系统内置 `lib/trace-sanitizer.ts`，所有写入 SQLite 或通过 SSE 推送的 Trace 日志均会自动过滤并脱敏 `sk-*`、`Bearer`、`apiKey` 等敏感凭据。

---

## 📂 项目目录结构

```text
xuejing-learning-os/
├── app/                          # Next.js 16 App Router 页面与后端 API 路由
│   ├── api/
│   │   ├── agent/                # ReAct 伴学 Agent 核心对话与工具调用路由
│   │   ├── audit/                # 运行轨迹与实时 SSE Trace 审计流
│   │   ├── chats/                # 多会话与轨道专属对话持久化接口
│   │   ├── learning/             # 课堂准备、练习提交、计划草案与会话接口
│   │   ├── model-test/           # 多模型连通性即时测试接口
│   │   ├── state/                # 全局学习状态同步与迁移接口
│   │   ├── tasks/                # 后台异步 LLM 任务管理接口
│   │   ├── tracks/               # 学习轨道管理接口
│   │   └── workflows/            # 建课与研究工作流编排接口
│   ├── globals.css               # 全局设计系统变量与暗色/亮色主题样式
│   ├── layout.tsx                # 根布局与元数据
│   └── page.tsx                  # 工作台入口
├── components/                   # React 19 客户端组件
│   ├── gen-ui/                   # 生成式教学 UI 组件集 (测验卡、SVG/Mermaid 画布、计划 Diff 等)
│   ├── workbench/                # 三栏桌面工作台核心视图 (今日、课堂、图谱、日历、复习、记忆)
│   ├── ActivityAudit.tsx         # 运行轨迹与开发者 Trace 审计面板
│   ├── Agent.tsx                 # 右侧 AI 伴学助手面板
│   ├── KnowledgeFlowMap.tsx      # 交互式 DAG 知识图谱画布 (@xyflow/react)
│   ├── LearningStore.tsx         # 前端状态仓库与本机 SQLite 同步层
│   ├── ModelSettingsDialog.tsx   # 多模型配置与连接测试弹窗
│   └── Planner.tsx               # 日程规划与事件编辑器
├── electron/                     # Electron 桌面客户端主进程、预加载脚本与启动器
├── lib/                          # 核心领域算法与服务端基础设施
│   ├── agent-runtime.ts          # Agent 运行时与工具集编排
│   ├── agent-trace.ts            # ReAct 运行轨迹记录器
│   ├── bkt-fsrs.ts               # BKT 贝叶斯知识追踪 + ts-fsrs 间隔重复算法
│   ├── context-manager.ts        # 动态上下文预算分配与记忆注入
│   ├── curriculum-blueprint.ts   # 课程蓝图结构与校验
│   ├── curriculum-planner.ts     # 智能建课规划器
│   ├── db.ts                     # Node.js 22 内置 node:sqlite 存储引擎 (WAL 模式)
│   ├── deepseek-config.ts        # DeepSeek 思考模式与 OpenAI 兼容层适配
│   ├── graph.ts                  # DAG 环检测与拓扑分层布局算法
│   ├── learning-engine.ts        # 学习活动推进与状态流转核心引擎
│   ├── pedagogy.ts               # 7 态教学策略与补救决策引擎
│   ├── scheduler.ts              # 睡眠红线保护与约束日历排程引擎
│   ├── trace-sanitizer.ts        # 敏感密钥自动脱敏与超大负载截断
│   └── visual-explainer.ts       # 可视化图解生成与 SVG 安全清洗
├── public/                       # 应用图标与静态资源
├── skills/                       # Agent 内置领域技能定义 (visual-explainer 等)
├── tests/                        # 16 套全链路逻辑、算法、Trace 与端到端单元测试
├── docs/screenshots/             # 真实调用大模型建课与伴学全流程实机截图 (01~10)
├── .env.example                  # 环境变量配置模板（不含任何真实密钥）
├── electron-builder.yml          # Electron 跨平台打包配置
└── package.json                  # 项目依赖与脚本定义
```

---

## 🧪 测试与质量验证

项目内置完整的 TypeScript 类型检查与 16 套基于 Node.js 原生测试运行器（`node:test`）的单元测试套件，覆盖 SQLite 持久化、BKT/FSRS 认知算法、DAG 拓扑排序、睡眠红线排程、记忆 TTL、Trace 脱敏与并发隔离等核心逻辑：

```bash
# 1. TypeScript 严格类型检查
npm run typecheck

# 2. 运行全量领域逻辑与算法测试套件
npm run test:logic

# 3. 单独运行 ReAct Trace 审计与凭证脱敏测试
npm run test:trace

# 4. Next.js 生产构建验证
npm run build
```

---

## 📄 开源许可 (License)

本项目基于 [MIT License](https://opensource.org/licenses/MIT) 开源。
