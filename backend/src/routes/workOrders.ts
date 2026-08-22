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
  try {
    const workOrder = await createWorkOrder(missionIdOf(req), {
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

missionWorkOrdersRouter.get("/:workOrderId", (req, res, next) => {
  const workOrder = getWorkOrder(req.params.workOrderId);
  if (!workOrder || workOrder.missionId !== missionIdOf(req)) {
    next(new WorkOrderNotFoundError(req.params.workOrderId));
    return;
  }
  res.json({ workOrder });
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
