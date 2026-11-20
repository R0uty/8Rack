import { advanceMission, type FactoryAdvanceResult } from "./factoryDirector.js";
import { publishMission } from "./missionEvents.js";
import { getTask, provideGuidance, type ChunkListener } from "./orchestrator.js";
import { getExecution } from "./toolManager.js";
import {
  dependenciesSatisfied,
  getWorkOrder,
  listWorkOrders,
  refreshWorkOrder,
  startWorkOrder,
  workOrderNeedsGuidance,
} from "./workOrderManager.js";
import { InvalidWorkOrderStateError, RunInProgressError, WorkOrderNotFoundError } from "./errors.js";
import type { MissionRunState } from "../types/missionRun.js";

/**
 * A mission's factory run, owned by the server. Before this, a run lived inside one streaming
 * POST /factory/advance: closing the tab aborted the generation, nothing stopped two tabs advancing
 * the same mission, and the reason a run stopped was lost on reload. Now a run is started here and
 * reported through missionEvents (GET /api/missions/:id/events); the HTTP request that starts it
 * returns at once.
 *
 * One run per mission. A tool run settling (approved and finished, or rejected) asks the mission to
 * resume: it starts a run if none is going, or makes the current run advance once more before it
 * stops, since that run may already be past the point where it looks at waiting orders.
 */
interface Run {
  state: MissionRunState;
  controller?: AbortController;
  /** Set when a waiting order became resumable while this run was going. */
  resumeRequested: boolean;
}

/** Work done before the Director's own advance - starting one order by hand, or sending guidance. */
type RunStep = (ctx: { onChunk: ChunkListener; signal: AbortSignal; setWorkOrder: (id: string) => void }) => Promise<void>;

const runs = new Map<string, Run>();

function getRun(missionId: string): Run {
  let run = runs.get(missionId);
  if (!run) {
    run = { state: { missionId, status: "idle", updatedAt: Date.now() }, resumeRequested: false };
    runs.set(missionId, run);
  }
  return run;
}

function setState(run: Run, patch: Omit<MissionRunState, "missionId" | "updatedAt" | "startedAt">): void {
  run.state = { missionId: run.state.missionId, startedAt: run.state.startedAt, ...patch, updatedAt: Date.now() };
  publishMission(run.state.missionId, { type: "run_state", run: run.state });
}

export function getRunState(missionId: string): MissionRunState {
  return runs.get(missionId)?.state ?? { missionId, status: "idle", updatedAt: Date.now() };
}

export function isRunning(missionId: string): boolean {
  return runs.get(missionId)?.state.status === "running";
}

/** What the run stopped on, from the Director's result plus anything still parked on approval. */
function settledState(missionId: string, result: FactoryAdvanceResult): Omit<MissionRunState, "missionId" | "updatedAt" | "startedAt"> {
  const wo = result.workOrder;
  if (wo && workOrderNeedsGuidance(wo)) return { status: "waiting_guidance", workOrderId: wo.id, reason: result.blockedReason };
  if (result.blockedReason) return { status: "blocked", workOrderId: wo?.id, reason: result.blockedReason };
  const waiting = wo?.status === "waiting_approval" ? wo : listWorkOrders(missionId).find((o) => o.status === "waiting_approval");
  if (waiting) {
    return workOrderNeedsGuidance(waiting)
      ? { status: "waiting_guidance", workOrderId: waiting.id, reason: `${waiting.agentId}'s last tool request failed and it needs a note before it can continue.` }
      : { status: "waiting_approval", workOrderId: waiting.id };
  }
  return { status: "idle" };
}

