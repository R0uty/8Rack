export type OrchestratorMessageRole = "system" | "user" | "assistant" | "tool";

export interface OrchestratorMessage {
  role: OrchestratorMessageRole;
  content: string;
}

export type TaskStatus =
  | "running"
  | "waiting_confirmation"
  | "waiting_guidance"
  | "completed"
  | "failed"
  | "cancelled"
  | "max_executions_reached"
  | "max_time_reached";

export interface OrchestratorTask {
  id: string;
  missionId: string;
  agentId: string;
  model?: string;
  objective: string;
  messages: OrchestratorMessage[];
  status: TaskStatus;
  toolExecutionIds: string[];
  toolCallCount: number;
  pendingExecutionId?: string;
  finalResponse?: string;
  error?: string;
  /** Agent working time, excluding time parked on a human decision - what the time cap counts. */
  activeMs?: number;
  createdAt: number;
  updatedAt: number;
}
