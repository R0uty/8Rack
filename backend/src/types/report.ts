/**
 * Report generation: turn a set of already-triaged Findings (see types/finding.ts) into one
 * cohesive Markdown write-up: the Report Writer agent (backend/data/agents/report-writer.json) writes
 * an executive summary and each finding's impact and remediation, and evidence and reproduction are
 * built from recorded tool runs. Persisted
 * per-mission like every other mission-scoped history (executions/tasks/plans/scans).
 */

export interface ReportSection {
  heading: string;
  content: string;
}

/**
 * A report is always born from a real LLM generation (createReport calls the Report Writer agent
 * synchronously) - there's no not-yet-generated placeholder state in this app, so "draft" isn't
 * the starting status. `ai_generated` (the starting status) -> `human_review` -> `ready` ->
 * `submitted` is the intended forward path; `draft` exists for a report a human wants to mark as
 * needing a rewrite/regeneration before it's usable. No enforced transition graph (any status can
 * move to any other via PATCH) - same rigor level as `Finding.status`
 * (services/findingsManager.ts#updateFinding), which is equally unconstrained.
 */
export type ReportStatus = "draft" | "ai_generated" | "human_review" | "ready" | "submitted";

export interface Report {
  id: string;
  missionId: string;
  title: string;
  /** Which findings (by id) this report was generated from - see types/finding.ts. */
  findingIds: string[];
  agentId: string;
  model: string;
  /** The full Markdown: the agent's analysis assembled with evidence built from recorded executions
   * (services/reportEvidence.ts) - kept alongside `sections` so export/re-render never has to lossily
   * reassemble it from the split sections. */
  markdown: string;
  /** `markdown` split on "## " headings - see services/reportManager.ts#splitSections for the
   * lenient parsing rationale (local models don't always follow structure perfectly). */
  sections: ReportSection[];
  status: ReportStatus;
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
