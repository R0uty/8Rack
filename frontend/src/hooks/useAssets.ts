import { useCallback, useEffect, useState } from "react";
import { fetchAssets } from "../services/assetsApi";
import type { Asset } from "../types/asset";

/** Assets are mission-scoped, like useFindings' findings - pass null when no mission is selected
 * yet (assets stay empty, nothing is fetched). */
export function useAssets(missionId: string | null) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!missionId) {
      setAssets([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setAssets(await fetchAssets(missionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load assets");
    } finally {
      setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { assets, loading, error, refresh };
}
