import { useCallback, useEffect, useState } from "react";
import { createFinding, deleteFinding, fetchFindings, updateFinding } from "../services/findingsApi";
import type { Finding, FindingCreateInput, FindingPatchInput } from "../types/finding";

/** Findings are project-scoped, like useTools' executions - pass null when no project is selected
 * yet (findings stay empty, nothing is fetched). */
export function useFindings(projectId: string | null) {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setFindings([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setFindings(await fetchFindings(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load findings");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: FindingCreateInput) => {
      if (!projectId) throw new Error("No project selected");
      const finding = await createFinding(projectId, input);
      await refresh();
      return finding;
    },
    [projectId, refresh],
  );

  const update = useCallback(
    async (id: string, patch: FindingPatchInput) => {
      const finding = await updateFinding(id, patch);
      await refresh();
      return finding;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteFinding(id);
      await refresh();
    },
    [refresh],
  );

  return { findings, loading, error, refresh, create, update, remove };
}
