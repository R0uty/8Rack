export type WorkOrderStatus = "pending" | "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

/**
 * A unit of factory work assigned to one agent - the spec's "Security Work Order". Backed by a real
 * single-agent OrchestratorTask once started (orchestratorTaskId), reusing services/orchestrator.ts
 * exactly rather than a second execution mechanism - see services/workOrderManager.ts.
 */
export interface WorkOrder {
  id: string;
  missionId: string;
  agentId: string;
  objective: string;
  target?: string;
  status: WorkOrderStatus;
  /** Higher runs first when the Factory Director picks the next runnable work order - no fixed
   * scale, just relative ordering within a mission. */
  priority: number;
  /** Other WorkOrder ids that must reach "completed" before this one is startable - see
   * workOrderManager.ts#dependenciesSatisfied. */
  dependencies: string[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** The underlying task's finalResponse (success) or error (failure) once settled. */
  result?: string;
  relatedAssets: string[];
  relatedFindings: string[];
  /** Set once startWorkOrder creates the backing OrchestratorTask - undefined while still "pending". */
  orchestratorTaskId?: string;
}

export type WorkOrderCreateInput = Pick<WorkOrder, "agentId" | "objective"> &
  Partial<Pick<WorkOrder, "target" | "priority" | "dependencies" | "relatedAssets" | "relatedFindings">>;
