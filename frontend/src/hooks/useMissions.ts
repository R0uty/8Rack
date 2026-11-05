import { useCallback, useEffect, useState } from "react";
import { createMission, deleteMission, fetchMissions, updateMission } from "../services/missionsApi";
import type { Mission } from "../types/mission";

export function useMissions() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMissions(await fetchMissions());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load missions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(
    async (name: string, notes: string, fields: Partial<Omit<Mission, "id" | "name" | "notes" | "createdAt">> = {}) => {
      const mission = await createMission(name, notes, fields);
      await refresh();
      return mission;
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, patch: Partial<Omit<Mission, "id" | "createdAt">>) => {
      const mission = await updateMission(id, patch);
      await refresh();
      return mission;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteMission(id);
      await refresh();
    },
    [refresh],
  );

  return { missions, loading, error, refresh, create, update, remove };
}
