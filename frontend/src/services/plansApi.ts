import type { OrchestratorTask } from "../types/orchestrator";
import type { MultiAgentPlan, PlanStep } from "../types/multiAgentPlan";
import { ApiError, apiFetch, readNdjsonStream, throwForErrorResponse } from "./httpClient";

interface PlanStreamLine {
  type: "chunk" | "result" | "error";
  content?: string;
  plan?: MultiAgentPlan;
  currentStepTask?: OrchestratorTask;
  error?: string;
}

export interface PlanStreamResult {
  plan: MultiAgentPlan;
  currentStepTask?: OrchestratorTask;
}

/**
 * Reads the NDJSON stream a plan-advancing endpoint (create/resume) responds with — mirrors
 * services/orchestratorApi.ts#streamTask, but the terminal line also carries the current step's
 * live OrchestratorTask (joined in server-side by routes/plans.ts) so there's no second fetch
 * needed to render it.
 */
async function streamPlan(
  res: Response,
  onChunk: (content: string) => void,
  signal?: AbortSignal,
): Promise<PlanStreamResult> {
  if (!res.ok) await throwForErrorResponse(res);

  let result: PlanStreamResult | undefined;
  await readNdjsonStream(res, (line) => {
    let parsed: PlanStreamLine;
    try {
      parsed = JSON.parse(line) as PlanStreamLine;
    } catch {
      throw new ApiError("Received an invalid response from the server", 502);
    }
    if (parsed.type === "error") throw new ApiError(parsed.error ?? "Plan step failed", 502);
    if (parsed.type === "chunk" && parsed.content) onChunk(parsed.content);
    if (parsed.type === "result" && parsed.plan) result = { plan: parsed.plan, currentStepTask: parsed.currentStepTask };
  });

  if (!result) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    throw new ApiError("Plan stream ended without a result", 502);
  }
  return result;
}

export async function createPlan(
  projectId: string,
  description: string,
  steps: PlanStep[],
  onChunk: (content: string) => void,
  signal?: AbortSignal,
): Promise<PlanStreamResult> {
  const res = await apiFetch("/api/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, description, steps }),
    signal,
  });
  return streamPlan(res, onChunk, signal);
}

/** Advances a plan after its current step's pending execution has been confirmed or rejected. */
export async function resumePlan(
  id: string,
  onChunk: (content: string) => void,
  signal?: AbortSignal,
): Promise<PlanStreamResult> {
  const res = await apiFetch(`/api/plans/${encodeURIComponent(id)}/resume`, { method: "POST", signal });
  return streamPlan(res, onChunk, signal);
}

/** Resumes a plan paused at "waiting_guidance" - see orchestratorApi.ts#provideGuidance, one level
 * up: the current step's task failed a tool request/execution and is waiting on a human note. */
export async function provideStepGuidance(
  id: string,
  note: string | undefined,
  onChunk: (content: string) => void,
  signal?: AbortSignal,
): Promise<PlanStreamResult> {
  const res = await apiFetch(`/api/plans/${encodeURIComponent(id)}/guidance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
    signal,
  });
  return streamPlan(res, onChunk, signal);
}

export async function cancelPlan(id: string): Promise<MultiAgentPlan> {
  const res = await apiFetch(`/api/plans/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { plan?: MultiAgentPlan } | null;
  if (!data?.plan) throw new ApiError("Received an invalid response from the server", 502);
  return data.plan;
}

export async function fetchPlans(projectId: string): Promise<MultiAgentPlan[]> {
  const res = await apiFetch(`/api/plans?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { plans?: MultiAgentPlan[] } | null;
  if (!data?.plans) throw new ApiError("Received an invalid response from the server", 502);
  return data.plans;
}

export async function fetchPlan(id: string): Promise<PlanStreamResult> {
  const res = await apiFetch(`/api/plans/${encodeURIComponent(id)}`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as
    | { plan?: MultiAgentPlan; currentStepTask?: OrchestratorTask }
    | null;
  if (!data?.plan) throw new ApiError("Received an invalid response from the server", 502);
  return { plan: data.plan, currentStepTask: data.currentStepTask };
}
