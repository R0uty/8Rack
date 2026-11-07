/** Mirrors backend/src/types/report.ts. */

export interface ReportSection {
  heading: string;
  content: string;
}

export type ReportStatus = "draft" | "ai_generated" | "human_review" | "ready" | "submitted";

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
