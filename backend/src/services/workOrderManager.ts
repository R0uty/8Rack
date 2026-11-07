import { randomUUID } from "node:crypto";
import { listMissionIds, readMissionJson, writeMissionJson } from "./missionStore.js";
import { onMissionDeleted } from "./missionManager.js";
import {
  cancelTask as cancelOrchestratorTask,
  createTask as createOrchestratorTask,
  getTask,
  resumeTask as resumeOrchestratorTask,
} from "./orchestrator.js";
import { getExecution } from "./toolManager.js";
import type { ChunkListener, OrchestratorTask } from "./orchestrator.js";
import { logActivity } from "./activityLog.js";
import { InvalidTaskStateError, InvalidWorkOrderStateError, RequestCancelledError, WorkOrderNotFoundError } from "./errors.js";
import type { WorkOrder, WorkOrderCreateInput } from "../types/workOrder.js";

/**
 * Security Work Orders - a unit of factory work assigned to one agent. Starting one creates a real
 * single-agent OrchestratorTask via services/orchestrator.ts (the exact reuse pattern
 * multiAgentOrchestrator.ts#createPlan already uses for a plan's first step) - no separate execution
 * mechanism, no duplicated tool-call/confirmation loop.
 */

const workOrders = new Map<string, WorkOrder>();
const WORK_ORDERS_FILE = "work-orders.json";

function missionWorkOrders(missionId: string): WorkOrder[] {
  return [...workOrders.values()].filter((w) => w.missionId === missionId).sort((a, b) => b.createdAt - a.createdAt);
}

async function persistWorkOrders(missionId: string): Promise<void> {
  await writeMissionJson(missionId, WORK_ORDERS_FILE, missionWorkOrders(missionId));
}

// See missionManager.ts#onMissionDeleted - a deleted mission's work orders must stop returning, and
// a still-running one's underlying task is already aborted by orchestrator.ts's own independently-
// registered handler (same projectId->missionId, same pattern multiAgentOrchestrator.ts's plans use).
onMissionDeleted((missionId) => {
  for (const [id, wo] of workOrders) {
    if (wo.missionId === missionId) workOrders.delete(id);
  }
});

/** Hydrates in-memory work orders from disk - called once at server startup so history survives a
 * restart, mirrors every other mission-scoped store's own load function. */
export async function loadWorkOrdersFromDisk(): Promise<void> {
  const missionIds = await listMissionIds();
  for (const missionId of missionIds) {
    const onDisk = await readMissionJson<WorkOrder>(missionId, WORK_ORDERS_FILE);
    for (const wo of onDisk) {
      // Loaded after tasks (see index.ts). A "running" order's driver died with the old process: its
      // task already says how that ended, and without a task it never really started.
      if (wo.status === "running") {
        const task = wo.orchestratorTaskId ? getTask(wo.orchestratorTaskId) : undefined;
        if (task) syncFromTask(wo, task);
        else resetToPending(wo);
      }
      workOrders.set(wo.id, wo);
    }
  }
}

export async function createWorkOrder(missionId: string, input: WorkOrderCreateInput): Promise<WorkOrder> {
  const wo: WorkOrder = {
    id: randomUUID(),
    missionId,
    agentId: input.agentId,
    objective: input.objective,
    target: input.target,
    status: "pending",
    priority: input.priority ?? 0,
    dependencies: input.dependencies ?? [],
    createdAt: Date.now(),
    relatedAssets: input.relatedAssets ?? [],
    relatedFindings: input.relatedFindings ?? [],
  };
  workOrders.set(wo.id, wo);
  await persistWorkOrders(missionId);
  await logActivity(missionId, "work_order_created", `Work order created for ${wo.agentId}: ${wo.objective}`, {
    workOrderId: wo.id,
    agentId: wo.agentId,
  });
  return wo;
}

/** True once every id in `dependencies` refers to a WorkOrder that has itself reached "completed" -
 * an unknown/deleted dependency id is treated as unmet (fails closed) rather than silently ignored. */
export function dependenciesSatisfied(wo: WorkOrder): boolean {
  return wo.dependencies.every((depId) => workOrders.get(depId)?.status === "completed");
}

/** Maps an OrchestratorTask's status onto the WorkOrder vocabulary - mirrors
 * multiAgentOrchestrator.ts#continueAfterStepTask's own task-status mapping one level up.
 * "waiting_guidance" (a failed tool request/execution needing a human note) is folded into
 * "waiting_approval" too - from a WorkOrder's-eye view both are "needs a human before this can keep
 * going", and the underlying task transcript still has the exact distinction for anyone drilling in. */
