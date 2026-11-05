import { randomUUID } from "node:crypto";
import { getAgent } from "./agentManager.js";
import {
  cancelTask as cancelOrchestratorTask,
  createTask as createOrchestratorTask,
  provideGuidance as provideOrchestratorGuidance,
  resumeTask as resumeOrchestratorTask,
} from "./orchestrator.js";
import type { ChunkListener, OrchestratorTask } from "./orchestrator.js";
import { listMissionIds, readMissionJson, writeMissionJson } from "./missionStore.js";
import { onMissionDeleted } from "./missionManager.js";
import { InvalidPlanStateError, PlanNotFoundError, RequestCancelledError } from "./errors.js";
import type { MultiAgentPlan, PlanStep, PlanStepRun } from "../types/orchestration.js";

/**
 * Multi-agent orchestration: a user-authored, ordered list of {agent, objective} steps run
 * sequentially, where each step is a full single-agent Orchestrator task (services/orchestrator.ts)
 * - so a step can request tools and pause for the exact same human confirmation flow a standalone
 * task uses, and each step's final answer feeds into the next step's objective as context. This is
 * the pause/resume state machine one level up from orchestrator.ts's own, mirroring its shape.
 */

const plans = new Map<string, MultiAgentPlan>();
const PLANS_FILE = "multi-agent-plans.json";

function missionPlans(missionId: string): MultiAgentPlan[] {
  return [...plans.values()].filter((p) => p.missionId === missionId).sort((a, b) => b.createdAt - a.createdAt);
}

async function persistPlans(missionId: string): Promise<void> {
  await writeMissionJson(missionId, PLANS_FILE, missionPlans(missionId));
}

// See missionManager.ts#onMissionDeleted. A plan's current-step task is a real entry in
// orchestrator.ts's own `tasks` map (same missionId) and is aborted by that module's own,
// independently-registered handler - this just stops the plan record itself from lingering.
onMissionDeleted((missionId) => {
  for (const [id, plan] of plans) {
    if (plan.missionId === missionId) plans.delete(id);
  }
});

/** Hydrates in-memory plans from disk - called once at server startup so plan history survives a
 * restart instead of only being written-through from that point on. */
export async function loadPlansFromDisk(): Promise<void> {
  const missionIds = await listMissionIds();
  for (const missionId of missionIds) {
    const missionPlansOnDisk = await readMissionJson<MultiAgentPlan>(missionId, PLANS_FILE);
    for (const plan of missionPlansOnDisk) {
      // Same as orchestrator.ts#loadTasksFromDisk - nothing is driving a "running" plan any more.
      if (plan.status === "running") {
        plan.status = "failed";
        plan.error = "The backend restarted while this plan was running.";
      }
      plans.set(plan.id, plan);
    }
  }
}

function touch(plan: MultiAgentPlan): void {
  plan.updatedAt = Date.now();
}

function snapshotRun(run: PlanStepRun, task: OrchestratorTask): void {
  run.status = task.status;
  run.finalResponse = task.finalResponse;
}

/** Every prior step's final response, labeled by agent name, prepended to a step's own authored
 * objective - so e.g. a Report Writer step actually sees what Recon Agent/Output Parser produced,
 * not just its own instructions in isolation. */
async function buildStepObjective(plan: MultiAgentPlan, step: PlanStep): Promise<string> {
  const context = await Promise.all(
    plan.stepRuns.map(async (run, i) => {
      const agent = await getAgent(run.agentId);
      const label = agent?.name ?? run.agentId;
      return `### Step ${i + 1} — ${label}\n${run.finalResponse ?? "(no output)"}`;
    }),
  );
  return `${context.join("\n\n")}\n\n---\n\nYour task: ${step.objective}`;
}

/** Advances the plan after one of its step tasks just settled - mirrors orchestrator.ts#advance's
 * own recursion, one level up: a step that completes without pausing chains straight into starting
 * the next one, so a plan can run start-to-finish in one call when nothing needs confirmation. */
async function continueAfterStepTask(
  plan: MultiAgentPlan,
  task: OrchestratorTask,
  onChunk?: ChunkListener,
  signal?: AbortSignal,
): Promise<MultiAgentPlan> {
  const currentRun = plan.stepRuns[plan.currentStepIndex];
  snapshotRun(currentRun, task);

  if (task.status === "waiting_confirmation") {
    plan.status = "waiting_confirmation";
    touch(plan);
    return plan;
  }

  if (task.status === "waiting_guidance") {
    // A step's tool request failed outright, or ran and failed - same pause orchestrator.ts uses
    // for a standalone task (see provideGuidance there). The whole plan pauses here too rather
    // than being misclassified as failed by the fallback branch below - resumed via
    // provideStepGuidance.
    plan.status = "waiting_guidance";
    touch(plan);
    return plan;
  }

  if (task.status === "completed") {
    if (plan.currentStepIndex + 1 >= plan.steps.length) {
      plan.status = "completed";
      touch(plan);
      return plan;
    }

    plan.currentStepIndex++;
    const nextStep = plan.steps[plan.currentStepIndex];
    const objective = await buildStepObjective(plan, nextStep);
    const nextTask = await createOrchestratorTask(nextStep.agentId, objective, plan.missionId, onChunk, signal);
    plan.stepRuns.push({
      agentId: nextStep.agentId,
      objective,
      orchestratorTaskId: nextTask.id,
      status: nextTask.status,
      finalResponse: nextTask.finalResponse,
    });
    touch(plan);
    return continueAfterStepTask(plan, nextTask, onChunk, signal);
  }

  // failed / cancelled / max_executions_reached / max_time_reached - the whole plan stops here.
  plan.status = task.status === "cancelled" ? "cancelled" : "failed";
  plan.error = task.error ?? `Step ${plan.currentStepIndex + 1} ended with status "${task.status}"`;
  touch(plan);
  return plan;
}

