export type WorkOrderStatus = "pending" | "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export interface WorkOrder {
  id: string;
  missionId: string;
  agentId: string;
  objective: string;
  target?: string;
  status: WorkOrderStatus;
  priority: number;
  dependencies: string[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  relatedAssets: string[];
  relatedFindings: string[];
  orchestratorTaskId?: string;
  /** The failed/cancelled order this one retries. */
  retryOf?: string;
  /** Completed without the agent calling any tool - nothing was run or recorded. */
  noOutcome?: boolean;
}

export type WorkOrderCreateInput = Pick<WorkOrder, "agentId" | "objective"> &
  Partial<Pick<WorkOrder, "target" | "priority" | "dependencies" | "relatedAssets" | "relatedFindings" | "retryOf">>;
