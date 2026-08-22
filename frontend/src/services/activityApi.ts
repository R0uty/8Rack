import type { MissionEvent } from "../types/missionEvent";
import { ApiError, apiFetch, throwForErrorResponse } from "./httpClient";

/** The Mission Activity Timeline - see backend/src/services/activityLog.ts. Newest first. */
export async function fetchActivity(missionId: string): Promise<MissionEvent[]> {
  const res = await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/activity`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { activity?: MissionEvent[] } | null;
  if (!data?.activity) throw new ApiError("Received an invalid response from the server", 502);
  return data.activity;
}
