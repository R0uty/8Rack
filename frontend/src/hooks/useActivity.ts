import { useCallback, useEffect, useState } from "react";
import { fetchActivity } from "../services/activityApi";
import type { MissionEvent } from "../types/missionEvent";

/** The Mission Activity Timeline - an explicit, named-event log (see backend/src/services/
 * activityLog.ts), superseding this hook's earlier client-side merge of tool executions +
 * orchestrator task transcripts (that merge only covered execution/task-level detail; this covers
 * every mission-scoped action - assets, work orders, findings, reports, scope blocks). */
export function useActivity(missionId: string | null) {
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!missionId) {
      setEvents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setEvents(await fetchActivity(missionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity");
    } finally {
      setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { events, loading, error, refresh };
}
