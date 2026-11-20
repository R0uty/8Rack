import type { FactoryPreview, MissionAttention } from "../types/attention";
import type { MissionRunState, MissionStreamEvent } from "../types/missionRun";
import { ApiError, apiFetch, readNdjsonStream, throwForErrorResponse } from "./httpClient";

async function unwrapRun(res: Response): Promise<MissionRunState> {
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { run?: MissionRunState } | null;
  if (!data?.run) throw new ApiError("Received an invalid response from the server", 502);
  return data.run;
}

/** Starts the mission's factory run on the server and returns at once. Progress arrives on the
 * mission's event stream. 409 if a run is already going. */
export async function advanceFactory(missionId: string): Promise<MissionRunState> {
  return unwrapRun(await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/factory/advance`, { method: "POST" }));
}

/** Stops the generation in progress. Its order goes back to pending. */
export async function stopFactory(missionId: string): Promise<MissionRunState> {
  return unwrapRun(await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/factory/stop`, { method: "POST" }));
}

/**
 * Reads the mission's event stream until it ends or `signal` aborts. The first line is always the
 * current run state. `onOpen` fires once the server has accepted the stream.
 */
export async function streamMissionEvents(
  missionId: string,
  onEvent: (event: MissionStreamEvent) => void,
  signal: AbortSignal,
  onOpen?: () => void,
): Promise<void> {
  const res = await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/events`, { signal });
  if (!res.ok) await throwForErrorResponse(res);
  onOpen?.();
  await readNdjsonStream(res, (line) => {
    try {
      onEvent(JSON.parse(line) as MissionStreamEvent);
    } catch {
      // One bad line shouldn't drop the stream.
    }
  });
}

export async function fetchAttention(missionId: string): Promise<MissionAttention> {
  const res = await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/attention`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { attention?: MissionAttention } | null;
  if (!data?.attention) throw new ApiError("Received an invalid response from the server", 502);
  return data.attention;
}

export async function fetchFactoryPreview(missionId: string): Promise<FactoryPreview> {
  const res = await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/factory/preview`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { preview?: FactoryPreview } | null;
  if (!data?.preview) throw new ApiError("Received an invalid response from the server", 502);
  return data.preview;
}