/** A step that throws (e.g. its agent was deleted between steps) must still settle the plan, not
 * leave it at "running" forever. */
function settleThrownPlan(plan: MultiAgentPlan, err: unknown): void {
  if (err instanceof RequestCancelledError) {
    plan.status = "cancelled";
  } else {
    plan.status = "failed";
    plan.error = err instanceof Error ? err.message : "Plan step failed";
  }
  touch(plan);
}

export async function createPlan(
  missionId: string,
  description: string,
  steps: PlanStep[],
  onChunk?: ChunkListener,
  signal?: AbortSignal,
): Promise<MultiAgentPlan> {
  const plan: MultiAgentPlan = {
    id: randomUUID(),
    missionId,
    description,
    steps,
    stepRuns: [],
    currentStepIndex: 0,
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  plans.set(plan.id, plan);

  try {
    const firstStep = steps[0];
    const task = await createOrchestratorTask(firstStep.agentId, firstStep.objective, missionId, onChunk, signal);
    plan.stepRuns.push({
      agentId: firstStep.agentId,
      objective: firstStep.objective,
      orchestratorTaskId: task.id,
      status: task.status,
      finalResponse: task.finalResponse,
    });
    const result = await continueAfterStepTask(plan, task, onChunk, signal);
    await persistPlans(plan.missionId);
    return result;
  } catch (err) {
    settleThrownPlan(plan, err);
    await persistPlans(plan.missionId).catch(() => {});
    throw err;
  }
}

/**
 * Call once the current step's pending execution has been confirmed or rejected via the existing
 * POST /api/tools/executions/:id/confirm|reject endpoints. Resumes that step's underlying
 * Orchestrator task and continues the plan loop from there.
 */
export async function resumePlan(id: string, onChunk?: ChunkListener, signal?: AbortSignal): Promise<MultiAgentPlan> {
  const plan = plans.get(id);
  if (!plan) throw new PlanNotFoundError(id);
  if (plan.status !== "waiting_confirmation") {
    throw new InvalidPlanStateError(`Plan "${id}" is not waiting on a tool confirmation (status: ${plan.status})`);
  }

  const currentRun = plan.stepRuns[plan.currentStepIndex];
  plan.status = "running";
  try {
    const task = await resumeOrchestratorTask(currentRun.orchestratorTaskId, onChunk, signal);
    const result = await continueAfterStepTask(plan, task, onChunk, signal);
    await persistPlans(plan.missionId);
    return result;
  } catch (err) {
    settleThrownPlan(plan, err);
    await persistPlans(plan.missionId).catch(() => {});
    throw err;
  }
}

/**
 * Call once the current step's task has paused at "waiting_guidance" - a tool request that failed
 * outright, or a confirmed execution that came back failed/cancelled (see
 * orchestrator.ts#provideGuidance). An optional human note steers the step's agent before it tries
 * again; omitting it just lets it retry on its own.
 */
export async function provideStepGuidance(
  id: string,
  note?: string,
  onChunk?: ChunkListener,
  signal?: AbortSignal,
): Promise<MultiAgentPlan> {
  const plan = plans.get(id);
  if (!plan) throw new PlanNotFoundError(id);
  if (plan.status !== "waiting_guidance") {
    throw new InvalidPlanStateError(`Plan "${id}" is not waiting on guidance (status: ${plan.status})`);
  }

  const currentRun = plan.stepRuns[plan.currentStepIndex];
  plan.status = "running";
  try {
    const task = await provideOrchestratorGuidance(currentRun.orchestratorTaskId, note, onChunk, signal);
    const result = await continueAfterStepTask(plan, task, onChunk, signal);
    await persistPlans(plan.missionId);
    return result;
  } catch (err) {
    settleThrownPlan(plan, err);
    await persistPlans(plan.missionId).catch(() => {});
    throw err;
  }
}

export function cancelPlan(id: string): MultiAgentPlan {
  const plan = plans.get(id);
  if (!plan) throw new PlanNotFoundError(id);
  if (plan.status === "completed" || plan.status === "failed" || plan.status === "cancelled") {
    throw new InvalidPlanStateError(`Plan "${id}" has already finished (status: ${plan.status})`);
  }
  const currentRun = plan.stepRuns[plan.currentStepIndex];
  if (currentRun) {
    try {
      cancelOrchestratorTask(currentRun.orchestratorTaskId);
    } catch {
      // Already finished, rejected, or never started running - nothing to cancel.
    }
  }
  plan.status = "cancelled";
  touch(plan);
  // Fire-and-forget: cancelPlan stays synchronous (its route calls it inline) - same tradeoff as
  // orchestrator.ts#cancelTask/toolManager.ts's reject/cancel.
  void persistPlans(plan.missionId).catch((err) => console.error("[plans] persist failed:", err));
  return plan;
}

export function getPlan(id: string): MultiAgentPlan | undefined {
  return plans.get(id);
}

export function listPlans(missionId: string): MultiAgentPlan[] {
  return missionPlans(missionId);
}
