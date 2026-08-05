import { useCallback, useEffect, useState } from "react";
import { fetchAgents, reloadAgents } from "../services/api";
import type { AgentConfigWarning, AgentWithStatus } from "../types/agent";

export function useAgents() {
  const [agents, setAgents] = useState<AgentWithStatus[]>([]);
  const [warnings, setWarnings] = useState<AgentConfigWarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAgents();
      setAgents(result.agents);
      setWarnings(result.warnings);
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
      const result = await reloadAgents();
      setAgents(result.agents);
      setWarnings(result.warnings);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reload agents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { agents, warnings, loading, error, refresh };
}
