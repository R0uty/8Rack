import { Router } from "express";
import { createProject, deleteProject, getProject, listProjects, updateProject } from "../services/projectManager.js";
import type { MissionStatus } from "../types/project.js";

export const projectsRouter = Router();

const MISSION_STATUSES: MissionStatus[] = ["planning", "active", "paused", "completed"];

interface MissionFieldsBody {
  description?: unknown;
  scope?: unknown;
  outOfScope?: unknown;
  rules?: unknown;
  startDate?: unknown;
  status?: unknown;
}

interface CreateProjectBody extends MissionFieldsBody {
  name?: unknown;
  notes?: unknown;
}

interface UpdateProjectBody extends MissionFieldsBody {
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

projectsRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ projects: await listProjects() });
  } catch (err) {
    next(err);
  }
});

projectsRouter.post("/", async (req, res, next) => {
  const body = req.body as CreateProjectBody;
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
    const project = await createProject(body.name.trim(), body.notes ?? "", missionFieldsFrom(body));
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

projectsRouter.get("/:id", async (req, res, next) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: `Project "${req.params.id}" was not found`, code: "PROJECT_NOT_FOUND" });
      return;
    }
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

projectsRouter.patch("/:id", async (req, res, next) => {
  const body = req.body as UpdateProjectBody;
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
    const project = await updateProject(req.params.id, {
      name: typeof body.name === "string" ? body.name.trim() : undefined,
      notes: body.notes as string | undefined,
      ...missionFieldsFrom(body),
    });
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

projectsRouter.delete("/:id", async (req, res, next) => {
  try {
    await deleteProject(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
