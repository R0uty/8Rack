import { randomUUID } from "node:crypto";
import { listMissionIds, readMissionJson, writeMissionJson } from "./missionStore.js";
import { onMissionDeleted } from "./missionManager.js";
import { logActivity } from "./activityLog.js";
import { AssetNotFoundError } from "./errors.js";
import type { Asset, AssetCreateInput, AssetPatchInput } from "../types/asset.js";

const assets = new Map<string, Asset>();
const ASSETS_FILE = "assets.json";

function missionAssets(missionId: string): Asset[] {
  return [...assets.values()].filter((a) => a.missionId === missionId).sort((a, b) => b.lastSeen - a.lastSeen);
}

async function persistAssets(missionId: string): Promise<void> {
  await writeMissionJson(missionId, ASSETS_FILE, missionAssets(missionId));
}

// See missionManager.ts#onMissionDeleted - a deleted mission's assets must stop returning from the
// Asset Inventory instead of lingering as ghost records, same purge pattern every other
// mission-scoped store here registers.
onMissionDeleted((missionId) => {
  for (const [id, asset] of assets) {
    if (asset.missionId === missionId) assets.delete(id);
  }
});

/** Hydrates in-memory assets from disk - called once at server startup, mirrors
 * findingsManager.ts#loadFindingsFromDisk. */
export async function loadAssetsFromDisk(): Promise<void> {
  const missionIds = await listMissionIds();
  for (const missionId of missionIds) {
    const onDisk = await readMissionJson<Asset>(missionId, ASSETS_FILE);
    for (const asset of onDisk) assets.set(asset.id, asset);
  }
}

function findExisting(missionId: string, type: Asset["type"], value: string): Asset | undefined {
  const key = value.toLowerCase();
  return missionAssets(missionId).find((a) => a.type === type && a.value.toLowerCase() === key);
}

/** Case-insensitive lookup by raw value across every asset type for a mission - used to resolve a
 * new asset's best-effort parentId (e.g. a port asset's parent host) without the caller needing to
 * know the parent's exact type. */
export function getAssetByValue(missionId: string, value: string): Asset | undefined {
  const key = value.toLowerCase();
  return missionAssets(missionId).find((a) => a.value.toLowerCase() === key);
}

/**
 * Creates a new Asset or, if one already exists for the same (missionId, type, value), updates it
 * in place instead of duplicating: bumps lastSeen, merges metadata, and accepts a fresher
 * status/parentId if the caller supplies one. Mirrors findingsManager.ts#upsertFinding's dedup shape
 * one level simpler (no evidence/history/confidence to reconcile).
 */
export async function upsertAsset(missionId: string, input: AssetCreateInput): Promise<Asset> {
  const now = Date.now();
  const existing = findExisting(missionId, input.type, input.value);

  if (existing) {
    existing.lastSeen = now;
    existing.metadata = { ...existing.metadata, ...input.metadata };
    if (input.status !== undefined) existing.status = input.status;
    if (input.discoveredBy !== undefined) existing.discoveredBy = input.discoveredBy;
    if (input.parentId !== undefined) existing.parentId = input.parentId;
    assets.set(existing.id, existing);
    await persistAssets(missionId);
    return existing;
  }

  const created: Asset = {
    id: randomUUID(),
    missionId,
    type: input.type,
    value: input.value,
    status: input.status ?? "active",
    discoveredBy: input.discoveredBy ?? "unknown",
    source: input.source ?? "manual",
    firstSeen: now,
    lastSeen: now,
    metadata: input.metadata ?? {},
    parentId: input.parentId,
  };
  assets.set(created.id, created);
  await persistAssets(missionId);
  await logActivity(missionId, "asset_discovered", `${created.type} discovered: ${created.value}`, {
    assetId: created.id,
    type: created.type,
  });
  return created;
}

export async function updateAsset(id: string, patch: AssetPatchInput): Promise<Asset> {
  const asset = assets.get(id);
  if (!asset) throw new AssetNotFoundError(id);
  if (patch.status !== undefined) asset.status = patch.status;
  if (patch.metadata !== undefined) asset.metadata = { ...asset.metadata, ...patch.metadata };
  asset.lastSeen = Date.now();
  assets.set(asset.id, asset);
  await persistAssets(asset.missionId);
  return asset;
}

export function getAsset(id: string): Asset | undefined {
  return assets.get(id);
}

export function listAssets(missionId: string): Asset[] {
  return missionAssets(missionId);
}
