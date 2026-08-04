/** Extension point for future multi-agent orchestration. Not implemented yet. */

export interface OrchestrationStep {
  agentId: string;
  input: string;
}

export interface OrchestrationPlan {
  id: string;
  description: string;
  steps: OrchestrationStep[];
}

export interface OrchestrationStepResult {
  agentId: string;
  output: string;
}

export interface OrchestrationResult {
  planId: string;
  steps: OrchestrationStepResult[];
}
