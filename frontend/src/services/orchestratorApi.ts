import type { OrchestratorTask } from "../types/orchestrator";
import { ApiError, apiFetch, throwForErrorResponse } from "./httpClient";

/** WorkOrdersView's read-only "Inspect" of a Work Order's underlying task (its final response) -
 * task creation/resume/cancel are internal to workOrderManager.ts/factoryDirector.ts on the
 * backend now, reached through the Work Order endpoints instead (guidance included - see
 * workOrdersApi.ts#guideWorkOrder). */
export async function fetchTask(id: string): Promise<OrchestratorTask> {
  const res = await apiFetch(`/api/orchestrator/tasks/${encodeURIComponent(id)}`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { task?: OrchestratorTask } | null;
  if (!data?.task) throw new ApiError("Received an invalid response from the server", 502);
  return data.task;
}
