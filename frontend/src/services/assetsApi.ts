import type { Asset } from "../types/asset";
import { ApiError, apiFetch, throwForErrorResponse } from "./httpClient";

export async function fetchAssets(missionId: string): Promise<Asset[]> {
  const res = await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/assets`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { assets?: Asset[] } | null;
  if (!data?.assets) throw new ApiError("Received an invalid response from the server", 502);
  return data.assets;
}
