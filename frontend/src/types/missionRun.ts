/** Mirrors backend/src/types/missionRun.ts. */
export type MissionRunStatus = "idle" | "running" | "waiting_approval" | "waiting_guidance" | "blocked";

export interface MissionRunState {
  missionId: string;
  status: MissionRunStatus;
  workOrderId?: string;
  reason?: string;
  startedAt?: number;
  updatedAt: number;
}

export type MissionStreamEvent =
  | { type: "run_state"; run: MissionRunState }
  | { type: "chunk"; workOrderId?: string; content: string }
  /** `resource` is a store name (work-orders, executions, findings, assets, activity,
   * orchestrator-tasks, reports, scans, mission), or "*" after a reconnect, when anything may have
   * changed while the stream was down. */
  | { type: "changed"; resource: string }
  | { type: "execution_output"; executionId: string; stream: "stdout" | "stderr"; data: string };
