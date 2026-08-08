import { useCallback, useEffect, useState } from "react";
import { fetchExecutions } from "../services/toolsApi";
import { fetchTasks } from "../services/orchestratorApi";
import type { ExecutionRecord } from "../types/execTool";
import type { OrchestratorTask } from "../types/orchestrator";

/** Merges a project's tool executions and Orchestrator task transcripts for the Activity feed -
 * both already exist and are separately fetchable (see useTools.ts/useOrchestratorTask.ts), this
 * just combines them for one project-wide view instead of adding a new backend entity. */
export function useActivity(projectId: string | null) {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [tasks, setTasks] = useState<OrchestratorTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setExecutions([]);
      setTasks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [executionList, taskList] = await Promise.all([fetchExecutions(projectId), fetchTasks(projectId)]);
      setExecutions(executionList);
      setTasks(taskList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { executions, tasks, loading, error, refresh };
}
