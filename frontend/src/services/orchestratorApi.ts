import type { OrchestratorTask } from "../types/orchestrator";
import { ApiError, apiFetch, readNdjsonStream, throwForErrorResponse } from "./httpClient";

/** WorkOrdersView's read-only "Inspect" of a Work Order's underlying task (its final response) -
 * task creation/resume/cancel are internal to workOrderManager.ts/factoryDirector.ts on the
 * backend now, reached through the Work Order endpoints instead. `provideGuidance` below is the
 * one exception still driven from the frontend: a tool request that fails outright (invalid tool,
 * unavailable executable, etc) has no ExecutionRecord to confirm/reject through the Approval
 * Queue - the task pauses at "waiting_guidance" instead, and a human note (or none, to just retry)
 * is the only way to unstick it. */
export async function fetchTask(id: string): Promise<OrchestratorTask> {
  const res = await apiFetch(`/api/orchestrator/tasks/${encodeURIComponent(id)}`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { task?: OrchestratorTask } | null;
  if (!data?.task) throw new ApiError("Received an invalid response from the server", 502);
  return data.task;
}

interface TaskStreamLine {
  type: "chunk" | "task" | "error";
  content?: string;
  task?: OrchestratorTask;
  error?: string;
}

/** Resumes a task paused at "waiting_guidance" - an optional human note steers the agent's next
 * attempt; omitting it just lets it try again on its own. */
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
