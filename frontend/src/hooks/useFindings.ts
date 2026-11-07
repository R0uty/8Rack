import { useCallback, useEffect, useRef, useState } from "react";
import { createFinding, deleteFinding, fetchFindings, updateFinding } from "../services/findingsApi";
import type { Finding, FindingCreateInput, FindingPatchInput } from "../types/finding";

/** Findings are mission-scoped, like useTools' executions - pass null when no mission is selected
 * yet (findings stay empty, nothing is fetched). */
export function useFindings(missionId: string | null) {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Guard against a stale previous-mission response landing after a quick mission switch - see
   * useTools.ts's identical ref for the pattern and why it matters. */
  const missionIdRef = useRef(missionId);
  useEffect(() => {
    missionIdRef.current = missionId;
  }, [missionId]);

  const refresh = useCallback(async () => {
    if (!missionId) {
      setFindings([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchFindings(missionId);
      if (missionIdRef.current !== missionId) return;
      setFindings(data);
    } catch (err) {
      if (missionIdRef.current !== missionId) return;
      setError(err instanceof Error ? err.message : "Failed to load findings");
    } finally {
      if (missionIdRef.current === missionId) setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: FindingCreateInput) => {
      if (!missionId) throw new Error("No mission selected");
      const finding = await createFinding(missionId, input);
      await refresh();
      return finding;
    },
    [missionId, refresh],
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
