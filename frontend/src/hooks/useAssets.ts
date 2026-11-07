import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAssets } from "../services/assetsApi";
import type { Asset } from "../types/asset";

/** Assets are mission-scoped, like useFindings' findings - pass null when no mission is selected
 * yet (assets stay empty, nothing is fetched). */
export function useAssets(missionId: string | null) {
  const [assets, setAssets] = useState<Asset[]>([]);
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
      setAssets([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAssets(missionId);
      if (missionIdRef.current !== missionId) return;
      setAssets(data);
    } catch (err) {
      if (missionIdRef.current !== missionId) return;
      setError(err instanceof Error ? err.message : "Failed to load assets");
    } finally {
      if (missionIdRef.current === missionId) setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { assets, loading, error, refresh };
}
