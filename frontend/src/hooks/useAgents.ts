import { useCallback, useEffect, useState } from "react";
import { createAgent, deleteAgent, fetchAgents, reloadAgents, updateAgent } from "../services/api";
import type { Agent, AgentConfigWarning, AgentWithStatus } from "../types/agent";

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

  // create/update/remove intentionally let errors propagate to the caller (AgentEditor) instead
  // of swallowing them into this hook's own `error` state - that state is for the list-level
  // load/refresh, not a single in-progress edit's validation error.
  const create = useCallback(
    async (agent: Agent) => {
      const created = await createAgent(agent);
      await refresh();
      return created;
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, agent: Agent) => {
      const updated = await updateAgent(id, agent);
      await refresh();
      return updated;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteAgent(id);
      await refresh();
    },
    [refresh],
  );

  return { agents, warnings, loading, error, refresh, create, update, remove };
}
