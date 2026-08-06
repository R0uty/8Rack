import type { OrchestratorTask } from "../types/orchestrator";
import { ApiError, apiFetch, readNdjsonStream, throwForErrorResponse } from "./httpClient";

interface TaskStreamLine {
  type: "chunk" | "task" | "error";
  content?: string;
  task?: OrchestratorTask;
  error?: string;
}

async function unwrapTask(res: Response): Promise<OrchestratorTask> {
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { task?: OrchestratorTask } | null;
  if (!data?.task) throw new ApiError("Received an invalid response from the server", 502);
  return data.task;
}

/**
 * Reads the NDJSON stream a task-advancing endpoint (create/resume) responds with: a "chunk" line
 * per piece of the agent's reply text as it streams in, then a single terminal "task" line once
 * the step settles. `onChunk` drives a live "thinking" UX; the resolved task is the settled state.
 */
async function streamTask(
  res: Response,
  onChunk: (content: string) => void,
  signal?: AbortSignal,
): Promise<OrchestratorTask> {
  if (!res.ok) await throwForErrorResponse(res);

  let result: OrchestratorTask | undefined;
  await readNdjsonStream(res, (line) => {
    let parsed: TaskStreamLine;
    try {
      parsed = JSON.parse(line) as TaskStreamLine;
    } catch {
      throw new ApiError("Received an invalid response from the server", 502);
    }
    if (parsed.type === "error") throw new ApiError(parsed.error ?? "Task step failed", 502);
    if (parsed.type === "chunk" && parsed.content) onChunk(parsed.content);
    if (parsed.type === "task" && parsed.task) result = parsed.task;
  });

  if (!result) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    throw new ApiError("Task stream ended without a result", 502);
  }
  return result;
}

export async function createTask(
  agentId: string,
  objective: string,
  projectId: string,
  onChunk: (content: string) => void,
  signal?: AbortSignal,
  /** Overrides the agent's configured model for this task, same convention as the chat path. */
  model?: string,
): Promise<OrchestratorTask> {
  const res = await apiFetch("/api/orchestrator/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, objective, projectId, model }),
    signal,
  });
  return streamTask(res, onChunk, signal);
}

export async function fetchTasks(projectId: string): Promise<OrchestratorTask[]> {
  const res = await apiFetch(`/api/orchestrator/tasks?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { tasks?: OrchestratorTask[] } | null;
  if (!data?.tasks) throw new ApiError("Received an invalid response from the server", 502);
  return data.tasks;
}

export async function fetchTask(id: string): Promise<OrchestratorTask> {
  return unwrapTask(await apiFetch(`/api/orchestrator/tasks/${encodeURIComponent(id)}`));
}

/** Advances a task after its pending execution has been confirmed or rejected. */
export async function resumeTask(
  id: string,
  onChunk: (content: string) => void,
  signal?: AbortSignal,
): Promise<OrchestratorTask> {
  const res = await apiFetch(`/api/orchestrator/tasks/${encodeURIComponent(id)}/resume`, { method: "POST", signal });
  return streamTask(res, onChunk, signal);
}

export async function cancelTask(id: string): Promise<OrchestratorTask> {
  return unwrapTask(await apiFetch(`/api/orchestrator/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }));
}

/** Sends a follow-up message into an already-completed task, continuing the same conversation
 * instead of starting a brand-new task with no memory of what came before. */
export async function continueTask(
  id: string,
  message: string,
  onChunk: (content: string) => void,
  signal?: AbortSignal,
): Promise<OrchestratorTask> {
  const res = await apiFetch(`/api/orchestrator/tasks/${encodeURIComponent(id)}/continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal,
  });
  return streamTask(res, onChunk, signal);
}

/** Resumes a task paused at "waiting_guidance" (a tool request that failed outright, or a
 * confirmed execution that came back failed/cancelled) - an optional human note steers the agent's
 * next attempt; omitting it just lets it try again on its own. */
export async function provideGuidance(
  id: string,
  note: string | undefined,
  onChunk: (content: string) => void,
  signal?: AbortSignal,
): Promise<OrchestratorTask> {
  const res = await apiFetch(`/api/orchestrator/tasks/${encodeURIComponent(id)}/guidance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
    signal,
  });
  return streamTask(res, onChunk, signal);
}
