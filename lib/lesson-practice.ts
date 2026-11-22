import type { Lesson } from "./learning";

export type PracticeEditorKind = "code" | "text";

export type ResolvedLessonPractice = {
  kind: PracticeEditorKind;
  language:
    | "python"
    | "typescript"
    | "javascript"
    | "java"
    | "json"
    | "sql"
    | "cpp"
    | "html"
    | "css"
    | "markdown"
    | "plaintext";
  prompt: string;
  starterCode: string;
  placeholder: string;
  reason: string;
};

export function detectCodeLanguage(
  sample: string,
  context: string,
): ResolvedLessonPractice["language"] {
  const combined = `${context}\n${sample}`.toLowerCase();
  const trimmed = sample.trim();

  // Fenced code block explicit hint
  const fence = trimmed.match(/^```([a-z0-9+#-]+)/i);
  if (fence) {
    const f = fence[1].toLowerCase();
    if (f === "py" || f === "python") return "python";
    if (f === "ts" || f === "tsx" || f === "typescript") return "typescript";
    if (f === "js" || f === "jsx" || f === "javascript") return "javascript";
    if (f === "java") return "java";
    if (f === "json") return "json";
    if (f === "sql") return "sql";
    if (f === "cpp" || f === "c++" || f === "c") return "cpp";
    if (f === "html") return "html";
    if (f === "css") return "css";
    if (f === "md" || f === "markdown") return "markdown";
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    /json\s*schema|"type"\s*:\s*"object"|"properties"\s*:/.test(combined)
  ) {
    return "json";
  }
  if (
    /\b(public\s+class|system\.out\.println|static\s+void\s+main)\b/.test(
      combined,
    ) ||
    /\bjava\b/.test(context.toLowerCase())
  ) {
    return "java";
  }
  if (
    /\b(select\s+.+\s+from|create\s+table|insert\s+into|where\s+)\b/.test(
      combined,
    ) ||
    /\bsql\b/.test(context.toLowerCase())
  ) {
    return "sql";
  }
  if (
    /\b(interface\s+\w+|type\s+\w+\s*=|:\s*(string|number|boolean))\b/.test(
      combined,
    ) ||
    /\btypescript\b/.test(context.toLowerCase())
  ) {
    return "typescript";
  }
  if (
    /\b(const\s+\w+\s*=|let\s+\w+\s*=|function\s+\w+|=>|console\.log|async\s+function)\b/.test(
      combined,
    ) ||
    /\b(javascript|node\.js|react)\b/.test(context.toLowerCase())
  ) {
    return "javascript";
  }
  if (
    /\b(def\s+\w+|import\s+\w+|print\(|elif\b|from\s+\w+\s+import)\b/.test(
      combined,
    ) ||
    /\bpython\b/.test(context.toLowerCase())
  ) {
    return "python";
  }
  if (/\b(#include|std::|int\s+main\s*\()\b/.test(combined)) {
    return "cpp";
  }
  if (/<(div|html|body|section|button)\b/i.test(sample)) {
    return "html";
  }
  return "python";
}

function hasStrongCodeSignal(lesson: Lesson, trackTitle: string): boolean {
  const ex = (lesson.example || "").trim();
  const titleAndConcept = `${lesson.title} ${lesson.concept}`.toLowerCase();

  // Explicit code fence or clear syntax tokens inside lesson.example
  if (
    ex.includes("```") ||
    /\b(def |class |function |const |let |import |return |print\(|console\.log|public class|select |create table)\b/i.test(
      ex,
    ) ||
    (ex.startsWith("{") && ex.includes(":")) ||
    /[A-Za-z_]\w*\s*\([^)]*\)\s*[:{]/.test(ex)
  ) {
    return true;
  }

  // Explicit coding-oriented lesson title
  if (
    /(语法|代码|编程|函数|变量|字典|列表|循环|类与对象|手写|实现|json\s*schema|api\s*调用|sql|脚本|调试|重构)/i.test(
      lesson.title,
    )
  ) {
    return true;
  }

  // Strongly conceptual / architecture / essay titles default to text box
  if (
    /(原理|概念|入门|架构|论文|对比|设计模式|思维|权衡|机制|token|上下文|角色分工|prompt\s*结构)/i.test(
      titleAndConcept,
    ) &&
    !/(手写|代码|编程|实现)/.test(lesson.title)
  ) {
    return false;
  }

  // Fallback: check track domain
  return /(python|java|javascript|typescript|sql|c\+\+|rust|go|编程|代码)/i.test(
    trackTitle,
  );
}

/**
 * Dynamically determines whether a lesson's practice workspace should render
 * a real CodeMirror Code Editor ("code") or a structured prose Text Box ("text"),
 * along with its language, tailored prompt, and starter template.
 */
export function resolveLessonPracticeSpec(
  lesson: Lesson,
  trackTitle = "",
): ResolvedLessonPractice {
  const explicitKind = lesson.practiceType;
  const kind: PracticeEditorKind =
    explicitKind === "code" || explicitKind === "text"
      ? explicitKind
      : hasStrongCodeSignal(lesson, trackTitle)
        ? "code"
        : "text";

  const language = lesson.practiceLanguage
    ? detectCodeLanguage("", lesson.practiceLanguage)
    : detectCodeLanguage(
        lesson.starterCode || lesson.example || "",
        `${trackTitle} ${lesson.title} ${lesson.concept}`,
      );

  if (kind === "code") {
    const prompt =
      lesson.practicePrompt?.trim() ||
      `请用 ${language.toUpperCase()} 编写「${lesson.title}」的最小可运行实现，并考虑关键边界或异常输入。`;
    const commentPrefix =
      language === "python"
        ? "#"
        : language === "sql"
          ? "--"
          : language === "html"
            ? "<!--"
            : "//";
    const commentSuffix = language === "html" ? " -->" : "";
    const defaultStarter =
      language === "json"
        ? `{\n  \n}`
        : `${commentPrefix} 练习：${lesson.title}${commentSuffix}\n`;

    return {
      kind: "code",
      language,
      prompt,
      starterCode: lesson.starterCode ?? defaultStarter,
      placeholder: `在此编写 ${language} 代码（支持语法高亮、行号与自动缩进）…`,
      reason: explicitKind
        ? "由课程大纲指定为编程实践"
        : "检测到本课包含代码/结构化实现",
    };
  }

  const prompt =
    lesson.practicePrompt?.trim() ||
    (lesson.question?.trim()
      ? lesson.question.trim()
      : `用自己的话拆解「${lesson.title}」的核心机制：它解决了什么问题？输入与输出分别是什么？如果省略其中关键一步会发生什么？`);

  return {
    kind: "text",
    language: "markdown",
    prompt,
    starterCode: "",
    placeholder:
      "用自己的语言写出原理解释、结构拆解或关键结论（支持切换页面自动保留）…",
    reason: explicitKind
      ? "由课程大纲指定为原理文本作答"
      : "检测到本课侧重概念理解与结构化表达",
  };
}
