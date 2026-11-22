import fs from "node:fs";
import path from "node:path";

export interface TeachingSkillMeta {
  name: string;
  description: string;
  version: string;
  triggers: string[];
  capabilities: string[];
  filePath?: string;
}

export interface TeachingSkillDocument extends TeachingSkillMeta {
  /** Full Markdown body (without YAML frontmatter), loaded on demand */
  body: string;
}

export interface OnDemandSkillTriggerInput {
  action?: string;
  userRequest?: string;
  consecutiveFailures?: number;
  explicitSkillNames?: string[];
}

function parseSimpleYamlFrontmatter(raw: string): {
  meta: Record<string, string | string[]>;
  body: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { meta: {}, body: normalized.trim() };
  }
  const endIdx = normalized.indexOf("\n---\n", 4);
  if (endIdx < 0) {
    return { meta: {}, body: normalized.trim() };
  }
  const yamlBlock = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 5).trim();
  const meta: Record<string, string | string[]> = {};
  let activeArrayKey: string | null = null;

  for (const rawLine of yamlBlock.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const arrMatch = line.match(/^\s*-\s+(.+)$/);
    if (arrMatch && activeArrayKey) {
      const existing = meta[activeArrayKey];
      const val = arrMatch[1].trim().replace(/^["']|["']$/g, "");
      if (Array.isArray(existing)) {
        existing.push(val);
      } else {
        meta[activeArrayKey] = [val];
      }
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const val = kvMatch[2].trim();
      if (!val) {
        meta[key] = [];
        activeArrayKey = key;
      } else {
        meta[key] = val.replace(/^["']|["']$/g, "");
        activeArrayKey = null;
      }
    }
  }

  return { meta, body };
}

function resolveDefaultSkillsRoot(): string {
  return path.join(process.cwd(), "skills");
}

/**
 * TeachingSkillRegistry:
 * - Keeps static system prompt tiny (2-3 line catalog) to protect DeepSeek KV Disk Cache.
 * - Loads full SKILL.md bodies strictly on-demand (e.g. action === "visualize", visual requests,
 *   repeated errors needing visual remediation, or explicit tool invocation).
 * - Extensible for future skills (worked-example, analogy-builder, practice-designer, math-visualizer).
 */
export class TeachingSkillRegistry {
  private readonly skillsRoot: string;
  private readonly metaCache = new Map<string, TeachingSkillMeta>();
  private readonly bodyCache = new Map<string, string>();
  private readonly programmaticSkills = new Map<string, TeachingSkillDocument>();
  private discovered = false;

  constructor(skillsRoot?: string) {
    this.skillsRoot = skillsRoot || resolveDefaultSkillsRoot();
  }

  /** Programmatically register an in-memory skill (useful for extensions & unit tests). */
  registerSkill(skill: TeachingSkillDocument): void {
    this.programmaticSkills.set(skill.name, skill);
    this.metaCache.set(skill.name, {
      name: skill.name,
      description: skill.description,
      version: skill.version,
      triggers: [...skill.triggers],
      capabilities: [...skill.capabilities],
      filePath: skill.filePath,
    });
    this.bodyCache.set(skill.name, skill.body);
  }

  /** Discover available skills metadata (frontmatter only; keeps memory & prompt lean). */
  discover(force = false): TeachingSkillMeta[] {
    if (this.discovered && !force) {
      return [...this.metaCache.values()];
    }
    this.metaCache.clear();
    if (force) {
      this.bodyCache.clear();
    }

    // Re-hydrate programmatic skills first
    for (const [name, doc] of this.programmaticSkills.entries()) {
      this.metaCache.set(name, {
        name: doc.name,
        description: doc.description,
        version: doc.version,
        triggers: [...doc.triggers],
        capabilities: [...doc.capabilities],
        filePath: doc.filePath,
      });
      this.bodyCache.set(name, doc.body);
    }

    try {
      if (fs.existsSync(this.skillsRoot)) {
        const entries = fs.readdirSync(this.skillsRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillFile = path.join(this.skillsRoot, entry.name, "SKILL.md");
          if (!fs.existsSync(skillFile)) continue;
          const raw = fs.readFileSync(skillFile, "utf8");
          const { meta } = parseSimpleYamlFrontmatter(raw);
          const name =
            (typeof meta.name === "string" && meta.name.trim()) || entry.name;
          const description =
            (typeof meta.description === "string" && meta.description.trim()) ||
            `教学技能：${name}`;
          const version =
            (typeof meta.version === "string" && meta.version.trim()) || "1.0.0";
          const triggers = Array.isArray(meta.triggers)
            ? meta.triggers
            : typeof meta.triggers === "string"
              ? meta.triggers
                  .split(/[,，\s]+/)
                  .map((s) => s.trim())
                  .filter(Boolean)
              : [];
          const capabilities = Array.isArray(meta.capabilities)
            ? meta.capabilities
            : [];
          this.metaCache.set(name, {
            name,
            description,
            version,
            triggers,
            capabilities,
            filePath: skillFile,
          });
        }
      }
    } catch {
      // Best-effort filesystem discovery; never crash runtime
    }

    this.discovered = true;
    return [...this.metaCache.values()];
  }

  listSkillCatalog(): TeachingSkillMeta[] {
    return this.discover();
  }

  /**
   * Compact 2-3 line skill directory for the STATIC System Prompt prefix.
   * Never dumps full SKILL.md body so DeepSeek KV prefix cache stays hot.
   */
  getCompactCatalogForSystemPrompt(): string {
    const list = this.discover();
    if (list.length === 0) return "";
    const lines = list.map(
      (s) => `- \`${s.name}\`：${s.description}`,
    );
    return `可用按需教学技能（Teaching Skills，仅在需要时自动加载完整规范）：\n${lines.join("\n")}`;
  }

  /** Lazily loads the full SKILL.md body for a specific skill name. */
  loadSkill(name: string): TeachingSkillDocument | null {
    this.discover();
    const meta = this.metaCache.get(name);
    if (!meta) return null;

    let body = this.bodyCache.get(name);
    if (body === undefined && meta.filePath) {
      try {
        const raw = fs.readFileSync(meta.filePath, "utf8");
        body = parseSimpleYamlFrontmatter(raw).body;
        this.bodyCache.set(name, body);
      } catch {
        return null;
      }
    }
    if (body === undefined) return null;
    return {
      ...meta,
      body,
    };
  }

  /**
   * Resolves which Teaching Skills should be loaded on-demand for the current turn.
   * Returns empty array on normal non-visual turns so prompts stay compact!
   */
  resolveOnDemandSkills(input: OnDemandSkillTriggerInput): TeachingSkillDocument[] {
    this.discover();
    const matchedNames = new Set<string>();

    for (const explicit of input.explicitSkillNames || []) {
      if (this.metaCache.has(explicit)) matchedNames.add(explicit);
    }

    const actionLower = (input.action || "").trim().toLowerCase();
    const reqLower = (input.userRequest || "").trim().toLowerCase();

    for (const meta of this.metaCache.values()) {
      // Action match (e.g. action === "visualize")
      if (
        actionLower &&
        meta.triggers.some((t) => t.toLowerCase() === actionLower)
      ) {
        matchedNames.add(meta.name);
        continue;
      }
      // User request keyword trigger (e.g. "用图解释", "画图", "mermaid", "svg", "流程图", "示意图")
      if (
        reqLower &&
        meta.triggers.some(
          (t) => t.length >= 2 && reqLower.includes(t.toLowerCase()),
        )
      ) {
        matchedNames.add(meta.name);
        continue;
      }
    }

    // Visual remediation escalation: >= 2 consecutive failures -> offer visual-explainer
    if (
      (input.consecutiveFailures ?? 0) >= 2 &&
      this.metaCache.has("visual-explainer")
    ) {
      matchedNames.add("visual-explainer");
    }

    const docs: TeachingSkillDocument[] = [];
    for (const name of matchedNames) {
      const doc = this.loadSkill(name);
      if (doc) docs.push(doc);
    }
    return docs;
  }

  /** Formats on-demand loaded skills as a bounded prompt section for dynamic context injection. */
  formatLoadedSkillsPrompt(docs: TeachingSkillDocument[]): string {
    if (!docs.length) return "";
    return docs
      .map(
        (d) =>
          `\n【已按需加载教学技能：${d.name} (v${d.version})】\n${d.body}`,
      )
      .join("\n");
  }
}

let defaultRegistry: TeachingSkillRegistry | null = null;

export function getTeachingSkillRegistry(): TeachingSkillRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new TeachingSkillRegistry();
  }
  return defaultRegistry;
}
