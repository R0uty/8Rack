import type { ExecToolWithStatus, ExecutionRecord, ExecutionStatus } from "../types/execTool";
import { ApiError, apiFetch, throwForErrorResponse } from "./httpClient";

export async function fetchTools(): Promise<ExecToolWithStatus[]> {
  const res = await apiFetch("/api/tools");
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { tools?: ExecToolWithStatus[] } | null;
  if (!data?.tools) throw new ApiError("Received an invalid response from the server", 502);
  return data.tools;
}

/** Runtime enable/disable toggle for a tool - persisted on the backend, survives a restart. */
export async function setToolEnabled(toolId: string, enabled: boolean): Promise<ExecToolWithStatus> {
  const res = await apiFetch(`/api/tools/${encodeURIComponent(toolId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { tool?: ExecToolWithStatus } | null;
  if (!data?.tool) throw new ApiError("Received an invalid response from the server", 502);
  return data.tool;
}

/** A mission's executions, newest first - only those with one of `statuses` when given, which keeps
 * the Approval Queue from downloading every past run's output. */
export async function fetchExecutions(missionId: string, statuses?: ExecutionStatus[]): Promise<ExecutionRecord[]> {
  const query = new URLSearchParams({ missionId, ...(statuses?.length ? { status: statuses.join(",") } : {}) });
  const res = await apiFetch(`/api/tools/executions?${query}`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { executions?: ExecutionRecord[] } | null;
  if (!data?.executions) throw new ApiError("Received an invalid response from the server", 502);
  return data.executions;
}

/** Requests a tool execution — lands as `pending_confirmation` since every built-in tool requires it. */
export async function requestToolExecution(
  tool: string,
  args: string[],
  missionId: string,
  stdin?: string,
): Promise<ExecutionRecord> {
  const res = await apiFetch("/api/tools/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, arguments: args, missionId, stdin }),
  });
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { execution?: ExecutionRecord } | null;
  if (!data?.execution) throw new ApiError("Received an invalid response from the server", 502);
  return data.execution;
}

/** Starts a pending execution and returns once its process is running. It finishes on the server;
 * live output arrives as `execution_output` events on the mission's event stream. */
export async function confirmExecution(executionId: string): Promise<ExecutionRecord> {
  const res = await apiFetch(`/api/tools/executions/${encodeURIComponent(executionId)}/confirm`, { method: "POST" });
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { execution?: ExecutionRecord } | null;
  if (!data?.execution) throw new ApiError("Received an invalid response from the server", 502);
  return data.execution;
}

export async function rejectExecution(executionId: string): Promise<ExecutionRecord> {
  const res = await apiFetch(`/api/tools/executions/${encodeURIComponent(executionId)}/reject`, { method: "POST" });
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { execution?: ExecutionRecord } | null;
  if (!data?.execution) throw new ApiError("Received an invalid response from the server", 502);
  return data.execution;
}

export async function cancelExecution(executionId: string): Promise<ExecutionRecord> {
  const res = await apiFetch(`/api/tools/executions/${encodeURIComponent(executionId)}/cancel`, { method: "POST" });
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { execution?: ExecutionRecord } | null;
  if (!data?.execution) throw new ApiError("Received an invalid response from the server", 502);
  return data.execution;
}
