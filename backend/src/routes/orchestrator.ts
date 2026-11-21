import { Router } from "express";
import { getTask, listTasks } from "../services/orchestrator.js";

/**
 * Read-only. Tasks are started, guided and cancelled through their work order
 * (routes/workOrders.ts) - the create/continue/resume/guidance/cancel routes that used to live here
 * started agent runs outside the work-order model and nothing called them (PLAN.md Phase 4).
 */
export const orchestratorRouter = Router();

orchestratorRouter.get("/tasks", (req, res) => {
  const { missionId } = req.query;
  if (typeof missionId !== "string" || !missionId.trim()) {
    res.status(400).json({ error: "missionId query parameter is required", code: "INVALID_REQUEST" });
    return;
  }
  res.json({ tasks: listTasks(missionId) });
});

orchestratorRouter.get("/tasks/:id", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: `Task "${req.params.id}" was not found`, code: "TASK_NOT_FOUND" });
    return;
  }
  res.json({ task });
});
