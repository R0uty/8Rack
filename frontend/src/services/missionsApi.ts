import type { Mission } from "../types/mission";
import { ApiError, apiFetch, throwForErrorResponse } from "./httpClient";

async function unwrapMission(res: Response): Promise<Mission> {
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { mission?: Mission } | null;
  if (!data?.mission) throw new ApiError("Received an invalid response from the server", 502);
  return data.mission;
}

export async function fetchMissions(): Promise<Mission[]> {
  const res = await apiFetch("/api/missions");
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { missions?: Mission[] } | null;
  if (!data?.missions) throw new ApiError("Received an invalid response from the server", 502);
  return data.missions;
}

export async function createMission(
  name: string,
  notes: string,
  mission: Partial<Omit<Mission, "id" | "name" | "notes" | "createdAt">> = {},
): Promise<Mission> {
  const res = await apiFetch("/api/missions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, notes, ...mission }),
  });
  return unwrapMission(res);
}

export async function updateMission(id: string, patch: Partial<Omit<Mission, "id" | "createdAt">>): Promise<Mission> {
  const res = await apiFetch(`/api/missions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return unwrapMission(res);
}

export async function deleteMission(id: string): Promise<void> {
  const res = await apiFetch(`/api/missions/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) await throwForErrorResponse(res);
}
