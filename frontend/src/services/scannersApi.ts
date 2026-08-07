import type { ScanPreview, ScanProfile, ScanRun } from "../types/scanner";
import { ApiError, apiFetch, readNdjsonStream, throwForErrorResponse } from "./httpClient";

export async function fetchScanProfiles(): Promise<ScanProfile[]> {
  const res = await apiFetch("/api/scanners");
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { profiles?: ScanProfile[] } | null;
  if (!data?.profiles) throw new ApiError("Received an invalid response from the server", 502);
  return data.profiles;
}

export async function fetchScans(projectId: string): Promise<ScanRun[]> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/scans`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { scans?: ScanRun[] } | null;
  if (!data?.scans) throw new ApiError("Received an invalid response from the server", 502);
  return data.scans;
}

export async function previewScan(projectId: string, profileId: string, target: string): Promise<ScanPreview> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/scans/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId, target }),
  });
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { preview?: ScanPreview } | null;
  if (!data?.preview) throw new ApiError("Received an invalid response from the server", 502);
  return data.preview;
}

interface ScanStreamLine {
  type: "scan" | "step" | "output" | "done" | "error";
  scan?: ScanRun;
  scanId?: string;
  step?: ScanRun["steps"][number];
  toolId?: string;
  stream?: "stdout" | "stderr";
  data?: string;
  error?: string;
}

export type ScanStreamEvent =
  | { type: "scan"; scan: ScanRun }
  | { type: "step"; step: ScanRun["steps"][number] }
  | { type: "output"; toolId: string; stream: "stdout" | "stderr"; data: string };

/** Starts a scan run and streams live progress (scan/step/output events), resolving with the final
 * ScanRun once every step has settled or the run was cancelled. */
export async function createScan(
  projectId: string,
  profileId: string,
  target: string,
  onEvent: (event: ScanStreamEvent) => void,
  signal?: AbortSignal,
): Promise<ScanRun> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/scans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId, target }),
    signal,
  });
  if (!res.ok) await throwForErrorResponse(res);

  let result: ScanRun | undefined;
  await readNdjsonStream(res, (line) => {
    let parsed: ScanStreamLine;
    try {
      parsed = JSON.parse(line) as ScanStreamLine;
    } catch {
      throw new ApiError("Received an invalid response from the server", 502);
    }
    if (parsed.type === "error") throw new ApiError(parsed.error ?? "Scan failed", 502);
    if (parsed.type === "done" && parsed.scan) {
      result = parsed.scan;
      return;
    }
    if (parsed.type === "scan" && parsed.scan) {
      onEvent({ type: "scan", scan: parsed.scan });
      return;
    }
    if (parsed.type === "step" && parsed.step) {
      onEvent({ type: "step", step: parsed.step });
      return;
    }
    if (parsed.type === "output" && parsed.toolId && parsed.stream && parsed.data !== undefined) {
      onEvent({ type: "output", toolId: parsed.toolId, stream: parsed.stream, data: parsed.data });
    }
  });

  if (!result) throw new ApiError("Scan stream ended without a result", 502);
  return result;
}

export async function cancelScan(projectId: string, scanId: string): Promise<ScanRun> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/scans/${encodeURIComponent(scanId)}/cancel`,
    { method: "POST" },
  );
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { scan?: ScanRun } | null;
  if (!data?.scan) throw new ApiError("Received an invalid response from the server", 502);
  return data.scan;
}
