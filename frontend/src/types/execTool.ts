export type ExecToolCategory = "recon" | "network" | "web" | "fuzzing" | "analysis" | "os" | "reporting";
export type OutputParserKind = "text" | "lines" | "json";

export interface ExecTool {
  id: string;
  name: string;
  description: string;
  category: ExecToolCategory;
  executable: string;
  defaultArguments: string[];
  allowedArguments?: string[];
  timeout: number;
  enabled: boolean;
  requiresConfirmation: boolean;
  parser: OutputParserKind;
  icon: string;
}

export type ExecToolAvailability = "available" | "unavailable";

export interface ExecToolWithStatus extends ExecTool {
  availability: ExecToolAvailability;
  resolvedPath?: string;
  version?: string;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  executionTimeMs: number;
  success: boolean;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  parsedOutput?: unknown;
}

export type ExecutionStatus =
  | "pending_confirmation"
  | "running"
  | "completed"
  | "rejected"
  | "cancelled"
  | "failed";

export interface ExecutionRecord {
  id: string;
  toolId: string;
  agentId?: string;
  arguments: string[];
  resolvedCommand: string;
  cwd: string;
  status: ExecutionStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  scopeWarning?: string;
  result?: ExecutionResult;
  error?: string;
}
