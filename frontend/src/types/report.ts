/** Mirrors backend/src/types/report.ts. */

export interface ReportSection {
  heading: string;
  content: string;
}

export interface Report {
  id: string;
  projectId: string;
  title: string;
  findingIds: string[];
  agentId: string;
  model: string;
  markdown: string;
  sections: ReportSection[];
  createdAt: number;
}
