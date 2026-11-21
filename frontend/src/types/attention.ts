import type { ExecutionRecord } from "./execTool";
import type { WorkOrder } from "./workOrder";

/** Mirrors backend/src/services/missionAttention.ts. */
export interface AttentionWorkOrder {
  id: string;
  agentId: string;
  objective: string;
  target?: string;
}

export interface ApprovalItem {
  execution: ExecutionRecord;
  tool?: { name: string; description: string; timeoutMs: number };
  targets: string[];
  workOrder?: AttentionWorkOrder;
  agentText?: string;
}

export interface GuidanceItem {
  workOrder: AttentionWorkOrder;
  problem?: string;
  agentText?: string;
}

export interface MissionAttention {
  approvals: ApprovalItem[];
  running: ApprovalItem[];
  guidance: GuidanceItem[];
  failed: WorkOrder[];
}

/** Mirrors backend/src/services/factoryDirector.ts#FactoryPreview. */
export interface FactoryPreview {
  next?: { agentId: string; objective: string; target?: string; existing: boolean };
  blockedReason?: string;
  waitingOnApproval: number;
  waitingOnGuidance: number;
  unsettledFindings: number;
  confirmedFindings: number;
}
