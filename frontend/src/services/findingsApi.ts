import type { Finding, FindingCreateInput, FindingPatchInput } from "../types/finding";
import { ApiError, apiFetch, throwForErrorResponse } from "./httpClient";

async function unwrapFinding(res: Response): Promise<Finding> {
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { finding?: Finding } | null;
  if (!data?.finding) throw new ApiError("Received an invalid response from the server", 502);
  return data.finding;
}

export async function fetchFindings(missionId: string): Promise<Finding[]> {
  const res = await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/findings`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { findings?: Finding[] } | null;
  if (!data?.findings) throw new ApiError("Received an invalid response from the server", 502);
  return data.findings;
}

export async function createFinding(missionId: string, input: FindingCreateInput): Promise<Finding> {
  const res = await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/findings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrapFinding(res);
}

export async function updateFinding(id: string, patch: FindingPatchInput): Promise<Finding> {
  const res = await apiFetch(`/api/findings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return unwrapFinding(res);
}

export async function deleteFinding(id: string): Promise<void> {
  const res = await apiFetch(`/api/findings/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) await throwForErrorResponse(res);
}

/** Queries the public NVD database for CVEs matching this finding's title - the only request in
 * the app that reaches the internet, always user-triggered (never automatic). */
export async function lookupCves(findingId: string): Promise<Finding[]> {
  const res = await apiFetch(`/api/findings/${encodeURIComponent(findingId)}/cve-lookup`, { method: "POST" });
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { findings?: Finding[] } | null;
  if (!data?.findings) throw new ApiError("Received an invalid response from the server", 502);
  return data.findings;
}
