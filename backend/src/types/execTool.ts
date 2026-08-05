/**
 * The OS-command execution tool system ("Tool Execution Framework"). Distinct from
 * types/tool.ts's `Tool` (in-process Ollama-native function-calling) — an ExecTool spawns a real
 * OS process via toolExecutor.ts. Named separately to avoid confusion between the two.
 */

export type ExecToolCategory = "filesystem" | "network" | "recon" | "exec" | "vcs";

/** How raw stdout gets post-processed into ExecutionResult.parsedOutput. */
export type OutputParserKind = "text" | "lines" | "json";

export interface ExecTool {
  id: string;
  name: string;
  description: string;
  category: ExecToolCategory;
  /** Binary name (resolved via PATH) or absolute path. */
  executable: string;
  /** Arguments always prepended before the caller-supplied ones. */
  defaultArguments: string[];
  /** Regex source strings; if set, every caller-supplied argument must match at least one. */
  allowedArguments?: string[];
  /** Hard execution timeout in milliseconds. */
  timeout: number;
  /** Author-level toggle — disabled tools are rejected outright, distinct from availability. */
  enabled: boolean;
  /** Whether a human must confirm before this tool actually runs. */
  requiresConfirmation: boolean;
  parser: OutputParserKind;
  /** Emoji shown in the (future) Tool Registry UI. */
  icon: string;
}

export type ExecToolAvailability = "available" | "unavailable";

/** An ExecTool annotated with whether its executable actually resolves on this machine. */
export interface ExecToolWithStatus extends ExecTool {
  availability: ExecToolAvailability;
  resolvedPath?: string;
}

/** The standardized Tool Request format. */
export interface ToolRequestBody {
  tool: string;
  arguments: string[];
  projectId: string;
  /** Piped to the process's stdin — used by tools like write_file. */
  stdin?: string;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  executionTimeMs: number;
  success: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /** True if stdout or stderr was truncated at the output size limit. */
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
  projectId: string;
  toolId: string;
  arguments: string[];
  /** Human-readable resolved command, e.g. "nmap -sV -A 127.0.0.1". */
  resolvedCommand: string;
  cwd: string;
  status: ExecutionStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: ExecutionResult;
  error?: string;
}
