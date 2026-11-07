import type { ExecToolWithStatus, ExecutionRecord } from "../types/execTool";
import { ApiError, apiFetch, readNdjsonStream, throwForErrorResponse } from "./httpClient";

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

export async function fetchExecutions(missionId: string): Promise<ExecutionRecord[]> {
  const res = await apiFetch(`/api/tools/executions?missionId=${encodeURIComponent(missionId)}`);
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

interface ExecutionStreamLine {
  type: "stdout" | "stderr" | "result" | "error";
  data?: string;
  record?: ExecutionRecord;
  error?: string;
}

export type ExecutionStreamEvent =
  | { type: "output"; stream: "stdout" | "stderr"; data: string }
  | { type: "result"; record: ExecutionRecord };

/** Runs a pending execution, streaming live stdout/stderr, resolving with the final ExecutionRecord. */
export async function confirmExecution(
  executionId: string,
  onEvent: (event: ExecutionStreamEvent) => void,
  signal?: AbortSignal,
): Promise<ExecutionRecord> {
  const res = await apiFetch(`/api/tools/executions/${encodeURIComponent(executionId)}/confirm`, {
    method: "POST",
    signal,
  });
  if (!res.ok) await throwForErrorResponse(res);

  let result: ExecutionRecord | undefined;
  await readNdjsonStream(res, (line) => {
    let parsed: ExecutionStreamLine;
    try {
      parsed = JSON.parse(line) as ExecutionStreamLine;
    } catch {
      throw new ApiError("Received an invalid response from the server", 502);
    }
    if (parsed.type === "error") throw new ApiError(parsed.error ?? "Execution failed", 502);
    if (parsed.type === "result" && parsed.record) {
      result = parsed.record;
      onEvent({ type: "result", record: parsed.record });
      return;
    }
    if ((parsed.type === "stdout" || parsed.type === "stderr") && parsed.data !== undefined) {
      onEvent({ type: "output", stream: parsed.type, data: parsed.data });
    }
  });

  if (!result) throw new ApiError("Execution stream ended without a result", 502);
  return result;
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
