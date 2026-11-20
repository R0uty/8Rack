import { Router } from "express";
import { createMission, deleteMission, getMission, listMissions, updateMission } from "../services/missionManager.js";
import { getRunState, startRun, stopRun } from "../services/missionRunner.js";
import { subscribeMission } from "../services/missionEvents.js";
import { previewAdvance } from "../services/factoryDirector.js";
import { getMissionAttention } from "../services/missionAttention.js";
import { listActivity, logActivity } from "../services/activityLog.js";
import { MissionNotFoundError } from "../services/errors.js";
import type { MissionStatus } from "../types/mission.js";
import type { MissionStreamEvent } from "../types/missionRun.js";

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
    stopRun(req.params.id);
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

async function requireExistingMission(id: string): Promise<void> {
  if (!(await getMission(id))) throw new MissionNotFoundError(id);
}

/**
 * Starts this mission's factory run and returns at once with its state - the run belongs to the
 * server (services/missionRunner.ts), so closing the tab doesn't stop it. Progress, model output and
 * every store change arrive on GET /:id/events. 409 if a run is already going. A tool approval or
 * rejection resumes the run by itself; there is no need to call this again after one.
 */
missionsRouter.post("/:id/factory/advance", async (req, res, next) => {
  try {
    await requireExistingMission(req.params.id);
    res.json({ run: startRun(req.params.id) });
  } catch (err) {
    next(err);
  }
});

/** Aborts the generation in progress. The order it was on goes back to pending. */
missionsRouter.post("/:id/factory/stop", async (req, res, next) => {
  try {
    await requireExistingMission(req.params.id);
    res.json({ run: stopRun(req.params.id) });
  } catch (err) {
    next(err);
  }
});

missionsRouter.get("/:id/factory/run", (req, res) => {
  res.json({ run: getRunState(req.params.id) });
});

/** What the next Advance would do, without doing it - see factoryDirector.ts#previewAdvance. */
missionsRouter.get("/:id/factory/preview", async (req, res, next) => {
  try {
    res.json({ preview: await previewAdvance(req.params.id) });
  } catch (err) {
    next(err);
  }
});

/** Everything waiting on a human, with context for each item - see services/missionAttention.ts. */
missionsRouter.get("/:id/attention", async (req, res, next) => {
  try {
    await requireExistingMission(req.params.id);
    res.json({ attention: getMissionAttention(req.params.id) });
  } catch (err) {
    next(err);
  }
});

/** How often an idle event stream gets a blank line, so a dead connection is noticed and closed. */
const EVENTS_HEARTBEAT_MS = 25_000;

/**
 * This mission's live event stream, NDJSON (see types/missionRun.ts#MissionStreamEvent). The first
 * line is always the current run_state, so a client that connects late, or after a reload, sees
 * where the run stands. Open for as long as the client keeps it open.
 */
missionsRouter.get("/:id/events", async (req, res, next) => {
  const missionId = req.params.id;
  try {
    await requireExistingMission(missionId);
  } catch (err) {
    next(err);
    return;
  }
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const write = (event: MissionStreamEvent) => res.write(`${JSON.stringify(event)}\n`);
  write({ type: "run_state", run: getRunState(missionId) });
  const unsubscribe = subscribeMission(missionId, write);
  const heartbeat = setInterval(() => res.write("\n"), EVENTS_HEARTBEAT_MS);
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
