import { NextResponse } from "next/server";
import { resolveLanguageModel } from "../../../lib/ai-config";
import { getAgentWorkflowFromDb } from "../../../lib/db";
import type { PriorKnowledgeLevel, TrackDepth } from "../../../lib/learning";
import type { LessonDepthMode } from "../../../lib/lesson-content";
import type { ClientModelConfig } from "../../../lib/model-config";
import type { KnowledgeAcquisitionMode } from "../../../lib/web-research";
import {
  cancelWorkflowById,
  listRecentWorkflows,
  runGoalWorkflow,
  runLessonWorkflow,
} from "../../../lib/workflow-orchestrator";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const workflowId = url.searchParams.get("workflowId")?.trim();
    if (workflowId) {
      const workflow = getAgentWorkflowFromDb(workflowId);
      if (!workflow) {
        return NextResponse.json({ error: "未找到对应工作流" }, { status: 404 });
      }
      return NextResponse.json({ workflow });
    }
    return NextResponse.json({ workflows: listRecentWorkflows(25) });
  } catch (err) {
    console.error("[api/workflows GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "查询工作流失败" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: "start_goal" | "prepare_lesson" | "cancel";
      workflowId?: string;
      goal?: string;
      topic?: string;
      priorKnowledge?: PriorKnowledgeLevel;
      days?: number;
      dailyMinutes?: number;
      depth?: TrackDepth;
      lessonDepth?: LessonDepthMode;
      mode?: KnowledgeAcquisitionMode;
      userUrls?: string[];
      userNotes?: string;
      lessonId?: string;
      trackId?: string;
      userRequest?: string;
      availableMinutes?: number;
      includeTeachingDecision?: boolean;
      forceRefresh?: boolean;
      day?: string;
      clientModelConfig?: ClientModelConfig | null;
    };

    if (body.action === "cancel") {
      if (!body.workflowId?.trim()) {
        return NextResponse.json({ error: "缺少 workflowId" }, { status: 400 });
      }
      const res = cancelWorkflowById(body.workflowId.trim());
      return NextResponse.json({ ok: true, ...res });
    }

    const resolved = resolveLanguageModel(body.clientModelConfig);

    if (body.action === "start_goal") {
      if (!body.goal?.trim()) {
        return NextResponse.json({ error: "缺少学习目标 goal" }, { status: 400 });
      }
      const res = await runGoalWorkflow({
        input: {
          goal: body.goal.trim(),
          topic: body.topic?.trim(),
          priorKnowledge: body.priorKnowledge,
          days: body.days,
          dailyMinutes: body.dailyMinutes,
          depth: body.depth,
          mode: body.mode || "auto_web",
          userUrls: body.userUrls,
          userNotes: body.userNotes,
          day: body.day,
        },
        model: resolved?.model ?? null,
        modelLabel: resolved?.label,
        providerName: resolved?.providerName,
        clientConfig: body.clientModelConfig,
        abortSignal: request.signal,
      });
      return NextResponse.json({ ok: true, ...res });
    }

    if (body.action === "prepare_lesson") {
      if (!body.lessonId?.trim()) {
        return NextResponse.json({ error: "缺少 lessonId" }, { status: 400 });
      }
      const res = await runLessonWorkflow({
        lessonId: body.lessonId.trim(),
        trackId: body.trackId,
        depth: body.lessonDepth || "standard",
        mode: body.mode || "auto_web",
        userRequest: body.userRequest,
        availableMinutes: body.availableMinutes,
        includeTeachingDecision: body.includeTeachingDecision,
        forceRefresh: body.forceRefresh,
        day: body.day,
        model: resolved?.model ?? null,
        modelLabel: resolved?.label,
        providerName: resolved?.providerName,
        clientConfig: body.clientModelConfig,
        abortSignal: request.signal,
      });
      return NextResponse.json({ ok: true, ...res });
    }

    return NextResponse.json({ error: "不支持的工作流操作" }, { status: 400 });
  } catch (err) {
    console.error("[api/workflows POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "执行工作流失败" },
      { status: 500 },
    );
  }
}
