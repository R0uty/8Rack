import { Router } from "express";
import { createProject, deleteProject, getProject, listProjects, updateProject } from "../services/projectManager.js";

export const projectsRouter = Router();

interface CreateProjectBody {
  name?: unknown;
  notes?: unknown;
}

interface UpdateProjectBody {
  name?: unknown;
  notes?: unknown;
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
  try {
    const project = await createProject(body.name.trim(), body.notes ?? "");
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
  try {
    const project = await updateProject(req.params.id, {
      name: typeof body.name === "string" ? body.name.trim() : undefined,
      notes: body.notes as string | undefined,
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
