import { Router } from "express";
import { listAssets } from "../services/assetManager.js";

/** Mission-scoped Asset Inventory route - GET /api/missions/:missionId/assets. MUST be created with
 * { mergeParams: true } or req.params.missionId is undefined once mounted under a parent router's
 * :missionId segment (backend/src/index.ts) - same requirement as routes/findings.ts's
 * missionFindingsRouter. Read-only for now: assets are only ever written via
 * findingsManager.ts#mirrorAssetFromFinding or the upsert_asset pseudo-tool (orchestrator.ts), not
 * directly through this API. */
export const missionAssetsRouter = Router({ mergeParams: true });

function missionIdOf(req: { params: Record<string, string> }): string {
  return req.params.missionId;
}

missionAssetsRouter.get("/", (req, res) => {
  res.json({ assets: listAssets(missionIdOf(req)) });
});
