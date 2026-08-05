import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { listProjectIds, projectDir } from "./projectStore.js";
import { ProjectNotFoundError } from "./errors.js";
import type { Project } from "../types/project.js";

const PROJECT_FILE = "project.json";

async function readProjectMeta(id: string): Promise<Project | undefined> {
  try {
    const raw = await readFile(path.join(projectDir(id), PROJECT_FILE), "utf-8");
    return JSON.parse(raw) as Project;
  } catch {
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

export async function createProject(name: string, notes: string): Promise<Project> {
  const project: Project = { id: randomUUID(), name, notes, createdAt: Date.now() };
  await writeProjectMeta(project);
  return project;
}

export async function updateProject(id: string, patch: { name?: string; notes?: string }): Promise<Project> {
  const existing = await readProjectMeta(id);
  if (!existing) throw new ProjectNotFoundError(id);
  const updated: Project = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
  };
  await writeProjectMeta(updated);
  return updated;
}

export async function deleteProject(id: string): Promise<void> {
  const existing = await readProjectMeta(id);
  if (!existing) throw new ProjectNotFoundError(id);
  await rm(projectDir(id), { recursive: true, force: true });
}
