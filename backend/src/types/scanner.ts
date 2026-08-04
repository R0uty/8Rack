/** Extension point for future authorized security-scanner integrations. Not implemented yet. */

export type ScanSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface ScanFinding {
  id: string;
  title: string;
  severity: ScanSeverity;
  description: string;
  target: string;
}

export interface ScanResult {
  scannerId: string;
  target: string;
  findings: ScanFinding[];
  startedAt: string;
  completedAt: string;
}

export interface Scanner {
  id: string;
  name: string;
  description: string;
  scan: (target: string) => Promise<ScanResult>;
}
