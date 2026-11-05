import type { NextFunction, Request, Response } from "express";
import { getMission } from "../services/missionManager.js";
import { MissionNotFoundError } from "../services/errors.js";

/** Rejects a write to a mission that doesn't exist - otherwise writeMissionJson's mkdir would quietly
 * create an orphaned directory for it. Reads are left alone: they just find nothing. */
export async function requireMission(req: Request, _res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  const params = req.params as Record<string, string>;
  const body = (req.body ?? {}) as { missionId?: unknown };
  const missionId = params.missionId ?? body.missionId;
  if (typeof missionId !== "string") {
    next();
    return;
  }
  try {
    next((await getMission(missionId)) ? undefined : new MissionNotFoundError(missionId));
  } catch (err) {
    next(err);
  }
}
