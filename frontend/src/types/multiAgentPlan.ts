import type { TaskStatus } from "./orchestrator";

export interface PlanStep {
  agentId: string;
  objective: string;
}

export interface PlanStepRun {
  agentId: string;
  objective: string;
  orchestratorTaskId: string;
  status: TaskStatus;
  finalResponse?: string;
}

export type MultiAgentPlanStatus =
  | "running"
  | "waiting_confirmation"
  | "waiting_guidance"
  | "completed"
  | "failed"
  | "cancelled";

export interface MultiAgentPlan {
  id: string;
  projectId: string;
  description: string;
  steps: PlanStep[];
  stepRuns: PlanStepRun[];
  currentStepIndex: number;
  status: MultiAgentPlanStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
