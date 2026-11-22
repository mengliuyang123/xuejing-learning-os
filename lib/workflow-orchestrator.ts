import crypto from "node:crypto";
import type { LanguageModel } from "ai";
import {
  DEFAULT_LEARNOS_CAPABILITIES,
  type RuntimeCapability,
} from "./activity-registry";
import type { RuntimeModelExecutor } from "./agent-runtime";
import {
  type CurriculumBlueprint,
  type CurriculumValidationReport,
  blueprintToGoalPlan,
  runCurriculumPlanner,
} from "./curriculum-blueprint";
import { resolveGraphNeighborsForLesson } from "./curriculum-planner";
import {
  type AgentWorkflowRow,
  getAgentWorkflowFromDb,
  getLatestCurriculumBlueprintFromDb,
  getTrackResearchPackageFromDb,
  listAgentWorkflowsFromDb,
  loadStoreFromDb,
  saveCurriculumBlueprintToDb,
  saveStoreToDb,
  upsertAgentWorkflowInDb,
} from "./db";
import {
  type GoalPlan,
  type Lesson,
  type PriorKnowledgeLevel,
  type TrackDepth,
  available,
  getLessonById,
  getMissingPrerequisites,
  today,
} from "./learning";
import {
  listAttemptsForLesson,
  startLearningSession,
} from "./learning-engine";
import {
  type LessonContent,
  type LessonDepthMode,
  generateStructuredLessonContent,
} from "./lesson-content";
import type { ClientModelConfig } from "./model-config";
import {
  type ResearchPackage,
  runResearchPlanner,
} from "./research-planner";
import {
  cancelServerTask,
  ensureBootTaskHygiene,
  registerServerTaskController,
  unregisterServerTaskController,
} from "./server-task-registry";
import {
  type TeachingDecision,
  runTeachingPlanner,
} from "./teaching-planner";
import {
  type FetchLike,
  type KnowledgeAcquisitionMode,
  type WebResearchProvider,
  inferLearningCapabilityProfile,
} from "./web-research";

export type GoalWorkflowState =
  | "goal_created"
  | "goal_analyzing"
  | "research_planning"
  | "research_running"
  | "research_validating"
  | "curriculum_generating"
  | "curriculum_validating"
  | "curriculum_ready"
  | "first_lesson_preparing"
  | "ready_to_learn"
  | "failed"
  | "cancelled"
  | "interrupted";

export type LessonWorkflowState =
  | "not_prepared"
  | "preparing"
  | "validating"
  | "ready"
  | "limited"
  | "learning"
  | "practicing"
  | "assessing"
  | "completed"
  | "remediation_needed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "stale";

export interface GoalWorkflowInput {
  goal: string;
  topic?: string;
  priorKnowledge?: PriorKnowledgeLevel;
  days?: number;
  dailyMinutes?: number;
  depth?: TrackDepth;
  mode?: KnowledgeAcquisitionMode;
  userUrls?: string[];
  userNotes?: string;
  day?: string;
  workflowId?: string;
  maxResearchLoops?: number;
}

export interface GoalWorkflowResult {
  workflow: AgentWorkflowRow;
  goalId: string;
  researchPackage: ResearchPackage;
  blueprint: CurriculumBlueprint;
  validation: CurriculumValidationReport;
  plan: GoalPlan;
  firstLessonContent?: LessonContent | null;
  stateHistory: GoalWorkflowState[];
}

export interface LessonWorkflowResult {
  workflow: AgentWorkflowRow;
  lessonContent: LessonContent;
  initialDecision?: TeachingDecision;
  stateHistory: LessonWorkflowState[];
}

const activeWorkflowKeys = new Set<string>();

/**
 * Pure TypeScript Business Orchestrator for the full Goal Workflow (Section 6.1):
 * goal_created -> goal_analyzing -> research_planning -> research_running -> research_validating
 * (bounded follow-up research loop if coverage insufficient)
 * -> curriculum_generating -> curriculum_validating -> curriculum_ready
 * -> first_lesson_preparing -> ready_to_learn
 * Persists every transition in SQLite `agent_workflows` for restart recovery.
 */