async function execute(run: Run, controller: AbortController, step?: RunStep): Promise<void> {
  const { missionId } = run.state;
  const { signal } = controller;
  const setWorkOrder = (id: string) => {
    if (run.state.workOrderId !== id) setState(run, { status: "running", workOrderId: id });
  };
  const onChunk: ChunkListener = (content) => publishMission(missionId, { type: "chunk", workOrderId: run.state.workOrderId, content });

  try {
    if (step) await step({ onChunk, signal, setWorkOrder });
    let result: FactoryAdvanceResult;
    do {
      run.resumeRequested = false;
      result = await advanceMission(missionId, onChunk, signal, setWorkOrder);
    } while (run.resumeRequested && !signal.aborted);
    run.controller = undefined;
    setState(run, settledState(missionId, result));
  } catch (err) {
    run.controller = undefined;
    if (signal.aborted) {
      setState(run, { status: "blocked", reason: "Stopped. Advance again to continue." });
    } else {
      console.error(`[missionRunner] run for mission "${missionId}" failed:`, err);
      setState(run, { status: "blocked", workOrderId: run.state.workOrderId, reason: err instanceof Error ? err.message : "The run failed." });
    }
  }
}

/** Starts a run in the background and returns its state. Throws RunInProgressError if one is going. */
function beginRun(missionId: string, step?: RunStep): MissionRunState {
  const run = getRun(missionId);
  if (run.state.status === "running") throw new RunInProgressError(missionId);
  const controller = new AbortController();
  run.controller = controller;
  run.resumeRequested = false;
  run.state = { missionId, status: "running", startedAt: Date.now(), updatedAt: Date.now() };
  publishMission(missionId, { type: "run_state", run: run.state });
  void execute(run, controller, step);
  return run.state;
}

/** POST /factory/advance. */
export function startRun(missionId: string): MissionRunState {
  return beginRun(missionId);
}

/** Starts one pending order by hand (Retry in Work Orders), then lets the Director carry on. */
export function startWorkOrderRun(missionId: string, workOrderId: string): MissionRunState {
  const wo = getWorkOrder(workOrderId);
  if (!wo || wo.missionId !== missionId) throw new WorkOrderNotFoundError(workOrderId);
  if (wo.status !== "pending") throw new InvalidWorkOrderStateError(`Work order "${workOrderId}" is not pending (status: ${wo.status})`);
  if (!dependenciesSatisfied(wo)) throw new InvalidWorkOrderStateError(`Work order "${workOrderId}" has unmet dependencies`);
  return beginRun(missionId, async ({ onChunk, signal, setWorkOrder }) => {
    setWorkOrder(workOrderId);
    await startWorkOrder(workOrderId, onChunk, signal);
  });
}

/** Sends a human's note to an order paused on a failed tool request, then lets the Director carry on. */
export function guideWorkOrderRun(missionId: string, workOrderId: string, note?: string): MissionRunState {
  const wo = getWorkOrder(workOrderId);
  if (!wo || wo.missionId !== missionId) throw new WorkOrderNotFoundError(workOrderId);
  if (!workOrderNeedsGuidance(wo) || !wo.orchestratorTaskId) {
    throw new InvalidWorkOrderStateError(`Work order "${workOrderId}" is not waiting on guidance (status: ${wo.status})`);
  }
  const taskId = wo.orchestratorTaskId;
  return beginRun(missionId, async ({ onChunk, signal, setWorkOrder }) => {
    setWorkOrder(workOrderId);
    await provideGuidance(taskId, note, onChunk, signal);
    await refreshWorkOrder(workOrderId);
  });
}

/** POST /factory/stop. Aborts the generation in progress; its order goes back to pending. A tool
 * that is already running is not touched - it has its own Cancel. */
export function stopRun(missionId: string): MissionRunState {
  const run = runs.get(missionId);
  run?.controller?.abort();
  return getRunState(missionId);
}

/** A tool run settled (finished, failed, cancelled or rejected). If a work order of this mission was
 * waiting on it, resume the mission's run. */
export function resumeAfterExecution(executionId: string): void {
  const execution = getExecution(executionId);
  if (!execution?.missionId) return;
  const missionId = execution.missionId;
  const waiting = listWorkOrders(missionId).some(
    (wo) => wo.status === "waiting_approval" && !!wo.orchestratorTaskId && getTask(wo.orchestratorTaskId)?.pendingExecutionId === executionId,
  );
  if (!waiting) return;
  const run = getRun(missionId);
  if (run.state.status === "running") {
    run.resumeRequested = true;
    return;
  }
  beginRun(missionId);
}

/** For tests. */
export function resetRunsForTests(): void {
  runs.clear();
}
