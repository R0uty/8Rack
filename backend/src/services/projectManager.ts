import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { listProjectIds, projectDir } from "./projectStore.js";
import { ProjectNotFoundError } from "./errors.js";
import type { Project } from "../types/project.js";

const PROJECT_FILE = "project.json";

async function readProjectMeta(id: string): Promise<Project | undefined> {
  // projectDir(id) is resolved outside the try/catch below so an InvalidProjectIdError propagates
  // as a real error instead of looking identical to "no project.json here yet" - see
  // projectStore.ts#readProjectJson for the same reasoning.
  const dir = projectDir(id);
  let raw: string;
  try {
    raw = await readFile(path.join(dir, PROJECT_FILE), "utf-8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as Project;
  } catch (err) {
    // Same distinction as projectStore.ts#readProjectJson - a project.json that exists but fails
    // to parse means something went wrong, worth a log even though it still resolves to "not
    // found" from here (a project with no readable metadata isn't usable either way).
    console.warn(`[projectManager] project.json for "${id}" contains invalid JSON - treating as not found.`, err);
    return undefined;
  }
}

async function writeProjectMeta(project: Project): Promise<void> {
  await mkdir(projectDir(project.id), { recursive: true });
  await writeFile(path.join(projectDir(project.id), PROJECT_FILE), JSON.stringify(project, null, 2));
}

/** No read-through cache (unlike agentManager) - projects are mutated via this API, and the
 * project count will always be small enough that reading fresh each time is cheap. */
export async function listProjects(): Promise<Project[]> {
  const ids = await listProjectIds();
  const projects = await Promise.all(ids.map(readProjectMeta));
  return projects.filter((p): p is Project => !!p).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getProject(id: string): Promise<Project | undefined> {
  return readProjectMeta(id);
}

/** Mission fields, layered onto the required name/notes at creation time - see types/project.ts. */
export type MissionFields = Pick<Project, "description" | "scope" | "outOfScope" | "rules" | "startDate" | "status">;

export async function createProject(name: string, notes: string, mission: Partial<MissionFields> = {}): Promise<Project> {
  const project: Project = { id: randomUUID(), name, notes, createdAt: Date.now(), ...mission };
  await writeProjectMeta(project);
  return project;
}

export async function updateProject(
  id: string,
  patch: Partial<Omit<Project, "id" | "createdAt">>,
): Promise<Project> {
  const existing = await readProjectMeta(id);
  if (!existing) throw new ProjectNotFoundError(id);
  const updated: Project = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
    ...(patch.outOfScope !== undefined ? { outOfScope: patch.outOfScope } : {}),
    ...(patch.rules !== undefined ? { rules: patch.rules } : {}),
    ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
  };
  await writeProjectMeta(updated);
  return updated;
}

export async function deleteProject(id: string): Promise<void> {
  const existing = await readProjectMeta(id);
  if (!existing) throw new ProjectNotFoundError(id);
  await rm(projectDir(id), { recursive: true, force: true });
}
