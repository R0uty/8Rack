/**
 * Deterministic (non-agent) chained tool execution: pick a target + a preset ScanProfile, run
 * every step's underlying ExecTool in sequence through the existing toolManager pipeline (so
 * workspace containment, executable-availability checks, and Findings ingestion all apply
 * unchanged) — one human confirmation for the whole profile up front, not one per step, since the
 * steps and their arguments are fixed by the profile rather than chosen at runtime by an LLM.
 * Supersedes the original in-process `Scanner.scan()` stub.
 */

export type ScanStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface ScanProfileStep {
  /** An ExecTool id (see types/execTool.ts) — must be a registered, enabled tool. */
  toolId: string;
  /** May contain the literal placeholder "{target}", substituted with the run's target at request time. */
  arguments: string[];
  /** Defaults to the underlying ExecTool's name if omitted. */
  label?: string;
}

export interface ScanProfile {
  id: string;
  name: string;
  description: string;
  icon: string;
  steps: ScanProfileStep[];
}

export interface ScanStepRun {
  toolId: string;
  label: string;
  /** Already has {target} substituted in. */
  arguments: string[];
  resolvedCommand?: string;
  status: ScanStepStatus;
  /** Set once the step's underlying ExecutionRecord exists — links back into the Tool Registry / Findings. */
  executionId?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type ScanRunStatus = "running" | "completed" | "cancelled";

export interface ScanRun {
  id: string;
  missionId: string;
  profileId: string;
  /** Snapshot of the profile's name at run time, so a later profile edit doesn't rewrite history. */
  profileName: string;
  target: string;
  status: ScanRunStatus;
  steps: ScanStepRun[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface ScanPreviewStep {
  toolId: string;
  label: string;
  arguments: string[];
  resolvedCommand: string;
  available: boolean;
}

/** Read-only, side-effect-free resolution of a profile against a target — the "confirm before you
 * run all steps" view, computed without ever touching toolManager's execution pipeline. */
export interface ScanPreview {
  profile: Pick<ScanProfile, "id" | "name" | "description" | "icon">;
  target: string;
  steps: ScanPreviewStep[];
}
