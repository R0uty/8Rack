import { useCallback, useEffect, useState } from "react";
import { createProject, deleteProject, fetchProjects, updateProject } from "../services/projectsApi";
import type { Project } from "../types/project";

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProjects(await fetchProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(
    async (name: string, notes: string) => {
      const project = await createProject(name, notes);
      await refresh();
      return project;
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, patch: { name?: string; notes?: string }) => {
      const project = await updateProject(id, patch);
      await refresh();
      return project;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteProject(id);
      await refresh();
    },
    [refresh],
  );

  return { projects, loading, error, refresh, create, update, remove };
}
