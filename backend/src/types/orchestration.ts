import type { TaskStatus } from "../services/orchestrator.js";

/** One step of a user-authored multi-agent plan: which agent runs it, and what it's asked to do. */
export interface PlanStep {
  agentId: string;
  objective: string;
}

/**
 * A step's actual execution, backed by a full single-agent Orchestrator task (see
 * services/orchestrator.ts) so a step can request tools and pause for human confirmation just like
 * a standalone task. `status`/`finalResponse` are a snapshot captured each time the plan advances -
 * not live-polled; only the *current* step's task is fetched live (joined in by routes/plans.ts)
 * for in-progress transcript/confirmation rendering.
 */
export interface PlanStepRun {
  agentId: string;
  /** The context-augmented objective actually given to this step - the first step gets its
   * authored objective as-is, later steps get prior steps' outputs prepended. */
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
  missionId: string;
  description: string;
  /** Fixed at creation - the authored plan. */
  steps: PlanStep[];
  /** Grows as steps actually execute - stepRuns[i] corresponds to steps[i]. */
  stepRuns: PlanStepRun[];
  currentStepIndex: number;
  status: MultiAgentPlanStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
