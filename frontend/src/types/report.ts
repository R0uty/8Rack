/** Mirrors backend/src/types/report.ts. */

export interface ReportSection {
  heading: string;
  content: string;
}

export const REPORT_STATUSES = ["draft", "ai_generated", "human_review", "ready", "submitted"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface Report {
  id: string;
  missionId: string;
  title: string;
  findingIds: string[];
  agentId: string;
  model: string;
  markdown: string;
  sections: ReportSection[];
  status: ReportStatus;
  createdAt: number;
}
