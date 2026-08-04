import { useCallback, useEffect, useState } from "react";
import { fetchExecutions, fetchTools } from "../services/toolsApi";
import type { ExecToolWithStatus, ExecutionRecord } from "../types/execTool";

export function useTools() {
  const [tools, setTools] = useState<ExecToolWithStatus[]>([]);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [toolList, executionList] = await Promise.all([fetchTools(), fetchExecutions()]);
      setTools(toolList);
      setExecutions(executionList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tools");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { tools, executions, loading, error, refresh };
}
