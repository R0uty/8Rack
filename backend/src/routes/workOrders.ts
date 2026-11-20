import { Router } from "express";
import {
  cancelWorkOrder,
  createWorkOrder,
  getWorkOrder,
  listWorkOrders,
  refreshWorkOrder,
  startWorkOrder,
} from "../services/workOrderManager.js";
import { WorkOrderNotFoundError } from "../services/errors.js";

interface CreateWorkOrderBody {
  agentId?: unknown;
  objective?: unknown;
  target?: unknown;
  priority?: unknown;
  dependencies?: unknown;
  relatedAssets?: unknown;
  relatedFindings?: unknown;
  retryOf?: unknown;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Mission-scoped Work Order routes - GET/POST /api/missions/:missionId/workorders[...]. MUST be
 * created with { mergeParams: true }, same requirement as routes/findings.ts's
 * missionFindingsRouter/routes/assets.ts's missionAssetsRouter. */
export const missionWorkOrdersRouter = Router({ mergeParams: true });

function missionIdOf(req: { params: Record<string, string> }): string {
  return req.params.missionId;
}

// Every :workOrderId route is checked against the mission in its own path - otherwise any order could
// be started or cancelled through any mission's URL.
missionWorkOrdersRouter.param("workOrderId", (req, _res, next, id: string) => {
  const workOrder = getWorkOrder(id);
  next(workOrder && workOrder.missionId === req.params.missionId ? undefined : new WorkOrderNotFoundError(id));
});

missionWorkOrdersRouter.get("/", (req, res) => {
  res.json({ workOrders: listWorkOrders(missionIdOf(req)) });
});

missionWorkOrdersRouter.post("/", async (req, res, next) => {
  const body = req.body as CreateWorkOrderBody;
  if (typeof body.agentId !== "string" || !body.agentId.trim()) {
    res.status(400).json({ error: "agentId is required", code: "INVALID_REQUEST" });
    return;
  }
  if (typeof body.objective !== "string" || !body.objective.trim()) {
    res.status(400).json({ error: "objective is required", code: "INVALID_REQUEST" });
    return;
  }
  if (body.target !== undefined && typeof body.target !== "string") {
    res.status(400).json({ error: "target must be a string", code: "INVALID_REQUEST" });
    return;
  }
  if (body.priority !== undefined && typeof body.priority !== "number") {
    res.status(400).json({ error: "priority must be a number", code: "INVALID_REQUEST" });
    return;
  }
  if (body.dependencies !== undefined && !isStringArray(body.dependencies)) {
    res.status(400).json({ error: "dependencies must be an array of strings", code: "INVALID_REQUEST" });
    return;
  }
  if (body.relatedAssets !== undefined && !isStringArray(body.relatedAssets)) {
    res.status(400).json({ error: "relatedAssets must be an array of strings", code: "INVALID_REQUEST" });
    return;
  }
  if (body.relatedFindings !== undefined && !isStringArray(body.relatedFindings)) {
    res.status(400).json({ error: "relatedFindings must be an array of strings", code: "INVALID_REQUEST" });
    return;
  }
  if (body.retryOf !== undefined) {
    const original = typeof body.retryOf === "string" ? getWorkOrder(body.retryOf) : undefined;
    if (!original || original.missionId !== missionIdOf(req)) {
      res.status(400).json({ error: "retryOf must be the id of a work order in this mission", code: "INVALID_REQUEST" });
      return;
    }
  }
  try {
    const workOrder = await createWorkOrder(missionIdOf(req), {
      retryOf: body.retryOf as string | undefined,
      agentId: body.agentId,
      objective: body.objective,
      target: body.target as string | undefined,
      priority: body.priority as number | undefined,
      dependencies: body.dependencies as string[] | undefined,
      relatedAssets: body.relatedAssets as string[] | undefined,
      relatedFindings: body.relatedFindings as string[] | undefined,
    });
    res.status(201).json({ workOrder });
  } catch (err) {
    next(err);
  }
});

missionWorkOrdersRouter.get("/:workOrderId", (req, res) => {
  res.json({ workOrder: getWorkOrder(req.params.workOrderId) });
});

missionWorkOrdersRouter.post("/:workOrderId/start", async (req, res, next) => {
  try {
    res.json({ workOrder: await startWorkOrder(req.params.workOrderId) });
  } catch (err) {
    next(err);
  }
});

/** Call after confirming/rejecting a running work order's pending tool execution, or after resuming
 * its underlying OrchestratorTask - re-syncs this work order's status from that task, same follow-up
 * every task-backed flow in this app already requires (see workOrderManager.ts#refreshWorkOrder). */
missionWorkOrdersRouter.post("/:workOrderId/refresh", async (req, res, next) => {
  try {
    res.json({ workOrder: await refreshWorkOrder(req.params.workOrderId) });
  } catch (err) {
    next(err);
  }
});

missionWorkOrdersRouter.post("/:workOrderId/cancel", (req, res, next) => {
  try {
    res.json({ workOrder: cancelWorkOrder(req.params.workOrderId) });
  } catch (err) {
    next(err);
  }
});
