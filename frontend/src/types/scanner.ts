/** Mirrors backend/src/types/scanner.ts. */

export type ScanStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface ScanProfileStep {
  toolId: string;
  arguments: string[];
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
  arguments: string[];
  resolvedCommand?: string;
  status: ScanStepStatus;
  executionId?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type ScanRunStatus = "running" | "completed" | "cancelled";

export interface ScanRun {
  id: string;
  projectId: string;
  profileId: string;
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

export interface ScanPreview {
  profile: Pick<ScanProfile, "id" | "name" | "description" | "icon">;
  target: string;
  steps: ScanPreviewStep[];
}
