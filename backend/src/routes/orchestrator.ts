import { Router } from "express";
import { RequestCancelledError } from "../services/errors.js";
import {
  cancelTask,
  continueTask,
  createTask,
  getTask,
  listTasks,
  provideGuidance,
  resumeTask,
} from "../services/orchestrator.js";
import { abortOnClientDisconnect } from "./streamUtils.js";
import type { Response } from "express";
import type { OrchestratorTask } from "../services/orchestrator.js";

export const orchestratorRouter = Router();

interface CreateTaskBody {
  agentId?: unknown;
  objective?: unknown;
  missionId?: unknown;
  model?: unknown;
}

/**
 * Streams the agent's reply text as it's generated (NDJSON lines of {type:"chunk", content}) so
 * the UI can show live "thinking" output, then a final {type:"task", task} line once the step
 * settles (tool request, final answer, or terminal status). Mirrors the confirm-execution stream
 * in routes/tools.ts: headers aren't sent until the first write, so an error raised before any
 * agent output (e.g. AgentNotFoundError) still reaches the error middleware as normal JSON.
 */
async function runAndStreamTask(
  res: Response,
  next: (err: unknown) => void,
  run: (onChunk: (content: string) => void, signal: AbortSignal) => Promise<OrchestratorTask>,
): Promise<void> {
  const controller = abortOnClientDisconnect(res);
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");

  try {
    const task = await run((content) => {
      res.write(`${JSON.stringify({ type: "chunk", content })}\n`);
    }, controller.signal);
    res.write(`${JSON.stringify({ type: "task", task })}\n`);
    res.end();
  } catch (err) {
    if (err instanceof RequestCancelledError) {
      res.end();
      return;
    }
    if (!res.headersSent) {
      next(err);
      return;
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    res.write(`${JSON.stringify({ type: "error", error: message })}\n`);
    res.end();
  }
}

orchestratorRouter.post("/tasks", async (req, res, next) => {
  const body = req.body as CreateTaskBody;
  if (typeof body.agentId !== "string" || !body.agentId.trim()) {
    res.status(400).json({ error: "agentId is required", code: "INVALID_REQUEST" });
    return;
  }
  if (typeof body.objective !== "string" || !body.objective.trim()) {
    res.status(400).json({ error: "objective is required", code: "INVALID_REQUEST" });
    return;
  }
  if (typeof body.missionId !== "string" || !body.missionId.trim()) {
    res.status(400).json({ error: "missionId is required", code: "INVALID_REQUEST" });
    return;
  }
  if (body.model !== undefined && typeof body.model !== "string") {
    res.status(400).json({ error: "model must be a string", code: "INVALID_REQUEST" });
    return;
  }
  await runAndStreamTask(res, next, (onChunk, signal) =>
    createTask(
      body.agentId as string,
      body.objective as string,
      body.missionId as string,
      onChunk,
      signal,
      body.model as string | undefined,
    ),
  );
});

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

orchestratorRouter.post("/tasks/:id/resume", async (req, res, next) => {
  await runAndStreamTask(res, next, (onChunk, signal) => resumeTask(req.params.id, onChunk, signal));
});

orchestratorRouter.post("/tasks/:id/continue", async (req, res, next) => {
  const body = req.body as { message?: unknown };
  if (typeof body.message !== "string" || !body.message.trim()) {
    res.status(400).json({ error: "message is required", code: "INVALID_REQUEST" });
    return;
  }
  await runAndStreamTask(res, next, (onChunk, signal) => continueTask(req.params.id, body.message as string, onChunk, signal));
});

orchestratorRouter.post("/tasks/:id/guidance", async (req, res, next) => {
  const body = req.body as { note?: unknown };
  if (body.note !== undefined && typeof body.note !== "string") {
    res.status(400).json({ error: "note must be a string", code: "INVALID_REQUEST" });
    return;
  }
  await runAndStreamTask(res, next, (onChunk, signal) =>
    provideGuidance(req.params.id, body.note as string | undefined, onChunk, signal),
  );
});

orchestratorRouter.post("/tasks/:id/cancel", (req, res, next) => {
  try {
    res.json({ task: cancelTask(req.params.id) });
  } catch (err) {
    next(err);
  }
});
