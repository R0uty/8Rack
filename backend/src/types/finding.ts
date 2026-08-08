export type FindingType =
  | "port"
  | "service"
  | "technology"
  | "domain"
  | "subdomain"
  | "directory"
  | "endpoint"
  | "credential"
  | "cookie"
  | "api"
  | "header"
  | "interesting_file"
  | "potential_vulnerability"
  | "confirmed_vulnerability"
  | "information"
  | "cve";

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

/**
 * A standard bug-bounty triage vocabulary. Renamed wholesale from an earlier, more mechanical set
 * (discovered/updated/verified/dismissed) - see findingsManager.ts's status-migration logic for
 * the old->new mapping applied to every finding loaded from disk, so existing project data keeps
 * working without a manual migration step.
 */
export type FindingStatus = "potential" | "investigating" | "confirmed" | "false_positive" | "reported" | "duplicate";

export interface FindingHistoryEntry {
  status: FindingStatus;
  at: number;
}

export type EvidenceType =
  | "http_request"
  | "http_response"
  | "terminal_output"
  | "tool_result"
  | "agent_reasoning"
  | "note";

export interface EvidenceItem {
  type: EvidenceType;
  content: string;
  createdAt: number;
}

export interface Finding {
  id: string;
  projectId: string;
  type: FindingType;
  severity: FindingSeverity;
  title: string;
  description: string;
  /** Who/what produced this finding. */
  source: "scanner" | "agent" | "manual";
  /** Tool id (e.g. "nmap"), agent id, or "manual". */
  tool: string;
  /** 0-1 */
  confidence: number;
  /** Host/domain/IP/URL this finding is about. */
  target: string;
  /** Canonical dedupe value, e.g. "80/tcp", "nginx", "admin.example.com" - set by each parser. */
  value: string;
  /** The vulnerable query/form/header parameter, if applicable (e.g. "id", "redirect_url"). */
  parameter?: string;
  /** What happens if this is exploited - kept distinct from `description` (what it is). */
  impact?: string;
  /** How to reproduce it, step by step. */
  reproductionSteps?: string;
  metadata: Record<string, unknown>;
  /** Structured evidence items, oldest first - HTTP requests/responses, terminal output, tool
   * results, agent reasoning summaries, or a free-text note. No binary attachment support
   * (screenshots/files) yet - see DEVELOPMENT.md's Findings & Evidence section for why. */
  evidence: EvidenceItem[];
  tags: string[];
  status: FindingStatus;
  /** Every status transition, oldest first - powers the Timeline UI. */
  history: FindingHistoryEntry[];
  /** Dedup counter - how many times this finding has been independently (re-)observed. */
  sourceCount: number;
  /** ExecutionRecord ids that produced or re-observed this finding, oldest first. */
  executionIds: string[];
  /** Agent ids that created or touched this finding, oldest first. */
  relatedAgents: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
}

/** What a parser returns - findingsManager fills in id/projectId/status/history/timestamps/sourceCount
 * on ingest, and wraps a raw `evidence` string into a single EvidenceItem. Parsers must never produce
 * type "confirmed_vulnerability" - only "potential_vulnerability"; promotion to confirmed is a
 * human/agent action via PATCH /api/findings/:id. */
export type ParsedFinding = Pick<
  Finding,
  "type" | "severity" | "title" | "description" | "tool" | "confidence" | "target" | "value"
> &
  Partial<Pick<Finding, "metadata" | "tags" | "parameter" | "impact" | "reproductionSteps">> & { evidence?: string };

/** Manual finding creation via POST /api/projects/:id/findings, or an agent's create_finding
 * pseudo-tool (see orchestrator.ts) - source is forced to "manual"/"agent" respectively by the
 * service, `evidence` (if given) becomes this finding's first EvidenceItem. */
export type FindingCreateInput = Pick<Finding, "type" | "severity" | "title" | "description" | "target" | "value"> &
  Partial<Pick<Finding, "tool" | "confidence" | "metadata" | "tags" | "parameter" | "impact" | "reproductionSteps">> & {
    evidence?: string;
  };

export type FindingPatchInput = Partial<
  Pick<
    Finding,
    "severity" | "status" | "tags" | "description" | "title" | "confidence" | "parameter" | "impact" | "reproductionSteps"
  >
>;

export interface FindingsGraphNode {
  id: string;
  type: FindingType | "target" | "tool";
  label: string;
}

export type FindingsGraphRelation = "runs_on" | "discovered_by" | "uses" | "contains" | "connected_to" | "related_to";

export interface FindingsGraphEdge {
  source: string;
  target: string;
  relation: FindingsGraphRelation;
}

export interface FindingsGraph {
  nodes: FindingsGraphNode[];
  edges: FindingsGraphEdge[];
}

export interface FindingFilters {
  type?: FindingType;
  severity?: FindingSeverity;
  tool?: string;
  target?: string;
  tag?: string;
  /** Matches findings whose confidence is >= this threshold (0-1). */
  minConfidence?: number;
  /** Matches `tool` when the finding is agent-sourced, or `relatedAgents` containing this id. */
  agent?: string;
}
