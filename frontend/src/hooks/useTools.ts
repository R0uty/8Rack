import { useCallback, useEffect, useState } from "react";
import { fetchExecutions, fetchTools, setToolEnabled } from "../services/toolsApi";
import type { ExecToolWithStatus, ExecutionRecord } from "../types/execTool";

/** Execution history is mission-scoped; pass null when no mission is selected yet (tools list
 * still loads, but there's nothing to fetch execution history for). */
export function useTools(missionId: string | null) {
  const [tools, setTools] = useState<ExecToolWithStatus[]>([]);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [toolList, executionList] = await Promise.all([
        fetchTools(),
        missionId ? fetchExecutions(missionId) : Promise.resolve([]),
      ]);
      setTools(toolList);
      setExecutions(executionList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tools");
    } finally {
      setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Toggles a tool's enabled state on the backend, then reconciles local state from its response
   * (rather than assuming the optimistic value) so availability/version stay in sync too. */
  const toggleTool = useCallback(async (toolId: string, enabled: boolean) => {
    const updated = await setToolEnabled(toolId, enabled);
    setTools((prev) => prev.map((t) => (t.id === toolId ? updated : t)));
  }, []);

  return { tools, executions, loading, error, refresh, toggleTool };
}
