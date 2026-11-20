import type { Asset, AssetStatus, AssetType } from "../types/asset";
import { ApiError, apiFetch, throwForErrorResponse } from "./httpClient";

export async function fetchAssets(missionId: string): Promise<Asset[]> {
  const res = await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/assets`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { assets?: Asset[] } | null;
  if (!data?.assets) throw new ApiError("Received an invalid response from the server", 502);
  return data.assets;
}

async function unwrapAsset(res: Response): Promise<Asset> {
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { asset?: Asset } | null;
  if (!data?.asset) throw new ApiError("Received an invalid response from the server", 502);
  return data.asset;
}

export async function createAsset(missionId: string, input: { type: AssetType; value: string; status?: AssetStatus }): Promise<Asset> {
  return unwrapAsset(
    await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function setAssetStatus(missionId: string, assetId: string, status: AssetStatus): Promise<Asset> {
  return unwrapAsset(
    await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/assets/${encodeURIComponent(assetId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }),
  );
}

export async function deleteAsset(missionId: string, assetId: string): Promise<Asset> {
  return unwrapAsset(
    await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" }),
  );
}
