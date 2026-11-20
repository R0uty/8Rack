/** Where a mission's factory run stands. One run per mission, owned by the server (missionRunner.ts),
 * so it outlives whichever tab started it. */
export type MissionRunStatus =
  /** Nothing has run since the backend started, or the last run finished with nothing left to do. */
  | "idle"
  | "running"
  /** Stopped on a tool request a human has to approve or reject in the Approval Queue. */
  | "waiting_approval"
  /** Stopped on a failed tool request; the work order needs a note before it can continue. */
  | "waiting_guidance"
  /** Stopped for any other reason a human should see: a failed order, no scope, the per-run cap,
   * a halted mission, or a stop. `reason` says which. */
  | "blocked";

export interface MissionRunState {
  missionId: string;
  status: MissionRunStatus;
  /** The order currently generating (running), or the one the run stopped on. */
  workOrderId?: string;
  reason?: string;
  startedAt?: number;
  updatedAt: number;
}

/** One line of GET /api/missions/:id/events. */
export type MissionStreamEvent =
  | { type: "run_state"; run: MissionRunState }
  /** A token of model output, tagged with the work order generating it. */
  | { type: "chunk"; workOrderId?: string; content: string }
  /** A mission-scoped store was written: re-read that resource. `resource` is the store's file name
   * without ".json" (work-orders, executions, findings, assets, activity, orchestrator-tasks,
   * reports, scans, mission). */
  | { type: "changed"; resource: string }
  /** Live output of an approved tool run. */
  | { type: "execution_output"; executionId: string; stream: "stdout" | "stderr"; data: string };
