import { Router } from "express";
import { deleteAsset, getAsset, listAssets, updateAsset, upsertAsset } from "../services/assetManager.js";
import { AssetNotFoundError } from "../services/errors.js";
import type { AssetStatus, AssetType } from "../types/asset.js";

/** Mission-scoped Asset Inventory routes - /api/missions/:missionId/assets. MUST be created with
 * { mergeParams: true } or req.params.missionId is undefined once mounted under a parent router's
 * :missionId segment (backend/src/index.ts) - same requirement as routes/findings.ts's
 * missionFindingsRouter. Agents write assets through the upsert_asset pseudo-tool and finding
 * mirroring; these routes are for a human adding, correcting or removing one. */
export const missionAssetsRouter = Router({ mergeParams: true });

const ASSET_TYPES: AssetType[] = ["domain", "subdomain", "url", "ip", "port", "service", "api", "technology"];
const ASSET_STATUSES: AssetStatus[] = ["active", "inactive", "unverified"];

function missionIdOf(req: { params: Record<string, string> }): string {
  return req.params.missionId;
}

// An asset id from another mission is "not found" here, same as work orders/reports/scans.
missionAssetsRouter.param("assetId", (req, _res, next, id: string) => {
  const asset = getAsset(id);
  next(asset && asset.missionId === req.params.missionId ? undefined : new AssetNotFoundError(id));
});

missionAssetsRouter.get("/", (req, res) => {
  res.json({ assets: listAssets(missionIdOf(req)) });
});

missionAssetsRouter.post("/", async (req, res, next) => {
  const { type, value, status } = (req.body ?? {}) as { type?: unknown; value?: unknown; status?: unknown };
  if (!ASSET_TYPES.includes(type as AssetType)) {
    res.status(400).json({ error: `type must be one of: ${ASSET_TYPES.join(", ")}`, code: "INVALID_REQUEST" });
    return;
  }
  if (typeof value !== "string" || !value.trim()) {
    res.status(400).json({ error: "value is required", code: "INVALID_REQUEST" });
    return;
  }
  if (status !== undefined && !ASSET_STATUSES.includes(status as AssetStatus)) {
    res.status(400).json({ error: `status must be one of: ${ASSET_STATUSES.join(", ")}`, code: "INVALID_REQUEST" });
    return;
  }
  try {
    const asset = await upsertAsset(missionIdOf(req), {
      type: type as AssetType,
      value: value.trim(),
      status: (status as AssetStatus | undefined) ?? "unverified",
      discoveredBy: "manual",
      source: "manual",
    });
    res.status(201).json({ asset });
  } catch (err) {
    next(err);
  }
});

missionAssetsRouter.patch("/:assetId", async (req, res, next) => {
  const { status } = (req.body ?? {}) as { status?: unknown };
  if (!ASSET_STATUSES.includes(status as AssetStatus)) {
    res.status(400).json({ error: `status must be one of: ${ASSET_STATUSES.join(", ")}`, code: "INVALID_REQUEST" });
    return;
  }
  try {
    res.json({ asset: await updateAsset(req.params.assetId, { status: status as AssetStatus }) });
  } catch (err) {
    next(err);
  }
});

missionAssetsRouter.delete("/:assetId", async (req, res, next) => {
  try {
    res.json({ asset: await deleteAsset(req.params.assetId) });
  } catch (err) {
    next(err);
  }
});
