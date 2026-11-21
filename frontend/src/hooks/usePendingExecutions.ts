import { useCallback, useEffect, useRef, useState } from "react";
import { fetchExecutions } from "../services/toolsApi";
import type { ExecutionRecord } from "../types/execTool";

/** The mission's executions waiting on a human's approval - what the Approval Queue shows. Unlike
 * useTools it fetches only those, not the tool list or every past run's output. */
export function usePendingExecutions(missionId: string | null) {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Same stale-response guard as useTools - a slow reply for the previous mission mustn't land here.
  const missionIdRef = useRef(missionId);
  useEffect(() => {
    missionIdRef.current = missionId;
  }, [missionId]);

  const refresh = useCallback(async () => {
    if (!missionId) {
      setExecutions([]);
      return;
    }
    setError(null);
    try {
      const pending = await fetchExecutions(missionId, "pending_confirmation");
      if (missionIdRef.current === missionId) setExecutions(pending);
    } catch (err) {
      if (missionIdRef.current === missionId) setError(err instanceof Error ? err.message : "Failed to load pending approvals");
    }
  }, [missionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { executions, error, refresh };
}
