import { Router } from "express";
import { createMission, deleteMission, getMission, listMissions, updateMission } from "../services/missionManager.js";
import { advanceMission } from "../services/factoryDirector.js";
import { listActivity, logActivity } from "../services/activityLog.js";
import { RequestCancelledError } from "../services/errors.js";
import { abortOnClientDisconnect } from "./streamUtils.js";
import type { MissionStatus } from "../types/mission.js";

export const missionsRouter = Router();

const MISSION_STATUSES: MissionStatus[] = [
  "draft",
  "ready",
  "recon",
  "investigating",
  "validating",
  "reporting",
  "review",
  "completed",
  "paused",
  "cancelled",
];

interface MissionFieldsBody {
  description?: unknown;
  scope?: unknown;
  outOfScope?: unknown;
  rules?: unknown;
  startDate?: unknown;
  status?: unknown;
}

interface CreateMissionBody extends MissionFieldsBody {
  name?: unknown;
  notes?: unknown;
}

interface UpdateMissionBody extends MissionFieldsBody {
  name?: unknown;
  notes?: unknown;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Shared validation for the mission fields both POST and PATCH accept - every field optional, so
 * a caller only sending name/notes (the pre-mission-fields shape) still works unchanged. */
function validateMissionFields(body: MissionFieldsBody): string | undefined {
  if (body.description !== undefined && typeof body.description !== "string") {
    return "description must be a string";
  }
  if (body.scope !== undefined && !isStringArray(body.scope)) {
    return "scope must be an array of strings";
  }
  if (body.outOfScope !== undefined && !isStringArray(body.outOfScope)) {
    return "outOfScope must be an array of strings";
  }
  if (body.rules !== undefined && typeof body.rules !== "string") {
    return "rules must be a string";
  }
  if (body.startDate !== undefined && typeof body.startDate !== "number") {
    return "startDate must be a number (epoch ms)";
  }
  if (body.status !== undefined && !MISSION_STATUSES.includes(body.status as MissionStatus)) {
    return `status must be one of: ${MISSION_STATUSES.join(", ")}`;
  }
  return undefined;
}

function missionFieldsFrom(body: MissionFieldsBody) {
  return {
    description: body.description as string | undefined,
    scope: body.scope as string[] | undefined,
    outOfScope: body.outOfScope as string[] | undefined,
    rules: body.rules as string | undefined,
    startDate: body.startDate as number | undefined,
    status: body.status as MissionStatus | undefined,
  };
}

missionsRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ missions: await listMissions() });
  } catch (err) {
    next(err);
  }
});

missionsRouter.post("/", async (req, res, next) => {
  const body = req.body as CreateMissionBody;
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required", code: "INVALID_REQUEST" });
    return;
  }
  if (body.notes !== undefined && typeof body.notes !== "string") {
    res.status(400).json({ error: "notes must be a string", code: "INVALID_REQUEST" });
    return;
  }
  const missionError = validateMissionFields(body);
  if (missionError) {
    res.status(400).json({ error: missionError, code: "INVALID_REQUEST" });
    return;
  }
  try {
    const mission = await createMission(body.name.trim(), body.notes ?? "", missionFieldsFrom(body));
    await logActivity(mission.id, "mission_created", `Mission "${mission.name}" created`);
    res.json({ mission });
  } catch (err) {
    next(err);
  }
});

missionsRouter.get("/:id", async (req, res, next) => {
  try {
    const mission = await getMission(req.params.id);
    if (!mission) {
      res.status(404).json({ error: `Mission "${req.params.id}" was not found`, code: "MISSION_NOT_FOUND" });
      return;
    }
    res.json({ mission });
  } catch (err) {
    next(err);
  }
});

missionsRouter.patch("/:id", async (req, res, next) => {
  const body = req.body as UpdateMissionBody;
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
    res.status(400).json({ error: "name must be a non-empty string", code: "INVALID_REQUEST" });
    return;
  }
  if (body.notes !== undefined && typeof body.notes !== "string") {
    res.status(400).json({ error: "notes must be a string", code: "INVALID_REQUEST" });
    return;
  }
  const missionError = validateMissionFields(body);
  if (missionError) {
    res.status(400).json({ error: missionError, code: "INVALID_REQUEST" });
    return;
  }
  try {
    // Read before writing so a status change (if any) can be logged with both the old and new
    // value - updateMission itself doesn't know or report what changed, it just merges the patch.
    const before = await getMission(req.params.id);
    const mission = await updateMission(req.params.id, {
      name: typeof body.name === "string" ? body.name.trim() : undefined,
      notes: body.notes as string | undefined,
      ...missionFieldsFrom(body),
    });
    if (body.status !== undefined && before?.status !== mission.status) {
      await logActivity(mission.id, "mission_status_changed", `Mission status changed: ${before?.status ?? "(none)"} -> ${mission.status}`, {
        from: before?.status,
        to: mission.status,
      });
    }
    res.json({ mission });
  } catch (err) {
    next(err);
  }
});

missionsRouter.delete("/:id", async (req, res, next) => {
  try {
    await deleteMission(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** The Mission Activity Timeline - see services/activityLog.ts. Newest first, same convention as
 * every other mission-scoped list endpoint in this file. */
missionsRouter.get("/:id/activity", (req, res) => {
  res.json({ activity: listActivity(req.params.id) });
});

/**
 * Advances this mission's factory pipeline by one call - streamed NDJSON like every other
 * long-running route in this codebase (see routes/plans.ts#runAndStreamPlan, the closest existing
 * precedent: a {type:"chunk"} line per token from whichever work order is currently generating,
 * then a single terminal {type:"result"} line). Call again after resolving a pending confirmation
 * (POST /api/tools/executions/:id/confirm|reject) to continue the chain - the same follow-up every
 * other task-backed flow in this app already requires.
 */
missionsRouter.post("/:id/factory/advance", async (req, res, next) => {
  const controller = abortOnClientDisconnect(res);
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");

  try {
    const result = await advanceMission(
      req.params.id,
      (content) => res.write(`${JSON.stringify({ type: "chunk", content })}\n`),
      controller.signal,
    );
    res.write(`${JSON.stringify({ type: "result", ...result })}\n`);
    res.end();
  } catch (err) {
    if (err instanceof RequestCancelledError) {
      res.end();
      return;
    }
    if (!res.headersSent) {
      next(err);
      return;
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    res.write(`${JSON.stringify({ type: "error", error: message })}\n`);
    res.end();
  }
});
