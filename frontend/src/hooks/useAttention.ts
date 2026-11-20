import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAttention, fetchFactoryPreview } from "../services/factoryApi";
import { useRefreshOnChange } from "./useMissionEvents";
import type { FactoryPreview, MissionAttention } from "../types/attention";

const EMPTY: MissionAttention = { approvals: [], running: [], guidance: [], failed: [] };

/** Loads one mission-scoped value and re-reads it whenever one of `resources` changes on the server.
 * A slow reply for a previous mission is dropped. */
function useMissionResource<T>(missionId: string | null, resources: string[], load: (id: string) => Promise<T>, empty: T) {
  const [value, setValue] = useState<T>(empty);
  const [error, setError] = useState<string | null>(null);
  const missionIdRef = useRef(missionId);
  useEffect(() => {
    missionIdRef.current = missionId;
  }, [missionId]);

  const refresh = useCallback(async () => {
    if (!missionId) {
      setValue(empty);
      return;
    }
    try {
      const next = await load(missionId);
      if (missionIdRef.current !== missionId) return;
      setValue(next);
      setError(null);
    } catch (err) {
      if (missionIdRef.current === missionId) setError(err instanceof Error ? err.message : "Failed to load");
    }
    // `load` and `empty` are module-level constants at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useRefreshOnChange(missionId, resources, refresh);
  return { value, error, refresh };
}

/** Everything on the mission waiting on a human - the dashboard's "Needs you" list. */
export function useAttention(missionId: string | null) {
  const { value, error, refresh } = useMissionResource(missionId, ["executions", "work-orders", "orchestrator-tasks"], fetchAttention, EMPTY);
  return { attention: value, error, refresh };
}

/** What the next Advance would do. */
export function useFactoryPreview(missionId: string | null) {
  const { value, error, refresh } = useMissionResource<FactoryPreview | null>(
    missionId,
    ["work-orders", "assets", "findings", "mission"],
    fetchFactoryPreview,
    null,
  );
  return { preview: value, error, refresh };
}
