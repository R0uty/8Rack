import { useCallback, useEffect, useState } from "react";
import { fetchRagStatus, reindex as reindexApi } from "../services/ragApi";
import type { RagIndexStatus } from "../types/rag";

export function useRag() {
  const [status, setStatus] = useState<RagIndexStatus | null>(null);
  const [loading, setLoading] = useState(true);
  /** Separate from `loading` - a reindex can take a while (real folder walk + embedding), and the
   * panel wants to say "Indexing…" specifically, not just show its normal loading state. */
  const [reindexing, setReindexing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchRagStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load knowledge base status");
    } finally {
      setLoading(false);
    }
  }, []);

  const reindex = useCallback(async () => {
    setReindexing(true);
    setError(null);
    try {
      setStatus(await reindexApi());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reindex the knowledge base");
    } finally {
      setReindexing(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { status, loading, reindexing, error, refresh, reindex };
}
