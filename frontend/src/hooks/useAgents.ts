import { useCallback, useEffect, useState } from "react";
import { fetchAgents, reloadAgents } from "../services/api";
import type { AgentWithStatus } from "../types/agent";

export function useAgents() {
  const [agents, setAgents] = useState<AgentWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAgents(await fetchAgents());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agents");
    } finally {
      setLoading(false);
    }
  }, []);

  // Forces the backend to re-read agent config files and re-validate their models against
  // Ollama, rather than just re-fetching the (possibly stale) cached list.
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAgents(await reloadAgents());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reload agents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { agents, loading, error, refresh };
}
