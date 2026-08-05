import type { Project } from "../types/project";
import { ApiError, apiFetch, throwForErrorResponse } from "./httpClient";

async function unwrapProject(res: Response): Promise<Project> {
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { project?: Project } | null;
  if (!data?.project) throw new ApiError("Received an invalid response from the server", 502);
  return data.project;
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await apiFetch("/api/projects");
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { projects?: Project[] } | null;
  if (!data?.projects) throw new ApiError("Received an invalid response from the server", 502);
  return data.projects;
}

export async function createProject(name: string, notes: string): Promise<Project> {
  const res = await apiFetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, notes }),
  });
  return unwrapProject(res);
}

export async function updateProject(id: string, patch: { name?: string; notes?: string }): Promise<Project> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return unwrapProject(res);
}

export async function deleteProject(id: string): Promise<void> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) await throwForErrorResponse(res);
}
