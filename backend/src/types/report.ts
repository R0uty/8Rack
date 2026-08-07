/**
 * Report generation: turn a set of already-triaged Findings (see types/finding.ts) into one
 * cohesive Markdown write-up via the Report Writer agent (backend/data/agents/report-writer.json)
 * - an executive summary plus a section per finding (impact, reproduction, remediation). Persisted
 * per-project like every other project-scoped history (executions/tasks/plans/scans).
 */

export interface ReportSection {
  heading: string;
  content: string;
}

export interface Report {
  id: string;
  projectId: string;
  title: string;
  /** Which findings (by id) this report was generated from - see types/finding.ts. */
  findingIds: string[];
  agentId: string;
  model: string;
  /** The full raw Markdown as generated - kept alongside `sections` so export/re-render never has
   * to lossily reassemble it from the split sections. */
  markdown: string;
  /** `markdown` split on "## " headings - see services/reportManager.ts#splitSections for the
   * lenient parsing rationale (local models don't always follow structure perfectly). */
  sections: ReportSection[];
  createdAt: number;
}

export interface ReportCreateInput {
  title: string;
  findingIds: string[];
  /** Defaults to the Report Writer agent - overridable per generation, same per-request-override
   * convention as chatService.ts#AgentChatRequest.model/agentId elsewhere in the app. */
  agentId?: string;
  model?: string;
}
