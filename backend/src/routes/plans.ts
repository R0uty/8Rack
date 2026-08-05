import { Router } from "express";
import { RequestCancelledError } from "../services/errors.js";
import { getAgent } from "../services/agentManager.js";
import { getTask } from "../services/orchestrator.js";
import { cancelPlan, createPlan, getPlan, listPlans, resumePlan } from "../services/multiAgentOrchestrator.js";
import { abortOnClientDisconnect } from "./streamUtils.js";
import type { Response } from "express";
import type { MultiAgentPlan, PlanStep } from "../types/orchestration.js";

export const plansRouter = Router();

interface CreatePlanBody {
  projectId?: unknown;
  description?: unknown;
  steps?: unknown;
}

/** The standardized plan-step shape: at least 2 steps, each a non-blank {agentId, objective}. */
function isValidSteps(steps: unknown): steps is PlanStep[] {
  return (
    Array.isArray(steps) &&
    steps.length >= 2 &&
    steps.every(
      (s) =>
        s &&
        typeof s === "object" &&
        typeof (s as PlanStep).agentId === "string" &&
        (s as PlanStep).agentId.trim().length > 0 &&
        typeof (s as PlanStep).objective === "string" &&
        (s as PlanStep).objective.trim().length > 0,
    )
  );
}

function currentStepTaskFor(plan: MultiAgentPlan) {
  const run = plan.stepRuns[plan.currentStepIndex];
  return run ? getTask(run.orchestratorTaskId) : undefined;
}

/**
 * Streams a plan-advancing call (create/resume) as NDJSON, mirroring routes/orchestrator.ts's own
 * runAndStreamTask: {type:"chunk", content} per token from whichever step is currently generating,
 * then a terminal {type:"result", plan, currentStepTask} - the current step's live OrchestratorTask
 * is joined in server-side so the client never needs a second fetch to render it.
 */
async function runAndStreamPlan(
  res: Response,
  next: (err: unknown) => void,
  run: (onChunk: (content: string) => void, signal: AbortSignal) => Promise<MultiAgentPlan>,
): Promise<void> {
  const controller = abortOnClientDisconnect(res);
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");

  try {
    const plan = await run((content) => {
      res.write(`${JSON.stringify({ type: "chunk", content })}\n`);
    }, controller.signal);
    res.write(`${JSON.stringify({ type: "result", plan, currentStepTask: currentStepTaskFor(plan) })}\n`);
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

plansRouter.post("/", async (req, res, next) => {
  const body = req.body as CreatePlanBody;
  if (typeof body.projectId !== "string" || !body.projectId.trim()) {
    res.status(400).json({ error: "projectId is required", code: "INVALID_REQUEST" });
    return;
  }
  if (typeof body.description !== "string" || !body.description.trim()) {
    res.status(400).json({ error: "description is required", code: "INVALID_REQUEST" });
    return;
  }
  if (!isValidSteps(body.steps)) {
    res.status(400).json({
      error: "steps must be an array of at least 2 {agentId, objective} entries",
      code: "INVALID_REQUEST",
    });
    return;
  }

  // Checked up front (not just left to createOrchestratorTask's own AgentNotFoundError) so a
  // typo'd agent id fails fast instead of after earlier steps already did real work.
  const unknownAgentIds: string[] = [];
  for (const step of body.steps) {
    if (!(await getAgent(step.agentId))) unknownAgentIds.push(step.agentId);
  }
  if (unknownAgentIds.length) {
    res.status(400).json({ error: `Unknown agent(s): ${unknownAgentIds.join(", ")}`, code: "INVALID_REQUEST" });
    return;
  }

  const { projectId, description, steps } = body;
  await runAndStreamPlan(res, next, (onChunk, signal) => createPlan(projectId, description, steps, onChunk, signal));
});

plansRouter.get("/", (req, res) => {
  const { projectId } = req.query;
  if (typeof projectId !== "string" || !projectId.trim()) {
    res.status(400).json({ error: "projectId query parameter is required", code: "INVALID_REQUEST" });
    return;
  }
  res.json({ plans: listPlans(projectId) });
});

plansRouter.get("/:id", (req, res) => {
  const plan = getPlan(req.params.id);
  if (!plan) {
    res.status(404).json({ error: `Plan "${req.params.id}" was not found`, code: "PLAN_NOT_FOUND" });
    return;
  }
  res.json({ plan, currentStepTask: currentStepTaskFor(plan) });
});

plansRouter.post("/:id/resume", async (req, res, next) => {
  await runAndStreamPlan(res, next, (onChunk, signal) => resumePlan(req.params.id, onChunk, signal));
});

plansRouter.post("/:id/cancel", (req, res, next) => {
  try {
    res.json({ plan: cancelPlan(req.params.id) });
  } catch (err) {
    next(err);
  }
});