function statusFromTask(taskStatus: OrchestratorTask["status"]): WorkOrder["status"] {
  switch (taskStatus) {
    case "waiting_confirmation":
    case "waiting_guidance":
      return "waiting_approval";
    case "completed":
      return "completed";
    case "running":
      return "running";
    case "cancelled":
      return "cancelled";
    default: // failed / max_executions_reached / max_time_reached
      return "failed";
  }
}

function isTerminal(status: WorkOrder["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function syncFromTask(wo: WorkOrder, task: OrchestratorTask): WorkOrder {
  wo.status = statusFromTask(task.status);
  wo.orchestratorTaskId = task.id;
  if (isTerminal(wo.status)) {
    wo.completedAt ??= Date.now();
    wo.result = task.finalResponse ?? task.error;
  }
  return wo;
}

function resetToPending(wo: WorkOrder): void {
  wo.status = "pending";
  wo.orchestratorTaskId = undefined;
  wo.startedAt = undefined;
}

/** Logs work_order_completed/failed exactly once, the moment a work order actually transitions
 * into one of those terminal statuses - called after every syncFromTask (startWorkOrder and
 * refreshWorkOrder alike), comparing against the status it had right before that sync. */
async function logTerminalTransition(missionId: string, workOrderId: string, previousStatus: WorkOrder["status"], wo: WorkOrder): Promise<void> {
  if (wo.status === previousStatus) return;
  if (wo.status === "completed") {
    await logActivity(missionId, "work_order_completed", `Work order completed: ${wo.objective}`, { workOrderId });
  } else if (wo.status === "failed") {
    await logActivity(missionId, "work_order_failed", `Work order failed: ${wo.objective}`, { workOrderId, result: wo.result });
  }
}

/** Starts a pending work order by creating a real OrchestratorTask for it - throws
 * InvalidWorkOrderStateError if the work order isn't "pending" or has unmet dependencies. */
export async function startWorkOrder(id: string, onChunk?: ChunkListener, signal?: AbortSignal): Promise<WorkOrder> {
  const wo = workOrders.get(id);
  if (!wo) throw new WorkOrderNotFoundError(id);
  if (wo.status !== "pending") {
    throw new InvalidWorkOrderStateError(`Work order "${id}" is not pending (status: ${wo.status})`);
  }
  if (!dependenciesSatisfied(wo)) {
    throw new InvalidWorkOrderStateError(`Work order "${id}" has unmet dependencies`);
  }

  // Claimed before the first await, so a double-clicked Start or a second advance can't start this
  // order twice while the (minutes-long) first generation is still running.
  wo.status = "running";
  wo.startedAt = Date.now();
  const objective = wo.target ? `${wo.objective}\n\nTarget: ${wo.target}` : wo.objective;
  await persistWorkOrders(wo.missionId);
  await logActivity(wo.missionId, "work_order_started", `Work order started for ${wo.agentId}: ${wo.objective}`, {
    workOrderId: wo.id,
    agentId: wo.agentId,
  });

  let task: OrchestratorTask;
  try {
    task = await createOrchestratorTask(wo.agentId, objective, wo.missionId, onChunk, signal, undefined, (created) => {
      wo.orchestratorTaskId = created.id; // what lets cancelWorkOrder reach this generation mid-run
    });
  } catch (err) {
    if (wo.status === "running") {
      if (err instanceof RequestCancelledError) {
        // The client went away mid-generation (reload, closed tab) - not a verdict on the work.
        resetToPending(wo);
      } else {
        wo.status = "failed";
        wo.completedAt = Date.now();
        wo.result = err instanceof Error ? err.message : "Failed to start the work order's task";
        await logTerminalTransition(wo.missionId, wo.id, "running", wo);
      }
    }
    await persistWorkOrders(wo.missionId);
    throw err;
  }

  const result = syncFromTask(wo, task);
  await persistWorkOrders(wo.missionId);
  await logTerminalTransition(wo.missionId, wo.id, "running", result);
  return result;
}

/**
 * Continues a paused work order whose tool execution a human has since confirmed or rejected: feeds
 * the outcome back to its task's agent and runs that task's next step. A no-op while the execution
 * is still undecided or running, or the task is waiting on guidance instead (that's provided on the
 * task directly). This is what makes an approval actually lead anywhere - without it the agent never
 * sees its tool's output and the order sits at waiting_approval forever.
 */
export async function resumeWorkOrderIfReady(id: string, onChunk?: ChunkListener, signal?: AbortSignal): Promise<WorkOrder> {
  const wo = workOrders.get(id);
  if (!wo) throw new WorkOrderNotFoundError(id);
  if (wo.status !== "waiting_approval" || !wo.orchestratorTaskId) return wo;

  const task = getTask(wo.orchestratorTaskId);
  if (task?.status === "waiting_confirmation" && task.pendingExecutionId) {
    const execution = getExecution(task.pendingExecutionId);
    if (execution?.status === "pending_confirmation" || execution?.status === "running") return wo;

    wo.status = "running"; // claimed before the first await, same as startWorkOrder
    try {
      await resumeOrchestratorTask(task.id, onChunk, signal);
    } catch (err) {
      if (err instanceof RequestCancelledError) {
        syncFromTask(wo, task);
        await persistWorkOrders(wo.missionId);
        throw err;
      }
      // InvalidTaskStateError: its execution record is gone (trimmed from history, or never survived
      // a restart), so the task can never continue. Either way, settle the order rather than leave
      // it stuck at "running" with nothing driving it.
      wo.status = "failed";
      wo.completedAt = Date.now();
      wo.result = err instanceof Error ? err.message : "Failed to resume the work order's task";
      await persistWorkOrders(wo.missionId);
      await logTerminalTransition(wo.missionId, wo.id, "running", wo);
      if (!(err instanceof InvalidTaskStateError)) throw err;
      return wo;
    }
    syncFromTask(wo, task);
    await persistWorkOrders(wo.missionId);
    await logTerminalTransition(wo.missionId, wo.id, "running", wo);
    return wo;
  }
  return refreshWorkOrder(id);
}

/** True when a paused order is waiting on a human's note rather than a pending approval - its tool run
 * failed, so the Approval Queue has nothing to show for it and advancing alone can't move it. */
export function workOrderNeedsGuidance(wo: WorkOrder): boolean {
  return wo.status === "waiting_approval" && !!wo.orchestratorTaskId && getTask(wo.orchestratorTaskId)?.status === "waiting_guidance";
}

/** Re-syncs a running/waiting work order's status from its underlying OrchestratorTask - call after
 * confirming/rejecting/resuming that task's pending tool execution via the existing
 * POST /api/tools/executions/:id/confirm|reject + POST /api/orchestrator/tasks/:id/resume routes,
 * the same follow-up every other task-backed flow in this app already requires. A no-op (returns the
 * work order unchanged) if it was never started or its task can't be found. */
export async function refreshWorkOrder(id: string): Promise<WorkOrder> {
  const wo = workOrders.get(id);
  if (!wo) throw new WorkOrderNotFoundError(id);
  if (!wo.orchestratorTaskId) return wo;
  const task = getTask(wo.orchestratorTaskId);
  // A cancelled order stays cancelled - its task may still be settling from the abort.
  if (!task || wo.status === "cancelled") return wo;
  const previousStatus = wo.status;
  const result = syncFromTask(wo, task);
  workOrders.set(result.id, result);
  await persistWorkOrders(wo.missionId);
  await logTerminalTransition(wo.missionId, wo.id, previousStatus, result);
  return result;
}

export function cancelWorkOrder(id: string): WorkOrder {
  const wo = workOrders.get(id);
  if (!wo) throw new WorkOrderNotFoundError(id);
  if (isTerminal(wo.status)) {
    throw new InvalidWorkOrderStateError(`Work order "${id}" has already finished (status: ${wo.status})`);
  }
  if (wo.orchestratorTaskId) {
    try {
      cancelOrchestratorTask(wo.orchestratorTaskId);
    } catch {
      // Already finished, or never actually started running - nothing to cancel.
    }
  }
  wo.status = "cancelled";
  wo.completedAt = Date.now();
  // Fire-and-forget: same synchronous-route tradeoff as orchestrator.ts#cancelTask/
  // multiAgentOrchestrator.ts#cancelPlan.
  void persistWorkOrders(wo.missionId).catch((err) => console.error("[workOrderManager] persist failed:", err));
  return wo;
}

export function getWorkOrder(id: string): WorkOrder | undefined {
  return workOrders.get(id);
}

export function listWorkOrders(missionId: string): WorkOrder[] {
  return missionWorkOrders(missionId);
}
