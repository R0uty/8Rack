import type { Report } from "../types/report";
import { ApiError, apiFetch, readNdjsonStream, throwForErrorResponse } from "./httpClient";

export async function fetchReports(projectId: string): Promise<Report[]> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/reports`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { reports?: Report[] } | null;
  if (!data?.reports) throw new ApiError("Received an invalid response from the server", 502);
  return data.reports;
}

interface ReportStreamLine {
  type: "chunk" | "report" | "error";
  content?: string;
  report?: Report;
  error?: string;
}

/**
 * Generates a report from a set of findings, streaming the agent's reply text as it's written
 * (live "typing" UX, same convention as Orchestrator task streaming) and resolving with the final
 * persisted Report once generation completes.
 */
export async function createReport(
  projectId: string,
  title: string,
  findingIds: string[],
  onChunk: (content: string) => void,
  signal?: AbortSignal,
): Promise<Report> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, findingIds }),
    signal,
  });
  if (!res.ok) await throwForErrorResponse(res);

  let result: Report | undefined;
  await readNdjsonStream(res, (line) => {
    let parsed: ReportStreamLine;
    try {
      parsed = JSON.parse(line) as ReportStreamLine;
    } catch {
      throw new ApiError("Received an invalid response from the server", 502);
    }
    if (parsed.type === "error") throw new ApiError(parsed.error ?? "Report generation failed", 502);
    if (parsed.type === "chunk" && parsed.content) onChunk(parsed.content);
    if (parsed.type === "report" && parsed.report) result = parsed.report;
  });

  if (!result) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    throw new ApiError("Report stream ended without a result", 502);
  }
  return result;
}

export async function deleteReport(projectId: string, reportId: string): Promise<void> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(reportId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) await throwForErrorResponse(res);
}
