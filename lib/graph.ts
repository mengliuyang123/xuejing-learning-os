import type { Lesson, Store } from "./learning";
import { available } from "./learning";

export type GraphNodeLayout = {
  lesson: Lesson;
  x: number; // percentage 10-90 (kept for unit test compatibility)
  y: number; // percentage 10-90 (kept for unit test compatibility)
  px: number; // roomy 2D landscape pixel X coordinate
  py: number; // roomy 2D landscape pixel Y coordinate
  layer: number;
  row: number;
  mastery: number;
  status: "mastered" | "available" | "locked";
};

export type GraphEdgeLayout = {
  id: string;
  fromId: string;
  toId: string;
  path: string;
  satisfied: boolean;
  kind?: "prerequisite" | "cross_concept";
  label?: string;
};

export type CrossConceptEdge = {
  id: string;
  fromId: string;
  toId: string;
  label: string;
};

export type GraphLayout = {
  nodes: GraphNodeLayout[];
  edges: GraphEdgeLayout[];
  crossEdges: CrossConceptEdge[];
  layerCount: number;
  boardWidth: number;
  boardHeight: number;
};

/**
 * Infers cross-chapter conceptual relationships (non-blocking synergy / extension links)
 * between nodes that are not already connected by direct prerequisite edges.
 * This ensures the Knowledge Graph displays rich conceptual connections beyond a mere table of contents.
 */
export function computeCrossChapterConceptLinks(
  units: Lesson[],
): CrossConceptEdge[] {
  if (units.length < 4) return [];
  const directEdgeSet = new Set<string>();
  for (const u of units) {
    for (const r of u.requires || []) {
      directEdgeSet.add(`${r}->${u.id}`);
      directEdgeSet.add(`${u.id}->${r}`);
    }
  }

  const rules: Array<{
    fromPattern: RegExp;
    toPattern: RegExp;
    label: string;
  }> = [
    {
      fromPattern: /记忆|Memory|上下文|摘要/i,
      toPattern: /RAG|检索|知识库|向量/i,
      label: "上下文与检索协同",
    },
    {
      fromPattern: /Loop|循环|ReAct|决策/i,
      toPattern: /评测|可观测|Tracing|监控|恢复|异常/i,
      label: "执行轨迹与质量闭环",
    },
    {
      fromPattern: /Function Calling|工具|Tool/i,
      toPattern: /多智能体|编排|Supervisor|Worker|MCP/i,
      label: "工具协议与分工扩展",
    },
    {
      fromPattern: /提示词|Prompt|API 调用/i,
      toPattern: /评测|Judge|回归/i,
      label: "提示词效果量化评估",
    },
    {
      fromPattern: /光圈|快门|曝光/i,
      toPattern: /人像|构图|后期/i,
      label: "曝光参数与实拍表现",
    },
  ];

  const links: CrossConceptEdge[] = [];
  const usedPairs = new Set<string>();

  for (const rule of rules) {
    const fromUnit = units.find((u) =>
      rule.fromPattern.test(`${u.title} ${u.concept}`),
    );
    const toUnit = units.find(
      (u) =>
        u.id !== fromUnit?.id &&
        rule.toPattern.test(`${u.title} ${u.concept}`),
    );
    if (!fromUnit || !toUnit) continue;
    const pairKey = [fromUnit.id, toUnit.id].sort().join("::");
    if (
      usedPairs.has(pairKey) ||
      directEdgeSet.has(`${fromUnit.id}->${toUnit.id}`)
    ) {
      continue;
    }
    usedPairs.add(pairKey);
    links.push({
      id: `cross-${fromUnit.id}->${toUnit.id}`,
      fromId: fromUnit.id,
      toId: toUnit.id,
      label: rule.label,
    });
  }

  // Fallback general concept association if no domain rule matched and track has >= 5 units
  if (links.length === 0 && units.length >= 5) {
    const midA = units[1];
    const midB = units[Math.min(units.length - 2, 3)];
    if (
      midA &&
      midB &&
      midA.id !== midB.id &&
      !directEdgeSet.has(`${midA.id}->${midB.id}`)
    ) {
      links.push({
        id: `cross-${midA.id}->${midB.id}`,
        fromId: midA.id,
        toId: midB.id,
        label: "跨节概念呼应",
      });
    }
  }

  return links.slice(0, 4);
}

/**
 * Computes a high-legibility 2D Landscape DAG layout for any prerequisite graph.
 * - Topological layers flow Left → Right (matching Left/Right node handles and wide landscape screens!)
 * - Parallel branches within a layer stack Vertically with generous breathing room
 * - Long chains (> 5 layers) wrap cleanly into a 2-band landscape grid so nodes are never squished into a 1D stick.
 */