export async function runGoalWorkflow(opts: {
  input: GoalWorkflowInput;
  model?: LanguageModel | string | null;
  modelLabel?: string;
  providerName?: string;
  clientConfig?: ClientModelConfig | null;
  webProvider?: WebResearchProvider;
  fetchImpl?: FetchLike;
  apiKey?: string;
  abortSignal?: AbortSignal;
  customResearchExecutor?: RuntimeModelExecutor;
  customCurriculumExecutor?: RuntimeModelExecutor;
  customLessonExecutor?: RuntimeModelExecutor;
  persistTrackToStore?: boolean;
}): Promise<GoalWorkflowResult> {
  ensureBootTaskHygiene();

  const input = opts.input;
  const day = input.day || today();
  const workflowId = input.workflowId || `wf-goal-${crypto.randomUUID().slice(0, 10)}`;
  const goalId = `goal-${crypto.randomUUID().slice(0, 8)}`;
  const topic = (input.topic || input.goal).trim();
  const dedupeKey = `goal:${topic.toLowerCase()}`;

  if (activeWorkflowKeys.has(dedupeKey)) {
    throw new Error(`目标「${topic}」已有正在执行的工作流，已阻止重复启动。`);
  }
  activeWorkflowKeys.add(dedupeKey);

  const serverCtrl = registerServerTaskController(workflowId);
  const onExternalAbort = () => serverCtrl.abort(opts.abortSignal?.reason);
  if (opts.abortSignal?.aborted) {
    serverCtrl.abort(opts.abortSignal.reason);
  } else {
    opts.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  const stateHistory: GoalWorkflowState[] = [];
  const contextState: Record<string, unknown> = {
    goal: input.goal,
    topic,
    day,
  };

  const transition = (
    state: GoalWorkflowState,
    extra: {
      trackId?: string | null;
      lessonId?: string | null;
      lastError?: string | null;
      patchContext?: Record<string, unknown>;
    } = {},
  ) => {
    stateHistory.push(state);
    if (extra.patchContext) Object.assign(contextState, extra.patchContext);
    return upsertAgentWorkflowInDb({
      workflowId,
      kind: "goal",
      state,
      goalId,
      trackId: extra.trackId ?? (contextState.trackId as string | undefined) ?? null,
      lessonId: extra.lessonId ?? (contextState.firstLessonId as string | undefined) ?? null,
      input,
      context: { ...contextState, stateHistory: [...stateHistory] },
      lastError: extra.lastError ?? null,
    });
  };

  try {
    transition("goal_created");
    if (serverCtrl.signal.aborted) throw new Error("TASK_ABORTED");

    // 1. Analyze Goal -> dynamic multi-dimensional capability profile
    transition("goal_analyzing");
    const profile = inferLearningCapabilityProfile(`${topic} ${input.goal}`);
    transition("research_planning", {
      patchContext: { capabilityProfile: profile },
    });

    // 2. Bounded Research Loop (research_running <-> research_validating)
    const maxResearchLoops = Math.max(1, Math.min(2, input.maxResearchLoops ?? 2));
    let researchPkg: ResearchPackage | null = null;
    for (let loop = 1; loop <= maxResearchLoops; loop++) {
      if (serverCtrl.signal.aborted) throw new Error("TASK_ABORTED");
      transition("research_running", {
        patchContext: { researchLoop: loop },
      });

      const res = await runResearchPlanner({
        request: {
          goal:
            loop === 1
              ? input.goal
              : `${input.goal}（重点补足缺失成果：${researchPkg?.coverageReport.missingOutcomes.join("、") || ""}）`,
          topic,
          learnerLevel: input.priorKnowledge || "intermediate",
          researchPurpose: "curriculum",
          mode: input.mode || "auto_web",
          userUrls: input.userUrls,
          userNotes: input.userNotes,
          forceRefresh: loop > 1,
          budget: {
            maxSteps: 5,
            maxSearches: loop === 1 ? 3 : 2,
            maxFetches: 2,
            maxTokens: 12000,
          },
        },
        identity: { workflowId, goalId },
        model: opts.model,
        modelLabel: opts.modelLabel,
        providerName: opts.providerName,
        clientConfig: opts.clientConfig,
        webProvider: opts.webProvider,
        fetchImpl: opts.fetchImpl,
        apiKey: opts.apiKey,
        abortSignal: serverCtrl.signal,
        customExecutor: opts.customResearchExecutor,
      });
      researchPkg = res.package;

      transition("research_validating", {
        patchContext: {
          researchPackageId: researchPkg.id,
          researchStatus: researchPkg.status,
          researchMode: researchPkg.effectiveMode,
        },
      });

      if (
        researchPkg.coverageReport.recommendation !== "continue_research" ||
        researchPkg.status === "fallback" ||
        loop >= maxResearchLoops
      ) {
        break;
      }
    }

    if (!researchPkg) {
      throw new Error("研究阶段未产出有效 ResearchPackage");
    }

    // 3. Curriculum Generation + Validation + Bounded Repair
    if (serverCtrl.signal.aborted) throw new Error("TASK_ABORTED");
    transition("curriculum_generating");

    const curRes = await runCurriculumPlanner({
      goalId,
      goal: input.goal,
      researchPackage: researchPkg,
      priorKnowledge: input.priorKnowledge || "intermediate",
      days: input.days,
      dailyMinutes: input.dailyMinutes,
      depth: input.depth,
      identity: { workflowId, goalId },
      model: opts.model,
      modelLabel: opts.modelLabel,
      providerName: opts.providerName,
      abortSignal: serverCtrl.signal,
      customExecutor: opts.customCurriculumExecutor,
      maxRepairAttempts: 2,
    });

    transition("curriculum_validating", {
      patchContext: {
        blueprintId: curRes.blueprint.id,
        lessonCount: curRes.validation.totalLessonCount,
        repairAttempts: curRes.repairAttempts,
      },
    });

    // Project CurriculumBlueprint to GoalPlan & conflict-free calendar slots
    const currentStore = loadStoreFromDb(day);
    const { plan, slots } = blueprintToGoalPlan({
      blueprint: curRes.blueprint,
      goal: input.goal,
      day,
      existingBlocks: currentStore.blocks,
      scheduleSettings: currentStore.scheduleSettings,
      days: input.days,
      dailyMinutes: input.dailyMinutes,
      priorKnowledge: input.priorKnowledge || "intermediate",
    });

    if (opts.persistTrackToStore !== false) {
      const nextMastery = { ...currentStore.mastery };
      for (const u of plan.units) nextMastery[u.id] ??= 0;
      saveStoreToDb(
        {
          ...currentStore,
          activeTrackId: plan.id,
          goalPlans: [...(currentStore.goalPlans || []), plan],
          blocks: [...currentStore.blocks, ...slots],
          mastery: nextMastery,
        },
        {
          trigger: "Workflow 建轨排课",
          summary: `通过自适应工作流创建「${plan.title}」（${plan.units.length} 节课，排入 ${slots.length} 个日程）`,
        },
      );
      try {
        saveCurriculumBlueprintToDb({
          blueprintId: curRes.blueprint.id,
          goalId,
          trackId: plan.id,
          version: curRes.blueprint.version,
          researchPackageId: researchPkg.id,
          status: "ready",
          blueprint: curRes.blueprint,
          validationReport: curRes.validation,
        });
      } catch {}
    }

    const firstLesson = plan.units[0];
    transition("curriculum_ready", {
      trackId: plan.id,
      lessonId: firstLesson?.id ?? null,
      patchContext: { trackId: plan.id, firstLessonId: firstLesson?.id ?? null },
    });

    // 4. First Lesson Preparation (prioritize Lesson 1, leave subsequent lessons on-demand)
    let firstLessonContent: LessonContent | null = null;
    if (firstLesson && !serverCtrl.signal.aborted) {
      transition("first_lesson_preparing", {
        trackId: plan.id,
        lessonId: firstLesson.id,
      });
      const lessonDepth: LessonDepthMode =
        input.priorKnowledge === "beginner"
          ? "beginner"
          : input.depth === "crash"
            ? "concise"
            : "standard";
      const firstNeighborhood = resolveGraphNeighborsForLesson(
        plan.units,
        firstLesson.id,
        { blueprintVersion: curRes.blueprint.version },
      );
      firstLessonContent = await generateStructuredLessonContent({
        lesson: firstLesson,
        trackId: plan.id,
        blueprintId: curRes.blueprint.id,
        blueprintVersion: curRes.blueprint.version,
        contract: firstNeighborhood?.contract ?? firstLesson.contract,
        graphNeighborhood: firstNeighborhood,
        depth: lessonDepth,
        researchPackage: researchPkg,
        profile,
        identity: { workflowId, goalId, trackId: plan.id, lessonId: firstLesson.id },
        model: opts.model,
        modelLabel: opts.modelLabel,
        providerName: opts.providerName,
        abortSignal: serverCtrl.signal,
        customExecutor: opts.customLessonExecutor,
      });
    }

    const finalWorkflow = transition("ready_to_learn", {
      trackId: plan.id,
      lessonId: firstLesson?.id ?? null,
      patchContext: {
        firstLessonContentId: firstLessonContent?.contentId ?? null,
        firstLessonStatus: firstLessonContent?.status ?? "not_prepared",
      },
    });

    return {
      workflow: finalWorkflow,
      goalId,
      researchPackage: researchPkg,
      blueprint: curRes.blueprint,
      validation: curRes.validation,
      plan,
      firstLessonContent,
      stateHistory,
    };
  } catch (err) {
    const isCancelled =
      serverCtrl.signal.aborted ||
      (err instanceof Error &&
        (err.message === "TASK_ABORTED" || err.name === "AbortError"));
    transition(isCancelled ? "cancelled" : "failed", {
      lastError: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    opts.abortSignal?.removeEventListener("abort", onExternalAbort);
    unregisterServerTaskController(workflowId);
    activeWorkflowKeys.delete(dedupeKey);
  }
}

/**
 * Pure TypeScript Business Orchestrator for the Lesson Workflow (Section 6.2):
 * not_prepared -> preparing -> validating -> ready (or limited / failed — NEVER mislabeled!)
 * -> optionally initializes learning session & evidence-driven Teaching Decision.
 */
export async function runLessonWorkflow(opts: {
  lessonId: string;
  trackId?: string;
  depth?: LessonDepthMode;
  mode?: KnowledgeAcquisitionMode;
  userRequest?: string;
  availableMinutes?: number;
  availableCapabilities?: readonly RuntimeCapability[];
  day?: string;
  forceRefresh?: boolean;
  includeTeachingDecision?: boolean;
  model?: LanguageModel | string | null;
  modelLabel?: string;
  providerName?: string;
  clientConfig?: ClientModelConfig | null;
  webProvider?: WebResearchProvider;
  fetchImpl?: FetchLike;
  apiKey?: string;
  abortSignal?: AbortSignal;
  customResearchExecutor?: RuntimeModelExecutor;
  customLessonExecutor?: RuntimeModelExecutor;
  customTeachingExecutor?: RuntimeModelExecutor;
}): Promise<LessonWorkflowResult> {
  ensureBootTaskHygiene();
  const day = opts.day || today();
  const workflowId = `wf-lesson-${crypto.randomUUID().slice(0, 10)}`;
  const store = loadStoreFromDb(day);
  const lesson: Lesson | undefined = getLessonById(store, opts.lessonId);
  if (!lesson) {
    throw new Error(`未找到课程 ${opts.lessonId}`);
  }
  const track =
    (store.goalPlans || []).find(
      (p) =>
        (opts.trackId && p.id === opts.trackId) ||
        p.units.some((u) => u.id === lesson.id),
    ) || null;

  const dedupeKey = `lesson:${lesson.id}`;
  if (activeWorkflowKeys.has(dedupeKey)) {
    throw new Error(`课程「${lesson.title}」已在准备中，请勿重复启动。`);
  }
  activeWorkflowKeys.add(dedupeKey);

  const serverCtrl = registerServerTaskController(workflowId);
  const stateHistory: LessonWorkflowState[] = [];
  const contextState: Record<string, unknown> = {
    lessonId: lesson.id,
    trackId: track?.id ?? opts.trackId ?? null,
  };

  const transition = (
    state: LessonWorkflowState,
    extra: { lastError?: string | null; patchContext?: Record<string, unknown> } = {},
  ) => {
    stateHistory.push(state);
    if (extra.patchContext) Object.assign(contextState, extra.patchContext);
    return upsertAgentWorkflowInDb({
      workflowId,
      kind: "lesson",
      state,
      trackId: track?.id ?? opts.trackId ?? null,
      lessonId: lesson.id,
      input: { lessonId: lesson.id, depth: opts.depth, mode: opts.mode },
      context: { ...contextState, stateHistory: [...stateHistory] },
      lastError: extra.lastError ?? null,
    });
  };

  try {
    transition("not_prepared");
    transition("preparing");

    const profile = inferLearningCapabilityProfile(
      `${lesson.title} ${lesson.concept} ${track?.goal || ""}`,
    );

    // Reuse track-level ResearchPackage by default (Global Research Reuse)
    // Only invoke ResearchPlanner if no track research exists, forceRefresh is true, or customResearchExecutor is injected
    let researchPkg: ResearchPackage | null = null;
    if (!opts.forceRefresh && !opts.customResearchExecutor && track) {
      const cachedTrackPkg = getTrackResearchPackageFromDb({
        packageId: track.researchPackageId,
        goal: track.goal,
        topic: track.title,
      });
      if (cachedTrackPkg?.pkg && typeof cachedTrackPkg.pkg === "object") {
        researchPkg = cachedTrackPkg.pkg as ResearchPackage;
      }
    }

    if (!researchPkg) {
      const research = await runResearchPlanner({
        request: {
          goal: lesson.objective || track?.goal || lesson.title,
          topic: `${track?.title ? `${track.title} ` : ""}${lesson.title}`,
          learnerLevel:
            opts.depth === "beginner"
              ? "beginner"
              : track?.priorKnowledge || "intermediate",
          researchPurpose: "lesson",
          mode: opts.mode || "auto_web",
          forceRefresh: opts.forceRefresh,
          budget: { maxSteps: 4, maxSearches: 2, maxFetches: 2, maxTokens: 10000 },
        },
        identity: { workflowId, trackId: track?.id, lessonId: lesson.id },
        model: opts.model,
        modelLabel: opts.modelLabel,
        providerName: opts.providerName,
        clientConfig: opts.clientConfig,
        webProvider: opts.webProvider,
        fetchImpl: opts.fetchImpl,
        apiKey: opts.apiKey,
        abortSignal: serverCtrl.signal,
        customExecutor: opts.customResearchExecutor,
      });
      researchPkg = research.package;
    }

    const latestBp = track
      ? getLatestCurriculumBlueprintFromDb(track.id)
      : null;
    const bpVersion = track?.blueprintVersion ?? latestBp?.version ?? 1;
    const neighborhood = track
      ? resolveGraphNeighborsForLesson(track.units, lesson.id, {
          blueprintVersion: bpVersion,
          mastery: store.mastery,
        })
      : resolveGraphNeighborsForLesson([lesson], lesson.id, {
          blueprintVersion: bpVersion,
          mastery: store.mastery,
        });

    transition("validating", {
      patchContext: {
        researchPackageId: researchPkg.id,
        blueprintVersion: bpVersion,
      },
    });

    const lessonContent = await generateStructuredLessonContent({
      lesson,
      trackId: track?.id ?? opts.trackId ?? null,
      blueprintId: latestBp?.blueprintId ?? track?.blueprintId ?? null,
      blueprintVersion: bpVersion,
      contract: neighborhood?.contract ?? lesson.contract,
      graphNeighborhood: neighborhood,
      depth: opts.depth || "standard",
      researchPackage: researchPkg,
      profile,
      identity: { workflowId, trackId: track?.id, lessonId: lesson.id },
      model: opts.model,
      modelLabel: opts.modelLabel,
      providerName: opts.providerName,
      abortSignal: serverCtrl.signal,
      customExecutor: opts.customLessonExecutor,
      forceRefresh: opts.forceRefresh,
    });

    // Honest status mapping: NEVER label a failed or limited lesson as `ready`!
    const contentState: LessonWorkflowState =
      lessonContent.status === "ready"
        ? "ready"
        : lessonContent.status === "limited"
          ? "limited"
          : "failed";
    let workflow = transition(contentState, {
      patchContext: {
        contentId: lessonContent.contentId,
        qualityScore: lessonContent.qualityReport.overallScore,
      },
    });

    let initialDecision: TeachingDecision | undefined;
    if (opts.includeTeachingDecision && contentState !== "failed") {
      const { session } = startLearningSession({
        lessonId: lesson.id,
        trackId: track?.id,
        day,
      });
      const attempts = listAttemptsForLesson(lesson.id).slice(0, 5);
      const prereqsMet = available(store, lesson);
      const missingPrereqs = getMissingPrerequisites(store, lesson).map(
        (m) => m.title,
      );
      const mastery = store.mastery[lesson.id] ?? 0;
      const meta = store.masteryMeta?.[lesson.id];

      initialDecision = await runTeachingPlanner({
        context: {
          goalId: track?.id || "local-goal",
          trackId: track?.id,
          lessonId: lesson.id,
          lessonTitle: lesson.title,
          learningSessionId: session.learning_session_id,
          currentOutcome: lesson.objective || lesson.title,
          knowledgeContext: {
            concept: lesson.concept,
            objective: lesson.objective,
            completionCriteria: lesson.completionCriteria,
            hasPreparedContent: lessonContent.status === "ready",
            missingPrerequisites: missingPrereqs,
            contract: neighborhood?.contract ?? lesson.contract,
            nextLessonTitle:
              neighborhood?.directSuccessors[0]?.title ||
              neighborhood?.laterUnits[0]?.title,
            trackPosition: neighborhood
              ? `${neighborhood.positionIndex}/${neighborhood.totalUnits}`
              : undefined,
          },
          learnerEvidence: {
            recentAttempts: attempts.map((a) => ({
              attemptId: a.attempt_id,
              correct: a.correct,
              score: a.score,
              errorType: a.error_type,
              feedback: a.feedback,
            })),
            misconceptions: attempts
              .filter((a) => !a.correct && a.feedback)
              .map((a) => a.feedback),
            masteryEstimate: mastery,
            masteryOrigin: meta?.masteryOrigin,
            consecutiveFailures: meta?.consecutiveFailures ?? 0,
          },
          prerequisitesMet: prereqsMet,
          userRequest: opts.userRequest,
          availableCapabilities:
            opts.availableCapabilities || DEFAULT_LEARNOS_CAPABILITIES,
          availableMinutes: opts.availableMinutes,
        },
        lesson,
        identity: {
          workflowId,
          trackId: track?.id,
          lessonId: lesson.id,
          learningSessionId: session.learning_session_id,
        },
        model: opts.model,
        modelLabel: opts.modelLabel,
        providerName: opts.providerName,
        webProvider: opts.webProvider,
        abortSignal: serverCtrl.signal,
        customExecutor: opts.customTeachingExecutor,
      });

      const nextState: LessonWorkflowState =
        initialDecision.action === "remediate"
          ? "remediation_needed"
          : initialDecision.action === "assess"
            ? "assessing"
            : initialDecision.action === "guided_practice" ||
                initialDecision.action === "independent_practice"
              ? "practicing"
              : "learning";
      workflow = transition(nextState, {
        patchContext: { latestDecisionId: initialDecision.decisionId },
      });
    }

    return {
      workflow,
      lessonContent,
      initialDecision,
      stateHistory,
    };
  } catch (err) {
    const isCancelled =
      serverCtrl.signal.aborted ||
      (err instanceof Error &&
        (err.message === "TASK_ABORTED" || err.name === "AbortError"));
    transition(isCancelled ? "cancelled" : "failed", {
      lastError: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    unregisterServerTaskController(workflowId);
    activeWorkflowKeys.delete(dedupeKey);
  }
}

export function cancelWorkflowById(workflowId: string): {
  cancelledInProcess: boolean;
  workflow: AgentWorkflowRow | null;
} {
  const cancelledInProcess = cancelServerTask(workflowId);
  const existing = getAgentWorkflowFromDb(workflowId);
  if (existing && !["ready_to_learn", "completed", "failed", "cancelled"].includes(existing.state)) {
    const updated = upsertAgentWorkflowInDb({
      workflowId: existing.workflowId,
      kind: existing.kind,
      state: "cancelled",
      goalId: existing.goalId,
      trackId: existing.trackId,
      lessonId: existing.lessonId,
      input: existing.input,
      context: existing.context,
      lastError: "用户手动取消工作流",
    });
    return { cancelledInProcess, workflow: updated };
  }
  return { cancelledInProcess, workflow: existing };
}

export function listRecentWorkflows(limit = 20): AgentWorkflowRow[] {
  ensureBootTaskHygiene();
  return listAgentWorkflowsFromDb(limit);
}
