/** Extension point for future report generation (e.g. bug bounty writeups). Not implemented yet. */

import type { ScanFinding } from "./scanner.js";

export interface ReportSection {
  heading: string;
  content: string;
}

export interface Report {
  id: string;
  title: string;
  createdAt: string;
  sections: ReportSection[];
}

export interface ReportInput {
  title: string;
  findings: ScanFinding[];
}