export function layoutKnowledgeGraph(units: Lesson[], s: Store): GraphLayout {
  if (!units.length) {
    return {
      nodes: [],
      edges: [],
      crossEdges: [],
      layerCount: 0,
      boardWidth: 920,
      boardHeight: 420,
    };
  }

  const byId = new Map(units.map((u) => [u.id, u]));
  const depthMemo = new Map<string, number>();

  function depthOf(id: string, visiting = new Set<string>()): number {
    if (depthMemo.has(id)) return depthMemo.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const unit = byId.get(id);
    if (!unit) return 0;
    const validReqs = unit.requires.filter((r) => byId.has(r));
    const depth = validReqs.length
      ? Math.max(...validReqs.map((r) => depthOf(r, visiting) + 1))
      : 0;
    visiting.delete(id);
    depthMemo.set(id, depth);
    return depth;
  }

  for (const u of units) depthOf(u.id);

  const layerMap = new Map<number, Lesson[]>();
  for (const u of units) {
    const d = depthMemo.get(u.id) ?? 0;
    const arr = layerMap.get(d) || [];
    arr.push(u);
    layerMap.set(d, arr);
  }

  const layers = [...layerMap.keys()].sort((a, b) => a - b);
  const layerCount = layers.length;

  // If a layer has > 3 parallel nodes, or if all layers have 1 node and layerCount > 5,
  // arrange into a balanced 2D grid (max 5–6 columns wide, 2–3 rows tall)
  const maxNodesInLayer = Math.max(
    1,
    ...layers.map((l) => layerMap.get(l)?.length ?? 1),
  );
  const allSingleColumn = maxNodesInLayer === 1 && layerCount >= 5;
  const maxColsPerBand = allSingleColumn ? Math.ceil(layerCount / 2) : Math.min(6, layerCount);

  const COL_GAP_PX = 276;
  const ROW_GAP_PX = 148;
  const PAD_X = 44;
  const PAD_Y = 48;

  const totalCols = allSingleColumn ? maxColsPerBand : layerCount;
  const totalRows = allSingleColumn ? 2 : Math.max(2, maxNodesInLayer);

  const boardWidth = Math.max(780, PAD_X * 2 + Math.max(1, totalCols - 1) * COL_GAP_PX + 240);
  const boardHeight = Math.max(380, PAD_Y * 2 + Math.max(1, totalRows - 1) * ROW_GAP_PX + 110);

  const posById = new Map<
    string,
    { x: number; y: number; px: number; py: number; layer: number; row: number }
  >();
  const nodes: GraphNodeLayout[] = [];

  layers.forEach((layer, layerIdx) => {
    const colUnits = layerMap.get(layer)!;
    const count = colUnits.length;

    colUnits.forEach((lesson, rowIdx) => {
      let colPos = layerIdx;
      let verticalCenterOffset = 0;

      if (allSingleColumn) {
        // Wrap long 1D chain into a 2-row left-to-right grid so it fills the landscape canvas
        const band = Math.floor(layerIdx / maxColsPerBand);
        colPos = layerIdx % maxColsPerBand;
        verticalCenterOffset = band * ROW_GAP_PX;
      } else {
        // Center parallel nodes vertically around the canvas midline, with slight stagger for single-node columns
        const midRow = (count - 1) / 2;
        const baseMidPx = Math.round((boardHeight - 100) / 2);
        const stagger =
          count === 1 && layerCount >= 4
            ? (layerIdx % 2 === 0 ? -24 : 24)
            : 0;
        verticalCenterOffset =
          baseMidPx - PAD_Y + Math.round((rowIdx - midRow) * ROW_GAP_PX) + stagger;
      }

      const px = PAD_X + colPos * COL_GAP_PX;
      const py = Math.max(28, PAD_Y + verticalCenterOffset);

      // Normalized 12..88 percentage coordinates for existing unit tests
      const x =
        totalCols <= 1
          ? 50
          : Math.min(88, Math.max(12, Math.round(14 + (colPos * 72) / Math.max(1, totalCols - 1))));
      const y =
        count === 1
          ? allSingleColumn
            ? Math.floor(layerIdx / maxColsPerBand) === 0
              ? 30
              : 72
            : 50
          : Math.min(88, Math.max(12, Math.round(20 + (rowIdx * 60) / Math.max(1, count - 1))));

      posById.set(lesson.id, { x, y, px, py, layer: layerIdx, row: rowIdx });
      const mastery = s.mastery[lesson.id] ?? 0;
      const isAvail = available(s, lesson);
      nodes.push({
        lesson,
        x,
        y,
        px,
        py,
        layer: layerIdx,
        row: rowIdx,
        mastery,
        status: mastery >= 80 ? "mastered" : isAvail ? "available" : "locked",
      });
    });
  });

  const edges: GraphEdgeLayout[] = [];
  for (const target of units) {
    const to = posById.get(target.id);
    if (!to) continue;
    for (const reqId of target.requires) {
      const from = posById.get(reqId);
      if (!from) continue;
      const midX = (from.x + to.x) / 2;
      const path =
        Math.abs(from.y - to.y) < 1
          ? `M ${from.x} ${from.y} L ${to.x} ${to.y}`
          : `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
      edges.push({
        id: `${reqId}->${target.id}`,
        fromId: reqId,
        toId: target.id,
        path,
        satisfied: (s.mastery[reqId] ?? 0) >= 80,
        kind: "prerequisite",
      });
    }
  }

  const crossEdges = computeCrossChapterConceptLinks(units);

  return {
    nodes,
    edges,
    crossEdges,
    layerCount,
    boardWidth,
    boardHeight,
  };
}
